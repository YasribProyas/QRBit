/**
 * Tests for the local library IDB layer (PLAN.md §6.1–§6.3).
 *
 * `fake-indexeddb` stands in for the browser, so this file runs in the default
 * node environment (no jsdom docblock). Each test starts from an EMPTY database:
 * the module's cached connection is closed and the database is deleted in
 * `beforeEach` — per-test isolation without an injectable factory.
 *
 * The tests that matter most are the boundary ones: the layer must reject an item
 * that does not match its declared §6.1 shape, must reject a half-finished
 * transfer, and must keep a locked item's `{ciphertext, iv, salt}` byte-identical
 * (PLAN.md §6.2, §14, decision D9). The rest pin the round-trips and the §6.3
 * schema, and a few tests open the database the raw IndexedDB way to prove the
 * indexes are really there.
 */

import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  closeLibraryDatabase,
  createFolder,
  deleteFolder,
  deleteItem,
  getFolders,
  getItem,
  getItemsInFolder,
  moveItem,
  renameFolder,
  ROOT_FOLDER_ID,
  saveFromSession,
  saveItem,
  updateItem,
  type LibraryFileItem,
  type LibraryImageItem,
  type LibraryItem,
  type LibraryLockedItem,
  type LibraryTextItem,
} from './library'
import type {
  FileItem,
  ImageItem,
  LockedItem,
  RichTextItem,
  TextItem,
} from '../store/sessionStore'

/** PLAN.md §6.3 names the database; pinning it here catches a rename. */
const DB_NAME = 'qrdrop-library'

const NOW = 1_700_000_000_000

/** Every byte value from 0x00 to 0xFF appears, so a truncated copy cannot pass. */
function bytes(length: number): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * 31 + 7) % 256
  }
  return value
}

// ---------------------------------------------------------------------------
// Isolation + raw IDB access
// ---------------------------------------------------------------------------

async function freshDatabase(): Promise<void> {
  await closeLibraryDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'))
  })
}

beforeEach(freshDatabase)

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IDB request failed'))
  })
}

/**
 * The database as a second tab would open it. Always used after the API has
 * created the schema — opening without a version and no upgrade would create an
 * empty v1 and hide a schema bug rather than expose it.
 */
async function withRawDatabase<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await idbRequest(indexedDB.open(DB_NAME))
  try {
    return await run(db)
  } finally {
    db.close()
    // Let a transaction that was still committing finish before the next test
    // deletes the database: a close is deferred until then, and an open
    // connection would block the delete (see `freshDatabase`).
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function textItem(overrides: Partial<LibraryTextItem> = {}): LibraryTextItem {
  return {
    id: globalThis.crypto.randomUUID(),
    folderId: ROOT_FOLDER_ID,
    name: 'note',
    type: 'text',
    createdAt: NOW,
    updatedAt: NOW,
    content: 'hello',
    ...overrides,
  }
}

function imageItem(overrides: Partial<LibraryImageItem> = {}): LibraryImageItem {
  const blob = new Blob([bytes(64)], { type: 'image/png' })
  return {
    id: globalThis.crypto.randomUUID(),
    folderId: ROOT_FOLDER_ID,
    name: 'cat.png',
    type: 'image',
    createdAt: NOW,
    updatedAt: NOW,
    blob,
    mimeType: 'image/png',
    size: blob.size,
    ...overrides,
  }
}

function lockedItem(overrides: Partial<LibraryLockedItem> = {}): LibraryLockedItem {
  return {
    id: globalThis.crypto.randomUUID(),
    folderId: ROOT_FOLDER_ID,
    name: 'Portal password',
    type: 'locked',
    createdAt: NOW,
    updatedAt: NOW,
    label: 'Portal password',
    innerType: 'text',
    ciphertext: bytes(48),
    iv: bytes(12),
    salt: bytes(16),
    ...overrides,
  }
}

/** An item of the store's §9 shape. */
function sessionText(content: string): TextItem {
  return { id: globalThis.crypto.randomUUID(), type: 'text', status: 'complete', createdAt: NOW, content }
}

function sessionRichText(content: string): RichTextItem {
  return {
    id: globalThis.crypto.randomUUID(),
    type: 'richtext',
    status: 'complete',
    createdAt: NOW,
    content,
  }
}

function sessionFile(name = 'thesis.pdf', data = bytes(32)): FileItem {
  const file = new File([data], name, { type: 'application/pdf' })
  return {
    id: globalThis.crypto.randomUUID(),
    type: 'file',
    status: 'complete',
    createdAt: NOW,
    fileName: file.name,
    mimeType: file.type,
    totalSize: file.size,
    totalChunks: 1,
    progress: 100,
    blob: file,
  }
}

function sessionImage(): ImageItem {
  const blob = new Blob([bytes(96)], { type: 'image/jpeg' })
  return {
    id: globalThis.crypto.randomUUID(),
    type: 'image',
    status: 'complete',
    createdAt: NOW,
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    totalSize: blob.size,
    totalChunks: 1,
    progress: 100,
    blob,
  }
}

function sessionLocked(): LockedItem {
  return {
    id: globalThis.crypto.randomUUID(),
    type: 'locked',
    status: 'complete',
    createdAt: NOW,
    label: 'SSH key',
    innerType: 'file',
    ciphertext: bytes(80),
    iv: bytes(12),
    salt: bytes(16),
  }
}

/**
 * A deliberately malformed record, the kind untyped IDB could hand back. The
 * compiler would reject these shapes, which is exactly the point: the tests feed
 * the layer garbage to prove that its own validation — not the type system — is
 * what keeps IDB clean.
 */
function garbage(fields: Record<string, unknown>): LibraryItem {
  return fields as unknown as LibraryItem
}

function baseFields(folderId = ROOT_FOLDER_ID): Record<string, unknown> {
  return {
    id: globalThis.crypto.randomUUID(),
    folderId,
    name: 'garbage',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

// ---------------------------------------------------------------------------

describe('folders', () => {
  it('creates a top-level folder in the root and lists it', async () => {
    const folder = await createFolder('Uni Stuff', null)

    expect(folder.id).not.toBe('')
    expect(folder.name).toBe('Uni Stuff')
    expect(folder.parentId).toBeNull()
    expect(folder.createdAt).toBeGreaterThan(0)
    expect(folder.updatedAt).toBe(folder.createdAt)
    expect(await getFolders()).toEqual([folder])
  })

  it('gives every folder its own uuid', async () => {
    const first = await createFolder('Work', null)
    const second = await createFolder('Work', null)

    expect(first.id).not.toBe(second.id)
    expect(await getFolders()).toHaveLength(2)
  })

  it('creates a folder inside another folder', async () => {
    const parent = await createFolder('Uni', null)
    const child = await createFolder('Thesis', parent.id)

    expect(child.parentId).toBe(parent.id)
    const names = (await getFolders()).map((folder) => `${folder.name}:${String(folder.parentId)}`)
    expect(names.sort()).toEqual([`Thesis:${parent.id}`, 'Uni:null'])
  })

  it('treats the root id as an alias for a null parent', async () => {
    // The UI's "New Folder" inside the root passes the root's id; PLAN.md §6.1
    // defines top-level as parentId === null, so the stored value must be null.
    const folder = await createFolder('Work', ROOT_FOLDER_ID)

    expect(folder.parentId).toBeNull()
  })

  it('trims a folder name and rejects an empty one', async () => {
    expect((await createFolder('  Work  ', null)).name).toBe('Work')
    await expect(createFolder('   ', null)).rejects.toThrow(/non-empty name/)
    await expect(createFolder('', null)).rejects.toThrow(/non-empty name/)
  })

  it('rejects a parent that does not exist', async () => {
    await expect(createFolder('Orphan', 'no-such-folder')).rejects.toThrow(/no folder with id/)
  })

  it('renames a folder and bumps updatedAt', async () => {
    const folder = await createFolder('Wrok', null)

    await renameFolder(folder.id, ' Work ')

    const [renamed] = await getFolders()
    expect(renamed?.name).toBe('Work')
    expect(renamed?.createdAt).toBe(folder.createdAt)
    expect(renamed?.updatedAt).toBeGreaterThanOrEqual(folder.updatedAt)
  })

  it('rejects renaming an unknown folder or the root', async () => {
    await expect(renameFolder('no-such-folder', 'Work')).rejects.toThrow(/no folder with id/)
    await expect(renameFolder(ROOT_FOLDER_ID, 'Work')).rejects.toThrow(/root folder cannot be renamed/)
  })

  it('refuses to delete the root', async () => {
    await expect(deleteFolder(ROOT_FOLDER_ID)).rejects.toThrow(/root folder cannot be deleted/)
  })

  it('rejects deleting an unknown folder', async () => {
    await expect(deleteFolder('no-such-folder')).rejects.toThrow(/no folder with id/)
  })

  it('deletes a folder together with the items inside it', async () => {
    const folder = await createFolder('Work', null)
    const kept = textItem({ name: 'in the root' })
    const doomed = textItem({ folderId: folder.id, name: 'in the folder' })
    await saveItem(kept)
    await saveItem(doomed)

    await deleteFolder(folder.id)

    expect(await getFolders()).toEqual([])
    expect(await getItem(doomed.id)).toBeUndefined()
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(1)
    expect(await getItem(kept.id)).toBeDefined()
  })

  it('deletes a nested tree whole and leaves unrelated folders alone', async () => {
    const parent = await createFolder('Uni', null)
    const child = await createFolder('Thesis', parent.id)
    const grandchild = await createFolder('Chapter 1', child.id)
    const bystander = await createFolder('Work', null)

    const items = [
      textItem({ folderId: parent.id, name: 'parent item' }),
      textItem({ folderId: child.id, name: 'child item' }),
      textItem({ folderId: grandchild.id, name: 'grandchild item' }),
      textItem({ folderId: bystander.id, name: 'bystander item' }),
      textItem({ folderId: ROOT_FOLDER_ID, name: 'root item' }),
    ]
    for (const item of items) await saveItem(item)

    await deleteFolder(parent.id)

    expect((await getFolders()).map((folder) => folder.name).sort()).toEqual(['Work'])
    expect(await getItem(items[0]!.id)).toBeUndefined()
    expect(await getItem(items[1]!.id)).toBeUndefined()
    expect(await getItem(items[2]!.id)).toBeUndefined()
    expect(await getItem(items[3]!.id)).toBeDefined()
    expect(await getItem(items[4]!.id)).toBeDefined()
    expect(await getItemsInFolder(bystander.id)).toHaveLength(1)
  })
})

describe('items', () => {
  it('round-trips a text item', async () => {
    const item = textItem({ content: 'the portal password is hunter2' })

    await saveItem(item)

    expect(await getItem(item.id)).toEqual(item)
  })

  it('returns undefined for an item that is not there', async () => {
    expect(await getItem('no-such-item')).toBeUndefined()
  })

  it('overwrites an item saved with the same id and lists it once', async () => {
    const item = textItem({ content: 'first' })
    await saveItem(item)
    await saveItem({ ...item, content: 'second' })

    const stored = await getItem(item.id)
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(1)
    expect(stored?.type === 'text' ? stored.content : null).toBe('second')
  })

  it('lists the items of one folder only, most recently updated first', async () => {
    const folder = await createFolder('Work', null)
    const older = textItem({ updatedAt: NOW, name: 'older' })
    const middle = textItem({ updatedAt: NOW + 10, name: 'middle' })
    const newest = textItem({ updatedAt: NOW + 20, name: 'newest', folderId: folder.id })
    for (const item of [older, middle, newest]) await saveItem(item)

    const inRoot = await getItemsInFolder(ROOT_FOLDER_ID)
    expect(inRoot.map((item) => item.name)).toEqual(['middle', 'older'])
    expect((await getItemsInFolder(folder.id)).map((item) => item.name)).toEqual(['newest'])
  })

  it('has no items for a folder that does not exist', async () => {
    await createFolder('Work', null)
    expect(await getItemsInFolder('no-such-folder')).toEqual([])
  })

  it('rejects an item whose folder does not exist', async () => {
    await expect(saveItem(textItem({ folderId: 'no-such-folder' }))).rejects.toThrow(/no folder with id/)
  })

  it('accepts an item in the root without a folder row', async () => {
    const item = textItem()
    await saveItem(item)
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toEqual([item])
  })

  it('rejects a text item with no content', async () => {
    await expect(saveItem(garbage({ ...baseFields(), type: 'text' }))).rejects.toThrow(
      /text item needs a string "content"/,
    )
  })

  it('accepts an empty note as content', async () => {
    const empty = textItem({ content: '' })
    await saveItem(empty)
    expect(await getItem(empty.id)).toEqual(empty)
  })

  it('rejects a locked item missing any part of the tuple', async () => {
    const complete = lockedItem()

    for (const key of ['ciphertext', 'iv', 'salt'] as const) {
      const { [key]: _dropped, ...rest } = complete
      await expect(saveItem(garbage({ ...rest }))).rejects.toThrow(
        new RegExp(`locked item needs "${key}" as Uint8Array bytes`),
      )
    }
  })

  it('rejects a locked item with empty or non-byte unlock material', async () => {
    await expect(saveItem(lockedItem({ iv: new Uint8Array(0) }))).rejects.toThrow(
      /non-empty "iv" bytes/,
    )
    await expect(
      saveItem(garbage({ ...lockedItem(), ciphertext: 'not bytes' })),
    ).rejects.toThrow(/as Uint8Array bytes/)
    await expect(
      saveItem(garbage({ ...lockedItem(), innerType: 'image' })),
    ).rejects.toThrow(/needs an "innerType" of text, richtext or file/)
  })

  it('rejects a locked tuple whose iv or salt is not the §6.1 width', async () => {
    await expect(saveItem(lockedItem({ iv: bytes(1) }))).rejects.toThrow(
      /locked item needs "iv" to be 12 bytes \(got 1\)/,
    )
    await expect(saveItem(lockedItem({ salt: bytes(15) }))).rejects.toThrow(
      /locked item needs "salt" to be 16 bytes \(got 15\)/,
    )
    await expect(saveItem(lockedItem({ salt: bytes(5000) }))).rejects.toThrow(
      /locked item needs "salt" to be 16 bytes \(got 5000\)/,
    )

    // The same rule on the patch path: a width that `encryptItem` never emits cannot be
    // introduced by an update either.
    const stored = lockedItem()
    await saveItem(stored)
    await expect(updateItem(stored.id, { iv: bytes(1) })).rejects.toThrow(
      /locked item needs "iv" to be 12 bytes/,
    )

    // Nothing landed: the three rejections above wrote no row, and the patch left the
    // stored tuple exactly as it was.
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toEqual([stored])
  })

  it('accepts the 12-byte iv and 16-byte salt encryptItem emits, whatever the ciphertext length', async () => {
    // The ciphertext is plaintext + the AES-GCM tag, so it is the only field of the tuple
    // whose length is free (PLAN.md §6.1, §11.4).
    const item = lockedItem({ ciphertext: bytes(4096) })
    await saveItem(item)

    const stored = (await getItem(item.id)) as LibraryLockedItem
    expect(stored.iv).toHaveLength(12)
    expect(stored.salt).toHaveLength(16)
    expect(stored.ciphertext).toHaveLength(4096)
  })

  it('rejects an image or file item without a blob, mimeType or matching size', async () => {
    const image = imageItem()

    await expect(saveItem(garbage({ ...image, blob: undefined }))).rejects.toThrow(
      /needs a Blob "blob"/,
    )
    await expect(saveItem(garbage({ ...image, mimeType: 7 }))).rejects.toThrow(
      /needs a string "mimeType"/,
    )
    await expect(saveItem(garbage({ ...image, size: undefined }))).rejects.toThrow(
      /non-negative integer "size"/,
    )
    await expect(saveItem(imageItem({ size: image.size + 1 }))).rejects.toThrow(
      /declares size \d+ but its blob holds \d+/,
    )
  })

  it('rejects a field that belongs to another type', async () => {
    await expect(saveItem(garbage({ ...textItem(), blob: new Blob(['x']) }))).rejects.toThrow(
      /unexpected field "blob" on a text item/,
    )
  })

  it('rejects an unknown item type, a blank id and a blank name', async () => {
    await expect(saveItem(garbage({ ...baseFields(), type: 'video' }))).rejects.toThrow(
      /unknown item type/,
    )
    await expect(saveItem(textItem({ id: '   ' }))).rejects.toThrow(/non-empty id/)
    await expect(saveItem(textItem({ name: '  ' }))).rejects.toThrow(/non-empty name/)
  })

  it('never hands back a corrupt stored row', async () => {
    await saveItem(textItem())
    await withRawDatabase(async (db) => {
      await idbRequest(
        db.transaction('items', 'readwrite').objectStore('items').put({
          ...textItem({ id: 'corrupt' }),
          sneaky: true,
        }),
      )
    })

    await expect(getItem('corrupt')).rejects.toThrow(/unexpected field "sneaky" on a text item/)
    await expect(getItemsInFolder(ROOT_FOLDER_ID)).rejects.toThrow(/unexpected field "sneaky"/)
  })

  it('rejects a stored row whose type is not a library type', async () => {
    await saveItem(textItem())
    await withRawDatabase(async (db) => {
      await idbRequest(
        db.transaction('items', 'readwrite').objectStore('items').put({
          ...baseFields(),
          type: 'video',
        }),
      )
    })

    await expect(getItemsInFolder(ROOT_FOLDER_ID)).rejects.toThrow(/unknown item type/)
  })

  it('applies a patch without touching the fields it does not name', async () => {
    const item = textItem({ content: 'keep me' })
    await saveItem(item)

    await updateItem(item.id, { name: 'renamed' })

    const updated = await getItem(item.id)
    expect(updated?.name).toBe('renamed')
    expect(updated?.type).toBe('text')
    expect(updated?.createdAt).toBe(item.createdAt)
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(item.updatedAt)
    expect(updated?.type === 'text' ? updated.content : null).toBe('keep me')
  })

  it('patches a locked item without disturbing its tuple', async () => {
    const item = lockedItem()
    await saveItem(item)

    await updateItem(item.id, { name: 'Renamed secret' })

    const updated = await getItem(item.id)
    expect(updated?.type === 'locked' ? updated.ciphertext : null).toEqual(item.ciphertext)
    expect(updated?.type === 'locked' ? updated.iv : null).toEqual(item.iv)
    expect(updated?.type === 'locked' ? updated.salt : null).toEqual(item.salt)
  })

  it('rejects a patch that would change the identity or type fields', async () => {
    const item = textItem()
    await saveItem(item)

    await expect(updateItem(item.id, { id: 'other-id' })).rejects.toThrow(/id is immutable/)
    await expect(updateItem(item.id, { type: 'file' })).rejects.toThrow(/type is immutable/)
    await expect(updateItem(item.id, { createdAt: NOW + 1 })).rejects.toThrow(
      /createdAt is immutable/,
    )
  })

  it('rejects a patch that smuggles in another type field', async () => {
    const item = textItem()
    await saveItem(item)

    await expect(updateItem(item.id, { blob: new Blob(['x']) })).rejects.toThrow(
      /unexpected field "blob" on a text item/,
    )
  })

  it('rejects updating an item that is not there', async () => {
    await expect(updateItem('no-such-item', { name: 'x' })).rejects.toThrow(/no item with id/)
  })

  it('deletes an item and rejects deleting one that is not there', async () => {
    const item = textItem()
    await saveItem(item)

    await deleteItem(item.id)

    expect(await getItem(item.id)).toBeUndefined()
    await expect(deleteItem(item.id)).rejects.toThrow(/no item with id/)
  })

  it('moves an item to another folder, changing nothing else', async () => {
    const folder = await createFolder('Work', null)
    const item = lockedItem()
    await saveItem(item)

    await moveItem(item.id, folder.id)

    const moved = await getItem(item.id)
    expect(moved).toEqual({ ...item, folderId: folder.id, updatedAt: expect.any(Number) })
    expect(await getItemsInFolder(folder.id)).toHaveLength(1)
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toEqual([])
  })

  it('moves an item back to the root and rejects a bad move', async () => {
    const folder = await createFolder('Work', null)
    const item = textItem({ folderId: folder.id })
    await saveItem(item)

    await moveItem(item.id, ROOT_FOLDER_ID)
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(1)

    await expect(moveItem(item.id, 'no-such-folder')).rejects.toThrow(/no folder with id/)
    await expect(moveItem('no-such-item', ROOT_FOLDER_ID)).rejects.toThrow(/no item with id/)
  })
})

describe('saveFromSession conversions', () => {
  it('converts a text item, naming it after its opening words', async () => {
    const session = sessionText('  Portal   password for Uni  ')

    const saved = await saveFromSession(session, ROOT_FOLDER_ID)

    expect(saved).toMatchObject({
      type: 'text',
      name: 'Portal password for Uni',
      folderId: ROOT_FOLDER_ID,
      content: '  Portal   password for Uni  ',
    })
    expect(saved.id).not.toBe(session.id)
    expect(await getItem(saved.id)).toEqual(saved)
  })

  it('names an empty text item after its type', async () => {
    const saved = await saveFromSession(sessionText('   '), ROOT_FOLDER_ID)
    expect(saved.name).toBe('Text note')
  })

  it('clips a long text name to its first words', async () => {
    const saved = await saveFromSession(
      sessionText('the quick brown fox jumps over the lazy dog and keeps on running'),
      ROOT_FOLDER_ID,
    )

    expect(saved.name.endsWith('…')).toBe(true)
    expect(saved.name.length).toBeLessThanOrEqual(41)
    expect(saved.name).toBe('the quick brown fox jumps over the lazy…')
  })

  it('converts a rich text item with the default name', async () => {
    const session = sessionRichText('{"type":"doc","content":[]}')

    const saved = await saveFromSession(session, ROOT_FOLDER_ID)

    expect(saved).toMatchObject({
      type: 'richtext',
      name: 'Rich text note',
      content: '{"type":"doc","content":[]}',
    })
    expect(saved.id).not.toBe(session.id)
  })

  it('converts an image item, keeping the assembled blob and its size', async () => {
    const session = sessionImage()
    expect(session.blob).toBeDefined()
    const source = session.blob as Blob

    const saved = await saveFromSession(session, ROOT_FOLDER_ID)

    expect(saved.type).toBe('image')
    const image = saved as LibraryImageItem
    expect(image.name).toBe('photo.jpg')
    expect(image.mimeType).toBe('image/jpeg')
    expect(image.blob).toBe(source)
    expect(image.size).toBe(source.size)
    expect(new Uint8Array(await image.blob.arrayBuffer())).toEqual(new Uint8Array(await source.arrayBuffer()))
  })

  it('converts a file item, keeping the sender\u2019s File as the blob', async () => {
    const session = sessionFile()
    const source = session.blob as File

    const saved = await saveFromSession(session, ROOT_FOLDER_ID)

    expect(saved.type).toBe('file')
    const file = saved as LibraryFileItem
    expect(file.name).toBe('thesis.pdf')
    expect(file.mimeType).toBe('application/pdf')
    expect(file.blob).toBe(source)
    expect(file.size).toBe(source.size)
    expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(bytes(32))
  })

  it('falls back to the blob\u2019s own type when the announce left it blank', async () => {
    const session = sessionFile()
    const saved = await saveFromSession({ ...session, mimeType: '' }, ROOT_FOLDER_ID)

    expect(saved.type === 'file' ? saved.mimeType : null).toBe('application/pdf')
  })

  it('names an image or file item after its file name, or its type when blank', async () => {
    const image = sessionImage()
    expect((await saveFromSession(image, ROOT_FOLDER_ID)).name).toBe('photo.jpg')

    const nameless = await saveFromSession({ ...sessionFile(), fileName: ' ' }, ROOT_FOLDER_ID)
    expect(nameless.name).toBe('File')
  })

  it('converts a locked item with its tuple byte-for-byte and the label as default name', async () => {
    const session = sessionLocked()
    const ciphertext = session.ciphertext.slice()
    const iv = session.iv.slice()
    const salt = session.salt.slice()

    const saved = await saveFromSession(session, ROOT_FOLDER_ID)

    expect(saved).toMatchObject({
      type: 'locked',
      name: 'SSH key',
      label: 'SSH key',
      innerType: 'file',
    })
    expect(saved.id).not.toBe(session.id)

    const stored = (await getItem(saved.id)) as LibraryLockedItem
    expect(stored.ciphertext).toBeInstanceOf(Uint8Array)
    expect(stored.iv).toBeInstanceOf(Uint8Array)
    expect(stored.salt).toBeInstanceOf(Uint8Array)
    expect(stored.ciphertext).toEqual(ciphertext)
    expect(stored.iv).toEqual(iv)
    expect(stored.salt).toEqual(salt)
    expect(stored.ciphertext.byteLength).toBe(ciphertext.byteLength)
    expect(stored.iv.byteLength).toBe(12)
    expect(stored.salt.byteLength).toBe(16)
  })

  it('rejects a locked session item whose iv or salt is not the §6.1 width', async () => {
    // What a hostile peer's `locked-payload` becomes once it reaches this boundary: the
    // wire checks that the field is bytes and nothing more, so the width is checked here
    // or a permanently unopenable item is stored — and every unlock attempt on it reads
    // as "wrong password" (PLAN.md §17).
    await expect(
      saveFromSession({ ...sessionLocked(), iv: bytes(1) }, ROOT_FOLDER_ID),
    ).rejects.toThrow(/locked item needs "iv" to be 12 bytes/)
    await expect(
      saveFromSession({ ...sessionLocked(), salt: bytes(32) }, ROOT_FOLDER_ID),
    ).rejects.toThrow(/locked item needs "salt" to be 16 bytes/)

    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toEqual([])
  })

  it('keeps a locked item\u2019s bytes independent of the session item', async () => {
    const session = sessionLocked()
    const ciphertext = session.ciphertext.slice()

    const saved = await saveFromSession(session, ROOT_FOLDER_ID)
    session.ciphertext.fill(0)

    expect((await getItem(saved.id))?.type === 'locked').toBe(true)
    const stored = (await getItem(saved.id)) as LibraryLockedItem
    expect(stored.ciphertext).toEqual(ciphertext)
  })

  it('names a locked item after its label, with a fallback when the label is empty', async () => {
    const saved = await saveFromSession(sessionLocked(), ROOT_FOLDER_ID)
    expect(saved.name).toBe('SSH key')

    const unlabelled = await saveFromSession({ ...sessionLocked(), label: '' }, ROOT_FOLDER_ID)
    expect(unlabelled.name).toBe('Locked item')
  })

  it('saves into a chosen folder', async () => {
    const folder = await createFolder('Work', null)

    const saved = await saveFromSession(sessionText('notes'), folder.id)

    expect(saved.folderId).toBe(folder.id)
    expect(await getItemsInFolder(folder.id)).toHaveLength(1)
  })

  it('rejects saving into a folder that does not exist', async () => {
    await expect(saveFromSession(sessionText('notes'), 'no-such-folder')).rejects.toThrow(
      /no folder with id/,
    )
  })

  it('refuses to save a transfer that never completed', async () => {
    await expect(
      saveFromSession({ ...sessionFile(), status: 'transferring' }, ROOT_FOLDER_ID),
    ).rejects.toThrow(/while its transfer is "transferring"/)

    await expect(
      saveFromSession({ ...sessionText('half typed'), status: 'error' }, ROOT_FOLDER_ID),
    ).rejects.toThrow(/while its transfer is "error"/)

    await expect(
      saveFromSession({ ...sessionLocked(), status: 'pending' }, ROOT_FOLDER_ID),
    ).rejects.toThrow(/while its transfer is "pending"/)
  })

  it('refuses to save an image or file item with no assembled blob', async () => {
    await expect(
      saveFromSession({ ...sessionFile(), blob: undefined }, ROOT_FOLDER_ID),
    ).rejects.toThrow(/never produced a blob/)

    await expect(
      saveFromSession({ ...sessionImage(), status: 'pending', blob: undefined }, ROOT_FOLDER_ID),
    ).rejects.toThrow(/while its transfer is "pending"/)
  })

  it('writes nothing when the conversion is rejected', async () => {
    const folder = await createFolder('Work', null)

    await expect(
      saveFromSession({ ...sessionFile(), status: 'pending' }, folder.id),
    ).rejects.toThrow(/while its transfer is "pending"/)

    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toEqual([])
    expect(await getItemsInFolder(folder.id)).toEqual([])
  })
})

describe('bytes and blobs through IndexedDB', () => {
  it('round-trips Uint8Array unlock material byte-for-byte', async () => {
    const item = lockedItem({ ciphertext: bytes(255), iv: bytes(12), salt: bytes(16) })
    await saveItem(item)

    const stored = (await getItem(item.id)) as LibraryLockedItem

    expect(stored.ciphertext).toBeInstanceOf(Uint8Array)
    expect(stored.ciphertext).toHaveLength(255)
    expect(Array.from(stored.ciphertext)).toEqual(Array.from(item.ciphertext))
    expect(Array.from(stored.iv)).toEqual(Array.from(item.iv))
    expect(Array.from(stored.salt)).toEqual(Array.from(item.salt))
  })

  it('normalises a hand-written ArrayBuffer into a Uint8Array on read', async () => {
    // Some engines hand a byte field back as an ArrayBuffer, so the layer
    // normalises rather than trusting the stored form.
    const ciphertext = bytes(40)
    const iv = bytes(12)
    const salt = bytes(16)
    await saveItem(textItem())
    await withRawDatabase(async (db) => {
      await idbRequest(
        db.transaction('items', 'readwrite').objectStore('items').put({
          ...lockedItem({ id: 'from-another-tab' }),
          ciphertext: ciphertext.buffer.slice(0),
          iv: iv.buffer.slice(0),
          salt: salt.buffer.slice(0),
        }),
      )
    })

    const stored = (await getItem('from-another-tab')) as LibraryLockedItem

    expect(stored.ciphertext).toBeInstanceOf(Uint8Array)
    expect(Array.from(stored.ciphertext)).toEqual(Array.from(ciphertext))
    expect(Array.from(stored.iv)).toEqual(Array.from(iv))
    expect(Array.from(stored.salt)).toEqual(Array.from(salt))
  })

  it('round-trips a Blob byte-for-byte with its type and size', async () => {
    const item = imageItem()
    await saveItem(item)

    const stored = (await getItem(item.id)) as LibraryImageItem

    expect(stored.blob).toBeInstanceOf(Blob)
    expect(stored.blob.size).toBe(item.blob.size)
    expect(stored.blob.type).toBe('image/png')
    expect(new Uint8Array(await stored.blob.arrayBuffer())).toEqual(
      new Uint8Array(await item.blob.arrayBuffer()),
    )
  })

  it('normalises hand-written bytes into a Blob on read', async () => {
    const data = bytes(24)
    await saveItem(textItem())
    await withRawDatabase(async (db) => {
      await idbRequest(
        db.transaction('items', 'readwrite').objectStore('items').put({
          ...imageItem({ id: 'bytes-as-blob', size: undefined }),
          blob: data.slice(),
          size: data.byteLength,
        }),
      )
    })

    const stored = (await getItem('bytes-as-blob')) as LibraryImageItem

    expect(stored.blob).toBeInstanceOf(Blob)
    expect(stored.blob.type).toBe('image/png')
    expect(new Uint8Array(await stored.blob.arrayBuffer())).toEqual(data)
  })
})

describe('schema and indexes (PLAN.md §6.3)', () => {
  it('creates the folders and items stores with their keys and indexes', async () => {
    await getFolders()

    await withRawDatabase(async (db) => {
      expect(Array.from(db.objectStoreNames).sort()).toEqual(['folders', 'items'])

      const folders = db.transaction('folders').objectStore('folders')
      expect(folders.keyPath).toBe('id')

      const items = db.transaction('items').objectStore('items')
      expect(items.keyPath).toBe('id')
      expect(Array.from(items.indexNames).sort()).toEqual(['folderId', 'type', 'updatedAt'])
      expect(items.index('folderId').keyPath).toBe('folderId')
      expect(items.index('type').keyPath).toBe('type')
      expect(items.index('updatedAt').keyPath).toBe('updatedAt')
    })
  })

  it('answers the folderId index with exactly the items of one folder', async () => {
    const folder = await createFolder('Work', null)
    await saveItem(textItem({ name: 'root a' }))
    await saveItem(textItem({ name: 'root b' }))
    await saveItem(textItem({ folderId: folder.id, name: 'in folder' }))

    await withRawDatabase(async (db) => {
      const inFolder: unknown[] = await idbRequest(
        db.transaction('items').objectStore('items').index('folderId').getAll(folder.id),
      )
      const inRoot: unknown[] = await idbRequest(
        db.transaction('items').objectStore('items').index('folderId').getAll(ROOT_FOLDER_ID),
      )

      expect(inFolder).toHaveLength(1)
      expect(inFolder[0]).toMatchObject({ name: 'in folder' })
      expect(inRoot).toHaveLength(2)
    })
  })

  it('answers the type index with every item of one type', async () => {
    await saveItem(textItem({ name: 'note one' }))
    await saveItem(textItem({ name: 'note two' }))
    await saveItem(lockedItem())

    await withRawDatabase(async (db) => {
      const notes: unknown[] = await idbRequest(
        db.transaction('items').objectStore('items').index('type').getAll('text'),
      )
      const locked: unknown[] = await idbRequest(
        db.transaction('items').objectStore('items').index('type').getAll('locked'),
      )

      expect(notes).toHaveLength(2)
      expect(notes.map((note) => (note as { name: string }).name).sort()).toEqual([
        'note one',
        'note two',
      ])
      expect(locked).toHaveLength(1)
      expect(locked[0]).toMatchObject({ type: 'locked', ciphertext: expect.any(Uint8Array) })
    })
  })

  it('answers the updatedAt index with a range query', async () => {
    await saveItem(textItem({ name: 'older', updatedAt: NOW }))
    await saveItem(textItem({ name: 'newer', updatedAt: NOW + 5_000 }))

    await withRawDatabase(async (db) => {
      const recent: unknown[] = await idbRequest(
        db
          .transaction('items')
          .objectStore('items')
          .index('updatedAt')
          .getAll(IDBKeyRange.lowerBound(NOW + 1)),
      )

      expect(recent).toHaveLength(1)
      expect(recent[0]).toMatchObject({ name: 'newer' })
    })
  })

  it('keeps the schema across a reconnect', async () => {
    const folder = await createFolder('Work', null)
    const item = textItem({ folderId: folder.id })
    await saveItem(item)

    await closeLibraryDatabase()

    expect(await getFolders()).toEqual([folder])
    expect(await getItem(item.id)).toEqual(item)
  })
})

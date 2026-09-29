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
  createFile,
  createFolder,
  deleteFile,
  deleteFolder,
  deleteItem,
  getFile,
  getFiles,
  getFilesInFolder,
  getFolders,
  getItem,
  getItemsInFolder,
  isItemCorrupt,
  moveFile,
  moveItem,
  parseFile,
  renameFolder,
  reorderFile,
  ROOT_FOLDER_ID,
  saveFile,
  saveFolder,
  saveFromSession,
  saveItem,
  seedInitialLibrary,
  updateFile,
  updateItem,
  type FileBlock,
  type LibraryFile,
  type LibraryFileItem,
  type LibraryFolder,
  type LibraryImageItem,
  type LibraryItem,
  type LibraryLockedItem,
  type LibraryTextItem,
} from './library'
import { moveIndex, SORT_ORDER_GAP } from './reorder'
import type {
  FileItem,
  ImageItem,
  LockedItem,
  RichTextItem,
  TextItem,
} from '../store/sessionStore'

/** PLAN.md §6.3 names the database; pinning it here catches a rename. */
const DB_NAME = 'qrbit-library'

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

  it('saves a folder under the id it was given, which is what an import needs', async () => {
    // PLAN.md §14's manifest carries folder ids and every item's `folderId`, so a
    // restored folder has to keep its id or its items cannot be saved at all.
    const folder: LibraryFolder = {
      id: 'exported-folder-id',
      name: 'Uni Stuff',
      parentId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }

    await saveFolder(folder)

    expect(await getFolders()).toEqual([folder])
  })

  it('saves a folder under a parent that is already stored, preserving the tree', async () => {
    const parent = await createFolder('Uni', null)
    // Created after its parent, like any folder a user makes — `getFolders` lists
    // oldest first, so this is also what pins the restored order.
    const child: LibraryFolder = {
      id: 'exported-child-id',
      name: 'Thesis',
      parentId: parent.id,
      createdAt: parent.createdAt + 1,
      updatedAt: parent.updatedAt + 1,
    }

    await saveFolder(child)

    expect(await getFolders()).toEqual([parent, child])
  })

  it('writes an unknown parent as the root rather than a dangling reference', async () => {
    // A subset export can name a subfolder without its parent (§14 exports only the
    // chosen folders). A folder whose parent is missing is invisible in the tree, so
    // it lands at the top level, where the user can see it.
    const folder: LibraryFolder = {
      id: 'exported-child-id',
      name: 'Thesis',
      parentId: 'parent-not-in-this-export',
      createdAt: NOW,
      updatedAt: NOW,
    }

    await saveFolder(folder)

    expect(await getFolders()).toEqual([{ ...folder, parentId: null }])
  })

  it('treats the root id as an alias for a null parent, like createFolder', async () => {
    await saveFolder({
      id: 'exported-id',
      name: 'Work',
      parentId: ROOT_FOLDER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    })

    expect((await getFolders())[0]?.parentId).toBeNull()
  })

  it('is a no-op for an id that is already stored, so a re-import changes nothing', async () => {
    const exported: LibraryFolder = {
      id: 'exported-folder-id',
      name: 'Uni Stuff',
      parentId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    await saveFolder(exported)

    await saveFolder({ ...exported, name: 'Renamed by a second import', updatedAt: NOW + 1 })

    expect(await getFolders()).toEqual([exported])
  })

  it('rejects the virtual root and a folder that is not validly shaped', async () => {
    await expect(
      saveFolder({ id: ROOT_FOLDER_ID, name: 'Root', parentId: null, createdAt: NOW, updatedAt: NOW }),
    ).rejects.toThrow(/root folder is virtual/)
    await expect(
      saveFolder({ id: 'exported-id', name: '   ', parentId: null, createdAt: NOW, updatedAt: NOW }),
    ).rejects.toThrow(/non-empty name/)
  })

  it('lets an item be saved into a folder that arrived with it in the same import', async () => {
    const folder: LibraryFolder = {
      id: 'exported-folder-id',
      name: 'Uni Stuff',
      parentId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const item = textItem({ folderId: folder.id, name: 'in the restored folder' })

    await saveFolder(folder)
    await saveItem(item)

    expect(await getItemsInFolder(folder.id)).toEqual([item])
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

  describe('Safari / IndexedDB Blob persistence fallback', () => {
    it('gracefully handles the broken-Safari shape where blob is stored as an empty object', async () => {
      const id = 'safari-broken-blob'
      await saveItem(textItem())
      await withRawDatabase(async (db) => {
        await idbRequest(
          db.transaction('items', 'readwrite').objectStore('items').put({
            id,
            folderId: ROOT_FOLDER_ID,
            name: 'photo.jpg',
            type: 'image',
            createdAt: NOW,
            updatedAt: NOW,
            mimeType: 'image/jpeg',
            size: 4096,
            blob: {}, // Older Safari bug: stored Blob reads back as an empty plain object
          }),
        )
      })

      // Must not throw or crash on single item read
      const item = await getItem(id)
      expect(item).toBeDefined()
      expect(item?.type).toBe('image')
      expect(item?.name).toBe('photo.jpg')
      expect(item?.type === 'image' && item.size).toBe(4096)
      expect(item?.corrupt).toBe(true)
      expect(item?.error).toBe('This item could not be loaded')
      expect(isItemCorrupt(item!)).toBe(true)
      expect((item as LibraryImageItem).blob).toBeInstanceOf(Blob)

      // Must not throw or crash when reading all items in folder
      const folderItems = await getItemsInFolder(ROOT_FOLDER_ID)
      const found = folderItems.find((i) => i.id === id)
      expect(found).toBeDefined()
      expect(found?.corrupt).toBe(true)
      expect(found?.error).toBe('This item could not be loaded')

      // Renaming or moving the broken item still works without crashing
      await updateItem(id, { name: 'photo-renamed.jpg' })
      const updated = await getItem(id)
      expect(updated?.name).toBe('photo-renamed.jpg')
      expect(updated?.corrupt).toBe(true)
    })

    it('surfaces an error state when stored blob size disagrees with recorded size', async () => {
      const id = 'truncated-blob-item'
      await saveItem(textItem())
      await withRawDatabase(async (db) => {
        await idbRequest(
          db.transaction('items', 'readwrite').objectStore('items').put({
            id,
            folderId: ROOT_FOLDER_ID,
            name: 'document.pdf',
            type: 'file',
            createdAt: NOW,
            updatedAt: NOW,
            mimeType: 'application/pdf',
            size: 5000,
            blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }), // 3 bytes vs 5000 declared
          }),
        )
      })

      const item = await getItem(id)
      expect(item).toBeDefined()
      expect(item?.type).toBe('file')
      expect(item?.corrupt).toBe(true)
      expect(item?.error).toBe('This item could not be loaded')
      expect(item?.type === 'file' && item.size).toBe(5000)
    })

    it('surfaces an error state when blob field is missing or null', async () => {
      const id = 'missing-blob-item'
      await saveItem(textItem())
      await withRawDatabase(async (db) => {
        await idbRequest(
          db.transaction('items', 'readwrite').objectStore('items').put({
            id,
            folderId: ROOT_FOLDER_ID,
            name: 'missing.png',
            type: 'image',
            createdAt: NOW,
            updatedAt: NOW,
            mimeType: 'image/png',
            size: 1024,
            blob: null,
          }),
        )
      })

      const item = await getItem(id)
      expect(item).toBeDefined()
      expect(item?.corrupt).toBe(true)
      expect(item?.error).toBe('This item could not be loaded')
      expect((item as LibraryImageItem).blob).toBeInstanceOf(Blob)
    })

    it('parses older rows stored without a size field for backward compatibility', async () => {
      const id = 'older-row-without-size'
      const testBytes = bytes(48)
      await saveItem(textItem())
      await withRawDatabase(async (db) => {
        await idbRequest(
          db.transaction('items', 'readwrite').objectStore('items').put({
            id,
            folderId: ROOT_FOLDER_ID,
            name: 'legacy.png',
            type: 'image',
            createdAt: NOW,
            updatedAt: NOW,
            mimeType: 'image/png',
            blob: new Blob([testBytes], { type: 'image/png' }),
            // No size field stored in older schema
          }),
        )
      })

      const item = (await getItem(id)) as LibraryImageItem
      expect(item).toBeDefined()
      expect(item.corrupt).toBeUndefined()
      expect(item.error).toBeUndefined()
      expect(item.size).toBe(48)
      expect(new Uint8Array(await item.blob.arrayBuffer())).toEqual(testBytes)
    })
  })
})

describe('schema and indexes (PLAN.md §6.3)', () => {
  it('creates the folders and items stores with their keys and indexes', async () => {
    await getFolders()

    await withRawDatabase(async (db) => {
      expect(Array.from(db.objectStoreNames).sort()).toEqual(['files', 'folders', 'items'])

      const folders = db.transaction('folders').objectStore('folders')
      expect(folders.keyPath).toBe('id')

      const items = db.transaction('items').objectStore('items')
      expect(items.keyPath).toBe('id')
      expect(Array.from(items.indexNames).sort()).toEqual(['folderId', 'type', 'updatedAt'])
      expect(items.index('folderId').keyPath).toBe('folderId')
      expect(items.index('type').keyPath).toBe('type')
      expect(items.index('updatedAt').keyPath).toBe('updatedAt')

      const files = db.transaction('files').objectStore('files')
      expect(files.keyPath).toBe('id')
      expect(Array.from(files.indexNames).sort()).toEqual(['folderId', 'updatedAt'])
      expect(files.index('folderId').keyPath).toBe('folderId')
      expect(files.index('updatedAt').keyPath).toBe('updatedAt')
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

describe('files and blocks (dossier system)', () => {
  it('creates, saves, retrieves, and lists files in folders', async () => {
    const folder = await createFolder('Lab Dossiers', null)
    const blocks: FileBlock[] = [
      { id: 'b-1', type: 'heading', content: 'Cluster Alpha' },
      { id: 'b-2', type: 'shortText', label: 'Host', value: '10.0.0.1' },
      {
        id: 'b-3',
        type: 'locked',
        label: 'Secret',
        content: 'mypass',
        isLocked: true,
        password: 'pass',
      },
    ]

    const file = await createFile('Lab Config', folder.id, blocks)
    expect(file.id).toBeDefined()
    expect(file.name).toBe('Lab Config')
    expect(file.blocks).toHaveLength(3)

    const fetched = await getFile(file.id)
    expect(fetched).toBeDefined()
    expect(fetched?.name).toBe('Lab Config')
    expect(fetched?.blocks).toEqual(blocks)

    const inFolder = await getFilesInFolder(folder.id)
    expect(inFolder).toHaveLength(1)
    expect(inFolder[0]?.id).toBe(file.id)

    const allFiles = await getFiles()
    expect(allFiles).toHaveLength(1)
  })

  it('updates a file with patched blocks or name', async () => {
    const folder = await createFolder('Docs', null)
    const file = await createFile('Initial Title', folder.id, [
      { id: 'b-1', type: 'heading', content: 'Heading 1' },
    ])

    await updateFile(file.id, {
      name: 'Renamed Title',
      blocks: [
        { id: 'b-1', type: 'heading', content: 'Updated Heading' },
        { id: 'b-2', type: 'divider' },
      ],
    })

    const updated = await getFile(file.id)
    expect(updated?.name).toBe('Renamed Title')
    expect(updated?.blocks).toHaveLength(2)
    expect(updated?.blocks[0]?.content).toBe('Updated Heading')
  })

  it('moves a file to another folder and deletes a file', async () => {
    const folderA = await createFolder('Folder A', null)
    const folderB = await createFolder('Folder B', null)

    const file = await createFile('My Doc', folderA.id)
    expect((await getFilesInFolder(folderA.id))).toHaveLength(1)
    expect((await getFilesInFolder(folderB.id))).toHaveLength(0)

    await moveFile(file.id, folderB.id)
    expect((await getFilesInFolder(folderA.id))).toHaveLength(0)
    expect((await getFilesInFolder(folderB.id))).toHaveLength(1)

    await deleteFile(file.id)
    expect((await getFilesInFolder(folderB.id))).toHaveLength(0)
    expect(await getFile(file.id)).toBeUndefined()
  })

  it('cascade deletes files when their parent folder is deleted', async () => {
    const folder = await createFolder('Doomed Folder', null)
    const file1 = await createFile('Doc 1', folder.id)
    const file2 = await createFile('Doc 2', folder.id)

    expect((await getFilesInFolder(folder.id))).toHaveLength(2)

    await deleteFolder(folder.id)

    expect(await getFile(file1.id)).toBeUndefined()
    expect(await getFile(file2.id)).toBeUndefined()
    expect((await getFiles())).toHaveLength(0)
  })

  it('seeds initial folders and files when library is empty', async () => {
    expect((await getFolders())).toHaveLength(0)
    expect((await getFiles())).toHaveLength(0)

    await seedInitialLibrary()

    const folders = await getFolders()
    const files = await getFiles()

    expect(folders.length).toBeGreaterThanOrEqual(3)
    expect(files.length).toBeGreaterThanOrEqual(4)
    expect(files.some((f) => f.name === 'Uni Credentials & Keys')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// File ordering — `sortOrder`, `reorderFile`, and where `moveFile` lands
// (ORCHESTRATION D16.1 / D16.3)
// ---------------------------------------------------------------------------

/** A dossier with only the fields the ordering tests care about filled in. */
function dossier(overrides: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id: globalThis.crypto.randomUUID(),
    folderId: ROOT_FOLDER_ID,
    name: 'dossier',
    createdAt: NOW,
    updatedAt: NOW,
    blocks: [{ id: 'b-1', type: 'heading', content: 'Heading' }],
    ...overrides,
  }
}

async function saveDossier(overrides: Partial<LibraryFile>): Promise<LibraryFile> {
  const file = dossier(overrides)
  await saveFile(file)
  return file
}

/** The ids a folder reads back in, in read order — what every assertion below is about. */
async function idsIn(folderId: string): Promise<string[]> {
  return (await getFilesInFolder(folderId)).map((file) => file.id)
}

describe('file ordering (sortOrder, ORCHESTRATION D16)', () => {
  it('reads files by sortOrder ascending', async () => {
    const folder = await createFolder('Ordered', null)
    await saveDossier({ id: 'c-3', folderId: folder.id, sortOrder: 3000 })
    await saveDossier({ id: 'c-1', folderId: folder.id, sortOrder: 1000, createdAt: NOW + 5 })
    await saveDossier({ id: 'c-2', folderId: folder.id, sortOrder: 2000, createdAt: NOW + 9 })

    expect(await idsIn(folder.id)).toEqual(['c-1', 'c-2', 'c-3'])
    expect((await getFiles()).map((file) => file.id)).toEqual(['c-1', 'c-2', 'c-3'])
  })

  it('reads an unordered library oldest-first, and the same way every time', async () => {
    const folder = await createFolder('Legacy', null)
    // Written out of order on purpose: insertion order is not the read order.
    await saveDossier({ id: 'u-2', folderId: folder.id, createdAt: NOW + 10 })
    await saveDossier({ id: 'u-1', folderId: folder.id, createdAt: NOW })
    await saveDossier({ id: 'u-3', folderId: folder.id, createdAt: NOW + 20 })

    const first = await idsIn(folder.id)
    expect(first).toEqual(['u-1', 'u-2', 'u-3'])
    expect(await idsIn(folder.id)).toEqual(first)
    expect(await idsIn(folder.id)).toEqual(first)
  })

  it('splits an equal sortOrder by createdAt, then by id', async () => {
    const folder = await createFolder('Tied', null)
    await saveDossier({ id: 'x-2', folderId: folder.id, sortOrder: 1000, createdAt: NOW + 5 })
    await saveDossier({ id: 'x-1', folderId: folder.id, sortOrder: 1000, createdAt: NOW + 5 })
    await saveDossier({ id: 'x-3', folderId: folder.id, sortOrder: 1000, createdAt: NOW + 1 })

    expect(await idsIn(folder.id)).toEqual(['x-3', 'x-1', 'x-2'])
  })

  it('reads a file with no sortOrder after every file that has one', async () => {
    const folder = await createFolder('Mixed', null)
    // Older than the ordered rows, and still last: an unscored row is "not ordered yet",
    // which is what puts a freshly created dossier at the end of its folder.
    await saveDossier({ id: 'v-old', folderId: folder.id, createdAt: NOW - 10_000 })
    await saveDossier({ id: 'v-scored', folderId: folder.id, createdAt: NOW, sortOrder: 1000 })

    expect(await idsIn(folder.id)).toEqual(['v-scored', 'v-old'])
  })

  it('never orders by updatedAt, so a rename cannot teleport a row', async () => {
    const folder = await createFolder('Renamed', null)
    await saveDossier({ id: 'q-1', folderId: folder.id, sortOrder: 1000 })
    await saveDossier({ id: 'q-2', folderId: folder.id, sortOrder: 2000 })

    await updateFile('q-2', { name: 'Edited last, still last' })
    expect(await idsIn(folder.id)).toEqual(['q-1', 'q-2'])

    await updateFile('q-1', { name: 'Edited first, still first' })
    expect(await idsIn(folder.id)).toEqual(['q-1', 'q-2'])

    // Same again with nothing ordered at all (the createdAt tiebreak, not an edit stamp).
    const legacy = await createFolder('Legacy rename', null)
    await saveDossier({ id: 'w-1', folderId: legacy.id, createdAt: NOW })
    await saveDossier({ id: 'w-2', folderId: legacy.id, createdAt: NOW + 1 })
    await updateFile('w-2', { name: 'Touched' })
    expect(await idsIn(legacy.id)).toEqual(['w-1', 'w-2'])
  })

  it('validates sortOrder on the record and drops it when a whole file is rewritten without one', async () => {
    const folder = await createFolder('Parse', null)

    expect(parseFile(dossier({ folderId: folder.id, sortOrder: 7 })).sortOrder).toBe(7)
    expect(parseFile(dossier({ folderId: folder.id })).sortOrder).toBeUndefined()
    // A stored `null` (a hand-written record meaning "absent") is not garbage.
    expect(parseFile({ ...dossier({ folderId: folder.id }), sortOrder: null }).sortOrder).toBeUndefined()

    for (const bad of ['1000', Number.NaN, 1.5, Number.POSITIVE_INFINITY, -0.5, {}, true, []]) {
      expect(() => parseFile({ ...dossier({ folderId: folder.id }), sortOrder: bad })).toThrow(
        /library: a file needs an integer "sortOrder"/,
      )
    }

    // Negative positions are storable: a row dragged above a run that starts at 0 pushes
    // it down, and the run is only rewritten when that would leave the safe range.
    expect(parseFile(dossier({ folderId: folder.id, sortOrder: -1000 })).sortOrder).toBe(-1000)

    await saveDossier({ id: 'p-1', folderId: folder.id, sortOrder: 1500 })
    expect((await getFile('p-1'))?.sortOrder).toBe(1500)

    // A partial update keeps the position; a whole-file write is the caller's position.
    await updateFile('p-1', { name: 'Renamed' })
    expect((await getFile('p-1'))?.sortOrder).toBe(1500)
    await updateFile('p-1', { sortOrder: 300 })
    expect((await getFile('p-1'))?.sortOrder).toBe(300)
    await saveFile(dossier({ id: 'p-1', folderId: folder.id }))
    expect((await getFile('p-1'))?.sortOrder).toBeUndefined()
  })

  it('lands exactly where moveIndex says it should, in both directions', async () => {
    const folder = await createFolder('Run', null)
    let current = ['r-1', 'r-2', 'r-3', 'r-4']
    for (const [position, id] of current.entries()) {
      await saveDossier({ id, folderId: folder.id, sortOrder: (position + 1) * SORT_ORDER_GAP })
    }

    // `reorderFile`'s `targetIndex` and `moveIndex`'s `to` are the same number, which is
    // the whole point of one shared convention: the index the row ends up at.
    const moves: ReadonlyArray<readonly [string, number]> = [
      ['r-1', 3],
      ['r-4', 0],
      ['r-2', 2],
      ['r-3', 3],
      ['r-1', 1],
      ['r-2', 0],
    ]
    for (const [id, to] of moves) {
      const from = current.indexOf(id)
      await reorderFile(id, to, folder.id)
      current = moveIndex(current, from, to)
      expect(await idsIn(folder.id)).toEqual(current)
    }
  })

  it('rewrites only the moved record once the folder is ordered', async () => {
    const folder = await createFolder('Single write', null)
    await saveDossier({ id: 'a', folderId: folder.id, sortOrder: 1000, updatedAt: 111 })
    await saveDossier({ id: 'b', folderId: folder.id, sortOrder: 2000, updatedAt: 222 })
    await saveDossier({ id: 'c', folderId: folder.id, sortOrder: 3000, updatedAt: 333 })

    await reorderFile('c', 0, folder.id)

    const after = await getFilesInFolder(folder.id)
    expect(after.map((file) => file.id)).toEqual(['c', 'a', 'b'])
    expect(after.map((file) => file.sortOrder)).toEqual([0, 1000, 2000])
    // The two neighbours were neither rewritten nor restamped.
    expect(after.find((file) => file.id === 'a')).toEqual(
      expect.objectContaining({ sortOrder: 1000, updatedAt: 111 }),
    )
    expect(after.find((file) => file.id === 'b')).toEqual(
      expect.objectContaining({ sortOrder: 2000, updatedAt: 222 }),
    )
  })

  it('does not restamp updatedAt for a reorder', async () => {
    const folder = await createFolder('Stamped', null)
    await saveDossier({ id: 's-1', folderId: folder.id, sortOrder: 1000, updatedAt: 42 })
    await saveDossier({ id: 's-2', folderId: folder.id, sortOrder: 2000, updatedAt: 43 })

    await reorderFile('s-2', 0, folder.id)

    const moved = await getFile('s-2')
    expect(moved?.updatedAt).toBe(43)
    expect(moved?.sortOrder).toBe(0)
  })

  it('gives the whole run a position on the first reorder of an unordered folder', async () => {
    const folder = await createFolder('Legacy', null)
    await saveDossier({ id: 'l-1', folderId: folder.id, createdAt: NOW })
    await saveDossier({ id: 'l-2', folderId: folder.id, createdAt: NOW + 1 })
    await saveDossier({ id: 'l-3', folderId: folder.id, createdAt: NOW + 2 })

    await reorderFile('l-3', 0)

    const after = await getFilesInFolder(folder.id)
    expect(after.map((file) => file.id)).toEqual(['l-3', 'l-1', 'l-2'])
    expect(after.map((file) => file.sortOrder)).toEqual([
      SORT_ORDER_GAP,
      2 * SORT_ORDER_GAP,
      3 * SORT_ORDER_GAP,
    ])
  })

  it('renumbers the run when the gap around the target index has collapsed', async () => {
    const folder = await createFolder('Tight', null)
    await saveDossier({ id: 't-1', folderId: folder.id, sortOrder: 1000, createdAt: NOW })
    await saveDossier({ id: 't-2', folderId: folder.id, sortOrder: 1001, createdAt: NOW + 1 })
    await saveDossier({ id: 't-3', folderId: folder.id, sortOrder: 1002, createdAt: NOW + 2 })

    await reorderFile('t-1', 1)

    const after = await getFilesInFolder(folder.id)
    expect(after.map((file) => file.id)).toEqual(['t-2', 't-1', 't-3'])
    expect(after.map((file) => file.sortOrder)).toEqual([1000, 2000, 3000])
  })

  it('repairs duplicated positions by renumbering rather than writing another duplicate', async () => {
    const folder = await createFolder('Duplicated', null)
    await saveDossier({ id: 'd-1', folderId: folder.id, sortOrder: 1000, createdAt: NOW })
    await saveDossier({ id: 'd-2', folderId: folder.id, sortOrder: 1000, createdAt: NOW + 1 })
    await saveDossier({ id: 'd-3', folderId: folder.id, sortOrder: 2000, createdAt: NOW + 2 })

    // `d-3` cannot be inserted between two rows that share a position.
    await reorderFile('d-3', 1, folder.id)

    const after = await getFilesInFolder(folder.id)
    expect(after.map((file) => file.id)).toEqual(['d-1', 'd-3', 'd-2'])
    expect(after.map((file) => file.sortOrder)).toEqual([1000, 2000, 3000])
  })

  it('writes nothing when the row is dropped back where it was', async () => {
    const folder = await createFolder('No-op', null)
    await saveDossier({ id: 'n-1', folderId: folder.id, createdAt: NOW })
    await saveDossier({ id: 'n-2', folderId: folder.id, createdAt: NOW + 1 })

    await reorderFile('n-1', 0, folder.id)

    const after = await getFilesInFolder(folder.id)
    expect(after.map((file) => file.id)).toEqual(['n-1', 'n-2'])
    // No materialised positions either: the folder is exactly as it was.
    expect(after.map((file) => file.sortOrder)).toEqual([undefined, undefined])
  })

  it('keeps a file and its blocks intact through a renumber', async () => {
    const folder = await createFolder('Blocks', null)
    const other = await createFolder('Blocks other', null)
    const blocks: FileBlock[] = [
      { id: 'b-1', type: 'locked', label: 'Key', content: 'secret', isLocked: true, password: 'pass' },
      { id: 'b-2', type: 'shortText', label: 'Host', value: '10.0.0.1' },
      { id: 'b-3', type: 'divider' },
    ]
    await saveDossier({ id: 'k-1', folderId: folder.id, blocks, createdAt: NOW })
    await saveDossier({ id: 'k-2', folderId: folder.id, createdAt: NOW + 1 })
    await saveDossier({ id: 'k-3', folderId: other.id, createdAt: NOW + 2 })

    const before = await getFile('k-1')
    await reorderFile('k-1', 1, folder.id)

    expect((await getFile('k-1'))?.blocks).toEqual(before?.blocks)
    expect(await idsIn(folder.id)).toEqual(['k-2', 'k-1'])
    // Another folder is untouched by this reorder.
    expect(await idsIn(other.id)).toEqual(['k-3'])
  })

  it('reorders files in the virtual root folder', async () => {
    await saveDossier({ id: 'root-1', folderId: ROOT_FOLDER_ID, sortOrder: 1000 })
    await saveDossier({ id: 'root-2', folderId: ROOT_FOLDER_ID, sortOrder: 2000 })

    await reorderFile('root-2', 0, ROOT_FOLDER_ID)

    expect(await idsIn(ROOT_FOLDER_ID)).toEqual(['root-2', 'root-1'])
  })

  it('refuses an id, an index, or a folder it was not given', async () => {
    const folder = await createFolder('Guard', null)
    const other = await createFolder('Other', null)
    await saveDossier({ id: 'g-1', folderId: folder.id })
    await saveDossier({ id: 'g-2', folderId: folder.id })

    await expect(reorderFile('g-1', 2, folder.id)).rejects.toThrow(/out of range for 2 files/)
    await expect(reorderFile('g-1', 5)).rejects.toThrow(/out of range for 2 files/)
    await expect(reorderFile('g-1', -1)).rejects.toThrow(/non-negative integer index/)
    await expect(reorderFile('g-1', 1.5)).rejects.toThrow(/non-negative integer index/)
    await expect(reorderFile('g-1', Number.NaN)).rejects.toThrow(/non-negative integer index/)
    await expect(reorderFile('missing', 0)).rejects.toThrow(/library: no file with id "missing"/)
    await expect(reorderFile('', 0)).rejects.toThrow(/library: reorderFile needs a non-empty id/)
    await expect(reorderFile('g-1', 0, '  ')).rejects.toThrow(/non-empty id/)
    await expect(reorderFile('g-1', 0, other.id)).rejects.toThrow(/was given folder/)

    // A rejected reorder leaves the folder alone.
    expect(await idsIn(folder.id)).toEqual(['g-1', 'g-2'])
  })
})

describe('moveFile lands a file at the end (ORCHESTRATION D16)', () => {
  it('appends to a folder that is already ordered, leaving its rows alone', async () => {
    const source = await createFolder('From', null)
    const destination = await createFolder('To', null)
    await saveDossier({ id: 'f-1', folderId: destination.id, sortOrder: 1000, updatedAt: 111 })
    await saveDossier({ id: 'f-2', folderId: destination.id, sortOrder: 2000, updatedAt: 222 })
    await saveDossier({ id: 'f-3', folderId: source.id, sortOrder: 5000 })

    await moveFile('f-3', destination.id)

    const after = await getFilesInFolder(destination.id)
    expect(after.map((file) => file.id)).toEqual(['f-1', 'f-2', 'f-3'])
    expect(after.map((file) => file.sortOrder)).toEqual([1000, 2000, 3000])
    expect(after.find((file) => file.id === 'f-1')).toEqual(
      expect.objectContaining({ sortOrder: 1000, updatedAt: 111 }),
    )
    expect(await idsIn(source.id)).toEqual([])
  })

  it('renumbers an unordered destination so a moved file cannot jump to its top', async () => {
    const source = await createFolder('From', null)
    const destination = await createFolder('To', null)
    await saveDossier({ id: 'h-1', folderId: destination.id, createdAt: NOW })
    await saveDossier({ id: 'h-2', folderId: destination.id, createdAt: NOW + 1 })
    // An ordered row moving into an unordered folder: its old position would sort it above
    // both of them, so the destination run is materialised with the move last.
    await saveDossier({ id: 'h-3', folderId: source.id, sortOrder: 1000 })

    await moveFile('h-3', destination.id)

    const after = await getFilesInFolder(destination.id)
    expect(after.map((file) => file.id)).toEqual(['h-1', 'h-2', 'h-3'])
    expect(after.map((file) => file.sortOrder)).toEqual([1000, 2000, 3000])
  })

  it('gives a file moved into an empty folder the first gap', async () => {
    const source = await createFolder('From', null)
    const destination = await createFolder('Empty', null)
    await saveDossier({ id: 'z-1', folderId: source.id, sortOrder: 700 })

    await moveFile('z-1', destination.id)

    expect((await getFile('z-1'))?.sortOrder).toBe(SORT_ORDER_GAP)
    expect(await idsIn(destination.id)).toEqual(['z-1'])
  })

  it('appends to the root, and leaves the rest of the source folder in order', async () => {
    const source = await createFolder('From', null)
    await saveDossier({ id: 'y-1', folderId: source.id, sortOrder: 1000, createdAt: NOW })
    await saveDossier({ id: 'y-2', folderId: source.id, sortOrder: 2000, createdAt: NOW + 1 })
    await saveDossier({ id: 'y-3', folderId: source.id, sortOrder: 3000, createdAt: NOW + 2 })
    await saveDossier({ id: 'y-0', folderId: ROOT_FOLDER_ID, sortOrder: 1000 })

    await moveFile('y-2', ROOT_FOLDER_ID)

    expect(await idsIn(source.id)).toEqual(['y-1', 'y-3'])
    expect(await idsIn(ROOT_FOLDER_ID)).toEqual(['y-0', 'y-2'])
    expect((await getFile('y-2'))?.folderId).toBe(ROOT_FOLDER_ID)
  })
})

describe('a new file has no sortOrder, which reads as the end of its folder', () => {
  it('leaves the field absent and lands last', async () => {
    const folder = await createFolder('Fresh', null)
    await saveDossier({ id: 'n-first', folderId: folder.id, sortOrder: 1000 })
    await saveDossier({ id: 'n-second', folderId: folder.id, sortOrder: 2000 })

    const created = await createFile('Fresh dossier', folder.id)

    expect(created.sortOrder).toBeUndefined()
    expect(await idsIn(folder.id)).toEqual(['n-first', 'n-second', created.id])

    // Once it is dragged, it gets a position like any other row.
    await reorderFile(created.id, 0, folder.id)
    expect((await getFile(created.id))?.sortOrder).toBeDefined()
    expect(await idsIn(folder.id)).toEqual([created.id, 'n-first', 'n-second'])
  })
})


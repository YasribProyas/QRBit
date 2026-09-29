/**
 * Tests for the library store (PLAN.md §6, §16 Phase 5).
 *
 * `fake-indexeddb` stands in for the browser, so this file runs in the default node
 * environment. Each test starts from an EMPTY database: the library layer's cached
 * connection is closed and the database deleted in `beforeEach`, and the store is
 * reset to its initial state — per-test isolation without an injectable factory.
 *
 * What is pinned here:
 *
 *   - the round-trips of every action, asserted against IndexedDB itself rather than
 *     against the store's own copy, so "no stale copies" is checked and not assumed;
 *   - the cascade delete (PLAN.md §6.3), which is the one mutation whose result the
 *     store cannot compute locally;
 *   - that a locked item is stored as its ciphertext tuple only, with no plaintext in the
 *     stored row (PLAN.md §6.2, §19.3) — moved here from the deleted `NewItemBar` tests so
 *     removing that UI could not remove the guarantee with it;
 *   - error surfacing: a failure lands in `error` AND rejects, and the next successful
 *     action clears it;
 *   - the boundary: `refresh` reads and never writes, and no action of the store is
 *     reachable except through an explicit call.
 */

import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closeLibraryDatabase,
  getFolders,
  getItem,
  getItemsInFolder,
  createFolder as createFolderInLibrary,
  ROOT_FOLDER_ID,
  saveItem as saveItemInLibrary,
} from '../lib/library'
import type {
  LibraryFileItem,
  LibraryItem,
  LibraryLockedItem,
  LibraryTextItem,
} from '../lib/library'
import { decryptItem, encryptItem } from '../lib/crypto'
import { useLibraryStore } from './libraryStore'
import type { SessionItem } from './sessionStore'

const DB_NAME = 'qrbit-library'
const NOW = 1_700_000_000_000

/** Deterministic bytes, so a byte-identical comparison means something. */
function bytes(length: number): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(new ArrayBuffer(length))
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * 37 + 11) % 256
  }
  return value
}

async function freshDatabase(): Promise<void> {
  await closeLibraryDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'))
  })
}

beforeEach(async () => {
  useLibraryStore.setState({
    folders: [],
    items: [],
    loading: false,
    error: null,
  })
  await freshDatabase()
})

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

function fileItem(overrides: Partial<LibraryFileItem> = {}): LibraryFileItem {
  const blob = new Blob([bytes(32)], { type: 'application/octet-stream' })
  return {
    id: globalThis.crypto.randomUUID(),
    folderId: ROOT_FOLDER_ID,
    name: 'notes.bin',
    type: 'file',
    createdAt: NOW,
    updatedAt: NOW,
    blob,
    mimeType: 'application/octet-stream',
    size: blob.size,
    ...overrides,
  }
}

const store = () => useLibraryStore.getState()

describe('libraryStore refresh (PLAN.md §6.3)', () => {
  it('loads folders and every item, whichever folder they are in', async () => {
    const folder = await createFolderInLibrary('Uni Stuff', null)
    await saveItemInLibrary(textItem({ folderId: folder.id, name: 'Portal password' }))
    await saveItemInLibrary(textItem({ folderId: ROOT_FOLDER_ID, name: 'Loose note' }))

    await store().refresh()

    expect(store().loading).toBe(false)
    expect(store().error).toBe(null)
    expect(store().folders.map((entry) => entry.name)).toEqual(['Uni Stuff'])
    expect(store().items.map((item) => item.name).sort()).toEqual(['Loose note', 'Portal password'])
  })

  it('is empty, not stale, when the database is empty', async () => {
    await store().refresh()

    expect(store().folders).toEqual([])
    expect(store().items).toEqual([])
    expect(store().error).toBe(null)
  })

  it('never writes: a refresh is reads only', async () => {
    await saveItemInLibrary(textItem())
    await createFolderInLibrary('Work', null)

    const put = vi.spyOn(IDBObjectStore.prototype, 'put')
    const add = vi.spyOn(IDBObjectStore.prototype, 'add')
    const remove = vi.spyOn(IDBObjectStore.prototype, 'delete')

    await store().refresh()

    expect(put).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('libraryStore folders (PLAN.md §6.3)', () => {
  it('creates a folder, returns it and shows it without a manual refresh', async () => {
    const folder = await store().createFolder('Uni Stuff', null)

    expect(folder.name).toBe('Uni Stuff')
    expect(folder.parentId).toBe(null)
    expect(store().folders.map((entry) => entry.id)).toEqual([folder.id])
    // The store's copy is the stored row, not a locally-built one.
    expect(await getFolders()).toEqual([folder])
  })

  it('creates a nested folder through the id the UI passes for Root', async () => {
    const parent = await createFolderInLibrary('Uni Stuff', null)
    const child = await store().createFolder('Thesis', parent.id)

    expect(child.parentId).toBe(parent.id)
    expect(store().folders.map((entry) => entry.name).sort()).toEqual(['Thesis', 'Uni Stuff'])
  })

  it('renames a folder in the store and in IndexedDB', async () => {
    const folder = await store().createFolder('Uni Stuff', null)

    await store().renameFolder(folder.id, 'University')

    expect(store().folders).toEqual([{ ...folder, name: 'University', updatedAt: expect.any(Number) }])
    expect((await getFolders())[0]?.name).toBe('University')
  })

  it('surfaces a rename of a folder that does not exist', async () => {
    await expect(store().renameFolder('missing', 'Nope')).rejects.toThrow(/no folder/)

    expect(store().error).toMatch(/no folder/)
  })

  it('refuses to delete the root', async () => {
    await expect(store().deleteFolder(ROOT_FOLDER_ID)).rejects.toThrow(/root folder/)

    expect(store().error).toMatch(/root folder/)
  })
})

describe('libraryStore delete cascade (PLAN.md §6.3)', () => {
  it('removes the folder, its subfolders and every item inside them', async () => {
    const doomed = await store().createFolder('Uni Stuff', null)
    const child = await store().createFolder('Thesis', doomed.id)
    const kept = await store().createFolder('Work', null)
    await store().refresh()

    await store().saveItem(textItem({ folderId: doomed.id, name: 'Portal' }))
    await store().saveItem(textItem({ folderId: child.id, name: 'Draft' }))
    await store().saveItem(textItem({ folderId: kept.id, name: 'SSH keys' }))
    await store().saveItem(textItem({ folderId: ROOT_FOLDER_ID, name: 'Loose' }))

    await store().deleteFolder(doomed.id)

    expect(store().folders.map((entry) => entry.name)).toEqual(['Work'])
    expect(store().items.map((item) => item.name).sort()).toEqual(['Loose', 'SSH keys'])
    // The store's copy matches what IndexedDB really did.
    expect(await getFolders()).toHaveLength(1)
    expect(await getItemsInFolder(doomed.id)).toEqual([])
    expect(await getItemsInFolder(child.id)).toEqual([])
  })
})

describe('libraryStore items (PLAN.md §6.3)', () => {
  it('saves a new item and re-reads it into the store', async () => {
    const item = textItem({ name: 'Password' })

    await store().saveItem(item)

    expect(store().items).toEqual([item])
    expect(await getItem(item.id)).toEqual(item)
  })

  /*
   * Moved here from `NewItemBar.test.tsx` when that offline-creation bar was deleted
   * (ORCHESTRATION D16.4). The bar was only the UI that reached this write; the contract
   * belongs to the store and `lib/library.ts`, and it is the one worth keeping: a locked
   * item lands in IndexedDB as the `{ ciphertext, iv, salt }` tuple and its plaintext
   * label ONLY — never the secret itself (PLAN.md §6.2, §19.3) — and that tuple still
   * decrypts with the password that was typed. Deleting the component must not be allowed
   * to quietly delete this guarantee with it.
   */
  it('stores a locked item as the ciphertext tuple alone, with the plaintext provably absent', async () => {
    const SECRET_TEXT = 'extremely-sensitive-credential-9988'
    const PASSWORD = 'correct-horse-battery-staple'
    const folder = await store().createFolder('Secrets', null)
    const tuple = await encryptItem(PASSWORD, new TextEncoder().encode(SECRET_TEXT))

    const item: LibraryLockedItem = {
      id: globalThis.crypto.randomUUID(),
      folderId: folder.id,
      name: 'Server Credentials',
      type: 'locked',
      createdAt: NOW,
      updatedAt: NOW,
      label: 'Server Credentials',
      innerType: 'text',
      ciphertext: tuple.ciphertext,
      iv: tuple.iv,
      salt: tuple.salt,
    }
    await store().saveItem(item)

    // Read the row back out of IndexedDB itself, not out of the store's copy.
    await closeLibraryDatabase()
    const stored = await getItem(item.id)
    if (stored?.type !== 'locked') throw new Error('test bug: the stored item is not locked')

    expect(stored.label).toBe('Server Credentials')
    expect(stored.innerType).toBe('text')
    expect(stored.ciphertext).toBeInstanceOf(Uint8Array)
    expect(stored.iv).toBeInstanceOf(Uint8Array)
    expect(stored.iv.byteLength).toBe(12)
    expect(stored.salt).toBeInstanceOf(Uint8Array)
    expect(stored.salt.byteLength).toBe(16)

    // The plaintext is provably absent from the stored row (§6.2, §19.3).
    expect(JSON.stringify(stored)).not.toContain(SECRET_TEXT)
    expect(Object.keys(stored).sort()).toEqual([
      'ciphertext',
      'createdAt',
      'folderId',
      'id',
      'innerType',
      'iv',
      'label',
      'name',
      'salt',
      'type',
      'updatedAt',
    ])
    const secretBytes = new TextEncoder().encode(SECRET_TEXT)
    expect(Array.from(stored.ciphertext.slice(0, secretBytes.byteLength))).not.toEqual(
      Array.from(secretBytes),
    )

    const decrypted = await decryptItem(PASSWORD, stored.salt, stored.iv, stored.ciphertext)
    expect(new TextDecoder().decode(decrypted)).toBe(SECRET_TEXT)
  })

  it('overwrites by id instead of duplicating', async () => {
    const item = textItem({ name: 'Note', content: 'first' })
    await store().saveItem(item)

    const updated: LibraryItem = { ...item, content: 'second', updatedAt: NOW + 1 }
    await store().saveItem(updated)

    expect(store().items).toHaveLength(1)
    expect(store().items[0]).toMatchObject({ id: item.id, content: 'second' })
    expect(await getItem(item.id)).toMatchObject({ content: 'second' })
  })

  it('refuses an item whose folder does not exist, and stores nothing', async () => {
    await expect(store().saveItem(textItem({ folderId: 'not-a-folder' }))).rejects.toThrow(
      /no folder/,
    )

    expect(store().error).toMatch(/no folder/)
    expect(store().items).toEqual([])
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toEqual([])
  })

  it('renames an item through the layer’s update, keeping its type fields', async () => {
    const item = fileItem()
    await store().saveItem(item)

    await store().renameItem(item.id, 'Archive')

    const stored = await getItem(item.id)
    if (stored?.type !== 'file') throw new Error('test bug: the stored item is not a file')
    expect(stored.name).toBe('Archive')
    expect(stored.mimeType).toBe(item.mimeType)
    expect(stored.blob.size).toBe(item.blob.size)
    expect(store().items[0]?.name).toBe('Archive')
  })

  it('deletes an item from the store and IndexedDB', async () => {
    const item = textItem()
    await store().saveItem(item)

    await store().deleteItem(item.id)

    expect(store().items).toEqual([])
    expect(await getItem(item.id)).toBeUndefined()
  })

  it('moves an item to a folder, and back to the root with null', async () => {
    const folder = await store().createFolder('Uni Stuff', null)
    const item = textItem()
    await store().saveItem(item)

    await store().moveItem(item.id, folder.id)
    expect(store().items[0]?.folderId).toBe(folder.id)

    // `null` is the tree's Root in the UI; the store owns the library layer's sentinel id.
    await store().moveItem(item.id, null)
    expect(store().items[0]?.folderId).toBe(ROOT_FOLDER_ID)
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(1)
  })

  it('reports the items of one folder and nothing else', async () => {
    const folder = await store().createFolder('Work', null)
    const inside = textItem({ folderId: folder.id })
    const atRoot = textItem({ folderId: ROOT_FOLDER_ID })
    await store().saveItem(inside)
    await store().saveItem(atRoot)

    expect(store().itemsIn(folder.id).map((item) => item.id)).toEqual([inside.id])
    expect(store().itemsIn(ROOT_FOLDER_ID).map((item) => item.id)).toEqual([atRoot.id])
    expect(store().itemsIn('nowhere')).toEqual([])
  })
})

describe('libraryStore error surfacing (PLAN.md §17)', () => {
  it('clears the previous failure on the next successful action', async () => {
    await expect(store().renameItem('missing', 'Nope')).rejects.toThrow()
    expect(store().error).not.toBe(null)

    await store().createFolder('Work', null)

    expect(store().error).toBe(null)
  })

  it('reports an unparseable item instead of writing it', async () => {
    const broken = { ...textItem(), content: 42 } as unknown as LibraryItem

    await expect(store().saveItem(broken)).rejects.toThrow(/content/)

    expect(store().error).toMatch(/content/)
  })
})

// ---------------------------------------------------------------------------
// Session → library (PLAN.md §6.3, §8 Phase 4, decision D9)
// ---------------------------------------------------------------------------

describe('libraryStore.saveFromSession (PLAN.md §8 Phase 4)', () => {
  it('stores a received text item and puts it in the store', async () => {
    const received: SessionItem = {
      id: 'session-text',
      type: 'text',
      status: 'complete',
      createdAt: NOW,
      content: 'Portal password is hunter2',
    }

    const saved = await store().saveFromSession(received, null)

    expect(saved).toMatchObject({
      type: 'text',
      folderId: ROOT_FOLDER_ID,
      name: 'Portal password is hunter2',
      content: 'Portal password is hunter2',
    })
    // A new library id: session ids are a different namespace (PLAN.md §6.3).
    expect(saved.id).not.toBe(received.id)
    expect(store().items.map((item) => item.id)).toEqual([saved.id])
    expect(await getItem(saved.id)).toEqual(saved)
  })

  it('saves into the chosen folder', async () => {
    const folder = await store().createFolder('Uni Stuff', null)
    const received: SessionItem = {
      id: 'session-file',
      type: 'file',
      status: 'complete',
      createdAt: NOW,
      fileName: 'thesis.pdf',
      mimeType: 'application/pdf',
      totalSize: 3,
      totalChunks: 1,
      progress: 100,
      blob: new Blob(['pdf'], { type: 'application/pdf' }),
    }

    const saved = await store().saveFromSession(received, folder.id)

    expect(saved.folderId).toBe(folder.id)
    expect(await getItemsInFolder(folder.id)).toHaveLength(1)
  })

  it('never stores a transfer that did not complete (PLAN.md §17)', async () => {
    const partial: SessionItem = {
      id: 'session-partial',
      type: 'file',
      status: 'transferring',
      createdAt: NOW,
      fileName: 'half.bin',
      mimeType: 'application/octet-stream',
      totalSize: 3,
      totalChunks: 1,
      progress: 40,
      blob: new Blob(['hal']),
    }

    await expect(store().saveFromSession(partial, null)).rejects.toThrow(/transferring/)

    expect(store().error).toMatch(/transferring/)
    expect(store().items).toEqual([])
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toEqual([])
  })

  it('stores a locked item’s tuple byte-for-byte, with no decryption (D9)', async () => {
    const ciphertext = bytes(96)
    const iv = bytes(12)
    const salt = bytes(16)
    /** Kept before the session item is mutated, so the comparison below means something. */
    const original = ciphertext.slice()
    const received: SessionItem = {
      id: 'session-locked',
      type: 'locked',
      status: 'complete',
      createdAt: NOW,
      label: 'Uni portal password',
      innerType: 'text',
      ciphertext,
      iv,
      salt,
    }

    const saved = await store().saveFromSession(received, null)

    if (saved.type !== 'locked') throw new Error('test bug: the saved item is not locked')
    expect(saved.label).toBe('Uni portal password')
    expect(saved.name).toBe('Uni portal password')
    expect(saved.innerType).toBe('text')
    expect(saved.ciphertext).toEqual(original)
    expect(saved.iv).toEqual(iv)
    expect(saved.salt).toEqual(salt)

    const stored = await getItem(saved.id)
    if (stored?.type !== 'locked') throw new Error('test bug: the stored item is not locked')
    expect(stored.ciphertext).toEqual(original)
    expect(stored.iv).toEqual(iv)
    expect(stored.salt).toEqual(salt)

    // A copy, not the session item's own buffer: mutating the session cannot rewrite the
    // library.
    received.ciphertext.fill(0)
    expect(stored.ciphertext).toEqual(original)
  })
})

describe('libraryStore files (dossiers)', () => {
  it('creates, saves, and lists files by folder', async () => {
    const folder = await store().createFolder('Work', null)
    const file = await store().createFile('My Dossier', folder.id, [
      { id: 'b-1', type: 'heading', content: 'Title' },
    ])

    expect(file.id).toBeDefined()
    expect(store().files).toHaveLength(1)
    expect(store().filesIn(folder.id)).toHaveLength(1)
    expect(store().filesIn(folder.id)[0]?.name).toBe('My Dossier')

    await store().updateFile(file.id, { name: 'Renamed Dossier' })
    expect(store().filesIn(folder.id)[0]?.name).toBe('Renamed Dossier')

    const otherFolder = await store().createFolder('Other', null)
    await store().moveFile(file.id, otherFolder.id)

    expect(store().filesIn(folder.id)).toHaveLength(0)
    expect(store().filesIn(otherFolder.id)).toHaveLength(1)

    await store().deleteFile(file.id)
    expect(store().filesIn(otherFolder.id)).toHaveLength(0)
  })

  it('cascades folder delete to contained files in the store', async () => {
    const folder = await store().createFolder('Doomed', null)
    await store().createFile('F1', folder.id)
    await store().createFile('F2', folder.id)

    expect(store().filesIn(folder.id)).toHaveLength(2)

    await store().deleteFolder(folder.id)
    expect(store().files).toHaveLength(0)
  })
})


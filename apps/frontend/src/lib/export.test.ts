/**
 * Tests for the `.qrbit` export / import format (PLAN.md §14).
 *
 * The file this module writes is a user's only backup, so the tests are about the
 * things that would silently lose data: does a whole library come back byte-for-byte
 * through a fresh database, do locked items stay opaque when the outer file is not
 * encrypted, does a re-import duplicate anything, and does a damaged or foreign file
 * fail with a message rather than a stack trace.
 *
 * `fake-indexeddb` stands in for the browser (as in `library.test.ts`), so this file
 * runs in the default node environment: Node's `Blob`/`File` are the same realm as
 * the IDB stub, which is what lets a Blob round-trip through the store here.
 *
 * Real locked items are used rather than stand-in bytes, because the point of §19
 * decision 4 is that `{ciphertext, iv, salt}` survives the trip and still opens under
 * its own password — a stand-in tuple could not prove that. That costs a handful of
 * PBKDF2 derivations at 600,000 iterations (§19.9).
 */

import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'

import { decryptItem, encryptItem, toBase64 } from './crypto'
import {
  EXPORT_VERSION,
  exportLibrary,
  importLibrary,
  isEncryptedExport,
  suggestExportFilename,
  type ExportManifest,
} from './export'
import {
  closeLibraryDatabase,
  createFolder,
  getFolders,
  getItem,
  getItemsInFolder,
  isItemCorrupt,
  ROOT_FOLDER_ID,
  saveItem,
  type LibraryFileItem,
  type LibraryImageItem,
  type LibraryItem,
  type LibraryLockedItem,
  type LibraryTextItem,
} from './library'

const DB_NAME = 'qrbit-library'
const NOW = 1_700_000_000_000

// ---------------------------------------------------------------------------
// Isolation (the same pattern as library.test.ts)
// ---------------------------------------------------------------------------

/** Closes the cached connection and deletes the database, so each test starts empty. */
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

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IDB request failed'))
  })
}

async function withRawDatabase<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await idbRequest(indexedDB.open(DB_NAME))
  try {
    return await run(db)
  } finally {
    db.close()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Every byte value from 0x00 to 0xFF appears, so a truncated copy cannot pass. */
function bytes(length: number): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * 31 + 7) % 256
  }
  return value
}

function textItem(overrides: Partial<LibraryTextItem> = {}): LibraryTextItem {
  return {
    id: globalThis.crypto.randomUUID(),
    folderId: ROOT_FOLDER_ID,
    name: 'note',
    type: 'text',
    createdAt: NOW,
    updatedAt: NOW,
    content: 'the portal password is hunter2',
    ...overrides,
  }
}

function imageItem(overrides: Partial<LibraryImageItem> = {}): LibraryImageItem {
  const blob = new Blob([bytes(96)], { type: 'image/png' })
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

function fileItem(overrides: Partial<LibraryFileItem> = {}): LibraryFileItem {
  const blob = new Blob([bytes(4096)], { type: 'application/pdf' })
  return {
    id: globalThis.crypto.randomUUID(),
    folderId: ROOT_FOLDER_ID,
    name: 'thesis.pdf',
    type: 'file',
    createdAt: NOW,
    updatedAt: NOW,
    blob,
    mimeType: 'application/pdf',
    size: blob.size,
    ...overrides,
  }
}

function lockedItem(overrides: Partial<LibraryLockedItem> = {}): LibraryLockedItem {
  return {
    id: globalThis.crypto.randomUUID(),
    folderId: ROOT_FOLDER_ID,
    name: 'Server root key',
    type: 'locked',
    createdAt: NOW,
    updatedAt: NOW,
    label: 'Server root key',
    innerType: 'text',
    ciphertext: bytes(48),
    iv: bytes(12),
    salt: bytes(16),
    ...overrides,
  }
}

/** The exported Blob as the File a file input would hand to `importLibrary`. */
async function asFile(blob: Blob, name = 'qrbit-export.qrbit'): Promise<File> {
  return new File([await blob.arrayBuffer()], name, { type: blob.type })
}

/** The JSON of an unencrypted export, read as the manifest (the shape §14 defines). */
async function readManifest(blob: Blob): Promise<ExportManifest> {
  const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))
  return JSON.parse(text) as ExportManifest
}

/**
 * An item reduced to values two databases can be compared on: bytes become plain
 * arrays, because a `Blob` or a `Uint8Array` read back from IndexedDB is never the
 * same object even when it holds the same bytes.
 */
async function snapshot(item: LibraryItem): Promise<Record<string, unknown>> {
  switch (item.type) {
    case 'text':
    case 'richtext':
      return {
        id: item.id,
        folderId: item.folderId,
        name: item.name,
        type: item.type,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        content: item.content,
      }
    case 'image':
    case 'file':
      return {
        id: item.id,
        folderId: item.folderId,
        name: item.name,
        type: item.type,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        mimeType: item.mimeType,
        size: item.size,
        bytes: Array.from(new Uint8Array(await item.blob.arrayBuffer())),
      }
    case 'locked':
      return {
        id: item.id,
        folderId: item.folderId,
        name: item.name,
        type: item.type,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        label: item.label,
        innerType: item.innerType,
        ciphertext: Array.from(item.ciphertext),
        iv: Array.from(item.iv),
        salt: Array.from(item.salt),
      }
  }
}

/** Index of the first differing byte, or -1 when the two buffers are identical. */
function firstDifference(actual: Uint8Array, expected: Uint8Array): number {
  if (actual.length !== expected.length) return 0
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) return index
  }
  return -1
}

/**
 * One folder tree with one item of every type in it, some in the root and some in
 * folders — the shape `'all'` has to reproduce.
 */
async function seedLibrary(): Promise<{ items: LibraryItem[] }> {
  const uni = await createFolder('Uni Stuff', null)
  const thesis = await createFolder('Thesis', uni.id)

  const items: LibraryItem[] = [
    textItem({ name: 'root note' }),
    imageItem({ folderId: uni.id, name: 'diagram.png' }),
    fileItem({ folderId: thesis.id, name: 'draft.pdf' }),
    lockedItem({ folderId: uni.id }),
  ]
  for (const item of items) await saveItem(item)

  return { items }
}

// ---------------------------------------------------------------------------
// Export + import round trip
// ---------------------------------------------------------------------------

describe('exportLibrary / importLibrary round trip', () => {
  it("restores every folder and item of an 'all' export into a fresh database", async () => {
    const { items } = await seedLibrary()
    const folders = await getFolders()

    const file = await asFile(await exportLibrary('all', { encrypt: false }))
    await freshDatabase()

    const result = await importLibrary(file, {})

    expect(result).toEqual({ imported: items.length, errors: [] })
    // Folder ids are preserved, so parent links still point at real folders.
    expect(await getFolders()).toEqual(folders)
    for (const item of items) {
      const stored = await getItem(item.id)
      if (stored === undefined) throw new Error(`test: ${item.name} did not come back`)
      expect(await snapshot(stored)).toEqual(await snapshot(item))
    }
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(1)
  })

  it('round-trips an encrypted export and refuses a wrong or missing password', async () => {
    const item = textItem({ name: 'the only note' })
    await saveItem(item)

    const blob = await exportLibrary('all', { encrypt: true, password: 'correct horse battery staple' })
    expect(await isEncryptedExport(blob)).toBe(true)
    const file = await asFile(blob)

    // The whole file is one unreadable blob: not the note's text, not even the JSON.
    const encryptedBytes = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))
    expect(encryptedBytes).not.toContain('the only note')
    expect(encryptedBytes).not.toContain('"version"')

    await expect(importLibrary(file, { password: 'correct horse battery stapl' })).rejects.toThrow(
      'Wrong password or corrupted file',
    )
    await expect(importLibrary(file, {})).rejects.toThrow(/enter its password/)

    // Nothing above may have written anything on its way to failing.
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(1)

    await freshDatabase()
    expect(await importLibrary(file, { password: 'correct horse battery staple' })).toEqual({
      imported: 1,
      errors: [],
    })
    expect(await getItem(item.id)).toBeDefined()
  })

  it('keeps a locked item opaque in an unencrypted export, and restores a tuple that still opens', async () => {
    const password = 'correct horse battery staple'
    const plaintext = new TextEncoder().encode('Uni Portal: hunter2 / 4831')
    const { ciphertext, iv, salt } = await encryptItem(password, plaintext)
    const item = lockedItem({ id: globalThis.crypto.randomUUID(), ciphertext, iv, salt, name: 'Uni Portal' })
    await saveItem(item)

    const blob = await exportLibrary('all', { encrypt: false })
    const json = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))
    const entry = (await readManifest(blob)).items[0]
    if (entry === undefined) throw new Error('test: the export carried no items')

    // §14/§19.4: the tuple travels as base64 text, and the plaintext is nowhere in
    // the file — an unencrypted export is not a way to read a locked item.
    expect(entry.meta).toMatchObject({
      ciphertext: toBase64(ciphertext),
      iv: toBase64(iv),
      salt: toBase64(salt),
    })
    expect(json).not.toContain('hunter2')

    await freshDatabase()
    expect(await importLibrary(await asFile(blob), {})).toEqual({ imported: 1, errors: [] })

    const stored = await getItem(item.id)
    if (stored?.type !== 'locked') throw new Error('test: the locked item did not come back locked')
    expect(Array.from(stored.ciphertext)).toEqual(Array.from(ciphertext))
    // The real proof: the restored tuple still opens under the item's own password.
    expect(firstDifference(await decryptItem(password, stored.salt, stored.iv, stored.ciphertext), plaintext)).toBe(-1)
  })

  it('tells an encrypted export from a JSON one by its four-byte header', async () => {
    await saveItem(textItem())

    const plain = await exportLibrary('all', { encrypt: false })
    const encrypted = await exportLibrary('all', { encrypt: true, password: 'a password' })

    const firstFour = async (blob: Blob): Promise<string> =>
      new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()).slice(0, 4))

    expect(await firstFour(plain)).toBe('{"ve')
    expect(await firstFour(encrypted)).toBe('QRBE')
    expect(await isEncryptedExport(plain)).toBe(false)
    expect(await isEncryptedExport(encrypted)).toBe(true)
    // A file too short to hold a header is never treated as encrypted.
    expect(await isEncryptedExport(new Blob([new Uint8Array([0x51, 0x52])]))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('export scope', () => {
  it('takes only the named folders and their items, and excludes the root', async () => {
    const work = await createFolder('Work', null)
    const uni = await createFolder('Uni', null)
    const workItem = textItem({ folderId: work.id, name: 'work note' })
    const uniItem = textItem({ folderId: uni.id, name: 'uni note' })
    const rootItem = textItem({ name: 'root note' })
    for (const item of [workItem, uniItem, rootItem]) await saveItem(item)

    const manifest = await readManifest(await exportLibrary([work.id], { encrypt: false }))

    expect(manifest.folders.map((folder) => folder.name)).toEqual(['Work'])
    expect(manifest.items.map((entry) => entry.meta.id)).toEqual([workItem.id])

    // A scope that names nothing exports nothing — it is a selection, not a filter
    // whose miss should fail the export.
    const empty = await readManifest(await exportLibrary(['no-such-folder'], { encrypt: false }))
    expect(empty.folders).toEqual([])
    expect(empty.items).toEqual([])
  })

  it('lands a subfolder exported without its parent at the root, where it stays visible', async () => {
    const parent = await createFolder('Uni', null)
    const child = await createFolder('Thesis', parent.id)
    const item = textItem({ folderId: child.id, name: 'chapter one' })
    await saveItem(item)

    const file = await asFile(await exportLibrary([child.id], { encrypt: false }))
    await freshDatabase()

    expect(await importLibrary(file, {})).toEqual({ imported: 1, errors: [] })
    // The parent is not in this export, and a folder whose parent is missing would
    // be invisible in the tree — so it is restored at the top level instead.
    expect(await getFolders()).toEqual([{ ...child, parentId: null }])
    expect((await getItem(item.id))?.folderId).toBe(child.id)
  })
})

// ---------------------------------------------------------------------------
// Import behaviour on imperfect input
// ---------------------------------------------------------------------------

describe('importLibrary', () => {
  it('skips every duplicate by id on a second import, with no errors and nothing added', async () => {
    const { items } = await seedLibrary()
    const file = await asFile(await exportLibrary('all', { encrypt: false }))
    await freshDatabase()

    const first = await importLibrary(file, {})
    const foldersAfterFirst = await getFolders()
    expect(first).toEqual({ imported: items.length, errors: [] })

    const second = await importLibrary(file, {})

    expect(second).toEqual({ imported: 0, errors: [] })
    expect(await getFolders()).toEqual(foldersAfterFirst)
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(1)
  })

  it('stores the items it can and reports the ones it cannot, instead of aborting', async () => {
    const good = textItem({ name: 'good note' })
    const noContent = textItem({ name: 'content is a number', content: 'placeholder' })
    const orphan = textItem({ name: 'no such folder', folderId: 'folder-that-is-not-there' })

    const manifest = {
      version: EXPORT_VERSION,
      exportedAt: NOW,
      encrypted: false,
      folders: [],
      items: [
        { meta: { ...good } },
        { meta: { ...noContent, content: 42 } },
        { meta: { ...orphan } },
      ],
    }
    const file = new File([JSON.stringify(manifest)], 'handmade.qrbit', {
      type: 'application/json',
    })

    const result = await importLibrary(file, {})

    expect(result.imported).toBe(1)
    expect(result.errors).toHaveLength(2)
    expect(result.errors.join('\n')).toContain('"content is a number"')
    expect(result.errors.join('\n')).toContain('"no such folder"')
    expect(await getItem(good.id)).toBeDefined()
  })

  it('refuses a file that is not an export, and a version it does not know', async () => {
    await expect(importLibrary(new File(['not json at all'], 'junk.qrbit'), {})).rejects.toThrow(
      'This file is not a QRward library export.',
    )
    await expect(
      importLibrary(new File([JSON.stringify({ nonsense: true })], 'other.json'), {}),
    ).rejects.toThrow('This file is not a QRward library export.')

    const future = new File(
      [JSON.stringify({ version: 2, exportedAt: NOW, encrypted: false, folders: [], items: [] })],
      'future.qrbit',
    )
    await expect(importLibrary(future, {})).rejects.toThrow(/Unsupported export version 2/)
  })

  it('names the exported file with the export date and the .qrbit extension', () => {
    expect(suggestExportFilename(new Date('2026-09-15T12:34:56.000Z'))).toBe(
      'qrbit-export-2026-09-15.qrbit',
    )
  })

  it('round-trips a zero-byte file item without throwing', async () => {
    const item: LibraryFileItem = {
      id: 'zero-file',
      folderId: ROOT_FOLDER_ID,
      name: 'empty.bin',
      type: 'file',
      blob: new Blob([]),
      mimeType: 'application/octet-stream',
      size: 0,
      createdAt: 1000,
      updatedAt: 1000,
    }
    await saveItem(item)
    const blob = await exportLibrary('all', { encrypt: false })
    // Fresh DB for import (beforeEach runs before each test; manually reset here
    // because we need two DB states in one test)
    await freshDatabase()
    const { imported, errors } = await importLibrary(new File([blob], 'e.qrbit'), {})
    expect(errors).toEqual([])
    expect(imported).toBe(1)
    const restored = await getItem('zero-file')
    expect(restored).toBeDefined()
    expect(restored?.type).toBe('file')
    if (restored?.type === 'file') {
      expect(restored.size).toBe(0)
      const restoredBytes = new Uint8Array(await restored.blob.arrayBuffer())
      expect(restoredBytes.length).toBe(0)
    }
  })

  it('safely exports and imports a library containing an item with a broken Safari blob', async () => {
    await saveItem(textItem({ name: 'regular note' }))
    const id = 'safari-broken-export'
    await withRawDatabase(async (db) => {
      await idbRequest(
        db.transaction('items', 'readwrite').objectStore('items').put({
          id,
          folderId: ROOT_FOLDER_ID,
          name: 'broken-photo.jpg',
          type: 'image',
          createdAt: NOW,
          updatedAt: NOW,
          mimeType: 'image/jpeg',
          size: 2048,
          blob: {}, // Older Safari bug shape
        }),
      )
    })

    const exported = await exportLibrary('all', { encrypt: false })
    expect(exported.size).toBeGreaterThan(0)

    await freshDatabase()
    const result = await importLibrary(new File([exported], 'export.qrbit'), {})
    expect(result.errors).toEqual([])
    expect(result.imported).toBe(2)

    const importedItem = await getItem(id)
    expect(importedItem).toBeDefined()
    expect(importedItem?.name).toBe('broken-photo.jpg')
  })
})

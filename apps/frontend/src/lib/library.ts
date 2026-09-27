/**
 * Local library — the device-local IndexedDB store (PLAN.md §6.1–§6.3).
 *
 * THE ONE SANCTIONED INDEXEDDB USER (AGENTS.md, PLAN.md §6): the library is
 * permanent, device-local storage, never synced to any server. Session artifacts
 * — keys, the safety phrase, in-flight items, received items the user has not
 * explicitly saved — never reach this module (PLAN.md §1, §17). Save is always an
 * explicit user action: `saveItem` or `saveFromSession`.
 *
 * A plain data layer: no UI, no hooks, no zustand store, no crypto, no wire. It
 * never decrypts and never re-encrypts — a locked item's `{ciphertext, iv, salt}`
 * tuple is stored exactly as it arrived (PLAN.md §6.2, §14; orchestration
 * decision D9). The PBKDF2 key is derived from the user's password on every
 * unlock and is never written here.
 *
 * The module is also the boundary that keeps garbage out of IDB: IDB is untyped
 * at runtime, so every write is validated against the declared §6.1 shape, every
 * read is normalised, and an id that must exist but does not is an error rather
 * than a silent no-op.
 */

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'

import type { FileItem, ImageItem, SessionItem } from '../store/sessionStore'

// ---------------------------------------------------------------------------
// Data model (PLAN.md §6.1)
// ---------------------------------------------------------------------------

export interface LibraryFolder {
  id: string
  name: string
  color?: string
  /** null = lives in the root (PLAN.md §6.1). */
  parentId: string | null
  createdAt: number
  updatedAt: number
}

export type BlockType =
  | 'heading'
  | 'shortText'
  | 'richText'
  | 'image'
  | 'fileAttachment'
  | 'locked'
  | 'divider'

export interface EncryptedBlockData {
  ciphertext: Uint8Array | string
  iv: Uint8Array | string
  salt: Uint8Array | string
  innerType?: BlockType
}

export interface FileBlock {
  id: string
  type: BlockType
  /** Optional custom or preset label, e.g. "Gateway Proxy", "Optical Frequency", "Cluster Root Keyphrase" */
  label?: string
  /** Content for heading, richText, locked (when unlocked/raw), etc. */
  content?: string
  /** Value for shortText pair (or other key-value) */
  value?: string
  /** Media / file attachment metadata */
  fileName?: string
  fileSize?: string | number
  fileExt?: string
  caption?: string
  blob?: Blob
  mimeType?: string
  /** Security / locking */
  isLocked?: boolean
  password?: string
  lockedData?: EncryptedBlockData
  /** In-memory state */
  isUnlocked?: boolean
}

export interface LibraryFile {
  id: string
  folderId: string
  name: string
  createdAt: number
  updatedAt: number
  blocks: FileBlock[]
}

export type LibraryItemType = 'text' | 'richtext' | 'image' | 'file' | 'locked'

export interface LibraryItemBase {
  id: string
  /** ROOT_FOLDER_ID, or the id of the folder that holds the item. */
  folderId: string
  /** Display name, user-editable. */
  name: string
  type: LibraryItemType
  createdAt: number
  updatedAt: number
  /** True when stored blob data failed integrity check or Safari IDB serialization. */
  corrupt?: boolean
  /** Human-readable error message when the item could not be loaded. */
  error?: string
}

export interface LibraryTextItem extends LibraryItemBase {
  type: 'text'
  content: string
}

export interface LibraryRichTextItem extends LibraryItemBase {
  type: 'richtext'
  /** Tiptap JSON string. */
  content: string
}

export interface LibraryImageItem extends LibraryItemBase {
  type: 'image'
  blob: Blob
  mimeType: string
  size: number
  corrupt?: boolean
  error?: string
}

export interface LibraryFileItem extends LibraryItemBase {
  type: 'file'
  blob: Blob
  mimeType: string
  size: number
  corrupt?: boolean
  error?: string
}

export interface LibraryLockedItem extends LibraryItemBase {
  type: 'locked'
  /** The §9 session-locked-item label. Plaintext by design, like `name`. */
  label: string
  innerType: 'text' | 'richtext' | 'file'
  /** AES-256-GCM output. Opaque bytes — never decrypted by this module. */
  ciphertext: Uint8Array
  /** 12 bytes (PLAN.md §6.1). */
  iv: Uint8Array
  /** 16 bytes (PLAN.md §6.1). */
  salt: Uint8Array
}

export type LibraryItem =
  | LibraryTextItem
  | LibraryRichTextItem
  | LibraryImageItem
  | LibraryFileItem
  | LibraryLockedItem

/**
 * The id of the library's root folder (ADDITIVE to PLAN.md §6.1, which only says
 * `folderId` means "root folder if uncategorized").
 *
 * The root is virtual. PLAN.md §6.1 defines `LibraryFolder.parentId === null` to
 * mean "lives in the root", so the root itself is not a row in `folders`: it is
 * the `folderId` uncategorised items carry. `getFolders()` therefore returns the
 * user's folders only, and a UI renders the root node itself.
 *
 * `createFolder` accepts this id as an alias for `null` — a folder created while
 * the root is open is a top-level folder — but nothing is ever *stored* with
 * `parentId: 'root'`. `renameFolder`/`deleteFolder` reject it: the root always
 * exists and cannot be renamed or removed.
 */
export const ROOT_FOLDER_ID = 'root'

// ---------------------------------------------------------------------------
// Schema and connection (PLAN.md §6.3)
// ---------------------------------------------------------------------------

/**
 * Not exported: this module is the only code that may open the database, and
 * nothing outside it should name the store (the boundary the library exists for).
 */
const DB_NAME = 'qrbit-library'
const DB_VERSION = 2

interface LibraryDB extends DBSchema {
  folders: { key: string; value: LibraryFolder }
  items: {
    key: string
    value: LibraryItem
    indexes: { folderId: string; type: LibraryItemType; updatedAt: number }
  }
  files: {
    key: string
    value: LibraryFile
    indexes: { folderId: string; updatedAt: number }
  }
}

type LibraryTransaction = IDBPTransaction<LibraryDB, ('folders' | 'items' | 'files')[], 'readwrite'>

let database: Promise<IDBPDatabase<LibraryDB>> | null = null

function getDatabase(): Promise<IDBPDatabase<LibraryDB>> {
  if (database === null) {
    const opening = openDB<LibraryDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('folders', { keyPath: 'id' })
          const items = db.createObjectStore('items', { keyPath: 'id' })
          items.createIndex('folderId', 'folderId')
          items.createIndex('type', 'type')
          items.createIndex('updatedAt', 'updatedAt')
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('files')) {
            const files = db.createObjectStore('files', { keyPath: 'id' })
            files.createIndex('folderId', 'folderId')
            files.createIndex('updatedAt', 'updatedAt')
          }
        }
      },
    })
    // A failed open must not poison the cache: the next call tries again.
    opening.catch(() => {
      if (database === opening) database = null
    })
    database = opening
  }
  return database
}

/**
 * Closes the cached connection; the next API call opens the database again.
 *
 * ADDITIONAL to PLAN.md §6.3. A long-lived connection is what should hold a
 * `versionchange` from blocking, and tests use this to start each case from an
 * empty database (a `deleteDatabase` cannot proceed while a connection is open).
 */
export async function closeLibraryDatabase(): Promise<void> {
  const current = database
  database = null
  if (current === null) return
  try {
    ;(await current).close()
  } catch {
    // A connection that never opened has nothing to close; the cache is cleared either way.
  }
}

// ---------------------------------------------------------------------------
// Validation — the boundary between untyped IDB and the §6.1 model
// ---------------------------------------------------------------------------

type LockedInnerType = LibraryLockedItem['innerType']

const ITEM_TYPES: readonly LibraryItemType[] = ['text', 'richtext', 'image', 'file', 'locked']
const LOCKED_INNER_TYPES: readonly LockedInnerType[] = ['text', 'richtext', 'file']

/**
 * The fixed widths of a locked tuple's two bookkeeping fields (PLAN.md §6.1, §11.4:
 * `encryptItem` emits a random 12-byte IV and a 16-byte salt).
 */
const LOCKED_IV_BYTE_LENGTH = 12
const LOCKED_SALT_BYTE_LENGTH = 16

const BASE_FIELDS: readonly string[] = ['id', 'folderId', 'name', 'type', 'createdAt', 'updatedAt']

/** The type-specific fields of each §6.1 item. */
const TYPE_FIELDS: Record<LibraryItemType, readonly string[]> = {
  text: ['content'],
  richtext: ['content'],
  image: ['blob', 'mimeType', 'size', 'corrupt', 'error'],
  file: ['blob', 'mimeType', 'size', 'corrupt', 'error'],
  locked: ['label', 'innerType', 'ciphertext', 'iv', 'salt'],
}

const FOLDER_FIELDS: readonly string[] = ['id', 'name', 'color', 'parentId', 'createdAt', 'updatedAt']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isItemType(value: unknown): value is LibraryItemType {
  return typeof value === 'string' && ITEM_TYPES.some((itemType) => itemType === value)
}

function isLockedInnerType(value: unknown): value is LockedInnerType {
  return typeof value === 'string' && LOCKED_INNER_TYPES.some((innerType) => innerType === value)
}

/** A non-empty string argument of a public function. */
function requireId(id: string, what: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`library: ${what} needs a non-empty id`)
  }
  return id
}

function requireName(name: string, what: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`library: ${what} needs a non-empty name`)
  }
  return name.trim()
}

function readString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new Error(`library: ${what} needs a string "${key}"`)
  }
  return value
}

function readTimestamp(record: Record<string, unknown>, key: string, what: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`library: ${what} needs a non-negative number "${key}"`)
  }
  return value
}

/**
 * A true `Uint8Array`, whatever form structured clone handed back.
 *
 * IDB stores a `Uint8Array` natively but engines differ in whether they return
 * it as a byte array, an `ArrayBuffer` or another view, so every byte field is
 * normalised here. A `Uint8Array` is returned by reference (a locked item can
 * hold megabytes and a copy would double peak memory).
 */
function toBytes(value: unknown, key: string, what: string): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error(`library: ${what} needs "${key}" as Uint8Array bytes`)
}

/** Non-empty bytes: an absent, empty or wrongly-typed unlock share is garbage. */
function readBytes(record: Record<string, unknown>, key: string, what: string): Uint8Array {
  const bytes = toBytes(record[key], key, what)
  if (bytes.byteLength === 0) {
    throw new Error(`library: ${what} needs non-empty "${key}" bytes`)
  }
  return bytes
}

/**
 * A byte field whose width PLAN.md §6.1 fixes.
 *
 * Only the ciphertext of a locked tuple varies in length — it is the plaintext plus the
 * AES-GCM tag — so a 12-byte IV and a 16-byte salt are the signature of a tuple this app
 * produced. They are asserted at this boundary because it is the only one: a hostile
 * peer's `locked-payload` is validated as bytes and nothing more on the wire
 * (`protocol.ts`), so a 1-byte IV or a 5000-byte salt would be copied into IndexedDB
 * permanently by `saveFromSession`. Web Crypto then raises `OperationError` on every
 * unlock attempt, and both unlock paths report that as "wrong password" — the exact
 * misdiagnosis PLAN.md §17 exists to prevent.
 */
function readFixedBytes(
  record: Record<string, unknown>,
  key: string,
  what: string,
  byteLength: number,
): Uint8Array {
  const bytes = readBytes(record, key, what)
  if (bytes.byteLength !== byteLength) {
    throw new Error(
      `library: ${what} needs "${key}" to be ${byteLength} bytes (got ${bytes.byteLength})`,
    )
  }
  return bytes
}

function readBlob(
  record: Record<string, unknown>,
  key: string,
  what: string,
  mimeType: string,
): Blob {
  const value = record[key]
  if (value instanceof Blob) return value
  if (value instanceof ArrayBuffer) return new Blob([value], { type: mimeType })
  if (ArrayBuffer.isView(value)) {
    // Copied into an ArrayBuffer-backed view: `BlobPart` will not take the shared
    // buffer a view may point at, and this branch is only for bytes written by
    // hand rather than as a Blob.
    return new Blob([new Uint8Array(toBytes(value, key, what))], { type: mimeType })
  }
  throw new Error(`library: ${what} needs a Blob "${key}"`)
}

function assertKnownFields(record: Record<string, unknown>, fields: readonly string[], what: string): void {
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) {
      throw new Error(`library: unexpected field "${key}" on a ${what}`)
    }
  }
}

function readBlobFields(
  record: Record<string, unknown>,
  type: 'image' | 'file',
  mode: 'read' | 'write' = 'write',
): { blob: Blob; mimeType: string; size: number; corrupt?: boolean; error?: string } {
  const what = `${type} item`

  if (mode === 'write') {
    const mimeType = readString(record, 'mimeType', what)
    const blob = readBlob(record, 'blob', what, mimeType)
    const size = record['size']
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`library: ${what} needs a non-negative integer "size"`)
    }
    if (size !== blob.size) {
      throw new Error(`library: ${what} declares size ${size} but its blob holds ${blob.size} bytes`)
    }
    return { blob, mimeType, size }
  }

  // mode === 'read'
  // On READ: defensive fallback against older Safari (storing Blob as empty object {})
  // or corrupted storage where blob is missing or its size disagrees with the stored size.
  const mimeType = typeof record['mimeType'] === 'string' ? record['mimeType'] : ''
  const rawBlob = record['blob']
  const rawSize = record['size']
  const hasStoredSize = typeof rawSize === 'number' && Number.isSafeInteger(rawSize) && rawSize >= 0

  let blob: Blob | null = null
  try {
    blob = readBlob(record, 'blob', what, mimeType)
  } catch {
    blob = null
  }

  if (blob === null || (hasStoredSize && blob.size !== rawSize)) {
    return {
      blob: blob ?? new Blob([], { type: mimeType }),
      mimeType,
      size: hasStoredSize ? rawSize : 0,
      corrupt: true,
      error: 'This item could not be loaded',
    }
  }

  return {
    blob,
    mimeType,
    size: hasStoredSize ? rawSize : blob.size,
  }
}

/**
 * Parses one stored (or to-be-stored) item into the §6.1 model, or throws.
 *
 * The single validator both write paths and every read path go through, so the
 * shape written and the shape read cannot drift. An empty `content` is valid — an
 * empty note is a real item — but a missing or non-string `content` is not.
 */
function parseItem(value: unknown, mode: 'read' | 'write' = 'write'): LibraryItem {
  if (!isRecord(value)) throw new Error('library: an item must be an object')

  const type = value['type']
  if (!isItemType(type)) {
    throw new Error(`library: unknown item type ${JSON.stringify(value['type'])}`)
  }
  assertKnownFields(value, [...BASE_FIELDS, ...(TYPE_FIELDS[type])], `${type} item`)

  const what = `${type} item`
  const id = requireId(readString(value, 'id', what), 'an item')
  const folderId = requireId(readString(value, 'folderId', what), 'an item')
  const name = requireName(readString(value, 'name', what), 'an item')
  const createdAt = readTimestamp(value, 'createdAt', what)
  const updatedAt = readTimestamp(value, 'updatedAt', what)

  switch (type) {
    case 'text':
      return {
        id,
        folderId,
        name,
        type: 'text',
        createdAt,
        updatedAt,
        content: readString(value, 'content', what),
      }
    case 'richtext':
      return {
        id,
        folderId,
        name,
        type: 'richtext',
        createdAt,
        updatedAt,
        content: readString(value, 'content', what),
      }
    case 'image':
      return { id, folderId, name, type: 'image', createdAt, updatedAt, ...readBlobFields(value, 'image', mode) }
    case 'file':
      return { id, folderId, name, type: 'file', createdAt, updatedAt, ...readBlobFields(value, 'file', mode) }
    case 'locked': {
      const innerType = value['innerType']
      if (!isLockedInnerType(innerType)) {
        throw new Error(
          `library: locked item needs an "innerType" of text, richtext or file (got ${JSON.stringify(innerType)})`,
        )
      }
      return {
        id,
        folderId,
        name,
        type: 'locked',
        createdAt,
        updatedAt,
        label: readString(value, 'label', what),
        innerType,
        ciphertext: readBytes(value, 'ciphertext', what),
        iv: readFixedBytes(value, 'iv', what, LOCKED_IV_BYTE_LENGTH),
        salt: readFixedBytes(value, 'salt', what, LOCKED_SALT_BYTE_LENGTH),
      }
    }
  }
}

function parseFolder(value: unknown): LibraryFolder {
  if (!isRecord(value)) throw new Error('library: a folder must be an object')
  assertKnownFields(value, FOLDER_FIELDS, 'folder')

  const parentId = value['parentId']
  if (parentId !== null && typeof parentId !== 'string') {
    throw new Error('library: a folder needs a "parentId" that is a folder id or null')
  }

  const rawColor = value['color']
  const color = typeof rawColor === 'string' ? rawColor : undefined

  return {
    id: requireId(readString(value, 'id', 'folder'), 'a folder'),
    name: requireName(readString(value, 'name', 'folder'), 'a folder'),
    color,
    parentId,
    createdAt: readTimestamp(value, 'createdAt', 'folder'),
    updatedAt: readTimestamp(value, 'updatedAt', 'folder'),
  }
}

/**
 * The folder a write targets must exist, and the check shares its transaction
 * with the write so a folder cannot be deleted in between.
 *
 * The root has no row, so ROOT_FOLDER_ID and null both mean "the root".
 */
async function requireFolder(tx: LibraryTransaction, folderId: string | null): Promise<void> {
  if (folderId === null || folderId === ROOT_FOLDER_ID) return
  const folder = await tx.objectStore('folders').get(folderId)
  if (folder === undefined) {
    throw new Error(`library: no folder with id "${folderId}"`)
  }
}

/** `null` and the root's own id both mean "top level" (PLAN.md §6.1). */
function normaliseParentId(parentId: string | null): string | null {
  if (parentId === null || parentId === ROOT_FOLDER_ID) return null
  if (typeof parentId !== 'string' || parentId.trim() === '') {
    throw new Error('library: a folder parent must be a folder id or null')
  }
  return parentId
}

function compareNames(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

// ---------------------------------------------------------------------------
// Folders (PLAN.md §6.3)
// ---------------------------------------------------------------------------

/** Every folder, oldest first (name breaks a same-millisecond tie). */
export async function getFolders(): Promise<LibraryFolder[]> {
  const db = await getDatabase()
  const folders = (await db.getAll('folders')).map(parseFolder)
  return folders.sort((a, b) => a.createdAt - b.createdAt || compareNames(a.name, b.name))
}

export async function createFolder(
  name: string,
  parentId: string | null,
  color?: string,
): Promise<LibraryFolder> {
  const folderName = requireName(name, 'a folder')
  const parent = normaliseParentId(parentId)
  const now = Date.now()
  const folder: LibraryFolder = {
    id: globalThis.crypto.randomUUID(),
    name: folderName,
    color,
    parentId: parent,
    createdAt: now,
    updatedAt: now,
  }

  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items', 'files'], 'readwrite')
  await requireFolder(tx, parent)
  // `add`, not `put`: a colliding id must fail loudly rather than overwrite a folder tree.
  await tx.objectStore('folders').add(folder)
  await tx.done

  return folder
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const folderId = requireId(id, 'renameFolder')
  if (folderId === ROOT_FOLDER_ID) throw new Error('library: the root folder cannot be renamed')
  const folderName = requireName(name, 'a folder')

  const db = await getDatabase()
  const tx = db.transaction('folders', 'readwrite')
  const store = tx.objectStore('folders')
  const existing = await store.get(folderId)
  if (existing === undefined) throw new Error(`library: no folder with id "${folderId}"`)

  await store.put({ ...existing, name: folderName, updatedAt: Date.now() })
  await tx.done
}

/**
 * Writes a folder as given, preserving the id it carries (ADDITIVE to PLAN.md §6.3).
 *
 * `createFolder` mints its own uuid, which is right for a folder the user just made
 * and wrong for one being restored: a `.qrbit` export carries `folders[]` and every
 * item's `folderId` (PLAN.md §14), so an import has to put a folder back under its own
 * id or the items pointing at it cannot be saved at all (`putItem` refuses a
 * `folderId` with no folder behind it).
 *
 * Skip-by-id: an id that is already stored is left exactly as it is and the call is a
 * no-op, which is what makes re-importing the same export harmless. The whole library
 * is imported this way — folders first, then items — so that check and the items'
 * own duplicate skip are one rule rather than two.
 *
 * A `parentId` with no row here is written as the root instead of left dangling. A
 * subset export can name a subfolder without its parent, and a folder whose parent
 * does not exist is invisible in the tree (§6.4 renders the tree by walking down from
 * the root), so the folder would be stored but unreachable. Folders are imported
 * parent-first for the same reason; this is the backstop for when they cannot be.
 */
export async function saveFolder(folder: LibraryFolder): Promise<void> {
  const parsed = parseFolder(folder)
  if (parsed.id === ROOT_FOLDER_ID) {
    // The root is virtual (§6.1): it has no row, and one would make `getFolders()`
    // return a phantom folder that cannot be renamed or deleted.
    throw new Error('library: the root folder is virtual and cannot be stored')
  }

  const parentId = normaliseParentId(parsed.parentId)
  const db = await getDatabase()
  const tx = db.transaction('folders', 'readwrite')
  const store = tx.objectStore('folders')

  if ((await store.get(parsed.id)) !== undefined) {
    await tx.done
    return
  }

  const parentExists = parentId !== null && (await store.get(parentId)) !== undefined
  await store.put({ ...parsed, parentId: parentExists ? parentId : null })
  await tx.done
}

/**
 * Deletes a folder, every folder beneath it and every item inside them — a
 * folder tree dies whole (PLAN.md §6.3), because an item whose folder is gone
 * would be unreachable. Items in the root and in unrelated folders are untouched.
 *
 * One transaction, so a crash cannot leave orphaned items behind.
 */
export async function deleteFolder(id: string): Promise<void> {
  const folderId = requireId(id, 'deleteFolder')
  if (folderId === ROOT_FOLDER_ID) throw new Error('library: the root folder cannot be deleted')

  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items', 'files'], 'readwrite')
  const folderStore = tx.objectStore('folders')
  if ((await folderStore.get(folderId)) === undefined) {
    throw new Error(`library: no folder with id "${folderId}"`)
  }

  const doomed = collectSubtree(await folderStore.getAll(), folderId)
  const itemStore = tx.objectStore('items')
  for (const doomedFolderId of doomed) {
    for (const itemKey of await itemStore.index('folderId').getAllKeys(doomedFolderId)) {
      await itemStore.delete(itemKey)
    }
  }
  const fileStore = tx.objectStore('files')
  for (const doomedFolderId of doomed) {
    for (const fileKey of await fileStore.index('folderId').getAllKeys(doomedFolderId)) {
      await fileStore.delete(fileKey)
    }
  }
  for (const doomedFolderId of doomed) {
    await folderStore.delete(doomedFolderId)
  }
  await tx.done
}

/**
 * `rootId` plus the ids of every folder beneath it (breadth first).
 *
 * A folder already visited is skipped, so a corrupt cycle (`a → b → a`) cannot
 * loop forever or leave a folder behind.
 */
function collectSubtree(folders: readonly LibraryFolder[], rootId: string): Set<string> {
  const subtree = new Set<string>([rootId])
  let frontier = [rootId]

  while (frontier.length > 0) {
    const next: string[] = []
    for (const folder of folders) {
      const parentId = folder.parentId
      if (parentId === null || subtree.has(folder.id)) continue
      if (!frontier.includes(parentId)) continue
      subtree.add(folder.id)
      next.push(folder.id)
    }
    frontier = next
  }

  return subtree
}

// ---------------------------------------------------------------------------
// Items (PLAN.md §6.3)
// ---------------------------------------------------------------------------

/** The items directly in `folderId`, most recently updated first. */
export async function getItemsInFolder(folderId: string): Promise<LibraryItem[]> {
  const target = requireId(folderId, 'getItemsInFolder')
  const db = await getDatabase()
  const items = (await db.getAllFromIndex('items', 'folderId', target)).map((item) => parseItem(item, 'read'))
  return items.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
}

/** `undefined` for an id with no item — a read has nothing to throw about. */
export async function getItem(id: string): Promise<LibraryItem | undefined> {
  const itemId = requireId(id, 'getItem')
  const db = await getDatabase()
  const stored = await db.get('items', itemId)
  return stored === undefined ? undefined : parseItem(stored, 'read')
}

/** Create or overwrite by id (the library id is the store's key). */
export async function saveItem(item: LibraryItem): Promise<void> {
  await putItem(parseItem(item, 'write'))
}

/** The write half of `saveItem`, for callers that already hold a parsed item. */
async function putItem(item: LibraryItem): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items'], 'readwrite')
  await requireFolder(tx, item.folderId)
  await tx.objectStore('items').put(item)
  await tx.done
}

/**
 * Applies a partial update, preserving the item's type fields.
 *
 * The patch is merged onto the stored item and the result re-parsed, so the
 * fields the patch does not name survive and a patch cannot smuggle in a field
 * belonging to another type. `id`, `type` and `createdAt` are immutable and
 * `updatedAt` is stamped here — the layer owns those four.
 */
export async function updateItem(id: string, patch: Partial<LibraryItem>): Promise<void> {
  const itemId = requireId(id, 'updateItem')

  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items'], 'readwrite')
  const store = tx.objectStore('items')
  const existing = await store.get(itemId)
  if (existing === undefined) throw new Error(`library: no item with id "${itemId}"`)

  const merged: Record<string, unknown> = { ...existing, ...patch, updatedAt: Date.now() }
  if (merged['id'] !== existing.id) {
    throw new Error(`library: an item's id is immutable (use saveItem to create one)`)
  }
  if (merged['type'] !== existing.type) {
    throw new Error(`library: an item's type is immutable (it is "${existing.type}")`)
  }
  if (merged['createdAt'] !== existing.createdAt) {
    throw new Error(`library: an item's createdAt is immutable`)
  }

  const parsedExisting = parseItem(existing, 'read')
  const mode = 'blob' in patch && patch.blob !== undefined ? 'write' : parsedExisting.corrupt ? 'read' : 'write'
  const updated = parseItem(merged, mode)
  await requireFolder(tx, updated.folderId)
  await store.put(updated)
  await tx.done
}

export async function deleteItem(id: string): Promise<void> {
  const itemId = requireId(id, 'deleteItem')

  const db = await getDatabase()
  const tx = db.transaction('items', 'readwrite')
  const store = tx.objectStore('items')
  if ((await store.get(itemId)) === undefined) {
    throw new Error(`library: no item with id "${itemId}"`)
  }

  await store.delete(itemId)
  await tx.done
}

/** Moves an item to another folder. Nothing else about it changes. */
export async function moveItem(id: string, targetFolderId: string): Promise<void> {
  const itemId = requireId(id, 'moveItem')
  const target = requireId(targetFolderId, 'moveItem')

  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items'], 'readwrite')
  await requireFolder(tx, target)
  const store = tx.objectStore('items')
  const existing = await store.get(itemId)
  if (existing === undefined) throw new Error(`library: no item with id "${itemId}"`)

  const parsedExisting = parseItem(existing, 'read')
  const mode = parsedExisting.corrupt ? 'read' : 'write'
  await store.put(parseItem({ ...existing, folderId: target, updatedAt: Date.now() }, mode))
  await tx.done
}

/**
 * Returns true if the library item could not be fully loaded from storage
 * (e.g. an older Safari IndexedDB Blob serialization failure or size mismatch).
 */
export function isItemCorrupt(item: LibraryItem): boolean {
  return item.corrupt === true
}

// ---------------------------------------------------------------------------
// Session → library (PLAN.md §6.3 "save a received item")
// ---------------------------------------------------------------------------

/**
 * Saves a §9 session item into the library and returns what was stored.
 *
 * The library item gets a NEW uuid: session item ids are ephemeral and live in a
 * different namespace. Nothing is decrypted or re-encrypted on the way in — a
 * locked item's tuple is copied byte-for-byte, so it stays locked and the
 * password stays optional on the send path (PLAN.md §14, decision D9).
 *
 * An item whose transfer never completed has no bytes to keep and throws: a
 * truncated file must never reach the permanent library.
 */
export async function saveFromSession(item: SessionItem, folderId: string): Promise<LibraryItem> {
  const target = requireId(folderId, 'saveFromSession')
  const converted = parseItem(
    libraryItemFromSession(item, globalThis.crypto.randomUUID(), target, Date.now()),
    'write',
  )
  await putItem(converted)
  return converted
}

function libraryItemFromSession(
  item: SessionItem,
  id: string,
  folderId: string,
  now: number,
): LibraryItem {
  if (item.status !== 'complete') {
    throw new Error(
      `library: cannot save a ${item.type} item while its transfer is "${item.status}" — it has no complete data yet`,
    )
  }

  switch (item.type) {
    case 'text':
      return {
        id,
        folderId,
        name: nameForText(item.content),
        type: 'text',
        createdAt: now,
        updatedAt: now,
        content: item.content,
      }
    case 'richtext':
      // Tiptap JSON is not readable text, so the name stays the §6.1 default a UI can rename.
      return {
        id,
        folderId,
        name: 'Rich text note',
        type: 'richtext',
        createdAt: now,
        updatedAt: now,
        content: item.content,
      }
    case 'image':
      return { id, folderId, type: 'image', createdAt: now, updatedAt: now, ...blobFields(item) }
    case 'file':
      return { id, folderId, type: 'file', createdAt: now, updatedAt: now, ...blobFields(item) }
    case 'locked':
      return {
        id,
        folderId,
        name: item.label.trim() === '' ? 'Locked item' : item.label,
        type: 'locked',
        createdAt: now,
        updatedAt: now,
        label: item.label,
        innerType: item.innerType,
        // Byte-for-byte copies, so a later mutation of the session item's buffer
        // cannot rewrite what is in the library.
        ciphertext: copyBytes(item.ciphertext, 'ciphertext'),
        iv: copyBytes(item.iv, 'iv'),
        salt: copyBytes(item.salt, 'salt'),
      }
  }
}

/** The `{name, blob, mimeType, size}` an image/file item contributes. */
function blobFields(item: ImageItem | FileItem): {
  name: string
  blob: Blob
  mimeType: string
  size: number
} {
  const blob = item.blob
  if (blob === undefined) {
    throw new Error(
      `library: cannot save "${item.fileName}" — its ${item.type} transfer never produced a blob`,
    )
  }

  return {
    name: item.fileName.trim() === '' ? (item.type === 'image' ? 'Image' : 'File') : item.fileName,
    blob,
    // An empty announce (a browser leaves `File.type` blank for unknown
    // extensions) falls back to whatever the blob itself carries.
    mimeType: item.mimeType === '' ? blob.type : item.mimeType,
    size: blob.size,
  }
}

function copyBytes(bytes: Uint8Array, key: string): Uint8Array {
  return toBytes(bytes, key, 'locked item').slice()
}

const NOTE_NAME_MAX_LENGTH = 40

/** A note's name: its opening words, or the §6.1 default when it is empty. */
function nameForText(content: string): string {
  const collapsed = content.trim().replace(/\s+/g, ' ')
  if (collapsed === '') return 'Text note'
  if (collapsed.length <= NOTE_NAME_MAX_LENGTH) return collapsed

  const clipped = collapsed.slice(0, NOTE_NAME_MAX_LENGTH)
  const lastSpace = clipped.lastIndexOf(' ')
  return `${lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped}…`
}

// ---------------------------------------------------------------------------
// File & Block system (Glorified markdown files / dossiers)
// ---------------------------------------------------------------------------

const BLOCK_TYPES: readonly BlockType[] = [
  'heading',
  'shortText',
  'richText',
  'image',
  'fileAttachment',
  'locked',
  'divider',
]

function isBlockType(value: unknown): value is BlockType {
  return typeof value === 'string' && BLOCK_TYPES.some((t) => t === value)
}

export function parseBlock(value: unknown): FileBlock {
  if (!isRecord(value)) throw new Error('library: a block must be an object')
  const id = requireId(readString(value, 'id', 'block'), 'block')
  const rawType = value['type']
  const type: BlockType = isBlockType(rawType) ? rawType : 'shortText'

  const block: FileBlock = {
    id,
    type,
  }

  if (typeof value['label'] === 'string') block.label = value['label']
  if (typeof value['content'] === 'string') block.content = value['content']
  if (typeof value['value'] === 'string') block.value = value['value']
  if (typeof value['fileName'] === 'string') block.fileName = value['fileName']
  if (typeof value['fileSize'] === 'string' || typeof value['fileSize'] === 'number') block.fileSize = value['fileSize']
  if (typeof value['fileExt'] === 'string') block.fileExt = value['fileExt']
  if (typeof value['caption'] === 'string') block.caption = value['caption']
  if (typeof value['mimeType'] === 'string') block.mimeType = value['mimeType']
  if (typeof value['isLocked'] === 'boolean') {
    block.isLocked = value['isLocked']
  } else if (type === 'locked') {
    block.isLocked = true
  }
  if (typeof value['password'] === 'string') block.password = value['password']
  if (typeof value['isUnlocked'] === 'boolean') block.isUnlocked = value['isUnlocked']

  if (value['blob'] instanceof Blob) {
    block.blob = value['blob']
  }

  if (isRecord(value['lockedData'])) {
    const rawLocked = value['lockedData']
    block.lockedData = {
      ciphertext: rawLocked['ciphertext'] as Uint8Array | string,
      iv: rawLocked['iv'] as Uint8Array | string,
      salt: rawLocked['salt'] as Uint8Array | string,
      innerType: isBlockType(rawLocked['innerType']) ? rawLocked['innerType'] : undefined,
    }
  }

  return block
}

export function parseFile(value: unknown): LibraryFile {
  if (!isRecord(value)) throw new Error('library: a file must be an object')
  const what = 'file'
  const id = requireId(readString(value, 'id', what), what)
  const folderId = requireId(readString(value, 'folderId', what), what)
  const name = requireName(readString(value, 'name', what), what)
  const createdAt = readTimestamp(value, 'createdAt', what)
  const updatedAt = readTimestamp(value, 'updatedAt', what)

  const rawBlocks = value['blocks']
  const blocks: FileBlock[] = Array.isArray(rawBlocks) ? rawBlocks.map(parseBlock) : []

  return {
    id,
    folderId,
    name,
    createdAt,
    updatedAt,
    blocks,
  }
}

/** All files in the library, most recently updated first. */
export async function getFiles(): Promise<LibraryFile[]> {
  const db = await getDatabase()
  const files = (await db.getAll('files')).map(parseFile)
  return files.sort((a, b) => b.updatedAt - a.updatedAt || compareNames(a.name, b.name))
}

/** The files directly in `folderId`, most recently updated first. */
export async function getFilesInFolder(folderId: string): Promise<LibraryFile[]> {
  const target = requireId(folderId, 'getFilesInFolder')
  const db = await getDatabase()
  const files = (await db.getAllFromIndex('files', 'folderId', target)).map(parseFile)
  return files.sort((a, b) => b.updatedAt - a.updatedAt || compareNames(a.name, b.name))
}

/** `undefined` for an id with no file. */
export async function getFile(id: string): Promise<LibraryFile | undefined> {
  const fileId = requireId(id, 'getFile')
  const db = await getDatabase()
  const stored = await db.get('files', fileId)
  return stored === undefined ? undefined : parseFile(stored)
}

/** Create or overwrite a file by id. */
export async function saveFile(file: LibraryFile): Promise<void> {
  const parsed = parseFile(file)
  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items', 'files'], 'readwrite')
  await requireFolder(tx, parsed.folderId)
  await tx.objectStore('files').put(parsed)
  await tx.done
}

/** Creates a new dossier file inside `folderId`. */
export async function createFile(
  name: string,
  folderId: string,
  blocks: FileBlock[] = [],
): Promise<LibraryFile> {
  const fileName = requireName(name, 'a file')
  const target = requireId(folderId, 'createFile')
  const now = Date.now()
  const file: LibraryFile = {
    id: globalThis.crypto.randomUUID(),
    folderId: target,
    name: fileName,
    createdAt: now,
    updatedAt: now,
    blocks,
  }

  await saveFile(file)
  return file
}

/** Applies a partial update to an existing file. */
export async function updateFile(id: string, patch: Partial<LibraryFile>): Promise<void> {
  const fileId = requireId(id, 'updateFile')
  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items', 'files'], 'readwrite')
  const store = tx.objectStore('files')
  const existing = await store.get(fileId)
  if (existing === undefined) throw new Error(`library: no file with id "${fileId}"`)

  const merged = { ...existing, ...patch, updatedAt: Date.now() }
  if (merged.id !== existing.id) {
    throw new Error(`library: a file's id is immutable`)
  }
  if (merged.createdAt !== existing.createdAt) {
    throw new Error(`library: a file's createdAt is immutable`)
  }

  const parsed = parseFile(merged)
  await requireFolder(tx, parsed.folderId)
  await store.put(parsed)
  await tx.done
}

export async function deleteFile(id: string): Promise<void> {
  const fileId = requireId(id, 'deleteFile')
  const db = await getDatabase()
  const tx = db.transaction('files', 'readwrite')
  const store = tx.objectStore('files')
  if ((await store.get(fileId)) === undefined) {
    throw new Error(`library: no file with id "${fileId}"`)
  }
  await store.delete(fileId)
  await tx.done
}

export async function moveFile(id: string, targetFolderId: string): Promise<void> {
  const fileId = requireId(id, 'moveFile')
  const target = requireId(targetFolderId, 'moveFile')
  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items', 'files'], 'readwrite')
  await requireFolder(tx, target)
  const store = tx.objectStore('files')
  const existing = await store.get(fileId)
  if (existing === undefined) throw new Error(`library: no file with id "${fileId}"`)

  await store.put(parseFile({ ...existing, folderId: target, updatedAt: Date.now() }))
  await tx.done
}

// ---------------------------------------------------------------------------
// Seed Data (Realistic mock folders and files)
// ---------------------------------------------------------------------------

export const INITIAL_FOLDERS: LibraryFolder[] = [
  {
    id: 'f-1',
    name: 'Work & Credentials',
    color: '#1D4ED8',
    parentId: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  },
  {
    id: 'f-2',
    name: 'Research Dossiers',
    color: '#0F766E',
    parentId: null,
    createdAt: 1700000001000,
    updatedAt: 1700000001000,
  },
  {
    id: 'f-3',
    name: 'Field Deployments',
    color: '#7C3AED',
    parentId: null,
    createdAt: 1700000002000,
    updatedAt: 1700000002000,
  },
]

export const INITIAL_FILES: LibraryFile[] = [
  {
    id: 'file-1',
    folderId: 'f-1',
    name: 'Uni Credentials & Keys',
    createdAt: 1700000000000,
    updatedAt: Date.now() - 12 * 60 * 1000,
    blocks: [
      {
        id: 'b-101',
        type: 'heading',
        content: 'CS Lab 402 — Auth Cluster',
      },
      {
        id: 'b-102',
        type: 'shortText',
        label: 'Gateway Proxy',
        value: 'gateway.ece.university.edu:8443',
      },
      {
        id: 'b-103',
        type: 'locked',
        label: 'Cluster Root Keyphrase',
        content: 'sys_x94#kK99!Alpha2',
        password: 'pass',
        isLocked: true,
        isUnlocked: false,
      },
      {
        id: 'b-104',
        type: 'divider',
      },
      {
        id: 'b-105',
        type: 'richText',
        content:
          'Notes on cluster allocation:\n• Nodes 01–08 reserved for vision pipeline.\n• Daily checkpoint wipe at 04:00 UTC.\n• Mount scratch array via /mnt/scratch/shared.',
      },
      {
        id: 'b-106',
        type: 'fileAttachment',
        fileName: 'slurm_cluster_rules.yaml',
        fileSize: '24.8 KB',
        fileExt: 'yaml',
      },
    ],
  },
  {
    id: 'file-2',
    folderId: 'f-2',
    name: 'Robotics Vision Calibration',
    createdAt: 1700000001000,
    updatedAt: Date.now() - 60 * 60 * 1000,
    blocks: [
      {
        id: 'b-201',
        type: 'heading',
        content: 'LiDAR Extrinsic Calibration Matrices',
      },
      {
        id: 'b-202',
        type: 'shortText',
        label: 'Optical Frequency',
        value: '64Hz @ 120k pts/sec (Velodyne VLP-16)',
      },
      {
        id: 'b-203',
        type: 'image',
        fileName: 'sensor_rig_alignment.svg',
        caption: 'Dual camera baseline offset (120mm)',
        fileSize: '412 KB',
      },
      {
        id: 'b-204',
        type: 'locked',
        label: 'Calibration Rig Access Token',
        content: 'rig-tok_99182374182937491',
        password: 'pass',
        isLocked: true,
        isUnlocked: false,
      },
      {
        id: 'b-205',
        type: 'fileAttachment',
        fileName: 'calibration_weights_v4.bin',
        fileSize: '14.2 MB',
        fileExt: 'bin',
      },
    ],
  },
  {
    id: 'file-3',
    folderId: 'f-1',
    name: 'SSH Bastion Tunnels',
    createdAt: 1700000002000,
    updatedAt: Date.now() - 24 * 60 * 60 * 1000,
    blocks: [
      {
        id: 'b-301',
        type: 'heading',
        content: 'Internal Datacenter Gateway',
      },
      {
        id: 'b-302',
        type: 'shortText',
        label: 'Bastion IPv4',
        value: '10.240.18.2',
      },
      {
        id: 'b-303',
        type: 'locked',
        label: 'Ed25519 Private Key',
        content: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGf3Q+qF91Q97X28... admin@qrbit',
        password: 'pass',
        isLocked: true,
        isUnlocked: false,
      },
    ],
  },
  {
    id: 'file-4',
    folderId: 'f-3',
    name: 'Site Survey Telemetry Alpha',
    createdAt: 1700000003000,
    updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    blocks: [
      {
        id: 'b-401',
        type: 'heading',
        content: 'Antenna Array Coordinates',
      },
      {
        id: 'b-402',
        type: 'shortText',
        label: 'Base Station Lat/Long',
        value: '37.7749° N, 122.4194° W',
      },
      {
        id: 'b-403',
        type: 'richText',
        content:
          'Signal degradation observed beyond 450m radius when omnidirectional repeater is unpowered.',
      },
    ],
  },
]

/** Seeds initial folders and files if database is currently empty. */
export async function seedInitialLibrary(): Promise<void> {
  const db = await getDatabase()
  const existingFolders = await db.getAll('folders')
  const existingFiles = await db.getAll('files')

  if (existingFolders.length === 0 && existingFiles.length === 0) {
    const tx = db.transaction(['folders', 'files'], 'readwrite')
    for (const folder of INITIAL_FOLDERS) {
      await tx.objectStore('folders').put(folder)
    }
    for (const file of INITIAL_FILES) {
      await tx.objectStore('files').put(file)
    }
    await tx.done
  }
}


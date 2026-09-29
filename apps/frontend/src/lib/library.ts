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
import { moveIndex, needsRenumber, nextSortOrder, SORT_ORDER_GAP } from './reorder'

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
  /**
   * The folder's position among the folders that share its `parentId`, for drag-reordering
   * (ORCHESTRATION D16, extended from dossiers to folders).
   *
   * The same gap-based scheme as `LibraryFile.sortOrder`: `reorderFolder` writes the midpoint
   * of the two new neighbours (see `lib/reorder.ts`), so a reorder rewrites one record instead
   * of the whole sibling run. Library data, not session data — this is allowed to be persisted
   * (AGENTS.md).
   *
   * Absent means "never ordered": such a folder reads *after* every sibling that has one, and
   * that is what puts a newly created folder at the end of its parent's run and keeps folders
   * written before this field existed in their old createdAt order. The first reorder of a
   * sibling run materialises values for the whole run.
   *
   * Siblings only. The number is never compared across parent groups (`compareFolders`,
   * `siblingFolders`), so a root folder and a subfolder may both hold 1000.
   */
  sortOrder?: number
}

export type BlockType =
  | 'heading'
  | 'shortText'
  | 'richText'
  | 'image'
  | 'fileAttachment'
  | 'locked'
  | 'divider'

/**
 * A block's encrypted payload — exactly the PLAN.md §6.1 / §11.4 tuple, plus the note of
 * what the plaintext was so a reveal can decode it.
 *
 * The byte fields are typed as `Uint8Array` and nothing else (they used to allow `string`,
 * which every reader then had to guess how to convert): `encryptItem` emits bytes, IDB
 * structured-clone returns bytes, and `parseBlock` normalises whatever an engine handed back
 * through the same fixed-width checks a locked *item* gets (`readFixedBytes`). A tuple that
 * does not satisfy them is not a tuple — see `lockedTupleOf`.
 */
export interface EncryptedBlockData {
  /** AES-256-GCM output: the plaintext plus its 16-byte tag. */
  ciphertext: Uint8Array
  /** 12 bytes (PLAN.md §6.1, §11.4). */
  iv: Uint8Array
  /** 16 bytes (PLAN.md §6.1, §11.4). */
  salt: Uint8Array
  /** What was encrypted: `fileAttachment` for bytes, a text kind otherwise. */
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
  /**
   * The row's lock INTENT — set when the user asks for a protected block, cleared when they
   * remove the lock. It is not evidence of encryption and must never be read as such: a block
   * is encrypted if and only if `lockedTupleOf` returns a tuple, which is what
   * `isProtectedBlock` answers. A row written before this rule existed can legitimately carry
   * `isLocked: true` with nothing but plaintext in it — that is the unprotected state
   * `isUnprotectedSecretBlock` names, and the UI shows it as a warning, never as a badge.
   */
  isLocked?: boolean
  /** The encrypted payload. The ONLY protected form a block is stored in. */
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
  /**
   * The file's position within its folder, for drag-reordering (ORCHESTRATION D16).
   *
   * Gap-based, not dense: `reorderFile` writes the midpoint of the two new neighbours
   * (see `lib/reorder.ts`), so a reorder rewrites one record instead of the whole run.
   * Library data, not session data — this is allowed to be persisted (AGENTS.md).
   *
   * Absent means "never ordered": such a file reads *after* every file in the folder that
   * has one, which is what puts a newly created dossier at the end of its list, and what
   * keeps dossiers written before this field existed in their old createdAt order. The
   * first reorder of a folder materialises values for the whole run.
   */
  sortOrder?: number
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

const FOLDER_FIELDS: readonly string[] = [
  'id',
  'name',
  'color',
  'parentId',
  'createdAt',
  'updatedAt',
  'sortOrder',
]

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
 * An optional `sortOrder`, read the one way both orderable kinds are read.
 *
 * Absent or `null` means "never ordered" (the row reads last within its run). Anything else
 * present must be a safe integer: the gap arithmetic halves the distance between two
 * neighbours, so a float, a string or a value past the safe range cannot be trusted to hold a
 * position and is rejected as garbage rather than silently reordered. Negative positions are
 * legal — a row dragged above a run that starts at 0 pushes it down, and the run is
 * renumbered before it can overflow.
 */
function readSortOrder(record: Record<string, unknown>, what: string): number | undefined {
  const value = record['sortOrder']
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`library: ${what} needs an integer "sortOrder" (got ${JSON.stringify(value)})`)
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

  const folder: LibraryFolder = {
    id: requireId(readString(value, 'id', 'folder'), 'a folder'),
    name: requireName(readString(value, 'name', 'folder'), 'a folder'),
    color,
    parentId,
    createdAt: readTimestamp(value, 'createdAt', 'folder'),
    updatedAt: readTimestamp(value, 'updatedAt', 'folder'),
  }

  // Read strictly through the shared `sortOrder` rule, and carried back out: `saveFolder`
  // stores what `parseFolder` returns, so a dropped field here would silently teleport every
  // imported folder to the end of its parent's run.
  const position = readSortOrder(value, 'a folder')
  if (position !== undefined) folder.sortOrder = position

  return folder
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

/**
 * The sibling-group key of a parent id: `null` and the root's own id name the same group.
 *
 * The validating rule of `normaliseParentId` without the throw, for comparing parent ids that
 * have already been parsed — a stored `parentId` was written through `normaliseParentId`, so
 * only `null` and real folder ids occur, and a read path must not fail on data the writer
 * would have rejected anyway.
 */
function parentKey(parentId: string | null): string | null {
  return parentId === null || parentId === ROOT_FOLDER_ID ? null : parentId
}

/** How a parent is named in a message: the root has no row, so it is named for what it is. */
function describeParent(parentId: string | null): string {
  return parentId === null ? 'the root' : `folder "${parentId}"`
}

function compareNames(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * The one order folders are ever read in: drag order first, then age, then id.
 *
 * The dossier rule (`compareFiles`) applied to folders, for the same reasons: `updatedAt` plays
 * no part, so renaming a folder or writing a file into it cannot teleport it, and the tiebreak
 * is total (`id` is unique) so the same records always read back in the same sequence and
 * nothing jitters between two renders.
 *
 * Positions are only ever compared inside one sibling group (`siblingFolders`,
 * `reorderFolder`), which is what makes a root run and a subfolder run independent.
 */
function compareFolders(a: LibraryFolder, b: LibraryFolder): number {
  const left = a.sortOrder
  const right = b.sortOrder
  if (left === undefined || right === undefined) {
    if (left !== undefined) return -1
    if (right !== undefined) return 1
  } else if (left !== right) {
    return left < right ? -1 : 1
  }
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return compareNames(a.id, b.id)
}

// ---------------------------------------------------------------------------
// Folders (PLAN.md §6.3)
// ---------------------------------------------------------------------------

/**
 * Every folder, in the order the library shows them (see `compareFolders`).
 *
 * Drag order first; folders nobody has ordered read oldest first, which is how they looked
 * before `sortOrder` existed. Grouped by parent for the UI with `siblingFolders`.
 */
export async function getFolders(): Promise<LibraryFolder[]> {
  const db = await getDatabase()
  const folders = (await db.getAll('folders')).map(parseFolder)
  return folders.sort(compareFolders)
}

/**
 * The folders directly under `parentId`, in the order the library shows them.
 *
 * A reorder index only means something inside one sibling group, and a panel only renders one
 * group at a time, so the grouping is this module's rule rather than each component's: this
 * is the read side of `reorderFolder` and the two cannot disagree. `null` and `ROOT_FOLDER_ID`
 * name the same group — the root has no row (§6.1). A caller holding `getFolders()` and a
 * caller holding a shuffled list get the same answer, because the order is total.
 */
export function siblingFolders(
  folders: readonly LibraryFolder[],
  parentId: string | null,
): LibraryFolder[] {
  const parent = parentKey(parentId)
  return folders
    .filter((folder) => parentKey(folder.parentId) === parent)
    .sort(compareFolders)
}

export async function createFolder(
  name: string,
  parentId: string | null,
  color?: string,
): Promise<LibraryFolder> {
  const folderName = requireName(name, 'a folder')
  const parent = normaliseParentId(parentId)
  const now = Date.now()
  // No `sortOrder`, which is what places it last: an unordered row reads after every ordered
  // sibling (see `compareFolders`), exactly as `createFile` leaves a new dossier at the end of
  // its folder. The first reorder of the run gives every folder in it a position.
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

  // Spread of the stored record, so a rename changes `name` and `updatedAt` and nothing else:
  // the folder keeps its `sortOrder` and therefore its place in its parent's run (D16).
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

/**
 * Moves a folder to a new position among the folders that share its parent (ORCHESTRATION
 * D16 — the dossier ordering scheme applied to folders).
 *
 * **Sibling-scoped, and that is where the scoping lives.** `targetIndex` counts only the
 * folders whose parent key equals the moved folder's own (the same `parentKey` the read side
 * uses, so the two cannot disagree): `ordered` below is filtered to that group before the
 * index is interpreted, and only rows of that group are ever written. Reordering the top level
 * therefore cannot shuffle a subfolder out of its parent, and the root run and a subfolder run
 * are independent even when they use the same numbers. Moving a folder between parents is not
 * this function's job — the library layer has no `moveFolder` (PLAN.md §6.3).
 *
 * `targetIndex` is the index the folder should end up at in that sibling list *as it reads
 * now*, including itself: the convention `lib/reorder.ts` `moveIndex` implements and the one
 * `onMove(from, to)` hands the UI. Pass `parentId` when the caller knows which group it was
 * showing — `null` is the root, and `ROOT_FOLDER_ID` is accepted as its alias — because an
 * index counted against another group's list would move the wrong row, so a mismatch throws
 * instead of writing.
 *
 * In the common case one record is written — the midpoint of its two new neighbours — and the
 * rest of the run is untouched. The whole sibling run is rewritten only when the gap has
 * collapsed (`nextSortOrder` answers `REENUMBER_REQUIRED`), when a sibling carries no
 * `sortOrder` yet, or when the run would leave the safe integer range. `updatedAt` is left
 * alone: a reorder is not an edit.
 */
export async function reorderFolder(
  id: string,
  targetIndex: number,
  parentId?: string | null,
): Promise<void> {
  const folderId = requireId(id, 'reorderFolder')
  if (folderId === ROOT_FOLDER_ID) throw new Error('library: the root folder cannot be reordered')
  if (typeof targetIndex !== 'number' || !Number.isInteger(targetIndex) || targetIndex < 0) {
    throw new Error(
      `library: reorderFolder needs a non-negative integer index (got ${JSON.stringify(targetIndex)})`,
    )
  }
  const expectedParent = parentId === undefined ? undefined : normaliseParentId(parentId)

  const db = await getDatabase()
  // `folders` only: a reorder rewrites rows of this one store, and — unlike `reorderFile`,
  // which has to check that the folder a dossier sits in still exists — there is no container
  // to verify here. A stored parent either has a row (`createFolder` requires one, `saveFolder`
  // rewrites an unknown one as the root) or is the root itself, and `deleteFolder` cascades, so
  // a folder with a missing parent cannot be stored in the first place.
  const tx = db.transaction('folders', 'readwrite')
  const store = tx.objectStore('folders')
  const existing = await store.get(folderId)
  if (existing === undefined) throw new Error(`library: no folder with id "${folderId}"`)

  const moved = parseFolder(existing)
  const parent = parentKey(moved.parentId)
  if (expectedParent !== undefined && expectedParent !== parent) {
    throw new Error(
      `library: reorderFolder was given parent ${describeParent(expectedParent)} but folder "${folderId}" lives in ${describeParent(parent)}`,
    )
  }

  const ordered = siblingFolders((await store.getAll()).map(parseFolder), parent)
  const from = ordered.findIndex((folder) => folder.id === folderId)
  if (targetIndex >= ordered.length) {
    throw new Error(
      `library: reorderFolder index ${targetIndex} is out of range for ${ordered.length} folders in ${describeParent(parent)}`,
    )
  }
  if (from === targetIndex) {
    // Dropped where it was: not an error, and not a write.
    await tx.done
    return
  }

  const siblings = ordered.filter((folder) => folder.id !== folderId)
  const positions = sortOrdersOf(siblings)
  if (positions !== null) {
    const value = nextSortOrder(positions, targetIndex, moved.sortOrder)
    if (!needsRenumber(value)) {
      if (value !== moved.sortOrder) {
        await store.put({ ...moved, sortOrder: value })
      }
      await tx.done
      return
    }
  }

  // The gap cannot hold another position, or part of the run was never ordered: give the whole
  // sibling group a fresh spacing, in the order the user just asked for.
  for (const folder of withRenumberedOrder(moveIndex(ordered, from, targetIndex))) {
    await store.put(folder)
  }
  await tx.done
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

/**
 * A block's encrypted payload, validated by the same fixed-width rules a locked ITEM's is.
 *
 * `parseItem` refuses to store a 1-byte IV or a 5000-byte salt (see the comment on
 * `readFixedBytes`); a block is held to the same rule, because a tuple that fails it can never
 * be opened — Web Crypto raises `OperationError` on every attempt — while its presence would
 * let the row render a lock badge over plaintext. So an unusable `lockedData` is dropped rather
 * than trusted, and the block reads as what it actually is: unprotected.
 *
 * Dropping rather than throwing is deliberate on this path. `parseFile` runs on every read of
 * every dossier, so a throw here would make one damaged block unloadable and lock the whole
 * editor out of the dossier; a drop leaves the row editable, honest, and one `Lock` press away
 * from real ciphertext.
 */
function lockedDataOf(value: unknown): EncryptedBlockData | null {
  if (!isRecord(value)) return null

  let ciphertext: Uint8Array
  let iv: Uint8Array
  let salt: Uint8Array
  try {
    ciphertext = readBytes(value, 'ciphertext', 'locked block')
    iv = readFixedBytes(value, 'iv', 'locked block', LOCKED_IV_BYTE_LENGTH)
    salt = readFixedBytes(value, 'salt', 'locked block', LOCKED_SALT_BYTE_LENGTH)
  } catch {
    return null
  }

  return {
    ciphertext,
    iv,
    salt,
    // Only when it is one: `{ ciphertext, iv, salt }` is the stored shape (PLAN.md §6.1), so an
    // unknown or absent `innerType` is left out of the record rather than carried as a key
    // whose value is `undefined`.
    ...(isBlockType(value['innerType']) ? { innerType: value['innerType'] } : {}),
  }
}

/**
 * The one reading of a stored (or to-be-stored) block, shared by every read and every write.
 *
 * Three rules live here because they are the rules a dossier's protection rests on:
 *
 *   - **A password is not a field of a block, in either direction.** `FileBlock` has no
 *     `password` (PLAN.md §6.2: the key is derived on unlock and stored nowhere), and because
 *     every write stores what this function returns, a `password` on a row written by an older
 *     build is dropped the first time that dossier is saved. It is never read into app state,
 *     so no code can compare against it.
 *   - **A block that carries a real tuple carries no plaintext.** `content`, `value` and `blob`
 *     are the payload the tuple was made from; keeping them beside it is plaintext at rest,
 *     which is the defect this file exists to make impossible. Metadata (`fileName`, `fileSize`,
 *     `mimeType`, `label`) survives — it is not the secret and the row needs it to say what the
 *     ciphertext is.
 *   - **Nothing outside this shape is stored.** An unknown key is not copied, exactly as
 *     `assertKnownFields` rejects one on an item; blocks keep the lenient read because legacy
 *     rows must still open, but they are written from the same whitelist either way. Nor is
 *     `isUnlocked`: a reveal is in-memory state, and storing it would persist "this block is
 *     open" next to a payload that the rule above just refused to write down.
 */
export function parseBlock(value: unknown): FileBlock {
  if (!isRecord(value)) throw new Error('library: a block must be an object')
  const id = requireId(readString(value, 'id', 'block'), 'block')
  const rawType = value['type']
  const type: BlockType = isBlockType(rawType) ? rawType : 'shortText'

  const block: FileBlock = {
    id,
    type,
  }

  const lockedData = lockedDataOf(value['lockedData'])
  const encrypted = lockedData !== null

  if (typeof value['label'] === 'string') block.label = value['label']
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

  if (!encrypted) {
    if (typeof value['content'] === 'string') block.content = value['content']
    if (typeof value['value'] === 'string') block.value = value['value']
    if (value['blob'] instanceof Blob) block.blob = value['blob']
  }

  if (lockedData !== null) block.lockedData = lockedData

  return block
}

/**
 * The block's usable `{ ciphertext, iv, salt }`, or `null` when it has none.
 *
 * The single answer to "is this block's payload actually encrypted?" for the whole app — the
 * send path (decision D9: this tuple travels byte-for-byte and is never re-encrypted), the
 * editor's badge, and the unlock form all read it here so they cannot disagree.
 */
export function lockedTupleOf(block: FileBlock): EncryptedBlockData | null {
  return lockedDataOf(block.lockedData)
}

/** True only when the payload is really stored as ciphertext — never from the lock flag alone. */
export function isProtectedBlock(block: FileBlock): boolean {
  return lockedTupleOf(block) !== null
}

/** Does this block hold a plaintext payload of any kind (text, a value, or bytes)? */
function hasPlaintextPayload(block: FileBlock): boolean {
  if (block.blob instanceof Blob && block.blob.size > 0) return true
  const text = block.content ?? block.value
  return typeof text === 'string' && text !== ''
}

/** Did the user ask for this block to be a protected secret (by type or by the lock flag)? */
export function isLockedIntent(block: FileBlock): boolean {
  return block.type === 'locked' || block.isLocked === true
}

/**
 * A block the user means to be secret that is stored as plaintext.
 *
 * This is the legacy state (rows written while `parseBlock` persisted `password` and plaintext
 * side by side) and the in-progress state (a secret typed into a new locked block that has not
 * been encrypted yet). Either way the row must say "not encrypted", wear no lock badge, and
 * encrypt on save when the user supplies the password — never quietly pretend otherwise.
 */
export function isUnprotectedSecretBlock(block: FileBlock): boolean {
  return isLockedIntent(block) && !isProtectedBlock(block) && hasPlaintextPayload(block)
}

/**
 * Every block in `file` that is meant to be secret and is not encrypted.
 *
 * The editor's Save path asks about these: it cannot encrypt without a password, and inventing
 * one is what made the old "Encrypted" badge a lie. So it asks the user, in the foreground, at
 * the moment they press Save.
 */
export function unprotectedSecretBlocks(file: LibraryFile): FileBlock[] {
  return file.blocks.filter(isUnprotectedSecretBlock)
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

  const file: LibraryFile = {
    id,
    folderId,
    name,
    createdAt,
    updatedAt,
    blocks,
  }

  // `sortOrder` is the one optional field a file may carry, read through the same strict rule
  // a folder's is (see `readSortOrder`).
  const position = readSortOrder(value, 'a file')
  if (position !== undefined) file.sortOrder = position

  return file
}

/**
 * The one order files are ever read in: drag order first, then age, then id.
 *
 * `updatedAt` deliberately plays no part — a rename or an edit must not teleport a row the
 * user put somewhere by hand. The tiebreak is total (`id` is unique), so the same set of
 * records always reads back in the same sequence: nothing jitters between two renders.
 *
 * A file with no `sortOrder` sorts after every file that has one, then among the unscored
 * by `createdAt` and `id` (see `LibraryFile.sortOrder`).
 */
function compareFiles(a: LibraryFile, b: LibraryFile): number {
  const left = a.sortOrder
  const right = b.sortOrder
  if (left === undefined || right === undefined) {
    if (left !== undefined) return -1
    if (right !== undefined) return 1
  } else if (left !== right) {
    return left < right ? -1 : 1
  }
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return compareNames(a.id, b.id)
}

/** Every file in the library, in the order the library shows them (see `compareFiles`). */
export async function getFiles(): Promise<LibraryFile[]> {
  const db = await getDatabase()
  const files = (await db.getAll('files')).map(parseFile)
  return files.sort(compareFiles)
}

/** The files directly in `folderId`, in the order the library shows them (see `compareFiles`). */
export async function getFilesInFolder(folderId: string): Promise<LibraryFile[]> {
  const target = requireId(folderId, 'getFilesInFolder')
  const db = await getDatabase()
  const files = (await db.getAllFromIndex('files', 'folderId', target)).map(parseFile)
  return files.sort(compareFiles)
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

/**
 * Moves a file to another folder and places it at the END of that folder's order.
 *
 * Without a `sortOrder` write here, a moved file would keep the position it had in the
 * folder it left and could land in the middle of the destination list — or, if its old
 * neighbours were ordered and the destination was not, jump to its top.
 */
export async function moveFile(id: string, targetFolderId: string): Promise<void> {
  const fileId = requireId(id, 'moveFile')
  const target = requireId(targetFolderId, 'moveFile')
  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items', 'files'], 'readwrite')
  await requireFolder(tx, target)
  const store = tx.objectStore('files')
  const existing = await store.get(fileId)
  if (existing === undefined) throw new Error(`library: no file with id "${fileId}"`)

  const moved = parseFile({ ...existing, folderId: target, updatedAt: Date.now() })
  const siblings = (await store.index('folderId').getAll(target))
    .map(parseFile)
    .filter((file) => file.id !== fileId)
    .sort(compareFiles)

  const end = endSortOrder(siblings)
  if (end === null) {
    // The destination run cannot accept an appended position (something in it is not
    // ordered yet): rewrite it, with the moved file last.
    for (const file of withRenumberedOrder([...siblings, moved])) {
      await store.put(file)
    }
  } else {
    await store.put({ ...moved, sortOrder: end })
  }
  await tx.done
}

/**
 * Moves a file to a new position inside the folder that already holds it
 * (ORCHESTRATION D16.1/D16.3 — the persisted half of a drag or an arrow-key press).
 *
 * `targetIndex` is the index the file should end up at *in the list as it reads now*,
 * including the file itself, which is the same convention `lib/reorder.ts` `moveIndex`
 * uses and the same one `onMove(from, to)` hands the UI. Pass `folderId` when the caller
 * knows which folder it was showing: it is checked against what is stored, because an
 * index counted against another folder's list would move the wrong row.
 *
 * `updatedAt` is left alone: a reorder is not an edit, and a row must not look freshly
 * modified because someone dragged its grip. In the common case one record is written —
 * the midpoint of its new neighbours — and the rest of the folder is untouched. The whole
 * sibling run is rewritten only when the gap has collapsed (`nextSortOrder` says
 * `RENUMBER_REQUIRED`), when a sibling carries no `sortOrder` yet, or when the run would
 * overflow the safe integer range; then every file in the folder gets a fresh
 * `SORT_ORDER_GAP` spacing in one transaction.
 */
export async function reorderFile(id: string, targetIndex: number, folderId?: string): Promise<void> {
  const fileId = requireId(id, 'reorderFile')
  if (typeof targetIndex !== 'number' || !Number.isInteger(targetIndex) || targetIndex < 0) {
    throw new Error(`library: reorderFile needs a non-negative integer index (got ${JSON.stringify(targetIndex)})`)
  }
  const folder = folderId === undefined ? undefined : requireId(folderId, 'reorderFile')

  const db = await getDatabase()
  const tx = db.transaction(['folders', 'items', 'files'], 'readwrite')
  const store = tx.objectStore('files')
  const existing = await store.get(fileId)
  if (existing === undefined) throw new Error(`library: no file with id "${fileId}"`)

  const moved = parseFile(existing)
  if (folder !== undefined && moved.folderId !== folder) {
    throw new Error(
      `library: reorderFile was given folder "${folder}" but file "${fileId}" lives in "${moved.folderId}"`,
    )
  }
  await requireFolder(tx, moved.folderId)

  const ordered = (await store.index('folderId').getAll(moved.folderId)).map(parseFile).sort(compareFiles)
  const from = ordered.findIndex((file) => file.id === fileId)
  if (targetIndex >= ordered.length) {
    throw new Error(
      `library: reorderFile index ${targetIndex} is out of range for ${ordered.length} files in folder "${moved.folderId}"`,
    )
  }
  if (from === targetIndex) {
    // Dropped where it was: not an error, and not a write.
    await tx.done
    return
  }

  const siblings = ordered.filter((file) => file.id !== fileId)
  const positions = sortOrdersOf(siblings)
  if (positions !== null) {
    const value = nextSortOrder(positions, targetIndex, moved.sortOrder)
    if (!needsRenumber(value)) {
      if (value !== moved.sortOrder) {
        await store.put({ ...moved, sortOrder: value })
      }
      await tx.done
      return
    }
  }

  for (const file of withRenumberedOrder(moveIndex(ordered, from, targetIndex))) {
    await store.put(file)
  }
  await tx.done
}

/**
 * A record that can hold a position within its own run: a dossier in its folder, or a folder
 * among the siblings under its parent. Both are ordered by the same arithmetic.
 */
interface Orderable {
  sortOrder?: number
}

/**
 * The position that lands a record after `siblings`, which must already be in display
 * order, or `null` when the run has to be renumbered instead: a sibling carries no
 * `sortOrder`, the values do not ascend (a hand-edited or half-migrated folder, which the
 * read order cannot be trusted to reflect), or the appended gap would leave the safe
 * integer range.
 */
function endSortOrder(siblings: readonly Orderable[]): number | null {
  let previous: number | null = null
  for (const sibling of siblings) {
    const position = sibling.sortOrder
    if (typeof position !== 'number') return null
    if (previous !== null && position <= previous) return null
    previous = position
  }
  if (previous === null) return SORT_ORDER_GAP
  const appended = previous + SORT_ORDER_GAP
  return Number.isSafeInteger(appended) ? appended : null
}

/**
 * The run's `sortOrder` values in display order, or `null` when a row carries none.
 *
 * `null` means the gap rule has nothing to work between, so the caller renumbers.
 */
function sortOrdersOf(ordered: readonly Orderable[]): number[] | null {
  const positions: number[] = []
  for (const file of ordered) {
    if (typeof file.sortOrder !== 'number') return null
    positions.push(file.sortOrder)
  }
  return positions
}

/**
 * The same records, renumbered to `SORT_ORDER_GAP` spacing in the order given.
 *
 * The fallback both `reorderFile`/`reorderFolder` and `moveFile` take when a single gap-based
 * write is not possible. It is a fresh full-gap run rather than a compaction, so the next
 * hundred drags in that run each cost one write again.
 */
function withRenumberedOrder<T extends Orderable>(ordered: readonly T[]): T[] {
  return ordered.map((row, index) => ({ ...row, sortOrder: (index + 1) * SORT_ORDER_GAP }))
}


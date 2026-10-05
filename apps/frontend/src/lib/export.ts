/**
 * Library export / import (PLAN.md §14) — the whole local library, or a chosen
 * part of it, as one `.qrbit` file.
 *
 * Two shapes of file come out of here, and the first four bytes tell them apart:
 *
 *   - a plain JSON manifest, `application/json`;
 *   - the same manifest UTF-8 encoded and encrypted through `crypto.encryptExport`
 *     (§11.5), prefixed with the 4-byte magic `QRBE` and served as
 *     `application/octet-stream`.
 *
 * The magic is the only reliable discriminator: an encrypted export is binary, so
 * sniffing the JSON is not an option, and a header costs four bytes. It is read
 * before anything else, by `importLibrary` and by the Settings UI, which needs to
 * know whether to ask for a password.
 *
 * Locked items are the one thing that never changes shape here. PLAN.md §14 and
 * §19 decision 4 require them to travel as their `{ciphertext, iv, salt}` tuple
 * whether or not the outer file is encrypted — so an unencrypted `.qrbit` still
 * holds them as opaque ciphertext, and an encrypted one double-locks them. This
 * module therefore never calls `decryptItem`/`encryptItem`: a locked item is
 * copied byte-for-byte into base64 and back, which is also why forwarding one
 * needs no password (decision D9).
 *
 * IndexedDB belongs to `lib/library.ts`: this module reads and writes through its
 * functions and re-implements no query, no validation and no cascade. The one
 * additive seam it needs is `saveFolder`, because a manifest carries folder ids
 * and the library has no other way to restore a folder under its own id.
 *
 * Import is a merge, never a replace: a row whose id is already in the library is
 * skipped, so re-importing the same file is harmless. A row that cannot be stored
 * is reported in `errors` and the import carries on — one bad item must not cost
 * the user the other four hundred.
 */

import { decryptExport, encryptExport, fromBase64, toBase64 } from './crypto'
import {
  getFolders,
  getItem,
  getItemsInFolder,
  ROOT_FOLDER_ID,
  saveFolder,
  saveItem,
  type LibraryFileItem,
  type LibraryFolder,
  type LibraryImageItem,
  type LibraryItem,
  type LibraryLockedItem,
  type LibraryRichTextItem,
  type LibraryTextItem,
} from './library'

/** The manifest schema version this module writes and is willing to read (§14). */
export const EXPORT_VERSION = 1

/** The §14 file extension. The name is a convention; the header is the contract. */
export const EXPORT_FILE_EXTENSION = '.qrbit'

/**
 * The first four bytes of an encrypted export: 'QRBE' in ASCII.
 *
 * A constant rather than a literal so the writer, the reader and
 * `isEncryptedExport` cannot drift. Writing it as bytes (not a string) keeps the
 * comparison free of any text encoding question.
 */
const MAGIC_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([0x51, 0x52, 0x42, 0x45])

const JSON_MIME_TYPE = 'application/json'
const ENCRYPTED_MIME_TYPE = 'application/octet-stream'

/** The one message a failed decryption gets, whatever Web Crypto named the failure. */
const WRONG_PASSWORD_MESSAGE = 'Wrong password or corrupted file'

const NOT_EXPORT_MESSAGE = 'This file is not a QRward library export.'

// ---------------------------------------------------------------------------
// Manifest types (PLAN.md §14)
// ---------------------------------------------------------------------------

/** A locked item's byte tuple as it travels in JSON: base64 text, never `Uint8Array`. */
export interface LockedTupleExport {
  /** base64 of the AES-256-GCM ciphertext (plaintext plus the 16-byte tag). */
  ciphertext: string
  /** base64 of the 12-byte GCM IV. */
  iv: string
  /** base64 of the 16-byte PBKDF2 salt. */
  salt: string
}

/** A §6.1 locked row with its tuple serialized, so `JSON.stringify` cannot mangle it. */
export type LibraryLockedItemExport = Omit<LibraryLockedItem, 'ciphertext' | 'iv' | 'salt'> &
  LockedTupleExport

/**
 * An item's §6.1 row minus the `Blob`, which JSON cannot carry.
 *
 * Image and file items move their bytes to `blobData` on the wrapper below; text,
 * richtext and locked rows are carried whole (locked ones with base64 bytes).
 */
export type LibraryItemExportMeta =
  | LibraryTextItem
  | LibraryRichTextItem
  | Omit<LibraryImageItem, 'blob'>
  | Omit<LibraryFileItem, 'blob'>
  | LibraryLockedItemExport

/** One exported item: its row, plus its bytes in base64 when it has any (§14). */
export interface LibraryItemExport {
  meta: LibraryItemExportMeta
  /** The item's bytes as base64 — image and file items only. */
  blobData?: string
  /** The blob's MIME type, `meta.mimeType` repeated for a self-describing file. */
  blobMimeType?: string
}

/** The `.qrbit` payload (PLAN.md §14). */
export interface ExportManifest {
  version: typeof EXPORT_VERSION
  exportedAt: number
  /** Whether THIS FILE is encrypted. Locked items are encrypted either way (§19.4). */
  encrypted: boolean
  folders: LibraryFolder[]
  items: LibraryItemExport[]
}

/** What `importLibrary` reports back. */
export interface ImportResult {
  /** Items actually stored; a duplicate skipped by id is not counted. */
  imported: number
  /** One human-readable line per row that could not be stored. */
  errors: string[]
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** One stored item as a manifest entry, reading its blob when it has one. */
async function itemToExport(item: LibraryItem): Promise<LibraryItemExport> {
  switch (item.type) {
    case 'text':
    case 'richtext':
      return { meta: item }

    case 'image':
    case 'file': {
      // The row survives whole; only the bytes move out to `blobData`, which is
      // the one thing JSON cannot represent. `blob` is dropped by the rest
      // destructure, so it cannot be serialized by accident.
      const { blob, ...meta } = item
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return { meta, blobData: toBase64(bytes), blobMimeType: meta.mimeType }
    }

    case 'locked':
      // Never decrypted, never re-encrypted: the stored tuple is copied into
      // base64 exactly as it sits in IndexedDB (§14, §19.4).
      return {
        meta: {
          ...item,
          ciphertext: toBase64(item.ciphertext),
          iv: toBase64(item.iv),
          salt: toBase64(item.salt),
        },
      }
  }
}

/**
 * The manifest for the requested scope.
 *
 * `'all'` takes every folder, every item inside them and the items in the root.
 * An explicit id list takes exactly those folders and their items — an item in the
 * root is not "inside" a folder, so it is excluded — and the folders appear in the
 * library's own order. Ids that name no folder are ignored rather than rejected:
 * the scope is a selection, and a stale id must not fail the export.
 */
async function buildManifest(
  folderIds: string[] | 'all',
  encrypted: boolean,
): Promise<ExportManifest> {
  const folders = await getFolders()
  const selected = folderIds === 'all' ? folders : folders.filter((folder) => folderIds.includes(folder.id))

  const rootItems = folderIds === 'all' ? await getItemsInFolder(ROOT_FOLDER_ID) : []
  const folderItems = await Promise.all(selected.map((folder) => getItemsInFolder(folder.id)))
  const items = [...rootItems, ...folderItems.flat()]

  return {
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    encrypted,
    folders: selected,
    items: await Promise.all(items.map(itemToExport)),
  }
}

/**
 * Serializes the library (or the selected folders) to a `.qrbit` file (§14).
 *
 * With `encrypt: false` the result is the JSON manifest, readable by anyone who
 * opens the file — except for locked items, which stay opaque inside it. With
 * `encrypt: true` the same JSON is encrypted under the password and the file is
 * binary: `QRBE` then `crypto.encryptExport`'s envelope. A missing password is a
 * programming error, not a user one (the UI will not offer the encrypted path
 * without one), so it throws.
 */
export async function exportLibrary(
  folderIds: string[] | 'all',
  options: { encrypt: boolean; password?: string },
): Promise<Blob> {
  const manifest = await buildManifest(folderIds, options.encrypt)
  const json = new TextEncoder().encode(JSON.stringify(manifest))

  if (!options.encrypt) {
    return new Blob([json], { type: JSON_MIME_TYPE })
  }

  const password = options.password
  if (password === undefined || password === '') {
    throw new Error('export: encrypting a library export needs a password')
  }

  const envelope = new Uint8Array(await encryptExport(password, json))
  const file = new Uint8Array(MAGIC_BYTES.byteLength + envelope.byteLength)
  file.set(MAGIC_BYTES, 0)
  file.set(envelope, MAGIC_BYTES.byteLength)
  return new Blob([file], { type: ENCRYPTED_MIME_TYPE })
}

/** `qrbit-export-2026-09-15.qrbit` — the §14 name with an ISO date. */
export function suggestExportFilename(now: Date): string {
  return `qrbit-export-${now.toISOString().slice(0, 10)}${EXPORT_FILE_EXTENSION}`
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Whether `file` begins with the encrypted-export magic. Reads four bytes only. */
export async function isEncryptedExport(file: Blob): Promise<boolean> {
  if (file.size < MAGIC_BYTES.byteLength) return false
  const header = new Uint8Array(await file.slice(0, MAGIC_BYTES.byteLength).arrayBuffer())
  return MAGIC_BYTES.every((byte, index) => header[index] === byte)
}

/** The manifest after envelope validation, with its rows still untrusted. */
interface ParsedManifest {
  folders: unknown[]
  items: unknown[]
}

/**
 * Reads a `.qrbit` file and merges it into the library (§14).
 *
 * Folders are written before items, parents before children, because an item can
 * only be stored where a folder already exists. Every row is then stored through
 * `library.saveItem`/`saveFolder`, which validate the §6.1 shape; a row that is
 * malformed, or whose folder is missing, is recorded in `errors` instead of
 * aborting the run.
 *
 * Throws only when the file as a whole cannot be opened: an unknown version, a
 * missing password, or a wrong password / corrupted body — the last of which is
 * deliberately one message, since the user cannot tell those two apart either.
 */
export async function importLibrary(
  file: File,
  options: { password?: string },
): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const manifest = hasMagic(bytes)
    ? parseManifest(decodeJson(await decryptBody(bytes, options.password)))
    : parseManifest(decodeJson(bytes))

  const errors: string[] = []
  await importFolders(manifest.folders, errors)

  let imported = 0
  for (let index = 0; index < manifest.items.length; index += 1) {
    const entry = manifest.items[index]
    try {
      const item = itemFromExport(entry)
      // §14: "skips duplicates by id". The library id is the store's key, so an id
      // that is present IS the same row — content and name are never consulted.
      if ((await getItem(item.id)) !== undefined) continue
      await saveItem(item)
      imported += 1
    } catch (cause: unknown) {
      errors.push(`Could not import ${labelFor(entry, manifest.items, index)}: ${messageOf(cause)}`)
    }
  }

  return { imported, errors }
}

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MAGIC_BYTES.byteLength) return false
  return MAGIC_BYTES.every((byte, index) => bytes[index] === byte)
}

/**
 * Decrypts the body of an encrypted export (everything after the magic).
 *
 * Every failure here means the same thing to the user — the password is wrong or
 * the file is damaged — so all of them become one message. Web Crypto reports a
 * failed GCM tag as an `OperationError` DOMException; `decryptExport` raises a
 * plain `Error` for an envelope too short to hold its salt and IV, which is what
 * a truncated file looks like. Neither is fixable by retrying with the same
 * inputs, and neither should reach the user as a stack trace (PLAN.md §17).
 */
async function decryptBody(bytes: Uint8Array, password: string | undefined): Promise<Uint8Array> {
  if (password === undefined || password === '') {
    throw new Error('This export file is encrypted — enter its password to import it.')
  }
  // `slice` copies, so `body.buffer` is exactly the bytes after the magic.
  const body = bytes.slice(MAGIC_BYTES.byteLength)
  try {
    return await decryptExport(password, body.buffer)
  } catch {
    throw new Error(WRONG_PASSWORD_MESSAGE)
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  let text: string
  try {
    // `fatal` so a binary file that is not this app's export fails here rather
    // than turning into replacement characters that JSON.parse rejects anyway.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(NOT_EXPORT_MESSAGE)
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(NOT_EXPORT_MESSAGE)
  }
}

/**
 * Validates the §14 envelope and leaves the rows alone.
 *
 * The rows are checked one at a time while they are imported, so a single bad
 * entry costs one item rather than the file. What is checked here is only what
 * the whole file depends on: that it is an object, that its version is this app's,
 * and that it carries the two arrays.
 */
function parseManifest(value: unknown): ParsedManifest {
  if (!isRecord(value)) throw new Error(NOT_EXPORT_MESSAGE)

  const version = value['version']
  // A file with no version is not one of ours at all; a version that is a number
  // but not ours is ours from a build this app does not know how to read.
  if (typeof version !== 'number') throw new Error(NOT_EXPORT_MESSAGE)
  if (version !== EXPORT_VERSION) {
    throw new Error(
      `Unsupported export version ${version} — this app reads version ${EXPORT_VERSION}.`,
    )
  }

  const folders = value['folders']
  const items = value['items']
  if (!Array.isArray(folders) || !Array.isArray(items)) throw new Error(NOT_EXPORT_MESSAGE)

  return { folders, items }
}

/**
 * Restores the manifest's folders, shallowest first, through `library.saveFolder`.
 *
 * `saveFolder` preserves the id it is given and skips an id that is already
 * stored, so folder ids survive the round trip and a second import of the same
 * file adds nothing. Depth ordering matters because a folder must exist before
 * the folder inside it can be written; a cycle (only a hand-edited file can hold
 * one) is flattened rather than retried forever, and `saveFolder` writes a parent
 * that is still missing as the root.
 */
async function importFolders(folders: readonly unknown[], errors: string[]): Promise<void> {
  const parsed: LibraryFolder[] = []
  for (let index = 0; index < folders.length; index += 1) {
    try {
      parsed.push(folderFromExport(folders[index]))
    } catch (cause: unknown) {
      errors.push(`Could not import folder ${index + 1}: ${messageOf(cause)}`)
    }
  }

  const byId = new Map(parsed.map((folder) => [folder.id, folder]))
  const ordered = [...parsed].sort((a, b) => depthOf(a, byId) - depthOf(b, byId))

  for (const folder of ordered) {
    try {
      await saveFolder(folder)
    } catch (cause: unknown) {
      errors.push(`Could not import folder "${folder.name}": ${messageOf(cause)}`)
    }
  }
}

/** How far below the root a manifest folder sits (a missing parent or a cycle stops the walk). */
function depthOf(folder: LibraryFolder, byId: ReadonlyMap<string, LibraryFolder>): number {
  const seen = new Set<string>([folder.id])
  let depth = 0
  let current = folder

  while (current.parentId !== null && current.parentId !== ROOT_FOLDER_ID) {
    const parent = byId.get(current.parentId)
    if (parent === undefined || seen.has(parent.id)) return depth
    seen.add(parent.id)
    current = parent
    depth += 1
  }

  return depth
}

function folderFromExport(value: unknown): LibraryFolder {
  if (!isRecord(value)) throw new Error('it is not an object')
  return {
    id: readString(value, 'id'),
    name: readString(value, 'name'),
    parentId: readOptionalString(value['parentId']),
    createdAt: readNumber(value, 'createdAt'),
    updatedAt: readNumber(value, 'updatedAt'),
  }
}

/**
 * One manifest entry as a §6.1 item, ready for `library.saveItem` (which validates
 * it again at the IDB boundary — this is the shape check, that is the last word).
 *
 * Locked entries only ever reconstruct their tuple: nothing in this function can
 * produce a plaintext locked item, because there is nowhere for plaintext to come
 * from (§14, §19.4).
 */
function itemFromExport(value: unknown): LibraryItem {
  if (!isRecord(value)) throw new Error('its manifest entry is not an object')
  const meta = value['meta']
  if (!isRecord(meta)) throw new Error('its manifest entry has no "meta" object')

  const base = {
    id: readString(meta, 'id'),
    folderId: readString(meta, 'folderId'),
    name: readString(meta, 'name'),
    createdAt: readNumber(meta, 'createdAt'),
    updatedAt: readNumber(meta, 'updatedAt'),
  }

  switch (meta['type']) {
    case 'text':
      return { ...base, type: 'text', content: readString(meta, 'content') }
    case 'richtext':
      return { ...base, type: 'richtext', content: readString(meta, 'content') }
    case 'image':
      return { ...base, type: 'image', ...blobFromExport(value, meta) }
    case 'file':
      return { ...base, type: 'file', ...blobFromExport(value, meta) }
    case 'locked':
      return {
        ...base,
        type: 'locked',
        label: readString(meta, 'label'),
        innerType: readInnerType(meta['innerType']),
        ciphertext: fromBase64(readString(meta, 'ciphertext')),
        iv: fromBase64(readString(meta, 'iv')),
        salt: fromBase64(readString(meta, 'salt')),
      }
    default:
      throw new Error(`unknown item type ${JSON.stringify(meta['type'])}`)
  }
}

/**
 * An image/file entry's bytes as a Blob.
 *
 * `size` comes from the Blob rather than from `meta.size`: the two must agree for
 * the library to accept the row, and the bytes are what the user actually kept.
 */
function blobFromExport(
  value: Record<string, unknown>,
  meta: Record<string, unknown>,
): { blob: Blob; mimeType: string; size: number } {
  const mimeType = readOptionalString(value['blobMimeType']) ?? readOptionalString(meta['mimeType']) ?? ''
  const blobData = readString(value, 'blobData')
  // An empty base64 string encodes a zero-byte blob — fromBase64 rejects empty
  // input, so the empty case is handled explicitly.
  const bytes = blobData.length === 0 ? new Uint8Array(0) : fromBase64(blobData)
  const blob = new Blob([bytes], { type: mimeType })
  return { blob, mimeType, size: blob.size }
}

function readInnerType(value: unknown): LibraryLockedItem['innerType'] {
  if (value === 'text' || value === 'richtext' || value === 'file') return value
  throw new Error(`a locked item's innerType must be text, richtext or file (got ${JSON.stringify(value)})`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`"${key}" is missing or is not a string`)
  return value
}

function readOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.trim() === '') return null
  return value
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${key}" is missing or is not a number`)
  }
  return value
}

/** A row's name if it has one, so an error line points at something recognisable. */
function labelFor(value: unknown, all: readonly unknown[], index: number): string {
  if (isRecord(value)) {
    const meta = value['meta']
    if (isRecord(meta)) {
      const name = meta['name']
      if (typeof name === 'string' && name.trim() !== '') return `"${name}"`
    }
  }
  return `item ${index + 1} of ${all.length}`
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  if (typeof cause === 'string' && cause.trim() !== '') return cause
  return 'the library refused it.'
}

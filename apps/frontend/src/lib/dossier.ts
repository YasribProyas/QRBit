import type {
  BlockType,
  FileBlock,
  LibraryFile,
  LibraryItem,
  LibraryLockedItem,
} from './library'
import { encryptItem, LOCKED_ITEM_MAX_PLAINTEXT_BYTES } from './crypto'
import { formatByteSize, fileSizeText } from './byteSize'
import type { SessionItem } from '../store/sessionStore'

/*
 * ---------------------------------------------------------------------------
 * The rule this module exists to enforce
 * ---------------------------------------------------------------------------
 *
 * A dossier block is PROP DATA. An `image` or `fileAttachment` block either holds bytes the
 * user chose, or it holds nothing — and "nothing" is not a thing that may be transmitted as
 * something. This file used to do exactly that: when a block had no `blob` it fabricated
 * `new Blob([new Uint8Array(100)])` and sent 100 null bytes under a filename, a MIME type and
 * a size nobody ever measured, and `pages/Home.tsx` queued the result without a word. A
 * file-transfer product that silently substitutes invented bytes for the ones the user does not
 * have is not a bug with a cosmetic fix, so the mechanism is now structural:
 *
 *   1. `fileBlocksToLibraryItems` NEVER constructs a Blob. There is no `new Blob(` in the
 *      send path, and no fallback of any kind where a missing one used to be.
 *   2. An attachment block with no `blob` is INVALID, and invalid is a throw: a typed
 *      `DossierSendError` naming the block, its type and the reason. The whole conversion
 *      rejects, so a dossier cannot go out half-built — the caller gets either every item or
 *      none, and nothing that was fabricated.
 *   3. The same rule is available without throwing, through `findUnsendableBlocks`, so a UI
 *      can say "this block has no file yet" before the user presses Send. One rule, two
 *      readings; the two cannot disagree because the check is written once.
 *   4. Every number on the wire comes from the bytes themselves: `size` is `blob.size`, and a
 *      locked item's plaintext is measured against D6's cap before it is encrypted.
 *
 * The locked branch follows the same discipline and one more: a block the user locked is
 * checked BEFORE the attachment branches, so `isLocked` on an image block can no longer ship
 * its bytes in the clear, and nothing is encrypted under a password nobody set.
 */

/** Why one block cannot go on the wire. Machine-readable; the message is for people. */
export type DossierSendFailureReason =
  | 'attachment-missing'
  | 'locked-content-missing'
  | 'locked-password-missing'
  | 'locked-too-large'

/**
 * A dossier that cannot be sent, pointed at the block that cannot.
 *
 * Thrown by `fileBlocksToLibraryItems` and also produced by `findUnsendableBlocks`, which
 * collects them instead of throwing. The fields are what a caller needs to surface the
 * failure usefully: a block id the row it came from can be found by, and a reason a sentence
 * can be chosen from without parsing prose.
 */
export class DossierSendError extends Error {
  readonly blockId: string
  readonly blockType: BlockType
  readonly reason: DossierSendFailureReason

  constructor(reason: DossierSendFailureReason, block: FileBlock, message: string) {
    super(message)
    this.name = 'DossierSendError'
    this.blockId = block.id
    this.blockType = block.type
    this.reason = reason
  }
}

/** How a block of this type is named in a message the user has to act on. */
function blockWord(type: BlockType): string {
  if (type === 'image') return 'image'
  if (type === 'fileAttachment') return 'attachment'
  if (type === 'locked') return 'locked'
  return type
}

function sendFailure(
  reason: DossierSendFailureReason,
  block: FileBlock,
  detail: string,
): DossierSendError {
  return new DossierSendError(reason, block, `dossier: block ${block.id} ${detail}`)
}

/** Does this block travel as an encrypted tuple rather than as itself? */
function isLockedBlock(block: FileBlock): boolean {
  return block.type === 'locked' || block.isLocked === true
}

function isAttachmentBlock(block: FileBlock): boolean {
  return block.type === 'image' || block.type === 'fileAttachment'
}

/**
 * A locked block's stored `{ ciphertext, iv, salt }`, when it has a usable one.
 *
 * Anything that already carries a tuple travels byte-for-byte and is never re-encrypted here
 * (decision D9), so it also never needs a password a second time: the password was the one
 * that made those bytes.
 */
function storedTuple(block: FileBlock): { ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array } | null {
  const data = block.lockedData
  if (
    data !== undefined &&
    data.ciphertext instanceof Uint8Array &&
    data.iv instanceof Uint8Array &&
    data.salt instanceof Uint8Array
  ) {
    return { ciphertext: data.ciphertext, iv: data.iv, salt: data.salt }
  }
  return null
}

/**
 * What a locked block has to encrypt, or `null` when it has nothing.
 *
 * The old code fell back to the literal `'secret'` — a fabricated payload sent under the user's
 * label. Here, no content is simply no content, and `byteLength` is measured from the real
 * bytes (a Blob's `size`, a string's UTF-8 length) so D6 can be applied before anything is
 * read or encrypted.
 */
function lockedPlaintext(
  block: FileBlock,
): { bytes: () => Promise<Uint8Array>; byteLength: number; innerType: 'file' | 'text' } | null {
  if (block.blob instanceof Blob) {
    const blob = block.blob
    return {
      bytes: async () => new Uint8Array(await blob.arrayBuffer()),
      byteLength: blob.size,
      innerType: 'file',
    }
  }

  const text = block.content ?? block.value
  if (typeof text !== 'string' || text === '') return null
  const encoded = new TextEncoder().encode(text)
  return {
    bytes: async () => encoded,
    byteLength: encoded.byteLength,
    innerType: 'text',
  }
}

/**
 * Why `block` cannot be sent, or `null` when it can. Synchronous and cheap: nothing here
 * encrypts, reads a blob or allocates bytes.
 */
function blockSendFailure(block: FileBlock): DossierSendError | null {
  if (isLockedBlock(block)) {
    if (storedTuple(block) !== null) return null

    const plaintext = lockedPlaintext(block)
    if (plaintext === null) {
      return sendFailure(
        'locked-content-missing',
        block,
        `is locked and has no content or file to encrypt — this ${blockWord(block.type)} block needs something real to protect`,
      )
    }
    if (plaintext.byteLength > LOCKED_ITEM_MAX_PLAINTEXT_BYTES) {
      return sendFailure(
        'locked-too-large',
        block,
        `is locked and holds ${formatByteSize(plaintext.byteLength)}, over the ${formatByteSize(LOCKED_ITEM_MAX_PLAINTEXT_BYTES)} a locked item may carry (decision D6) — lock a smaller payload, or send the file unlocked`,
      )
    }
    if (typeof block.password !== 'string' || block.password === '') {
      return sendFailure(
        'locked-password-missing',
        block,
        'is locked but has no password, and an item locked under a password nobody chose cannot be opened by anybody who needs it',
      )
    }
    return null
  }

  if (isAttachmentBlock(block) && !(block.blob instanceof Blob)) {
    return sendFailure(
      'attachment-missing',
      block,
      'has no attachment data: the block was created, but no file was ever chosen for it',
    )
  }

  return null
}

/**
 * Every block in `file` that cannot be sent, in block order.
 *
 * The non-throwing reading of the same check `fileBlocksToLibraryItems` applies, so an editor
 * can refuse a Send and name the block before anything is queued. Empty means sendable.
 */
export function findUnsendableBlocks(file: LibraryFile): DossierSendError[] {
  const failures: DossierSendError[] = []
  for (const block of file.blocks) {
    if (block.type === 'divider') continue
    const failure = blockSendFailure(block)
    if (failure !== null) failures.push(failure)
  }
  return failures
}

/**
 * A dossier send failure as something safe to put on screen.
 *
 * The typed error's own message names a block id, which is right in a log and useless in a
 * dialog; this turns the reason into the sentence the user can act on.
 */
export function describeSendFailure(cause: unknown): string {
  if (cause instanceof DossierSendError) {
    switch (cause.reason) {
      case 'attachment-missing':
        return `This ${blockWord(cause.blockType)} block has no file chosen yet. Pick a file for it, or delete the block, then send again.`
      case 'locked-content-missing':
        return 'A locked block has nothing to encrypt. Give it content or a file, or unlock it, then send again.'
      case 'locked-password-missing':
        return 'A locked block has no password. Set one with the lock on that block, or unlock it, then send again.'
      case 'locked-too-large':
        return `A locked block is larger than the ${formatByteSize(LOCKED_ITEM_MAX_PLAINTEXT_BYTES)} a locked item can carry (decision D6). Send that file unlocked, or lock a smaller payload.`
    }
  }
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  return 'The dossier could not be sent.'
}

/**
 * Extracts a concise single-line preview from the first block of a file.
 */
export function getFirstBlockPreview(file: LibraryFile): string {
  if (!file.blocks || file.blocks.length === 0) return 'Empty dossier'
  const b = file.blocks[0]
  if (!b) return 'Empty dossier'

  if (b.type === 'heading') return b.content || 'Heading block'
  if (b.type === 'shortText') return `${b.label || 'Field'}: ${b.value || ''}`
  if (b.type === 'richText') {
    return b.content ? b.content.split('\n')[0] || 'Notes' : 'Notes'
  }
  // No invented filenames and no invented sizes: a block with no bytes says so (D16).
  if (b.type === 'image' || b.type === 'fileAttachment') {
    const word = b.type === 'image' ? 'Image' : 'Attachment'
    const name = b.fileName ?? 'no file chosen'
    const size = fileSizeText(b.fileSize)
    return size === null ? `${word}: ${name}` : `${word}: ${name} (${size})`
  }
  if (b.type === 'locked' || b.isLocked) return `Encrypted: ${b.label || 'Secret'}`
  return 'Block content preview'
}

/**
 * Returns true if the file contains any password-locked entities.
 */
export function hasLockedBlocks(file: LibraryFile): boolean {
  return file.blocks?.some((b) => b.type === 'locked' || b.isLocked === true) ?? false
}

/**
 * Converts a multi-entity LibraryFile into the transportable `LibraryItem`s that go out over
 * the WebRTC DataChannel via `useSession`.
 *
 * It throws `DossierSendError` for the first block that cannot be sent — which, in practice,
 * means an attachment block with no file chosen for it, or a locked block with nothing real to
 * encrypt, no password, or a payload over D6's cap. Nothing is ever substituted for the bytes
 * the user does not have, and because the whole call rejects, a dossier never goes out half
 * built: the caller receives every item or none. `findUnsendableBlocks` is the same rule for a
 * UI that wants to say so before a Send is attempted.
 */
export async function fileBlocksToLibraryItems(file: LibraryFile): Promise<LibraryItem[]> {
  const items: LibraryItem[] = []
  const now = Date.now()

  for (const block of file.blocks) {
    if (block.type === 'divider') continue

    // The gate: a block that cannot be sent rejects the whole conversion here, before any
    // item is built and long before anything reaches the wire.
    const failure = blockSendFailure(block)
    if (failure !== null) throw failure

    if (block.type === 'heading') {
      items.push({
        id: block.id,
        folderId: file.folderId,
        name: block.content || 'Heading',
        type: 'text',
        content: `# ${block.content || ''}`,
        createdAt: now,
        updatedAt: now,
      })
    } else if (block.type === 'shortText') {
      items.push({
        id: block.id,
        folderId: file.folderId,
        name: block.label || 'Short Text',
        type: 'text',
        content: `${block.label ? block.label + ': ' : ''}${block.value || ''}`,
        createdAt: now,
        updatedAt: now,
      })
    } else if (block.type === 'richText') {
      items.push({
        id: block.id,
        folderId: file.folderId,
        name: block.label || 'Notes',
        type: 'text',
        content: block.content || '',
        createdAt: now,
        updatedAt: now,
      })
    } else if (isLockedBlock(block)) {
      items.push(await lockedItemFromBlock(block, file.folderId, now))
    } else if (block.type === 'image' || block.type === 'fileAttachment') {
      const blob = requireAttachmentBlob(block)
      const isImage = block.type === 'image'
      items.push({
        id: block.id,
        folderId: file.folderId,
        // The category word is the fallback for a name, never a filename: a block that came
        // through `AttachmentPicker` always carries the chosen file's real name.
        name: block.fileName ?? (isImage ? 'Image' : 'Attachment'),
        type: isImage ? 'image' : 'file',
        blob,
        // Whatever the picker stored, else what the Blob itself announced, else the
        // conservative default for a hand-built block. The bytes are real in every case.
        mimeType: block.mimeType ?? blob.type ?? (isImage ? 'image/png' : 'application/octet-stream'),
        size: blob.size,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  return items
}

/**
 * The block's own bytes, or the failure that says it has none.
 *
 * `blockSendFailure` has usually already checked this; it is asserted here as well so no
 * future branch can reach a Blob field without going through the rule. This is the only place
 * in the send path that touches `block.blob`, and it never creates one.
 */
function requireAttachmentBlob(block: FileBlock): Blob {
  const blob = block.blob
  if (blob instanceof Blob) return blob
  throw sendFailure(
    'attachment-missing',
    block,
    'has no attachment data: the block was created, but no file was ever chosen for it',
  )
}

/**
 * One locked block as a §6.1 locked item: ciphertext, and nothing else.
 *
 * Either the stored tuple travels byte-for-byte (D9 — this module never decrypts and never
 * re-encrypts), or the block's real content is encrypted with the password the user set. The
 * item carries no `blob`, no `content` and no `size` field, so there is no plaintext left on
 * the sendable record to leak, and a locked `image`/`fileAttachment` block can no longer be
 * shipped in the clear by the attachment branch that used to be tested first.
 *
 * The `blockSendFailure` checks have already run for this block (the loop below applies them
 * per block); the throws here keep that proof local rather than assuming it.
 */
async function lockedItemFromBlock(
  block: FileBlock,
  folderId: string,
  now: number,
): Promise<LibraryLockedItem> {
  let ciphertext: Uint8Array
  let iv: Uint8Array
  let salt: Uint8Array
  let innerType: LibraryLockedItem['innerType']

  const stored = storedTuple(block)
  if (stored !== null) {
    ciphertext = stored.ciphertext
    iv = stored.iv
    salt = stored.salt
    innerType = block.lockedData?.innerType === 'fileAttachment' ? 'file' : 'text'
  } else {
    const source = lockedPlaintext(block)
    if (source === null) {
      throw sendFailure(
        'locked-content-missing',
        block,
        'is locked and has no content or file to encrypt',
      )
    }
    const password = block.password
    if (password === undefined || password === '') {
      throw sendFailure('locked-password-missing', block, 'is locked but has no password')
    }

    const tuple = await encryptItem(password, await source.bytes())
    ciphertext = tuple.ciphertext
    iv = tuple.iv
    salt = tuple.salt
    innerType = source.innerType
  }

  return {
    id: block.id,
    folderId,
    name: block.label ?? 'Locked Payload',
    label: block.label ?? 'Locked Payload',
    type: 'locked',
    innerType,
    ciphertext,
    iv,
    salt,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Converts incoming SessionItems from a live session back into a structured LibraryFile.
 */
export function sessionItemsToLibraryFile(
  name: string,
  folderId: string,
  sessionItems: SessionItem[],
): LibraryFile {
  const now = Date.now()
  const blocks: FileBlock[] = sessionItems.map((item) => {
    switch (item.type) {
      case 'text': {
        if (item.content.startsWith('# ')) {
          return {
            id: item.id,
            type: 'heading',
            content: item.content.slice(2),
          }
        }
        if (item.content.includes(': ')) {
          const [label, ...rest] = item.content.split(': ')
          return {
            id: item.id,
            type: 'shortText',
            label,
            value: rest.join(': '),
          }
        }
        return {
          id: item.id,
          type: 'richText',
          content: item.content,
        }
      }
      case 'richtext':
        return {
          id: item.id,
          type: 'richText',
          content: item.content,
        }
      case 'image':
        return {
          id: item.id,
          type: 'image',
          fileName: item.fileName,
          // Real bytes, counted from what arrived — not a rounded KB string that could be
          // re-labelled into a lie. A complete item has its blob; `totalSize` is the announce,
          // which is the peer's own count and is used only as the fallback.
          fileSize: item.blob?.size ?? item.totalSize,
          blob: item.blob,
          mimeType: item.mimeType,
        }
      case 'file':
        return {
          id: item.id,
          type: 'fileAttachment',
          fileName: item.fileName,
          fileSize: item.blob?.size ?? item.totalSize,
          blob: item.blob,
          mimeType: item.mimeType,
        }
      case 'locked':
        return {
          id: item.id,
          type: 'locked',
          label: item.label,
          content: typeof item.plaintextContent === 'string' ? item.plaintextContent : undefined,
          isLocked: true,
          lockedData: {
            ciphertext: item.ciphertext,
            iv: item.iv,
            salt: item.salt,
            innerType: item.innerType === 'file' ? 'fileAttachment' : 'shortText',
          },
          isUnlocked: item.unlocked ?? false,
        }
    }
  })

  return {
    id: globalThis.crypto.randomUUID(),
    folderId,
    name,
    createdAt: now,
    updatedAt: now,
    blocks,
  }
}

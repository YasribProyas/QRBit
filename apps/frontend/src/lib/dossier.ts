import type {
  BlockType,
  EncryptedBlockData,
  FileBlock,
  LibraryFile,
  LibraryItem,
  LibraryLockedItem,
} from './library'
import {
  isLockedIntent,
  isProtectedBlock,
  isUnprotectedSecretBlock,
  lockedTupleOf,
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
 *      stored tuple is measured against D6's cap before it is handed over.
 *
 * The locked branch follows the same discipline and two more:
 *
 *   - a block the user locked is matched BEFORE every other branch — heading, key/value, note,
 *     image and attachment alike — so no type branch can build an item out of the plaintext that
 *     the tuple was made from. `isLocked` on an image block used to ship its bytes in the clear
 *     for exactly this reason, and `shortText` did the same with the secret itself;
 *   - **this module never encrypts.** A locked block travels as the `{ ciphertext, iv, salt }`
 *      tuple it was stored as (decision D9), and a block with no tuple is REFUSED, not
 *      encrypted here. Encryption used to happen on the way out, using `block.password` — the
 *      field that also put the secret's own password into IndexedDB next to the secret. The
 *      password now belongs to the edit session, never to the record, so the only place an
 *      authored block can be encrypted is the editor (`encryptBlockPayload` below, called by
 *      the row's Lock dialog and by Save). A dossier whose locked block was never encrypted
 *      does not go out; the user is told which block and what to do about it.
 */

/**
 * AES-GCM's authentication tag, which `encryptItem` appends to the ciphertext.
 *
 * D6 caps the PLAINTEXT, so a stored tuple is sendable up to cap plus this tag — the same
 * bound `hooks/useSession.ts` applies at the frame gate, restated here so a dossier can name
 * the block that breaks it instead of failing inside the transport.
 */
const GCM_TAG_BYTE_LENGTH = 16

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

function isAttachmentBlock(block: FileBlock): boolean {
  return block.type === 'image' || block.type === 'fileAttachment'
}

/** The inner type a stored tuple declares, mapped to the §6.1 item's vocabulary. */
function tupleInnerType(block: FileBlock): LibraryLockedItem['innerType'] {
  return block.lockedData?.innerType === 'fileAttachment' ? 'file' : 'text'
}

/**
 * What a locked block has to encrypt, or `null` when it has nothing.
 *
 * The old code fell back to the literal `'secret'` — a fabricated payload sent under the user's
 * label. Here, no content is simply no content, and `byteLength` is measured from the real
 * bytes (a Blob's `size`, a string's UTF-8 length) so D6 can be applied before anything is
 * read or encrypted.
 *
 * Only `encryptBlockPayload` consumes `bytes()`. The send path reads `byteLength` alone, because
 * it never encrypts and must never hold a locked block's plaintext at all.
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
 * Encrypts an authored block's payload into the tuple it is stored as (PLAN.md §6.2, §11.4).
 *
 * This is the ONLY place a dossier block is encrypted, and it is reached from the editor: the
 * row's Lock dialog and the Save prompt in `FileEditView`. Both hand it a password the user
 * typed a moment before, so no record ever stores one and no code ever invents one — the defect
 * this replaces ran `encryptItem` with the record's own stored password — defaulting to a
 * literal four-letter hint — which locked a secret under a password from the source and then
 * persisted that password beside the secret.
 *
 * `LOCKED_ITEM_MAX_PLAINTEXT_BYTES` (decision D6) and the empty payload are refused here, before
 * any PBKDF2 work, with a `DossierSendError` a caller can put on screen. The plaintext buffer is
 * zeroed whichever way the encryption goes; the strings a JS block holds cannot be overwritten,
 * which is why the persistence boundary (`parseBlock`) refuses to store a plaintext beside a
 * tuple rather than relying on every caller dropping the field.
 */
export async function encryptBlockPayload(
  block: FileBlock,
  password: string,
): Promise<EncryptedBlockData> {
  if (password === '') {
    throw sendFailure(
      'locked-password-missing',
      block,
      'cannot be encrypted under an empty password',
    )
  }

  const source = lockedPlaintext(block)
  if (source === null) {
    throw sendFailure(
      'locked-content-missing',
      block,
      `is locked and has no content or file to encrypt — this ${blockWord(block.type)} block needs something real to protect`,
    )
  }
  if (source.byteLength > LOCKED_ITEM_MAX_PLAINTEXT_BYTES) {
    throw sendFailure(
      'locked-too-large',
      block,
      `is locked and holds ${formatByteSize(source.byteLength)}, over the ${formatByteSize(LOCKED_ITEM_MAX_PLAINTEXT_BYTES)} a locked item may carry (decision D6) — lock a smaller payload, or send the file unlocked`,
    )
  }

  const plaintext = await source.bytes()
  try {
    const tuple = await encryptItem(password, plaintext)
    return { ...tuple, innerType: source.innerType === 'file' ? 'fileAttachment' : 'shortText' }
  } finally {
    zeroBytes(plaintext)
  }
}

/** Overwrites a plaintext buffer this module no longer needs (PLAN.md §11.4). */
function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0)
}

/**
 * Why `block` cannot be sent, or `null` when it can. Synchronous and cheap: nothing here
 * encrypts, reads a blob or allocates bytes.
 */
function blockSendFailure(block: FileBlock): DossierSendError | null {
  if (isLockedIntent(block)) {
    const tuple = lockedTupleOf(block)
    if (tuple !== null) {
      // D9: the stored tuple is what travels. The only thing that can make it unsendable is
      // D6's one-frame bound on the ciphertext it turns into.
      if (tuple.ciphertext.byteLength > LOCKED_ITEM_MAX_PLAINTEXT_BYTES + GCM_TAG_BYTE_LENGTH) {
        return sendFailure(
          'locked-too-large',
          block,
          `is locked and its ciphertext is ${formatByteSize(tuple.ciphertext.byteLength)}, over the ${formatByteSize(LOCKED_ITEM_MAX_PLAINTEXT_BYTES)} a locked item may carry (decision D6)`,
        )
      }
      return null
    }

    // No tuple: this block was never encrypted, and this module cannot encrypt it here because
    // a password is not a field of a stored block. Refuse rather than send the secret as a
    // plain text item, which is what "it was only ever plaintext" would quietly mean.
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
    return sendFailure(
      'locked-password-missing',
      block,
      'is locked but holds plaintext with no encrypted payload: it was never given a password, and nothing here may choose one for it',
    )
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
        return 'A locked block is not encrypted yet — it still holds plaintext and no password was ever set for it. Use Lock on that block to encrypt it, or unlock it, then send again.'
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
  if (isLockedIntent(b)) {
    // The label is plaintext by design (PLAN.md §9); the payload is never in this line. And a
    // block that was never encrypted is not called encrypted, whatever its lock flag says.
    const word = isProtectedBlock(b) ? 'Encrypted' : 'Not encrypted'
    return `${word}: ${b.label || 'Secret'}`
  }
  return 'Block content preview'
}

/**
 * True when the dossier carries at least one block whose payload really is ciphertext.
 *
 * This is the question a lock badge answers, so it is answered from the tuple and not from the
 * `isLocked` flag: a row written before the editor encrypted on save would otherwise go on
 * wearing a badge over plaintext (PLAN.md §6.2 — the promise is the tuple, not the icon).
 */
export function hasLockedBlocks(file: LibraryFile): boolean {
  return file.blocks?.some(isProtectedBlock) ?? false
}

/**
 * True when the dossier carries a block that is meant to be secret and is stored as plaintext.
 *
 * The warning half of `hasLockedBlocks`: a UI can offer the user the difference between
 * "encrypted" and "not encrypted yet" without re-deriving the rule.
 */
export function hasUnprotectedSecretBlocks(file: LibraryFile): boolean {
  return file.blocks?.some(isUnprotectedSecretBlock) ?? false
}

/**
 * Converts a multi-entity LibraryFile into the transportable `LibraryItem`s that go out over
 * the WebRTC DataChannel via `useSession`.
 *
 * It throws `DossierSendError` for the first block that cannot be sent — which, in practice,
 * means an attachment block with no file chosen for it, or a locked block that was never
 * encrypted (no tuple, so nothing here may send it, and nothing here may encrypt it either:
 * a password is not a stored field), or one whose payload is over D6's cap. Nothing is ever
 * substituted for the bytes the user does not have, and because the whole call rejects, a
 * dossier never goes out half built: the caller receives every item or none. `findUnsendableBlocks`
 * is the same rule for a UI that wants to say so before a Send is attempted.
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

    if (isLockedIntent(block)) {
      /*
       * FIRST, before any type branch. `heading`, `shortText` and `richText` each build a text
       * item out of the block's own plaintext, and the lock dialog sits on every row — so a
       * key/value field the user encrypted would have gone out as `Label: the-secret` while its
       * ciphertext sat unused. A block whose payload is a tuple travels as that tuple (decision
       * D9) and is never rendered as the field it was written in.
       *
       * `blockSendFailure` above already refused a locked block with no tuple, so what reaches
       * this branch is ciphertext.
       */
      items.push(lockedItemFromBlock(block, file.folderId, now))
    } else if (block.type === 'heading') {
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
 * One locked block as a §6.1 locked item: the ciphertext tuple it stores, byte-for-byte.
 *
 * D9 in one sentence: the `{ ciphertext, iv, salt }` tuple is what travels, the password never
 * does, and this module neither decrypts nor re-encrypts. The item therefore carries no `blob`,
 * no `content` and no `size` — there is no plaintext on the sendable record to leak — and a
 * locked `image`/`fileAttachment` block cannot be shipped in the clear by the attachment branch
 * that used to be tested first.
 *
 * A block with no tuple never reaches here: `blockSendFailure` refuses it, because encrypting it
 * would need a password and a password is not a field of a stored block. The throw below keeps
 * that proof local rather than assuming the caller ran the gate.
 */
function lockedItemFromBlock(
  block: FileBlock,
  folderId: string,
  now: number,
): LibraryLockedItem {
  const stored = lockedTupleOf(block)
  if (stored === null) {
    throw sendFailure(
      'locked-password-missing',
      block,
      'is locked but holds no encrypted payload, and this module never encrypts on the send path',
    )
  }

  return {
    id: block.id,
    folderId,
    name: block.label ?? 'Locked Payload',
    label: block.label ?? 'Locked Payload',
    type: 'locked',
    innerType: tupleInnerType(block),
    ciphertext: stored.ciphertext,
    iv: stored.iv,
    salt: stored.salt,
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
          // A reveal the user is looking at, in memory only. `parseBlock` refuses to store a
          // plaintext beside a tuple, so this field is gone the moment the dossier is saved and
          // the row has to be unlocked again rather than read off the disk (PLAN.md §6.2).
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

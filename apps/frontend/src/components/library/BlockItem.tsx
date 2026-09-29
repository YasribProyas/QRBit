import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  GripVertical,
  Lock,
  Unlock,
  KeyRound,
  FileCode,
  Download,
  Trash2,
  Copy,
  ChevronUp,
  ChevronDown,
  CheckCircle2,
  Clock,
  Loader2,
  Shield,
  ShieldOff,
  Tag,
} from 'lucide-react'
import { IconX } from '@tabler/icons-react'
import type { FileBlock } from '../../lib/library'
import {
  isLockedIntent,
  isProtectedBlock,
  isUnprotectedSecretBlock,
  lockedTupleOf,
} from '../../lib/library'
import { decryptItem, LOCKED_ITEM_MAX_PLAINTEXT_BYTES } from '../../lib/crypto'
import { describeSendFailure, DossierSendError, encryptBlockPayload } from '../../lib/dossier'
import { formatByteSize, fileSizeText } from '../../lib/byteSize'
import { AttachmentPicker, LIBRARY_ATTACHMENT_MAX_BYTES } from './AttachmentPicker'
import type { AttachmentSelection } from './AttachmentPicker'
import type { ReorderHandleProps } from '../../hooks/useReorderDrag'

export interface BlockItemProps {
  block: FileBlock
  index: number
  totalBlocks: number
  mode?: 'edit' | 'sender' | 'receiver'
  /**
   * What the wire says about this row's item. Left unset, the row renders **no** pill: a
   * transfer status is a claim about frames that left the device, and a row that cannot back it
   * up should not make one. It used to default to `'sent'`, which put "Delivered" on every row
   * the caller did not think about.
   */
  transferStatus?: 'pending' | 'in_progress' | 'sent' | 'error'
  transferProgress?: number
  onUpdate?: (id: string, changes: Partial<FileBlock>) => void
  onDelete?: (id: string) => void
  onDuplicate?: (id: string) => void
  /**
   * The keyboard/accessible twin of the grip drag (ORCHESTRATION D16.3). Both this and
   * `reorderHandleProps` are wired by the editor to ONE reorder reducer, so a click on an
   * arrow and a released drag cannot drift apart.
   */
  onMoveUp?: (index: number) => void
  onMoveDown?: (index: number) => void
  onUnlockCredential?: (id: string, plaintextContent: string) => void
  /**
   * Props from `useReorderDrag().getHandleProps(index)`, spread onto the grip. The grip is a
   * real `<button>` because that is what the hook needs: pointer down starts the drag, and
   * ArrowUp/ArrowDown/Home/End on it are the keyboard path. Omitted = no grip rendered.
   */
  reorderHandleProps?: ReorderHandleProps
  /** True while THIS row is the one under the pointer; it is the row that gets translated. */
  isReorderDragging?: boolean
  /** Pixels the grabbed row sits below its normal position. Only read while dragging. */
  reorderOffset?: number
}

export function BlockItem({
  block,
  index,
  totalBlocks,
  mode = 'edit',
  transferStatus,
  transferProgress = 0,
  onUpdate,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onUnlockCredential,
  reorderHandleProps,
  isReorderDragging = false,
  reorderOffset = 0,
}: BlockItemProps) {
  const [passwordInput, setPasswordInput] = useState('')
  const [unlockError, setUnlockError] = useState(false)
  const [showUnlockModal, setShowUnlockModal] = useState(false)
  const [isDecrypting, setIsDecrypting] = useState(false)

  // Per-block Lock with Password Modal
  const [showLockConfigModal, setShowLockConfigModal] = useState(false)
  const [newLockPassword, setNewLockPassword] = useState('')
  const [isEncrypting, setIsEncrypting] = useState(false)
  /** Why a lock was refused, in words: an oversized or empty payload cannot be encrypted. */
  const [lockError, setLockError] = useState<string | null>(null)
  /**
   * The password asked for when the user chooses to REMOVE a lock. Removing one throws the
   * ciphertext away, and a protected block deliberately keeps no plaintext (that is the whole
   * point), so the payload has to be decrypted before the key it is locked under is dropped.
   * See `revealBlock`.
   */
  const [removeLockPassword, setRemoveLockPassword] = useState('')
  const [removeLockError, setRemoveLockError] = useState(false)

  // Every edit-mode row is a measured reorder item, grip or no grip: the hook counts those
  // markers to index a drag, so the set of them has to be the whole list.
  const isReorderRow = mode === 'edit'

  /*
   * The three states a lockable row can be in, decided by what is STORED rather than by the
   * flag the user last pressed — that distinction is this row's whole security story. A block
   * whose payload is a `{ ciphertext, iv, salt }` tuple is encrypted (`isProtected`) and gets the
   * lock badge, the Unlock button and no editable plaintext field. A block the user marked as a
   * secret that still holds plaintext is the WARNING state (`isUnprotected`): no badge, no lock
   * icon, no invented secret, and an explicit prompt to encrypt it. A marked block with nothing
   * in it is `isEmptyLocked` — an empty protected field, which is neither of those and is said
   * as plainly as it can be.
   */
  const isProtected = isProtectedBlock(block)
  const isUnprotected = isUnprotectedSecretBlock(block)
  const isEmptyLocked = isLockedIntent(block) && !isProtected && !isUnprotected
  /** Does this row show the lock area at all? */
  const showsLockArea = isLockedIntent(block)
  /** While a block is encrypted its plaintext field is not editable: nothing may drift from the ciphertext. */
  const canEditPayload = mode === 'edit' && !isProtected
  /** The only plaintext this row may paint in the reveal slot: what a successful `decryptItem` put back. */
  const revealedPlaintext = block.value ?? block.content
  /** How the unprotected note names this block, in the words the row already uses for it. */
  const blockWord =
    block.type === 'shortText'
      ? 'field'
      : block.type === 'image'
        ? 'image'
        : block.type === 'fileAttachment'
          ? 'attachment'
          : block.type === 'richText'
            ? 'note'
            : 'block'

  /** The grabbed row is painted at the pointer, above its neighbours, and nothing else moves. */
  const dragStyle = isReorderDragging
    ? { transform: `translateY(${reorderOffset}px)`, zIndex: 1 }
    : undefined

  /** The grip, rendered only when the editor handed this row a drag handle (D16.2). */
  const grip =
    isReorderRow && reorderHandleProps !== undefined ? (
      <button
        {...reorderHandleProps}
        className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded p-0.5 tactile-btn"
      >
        <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    ) : null

  /** The field this block type keeps its text payload in, so a reveal lands where the row reads. */
  const textIsValue = block.type === 'shortText'

  /**
   * Opens this block with a password: decrypts the stored tuple and puts the plaintext where the
   * row can show it (PLAN.md §11.4).
   *
   * The only door in the app for a locked dossier block. It returns false — with the caller's
   * error state set, and the field cleared, exactly as `UnlockModal` does for a session item —
   * for every way this can fail, so a wrong password, a tampered ciphertext, a malformed tuple
   * and **no tuple at all** are indistinguishable on screen. `lib/library.ts` reports a
   * malformed tuple as a wrong password for the same reason (see the comment above
   * `readFixedBytes`); a row that said "there is nothing encrypted here" instead would hand an
   * attacker the one thing the lock is supposed to keep.
   *
   * `discardTuple` is the Remove-Lock case. A protected block stores no plaintext — that is the
   * guarantee — so dropping the ciphertext without decrypting it first would destroy the user's
   * payload with it. Removal therefore goes through the same decrypt, and only a successful one
   * takes the tuple off the block.
   *
   * The decrypted buffer is wiped as soon as it has been turned into what the row shows
   * (PLAN.md §11.4: plaintext zeroed after use). The string or Blob that replaces it lives in
   * the draft, in memory, and `parseBlock` refuses to persist it beside a tuple.
   */
  const revealBlock = async (password: string, discardTuple: boolean): Promise<boolean> => {
    const tuple = lockedTupleOf(block)
    if (tuple === null) {
      reportUnlockFailure(discardTuple)
      return false
    }

    let decrypted: Uint8Array
    try {
      decrypted = await decryptItem(password, tuple.salt, tuple.iv, tuple.ciphertext)
    } catch {
      reportUnlockFailure(discardTuple)
      return false
    }

    const isFile =
      tuple.innerType === 'fileAttachment' ||
      block.type === 'image' ||
      block.type === 'fileAttachment'

    let revealed: Partial<FileBlock>
    try {
      revealed = isFile
        ? // A locked attachment's plaintext is bytes, not text: decoding it as UTF-8 would put
          // mojibake on the screen and call that the secret. `Blob` copies the buffer, so the
          // decrypted bytes can be wiped straight after (same shape as `LibraryItemRow`'s
          // reveal), and the row's own attachment area renders and downloads what it holds.
          // The copy into an `ArrayBuffer`-backed view is the DOM types' requirement, not a
          // defensive clone: `decryptItem` can hand back a view over anything.
          { blob: new Blob([new Uint8Array(decrypted)], { type: block.mimeType ?? '' }) }
        : textIsValue
          ? { value: new TextDecoder().decode(decrypted) }
          : { content: new TextDecoder().decode(decrypted) }
    } finally {
      decrypted.fill(0)
    }

    onUpdate?.(block.id, {
      ...revealed,
      isUnlocked: true,
      ...(discardTuple ? { isLocked: false, lockedData: undefined } : {}),
    })

    if (!discardTuple && revealed.content !== undefined) {
      onUnlockCredential?.(block.id, revealed.content)
    }

    if (discardTuple) {
      setRemoveLockPassword('')
      setShowLockConfigModal(false)
    } else {
      setPasswordInput('')
      setShowUnlockModal(false)
    }
    return true
  }

  /** One failure message for every reason an unlock can fail. See `revealBlock`. */
  function reportUnlockFailure(throughRemoval: boolean): void {
    if (throughRemoval) {
      setRemoveLockError(true)
      setRemoveLockPassword('')
      return
    }
    setUnlockError(true)
    setPasswordInput('')
  }

  const handleUnlockSubmit = async (e?: React.FormEvent): Promise<void> => {
    e?.preventDefault()
    setIsDecrypting(true)
    setUnlockError(false)
    await revealBlock(passwordInput, false)
    setIsDecrypting(false)
  }

  const handleSetLockPassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!newLockPassword.trim()) return

    setIsEncrypting(true)
    setLockError(null)
    try {
      /*
       * The row does not encrypt anything itself: it collects the password and calls the ONE
       * encryption path for authored blocks (`lib/dossier.ts` `encryptBlockPayload`), the same
       * one the editor's Save prompt uses. What that encrypts is the block's real payload — its
       * file bytes when it has them, otherwise its text — measured against D6's cap before any
       * PBKDF2 work, and its plaintext buffer is zeroed on the way out.
       *
       * No password is written onto the block, in this patch or in any other: `FileBlock` has no
       * field for one, because a record holding the secret and the key that opens it is not
       * encrypted at all (PLAN.md §6.2).
       *
       * The announced patch replaces the tuple and clears `isUnlocked`: a block that has just
       * been re-locked is not open, and a previous plaintext reveal must not stay on screen next
       * to ciphertext that no longer matches it.
       */
      const lockedData = await encryptBlockPayload(block, newLockPassword)
      onUpdate?.(block.id, {
        isLocked: true,
        lockedData,
        isUnlocked: false,
      })

      setShowLockConfigModal(false)
      setNewLockPassword('')
    } catch (cause: unknown) {
      setLockError(describeLockFailure(cause))
    } finally {
      setIsEncrypting(false)
    }
  }

  const handleRemoveLock = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (lockedTupleOf(block) === null) {
      // Nothing is encrypted, so there is nothing to open first: just drop the lock flag.
      onUpdate?.(block.id, { isLocked: false, lockedData: undefined })
      setShowLockConfigModal(false)
      return
    }

    setIsDecrypting(true)
    setRemoveLockError(false)
    await revealBlock(removeLockPassword, true)
    setIsDecrypting(false)
  }

  // Render Transfer Status Pill for session screens
  const renderStatusPill = (): ReactNode => {
    if (mode !== 'sender' && mode !== 'receiver') return null
    if (transferStatus === undefined) return null

    if (transferStatus === 'pending') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
          <Clock className="w-3 h-3 text-slate-400" />
          <span>Pending</span>
        </span>
      )
    }

    if (transferStatus === 'in_progress') {
      return (
        <div className="flex items-center gap-2">
          <div className="w-20 h-1.5 bg-blue-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#1D4ED8] rounded-full transition-all duration-300"
              style={{ width: `${transferProgress}%` }}
            />
          </div>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-[#1D4ED8] border border-blue-200">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{Math.round(transferProgress)}%</span>
          </span>
        </div>
      )
    }

    if (transferStatus === 'error') {
      return (
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-red-50 text-red-700 border border-red-200"
          data-transfer-error="true"
        >
          <Clock className="w-3 h-3 text-red-500" />
          <span>Not delivered</span>
        </span>
      )
    }

    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
        <span>Delivered</span>
      </span>
    )
  }

  // DIVIDER BLOCK
  if (block.type === 'divider') {
    return (
      <div
        className="group relative my-3 flex items-center gap-2"
        data-reorder-item={isReorderRow ? '' : undefined}
        style={dragStyle}
      >
        {grip !== null ? <span className="shrink-0">{grip}</span> : null}
        {mode === 'edit' && (
          <div className="absolute -left-8 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={() => onDelete?.(block.id)}
              className="p-1 text-slate-400 hover:text-red-600 rounded tactile-btn cursor-pointer"
              title="Delete divider"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <div className="w-full flex items-center gap-3">
          <div className="h-[1px] flex-1 bg-[#D1D9E4]" />
          <span className="text-[10px] tracking-wider text-slate-400 font-mono select-none">
            DIVIDER
          </span>
          <div className="h-[1px] flex-1 bg-[#D1D9E4]" />
        </div>
        {renderStatusPill()}
      </div>
    )
  }

  // --- attachment display (the two blocks that carry bytes) ----------------
  const attachmentBlob = block.blob
  /**
   * The size shown on the row, measured from what is actually on the block.
   *
   * `blob.size` when a file is chosen — that number is the only honest size there is. A stored
   * `fileSize` is read only for a record whose bytes are not in memory (a demo dossier, or
   * anything written before the picker existed), and a missing one says so instead of falling
   * back to a plausible-looking literal, which is exactly how `'2.4 MB'` got into this file.
   */
  const attachmentSizeLabel =
    attachmentBlob instanceof Blob
      ? formatByteSize(attachmentBlob.size)
      : fileSizeText(block.fileSize)
  /**
   * Whether a preview can be drawn: an `image` row shows the bytes only if they announced
   * themselves as an image (or announced nothing at all, which a `File` from an unknown
   * extension does, and which the picker's type check already refused to write).
   */
  const canPreviewImage =
    attachmentBlob instanceof Blob &&
    (attachmentBlob.type === '' || attachmentBlob.type.startsWith('image/'))
  /**
   * The ceiling for this block. A locked attachment travels as one `locked-payload` frame, so
   * it is capped by D6, not by the library cap; an unlocked one is a chunked file item and gets
   * `LIBRARY_ATTACHMENT_MAX_BYTES`. `AttachmentPicker` refuses above the number, and the draft
   * keeps whatever was on the block before.
   */
  const attachmentMaxBytes =
    block.type === 'locked' || block.isLocked === true
      ? LOCKED_ITEM_MAX_PLAINTEXT_BYTES
      : LIBRARY_ATTACHMENT_MAX_BYTES

  return (
    <div
      className={`group relative bg-white rounded-lg border transition-all ${
        isProtected
          ? 'border-[#C2410C]/40 bg-orange-50/15'
          : isUnprotected
            ? 'border-red-300 bg-red-50/25'
            : 'border-[#D1D9E4]'
      } hover:border-[#94A3B8] shadow-2xs ${isReorderDragging ? 'shadow-md' : ''}`}
      data-reorder-item={isReorderRow ? '' : undefined}
      data-block-protected={isProtected ? 'true' : undefined}
      data-block-unprotected={isUnprotected ? 'true' : undefined}
      style={dragStyle}
    >
      {/* Header bar of block */}
      <div className="px-3.5 pt-2.5 pb-1.5 flex items-center justify-between border-b border-slate-100">
        <div className="flex items-center gap-2">
          {grip !== null ? <span className="shrink-0">{grip}</span> : null}
          <span className="text-[11px] font-mono font-medium text-[#5B6B82] uppercase">
            {block.type === 'shortText' ? 'Short Text' : block.type}
          </span>

          {/*
            The badge is derived from the ciphertext, never from `isLocked`: a lock icon over a
            plaintext payload is the exact claim this row is not allowed to make. An unprotected
            secret says so instead.
          */}
          {isProtected && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-100 text-[#C2410C]">
              <Lock className="w-2.5 h-2.5" />
              <span>Encrypted</span>
            </span>
          )}

          {isUnprotected && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700"
              data-unprotected-badge="true"
            >
              <ShieldOff className="w-2.5 h-2.5" />
              <span>Not encrypted</span>
            </span>
          )}

          {/* Label tag indicator if entity has a label */}
          {block.label && block.type !== 'shortText' && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-700">
              <Tag className="w-2.5 h-2.5 text-slate-400" />
              <span>{block.label}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {renderStatusPill()}

          {mode === 'edit' && (
            <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
              {/* Lock / Unlock Toggle Button */}
              <button
                type="button"
                onClick={() => {
                  setLockError(null)
                  setShowLockConfigModal(true)
                }}
                className={`p-1 rounded tactile-btn cursor-pointer ${
                  isProtected
                    ? 'text-[#C2410C] hover:bg-orange-50'
                    : isUnprotected
                      ? 'text-red-600 hover:bg-red-50'
                      : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                }`}
                title={
                  isProtected
                    ? 'Manage encrypted block'
                    : isUnprotected
                      ? 'Encrypt this block with a password'
                      : 'Lock this entity with password'
                }
              >
                {isProtected ? (
                  <Lock className="w-3.5 h-3.5" />
                ) : isUnprotected ? (
                  <ShieldOff className="w-3.5 h-3.5" />
                ) : (
                  <Shield className="w-3.5 h-3.5" />
                )}
              </button>

              <button
                type="button"
                onClick={() => onMoveUp?.(index)}
                disabled={index === 0}
                className="p-1 text-slate-500 hover:text-slate-800 disabled:opacity-30 rounded tactile-btn cursor-pointer"
                title="Move up"
                aria-label={`Move ${block.type} block up`}
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onMoveDown?.(index)}
                disabled={index === totalBlocks - 1}
                className="p-1 text-slate-500 hover:text-slate-800 disabled:opacity-30 rounded tactile-btn cursor-pointer"
                title="Move down"
                aria-label={`Move ${block.type} block down`}
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDuplicate?.(block.id)}
                className="p-1 text-slate-500 hover:text-slate-800 rounded tactile-btn cursor-pointer"
                title="Duplicate block"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDelete?.(block.id)}
                className="p-1 text-slate-500 hover:text-red-600 rounded tactile-btn cursor-pointer"
                title="Delete block"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main Content Area based on block type */}
      <div className="p-3.5 space-y-2">
        {/* Optional Label field for entities when editing (User can choose to set label for each entity) */}
        {mode === 'edit' && block.type !== 'shortText' && (
          <div className="flex items-center gap-2 pb-1">
            <span className="text-[11px] font-medium text-[#5B6B82] w-12 shrink-0">Label:</span>
            <input
              type="text"
              value={block.label || ''}
              onChange={(e) => onUpdate?.(block.id, { label: e.target.value })}
              placeholder="Entity label (optional)..."
              className="flex-1 text-xs font-medium text-slate-600 bg-slate-50/70 px-2 py-1 rounded border border-slate-200 focus:outline-none focus:border-[#1D4ED8]"
            />
          </div>
        )}

        {/* HEADING BLOCK */}
        {block.type === 'heading' && (
          <div>
            {canEditPayload ? (
              <input
                type="text"
                value={block.content || ''}
                onChange={(e) => onUpdate?.(block.id, { content: e.target.value })}
                placeholder="Enter section heading..."
                className="w-full font-display text-lg font-bold text-[#0F172A] bg-transparent border-0 border-b border-transparent focus:border-[#1D4ED8] focus:outline-none pb-0.5"
              />
            ) : (
              <h3 className="font-display text-lg font-bold text-[#0F172A]">{block.content}</h3>
            )}
          </div>
        )}

        {/* SHORT TEXT BLOCK */}
        {block.type === 'shortText' && (
          <div className="space-y-1.5">
            {mode === 'edit' ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-[#5B6B82] w-12 shrink-0">Label:</span>
                  <input
                    type="text"
                    value={block.label || ''}
                    onChange={(e) => onUpdate?.(block.id, { label: e.target.value })}
                    placeholder="Field label..."
                    className="flex-1 text-xs font-medium text-slate-600 bg-slate-50 px-2 py-1 rounded border border-slate-200 focus:outline-none focus:border-[#1D4ED8]"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-[#5B6B82] w-12 shrink-0">Value:</span>
                  {/*
                    No editable value while the block is encrypted: the tuple is a ciphertext of
                    the bytes that were on the block when it was locked, so a field the user could
                    type into beside it would put one payload on screen and another on the wire.
                    The value appears below, after a real unlock.
                  */}
                  {canEditPayload ? (
                    <input
                      type="text"
                      value={block.value || ''}
                      onChange={(e) => onUpdate?.(block.id, { value: e.target.value })}
                      placeholder="Single-line value..."
                      className="flex-1 font-mono text-xs text-[#0F172A] bg-white px-2 py-1 rounded border border-[#D1D9E4] focus:outline-none focus:border-[#1D4ED8]"
                    />
                  ) : (
                    <span className="flex-1 font-mono text-xs text-[#5B6B82]">
                      Encrypted value — unlock to reveal it
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                <span className="text-[12px] font-medium text-[#5B6B82]">{block.label}</span>
                <span className="font-mono text-[13px] text-[#0F172A] bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                  {block.value}
                </span>
              </div>
            )}
          </div>
        )}

        {/* RICH TEXT BLOCK */}
        {block.type === 'richText' && (
          <div>
            {canEditPayload ? (
              <textarea
                rows={3}
                value={block.content || ''}
                onChange={(e) => onUpdate?.(block.id, { content: e.target.value })}
                placeholder="Write formatted notes or documentation..."
                className="w-full text-xs leading-relaxed text-[#0F172A] bg-slate-50/50 p-2.5 rounded border border-[#D1D9E4] focus:outline-none focus:border-[#1D4ED8] focus:bg-white resize-y"
              />
            ) : (
              <p className="text-[13.5px] leading-relaxed text-[#0F172A] whitespace-pre-line">
                {block.content}
              </p>
            )}
          </div>
        )}

        {/* IMAGE BLOCK */}
        {block.type === 'image' && (
          <div className="space-y-2">
            <div className="relative aspect-video max-h-48 w-full bg-[#0F172A] rounded-md overflow-hidden border border-[#D1D9E4] flex flex-col items-center justify-center p-4">
              {canPreviewImage && attachmentBlob instanceof Blob ? (
                <ImagePreview blob={attachmentBlob} name={block.fileName ?? 'Chosen image'} />
              ) : (
                <p
                  className="text-[11px] font-mono text-slate-400 text-center px-4"
                  data-attachment-empty="true"
                >
                  {attachmentBlob instanceof Blob
                    ? 'The bytes on this block are not an image, so there is no preview to draw.'
                    : 'No image chosen yet — this block holds no bytes.'}
                </p>
              )}

              {transferStatus === 'in_progress' && (
                <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex flex-col items-center justify-center p-6">
                  <span className="text-white text-xs font-mono mb-2">
                    Streaming image data... {Math.round(transferProgress)}%
                  </span>
                  <div className="w-48 h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all"
                      style={{ width: `${transferProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 text-xs text-[#5B6B82] pt-1">
              <span className="font-mono text-slate-800 font-medium truncate">
                {block.fileName ?? 'No file chosen'}
              </span>
              <span className="shrink-0">
                {attachmentSizeLabel ?? 'no size until a file is chosen'}
              </span>
            </div>

            {block.caption !== undefined && block.caption !== '' ? (
              <p className="text-[11px] text-[#5B6B82]">{block.caption}</p>
            ) : null}

            {mode === 'edit' ? (
              <AttachmentControls block={block} maxBytes={attachmentMaxBytes} onUpdate={onUpdate} />
            ) : null}
          </div>
        )}

        {/* FILE ATTACHMENT BLOCK */}
        {block.type === 'fileAttachment' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-md border border-[#D1D9E4]">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded bg-white border border-[#D1D9E4] flex items-center justify-center text-[#1D4ED8] shrink-0">
                  <FileCode className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-mono font-medium text-[#0F172A] truncate">
                    {block.fileName ?? 'No file chosen'}
                  </p>
                  <p className="text-[11px] text-[#5B6B82]">
                    {attachmentSizeLabel ?? 'no size until a file is chosen'}
                  </p>
                </div>
              </div>

              {mode !== 'edit' ? (
                /*
                 * A real save, or none at all. This button used to run
                 * `alert(`Saved ${block.fileName} to local sandbox.`)` — it saved nothing, and there
                 * is no sandbox: the library writes dossiers to IndexedDB, and this row is showing
                 * a file that arrived over a data channel and lives in memory. It is now an
                 * ordinary download anchor over the block's own Blob, whose object URL is revoked
                 * when the row unmounts, and it disappears entirely when the block has no bytes
                 * (a "Save" for a file that does not exist was the same lie in a smaller hat).
                 */
                attachmentBlob instanceof Blob ? (
                  <AttachmentDownload blob={attachmentBlob} name={block.fileName ?? 'download'} />
                ) : (
                  <span className="text-[11px] text-[#5B6B82]" data-attachment-no-bytes="true">
                    No bytes to save
                  </span>
                )
              ) : null}
            </div>

            {mode === 'edit' ? (
              <AttachmentControls block={block} maxBytes={attachmentMaxBytes} onUpdate={onUpdate} />
            ) : null}
          </div>
        )}

        {/* LOCKED BLOCK OR LOCKED ENTITY CONTENT */}
        {showsLockArea && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <span
                className={`text-[12px] font-semibold flex items-center gap-1.5 ${
                  isProtected ? 'text-[#C2410C]' : 'text-red-700'
                }`}
              >
                {isProtected ? (
                  <KeyRound className="w-3.5 h-3.5" />
                ) : (
                  <ShieldOff className="w-3.5 h-3.5" />
                )}
                <span>{block.label || (isProtected ? 'Encrypted payload' : 'Secret field')}</span>
              </span>

              {/*
                No "Passphrase: •••••••• / (set)" readout, and no `(hint: pass)` anywhere in this
                row. A dossier stores no password (PLAN.md §6.2), so the only honest thing that
                could be shown here was a field that is always empty — and the pair of labels it
                used (`(set)` when unset, dots when set) was inverted as well. The state it was
                trying to show is now shown by the badge in the header, which is derived from the
                ciphertext instead of from a field that no longer exists.
              */}
              {mode === 'edit' && !isProtected ? (
                <button
                  type="button"
                  onClick={() => {
                    setLockError(null)
                    setShowLockConfigModal(true)
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold text-white bg-[#C2410C] hover:bg-[#9A3412] rounded tactile-btn cursor-pointer"
                >
                  <Shield className="w-3 h-3" />
                  <span>Encrypt</span>
                </button>
              ) : null}
            </div>

            {isProtected ? (
              /*
                An encrypted row shows ciphertext or nothing. There used to be a blurred
                demo vault string from the deleted mock seeder, painted over every locked block
                whatever it held, so the dark box always
                looked like a hidden secret. What is shown now is the shape of what is actually
                stored, and the plaintext only ever after a real decryption.
              */
              <div className="relative rounded-md border border-[#D1D9E4] bg-slate-900 text-slate-100 p-3 overflow-hidden font-mono text-[13px]">
                {block.isUnlocked ? (
                  <div className="flex items-center justify-between gap-2 transition-all duration-200">
                    <span className="text-emerald-400 select-all break-all" data-revealed="true">
                      {revealedPlaintext ??
                        'The decrypted file is back on the block — see the preview above.'}
                    </span>
                    <span className="text-[11px] text-slate-400 px-1.5 py-0.5 bg-slate-800 rounded shrink-0">
                      Unlocked
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-400" data-ciphertext-state="true">
                      Encrypted with PBKDF2 + AES-256-GCM. No plaintext is stored for this block.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setUnlockError(false)
                        setShowUnlockModal(true)
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#C2410C] hover:bg-[#9A3412] text-white text-xs font-semibold rounded shadow-xs tactile-btn cursor-pointer shrink-0"
                    >
                      <Unlock className="w-3.5 h-3.5" />
                      <span>Unlock</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              /*
                The honest unprotected state — a locked block that carries plaintext and no tuple,
                which is every locked row written before the editor encrypted on save. It is said
                in the plainest terms available because the alternative is the bug: a lock badge
                over a secret sitting in IndexedDB as text.
              */
              <div
                className="rounded-md border border-red-200 bg-red-50 p-3 space-y-2"
                data-unprotected-note="true"
              >
                <p className="text-[11px] text-red-700">
                  {isEmptyLocked
                    ? 'Nothing has been written into this block yet, so there is nothing to encrypt.'
                    : `Not encrypted: this ${blockWord} is stored as plaintext in the library on this device.`}
                </p>
                {mode === 'edit' && block.type === 'locked' ? (
                  /*
                    The secret field a `locked` block needs in order to exist at all: every other
                    type has its own editor above, and the old row had none for this one, which is
                    why the deleted mock seeder pre-filled a made-up secret here. What is typed in
                    this box is what `encryptBlockPayload` encrypts, and it is stored as plaintext
                    only until the user does.
                  */
                  <textarea
                    rows={2}
                    value={block.content ?? ''}
                    onChange={(e) => onUpdate?.(block.id, { content: e.target.value })}
                    placeholder="Write the secret to protect..."
                    aria-label="Secret to encrypt"
                    className="w-full text-xs font-mono text-[#0F172A] bg-white p-2 rounded border border-[#D1D9E4] focus:outline-none focus:border-[#1D4ED8] resize-y"
                  />
                ) : null}
                <p className="text-[11px] text-[#5B6B82]">
                  Encrypt it with a password you choose, or clear the lock to keep it as an
                  ordinary unprotected field.
                </p>
              </div>
            )}

            {/* Inline unlock form modal */}
            {showUnlockModal && isProtected && !block.isUnlocked && (
              <form
                onSubmit={handleUnlockSubmit}
                className="modal-enter p-3 bg-white border border-[#C2410C] rounded-md shadow-md mt-2 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-800">
                    Enter Decryption Key for "{block.label || 'Encrypted payload'}"
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowUnlockModal(false)}
                    className="text-xs text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    autoFocus
                    placeholder="Password for this block"
                    aria-label="Password for this block"
                    value={passwordInput}
                    onChange={(e) => {
                      setPasswordInput(e.target.value)
                      setUnlockError(false)
                    }}
                    className={`flex-1 text-xs px-2.5 py-1.5 rounded border ${
                      unlockError ? 'border-red-500 bg-red-50' : 'border-[#D1D9E4]'
                    } focus:outline-none focus:border-[#1D4ED8]`}
                  />
                  <button
                    type="submit"
                    disabled={isDecrypting}
                    className="px-3.5 py-1.5 bg-[#1D4ED8] hover:bg-blue-700 text-white text-xs font-semibold rounded tactile-btn cursor-pointer"
                  >
                    {isDecrypting ? 'Decrypting...' : 'Decrypt'}
                  </button>
                </div>
                {/*
                  One message for every failure. `revealBlock` reports a wrong password, a
                  tampered ciphertext and an unusable tuple identically, the way both other unlock
                  paths in the app do (`LibraryItemRow` and `hooks/useSession`), so nothing on
                  screen distinguishes "you typed it wrong" from "there is nothing here to open".
                */}
                {unlockError && (
                  <p className="text-[11px] text-red-600" role="alert" data-unlock-error="true">
                    Incorrect password. Please try again.
                  </p>
                )}
              </form>
            )}
          </div>
        )}

        {/* Lock Configuration Modal (Allows locking any entity with custom password) */}
        {showLockConfigModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs"
            onClick={() => setShowLockConfigModal(false)}
          >
            <div
              className="w-full max-w-sm bg-white rounded-xl border border-[#D1D9E4] shadow-2xl p-5 modal-enter"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="font-display font-bold text-sm text-[#0F172A] mb-1">
                {isProtected ? 'Encrypted block' : 'Encrypt this block with a password'}
              </h3>
              <p className="text-xs text-[#5B6B82] mb-3">
                {isProtected
                  ? 'The payload of this block is stored as AES-256-GCM ciphertext, and nothing else: no plaintext and no password are kept for it.'
                  : 'This encrypts the block\u2019s payload with Web Crypto PBKDF2-SHA256 (600,000 iterations) + AES-256-GCM. Only the ciphertext is stored. Each block can have its own password, and there is no recovery for one that is lost.'}
              </p>

              {!isProtected ? (
                <form onSubmit={handleSetLockPassword} className="space-y-3">
                  <div>
                    <label className="text-[11px] font-semibold text-slate-700 block mb-1">
                      Set Password for this Entity:
                    </label>
                    <input
                      type="password"
                      autoFocus
                      required
                      placeholder="Enter a password..."
                      value={newLockPassword}
                      onChange={(e) => setNewLockPassword(e.target.value)}
                      className="w-full text-xs px-2.5 py-1.5 rounded border border-[#D1D9E4] focus:outline-none focus:border-[#1D4ED8]"
                    />
                  </div>
                  {lockError !== null ? (
                    <p className="text-[11px] text-red-600" role="alert" data-lock-error="true">
                      {lockError}
                    </p>
                  ) : null}

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowLockConfigModal(false)}
                      className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg tactile-btn cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isEncrypting}
                      className="px-3.5 py-1.5 bg-[#C2410C] hover:bg-[#9A3412] text-white text-xs font-semibold rounded-lg tactile-btn cursor-pointer"
                    >
                      {isEncrypting ? 'Encrypting...' : 'Encrypt block'}
                    </button>
                  </div>
                </form>
              ) : (
                /*
                 * Removing a lock throws the ciphertext away, and a protected block keeps no
                 * plaintext by design, so removal first proves the password opens it and puts the
                 * payload back on the block. It used to be a one-click button that destroyed the
                 * secret with the lock — a data-loss bug wearing a security label. A wrong
                 * password here reports exactly as it does in the Unlock form above, and nothing
                 * changes on the block.
                 */
                <form onSubmit={handleRemoveLock} className="space-y-3">
                  <p className="text-xs text-slate-600 bg-orange-50 p-2.5 rounded border border-orange-200">
                    To reveal this block, use Unlock. To stop encrypting it, open it here first:
                    the password has to be right, or the payload would be discarded with the lock.
                  </p>
                  <input
                    type="password"
                    autoFocus
                    required
                    placeholder="Password for this block"
                    aria-label="Password to remove the lock"
                    value={removeLockPassword}
                    onChange={(e) => {
                      setRemoveLockPassword(e.target.value)
                      setRemoveLockError(false)
                    }}
                    className={`w-full text-xs px-2.5 py-1.5 rounded border ${
                      removeLockError ? 'border-red-500 bg-red-50' : 'border-[#D1D9E4]'
                    } focus:outline-none focus:border-[#1D4ED8]`}
                  />
                  {removeLockError ? (
                    <p className="text-[11px] text-red-600" role="alert" data-unlock-error="true">
                      Incorrect password. Please try again.
                    </p>
                  ) : null}
                  <div className="flex justify-between items-center pt-2">
                    <button
                      type="button"
                      onClick={() => setShowLockConfigModal(false)}
                      className="px-3.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg tactile-btn cursor-pointer"
                    >
                      Keep it encrypted
                    </button>
                    <button
                      type="submit"
                      disabled={isDecrypting}
                      className="px-3.5 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg tactile-btn cursor-pointer"
                    >
                      {isDecrypting ? 'Opening...' : 'Decrypt and remove lock'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Why an attempt to encrypt a block failed, in the words that fit a lock dialog.
 *
 * `describeSendFailure` already turns `DossierSendError` into a sentence, but its sentences end
 * in "then send again", which is not what just went wrong here: this is the editor, nothing is
 * being sent, and the fix is to write something into the block or choose a smaller file.
 */
function describeLockFailure(cause: unknown): string {
  if (cause instanceof DossierSendError) {
    switch (cause.reason) {
      case 'locked-content-missing':
        return 'This block has nothing to encrypt. Write the secret in, or choose a file for it, then lock it again.'
      case 'locked-password-missing':
        return 'A password is needed to encrypt this block. Type one, then lock it again.'
      default:
        return describeSendFailure(cause)
    }
  }
  return describeSendFailure(cause)
}

/**
 * A real save: the block's own bytes, handed to the browser as a download.
 *
 * The object URL is created when this anchor mounts and revoked when it unmounts (see
 * `useObjectURL`), so a row that goes away, a block whose file is replaced, and a session screen
 * that closes all release the reference. Nothing here claims a file was written anywhere: the
 * anchor is the mechanism, and the browser's own download UI is the confirmation.
 */
function AttachmentDownload({ blob, name }: { blob: Blob; name: string }) {
  const url = useObjectUrl(blob)
  if (url === null) return null

  return (
    <a
      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-[#D1D9E4] rounded hover:bg-slate-100 tactile-btn"
      href={url}
      download={name}
      data-attachment-download="true"
    >
      <Download className="w-3.5 h-3.5" aria-hidden="true" />
      <span>Save file</span>
    </a>
  )
}

interface AttachmentControlsProps {
  block: FileBlock
  /** D6's cap for a locked block, `LIBRARY_ATTACHMENT_MAX_BYTES` for a plain one. */
  maxBytes: number
  onUpdate?: (id: string, changes: Partial<FileBlock>) => void
}

/**
 * Choose / replace / remove, for the two block types that hold bytes.
 *
 * The message state lives on the row because a refusal belongs to the block it refuses and
 * disappears with it. The rule that makes this file's old behaviour impossible: `onUpdate` is
 * called only with a file that passed both checks, so a wrong-type or oversized choice cannot
 * leave a half-written block in the draft — the block keeps the file it had, or keeps having
 * none. Removing an attachment clears the bytes and the metadata together, so a block can never
 * claim a filename it no longer holds.
 */
function AttachmentControls({ block, maxBytes, onUpdate }: AttachmentControlsProps) {
  const [error, setError] = useState<string | null>(null)
  const blockType = block.type === 'image' ? 'image' : 'fileAttachment'
  const word = blockType === 'image' ? 'image' : 'file'
  const hasFile = block.blob !== undefined

  /*
   * A locked attachment's ciphertext was made from the bytes that were on the block when the
   * lock was set (see `handleSetLockPassword`). Choosing or removing a file after that would
   * leave the row showing one payload and `fileBlocksToLibraryItems` sending the other one —
   * the same species of defect as a fabricated blob, so it is refused here rather than detected
   * later. `fileBlocksToLibraryItems` sends the stored tuple byte-for-byte (D9), which is only
   * safe because nothing can silently rewrite these bytes underneath it.
   */
  /*
   * A locked block's ciphertext was made from the bytes that were on the block when the lock was
   * set (see `encryptBlockPayload`). Choosing or removing a file after that would leave the row
   * showing one payload and `fileBlocksToLibraryItems` sending the other one — the same species
   * of defect as a fabricated blob, so it is refused here rather than detected later. The guard
   * is the CIPHERTEXT, not the lock flag: a block that is marked locked but holds no tuple is
   * exactly the row that still needs a file choosing, so that it can be encrypted at all.
   */
  if (isProtectedBlock(block)) {
    return (
      <p className="text-[11px] text-[#5B6B82]" data-attachment-locked="true">
        This block is locked. Remove the lock to choose a different {word}.
      </p>
    )
  }

  const apply = (attachment: AttachmentSelection): void => {
    setError(null)
    onUpdate?.(block.id, {
      blob: attachment.blob,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      // A byte count taken from the chosen Blob, stored as a number. The row displays
      // `blob.size` directly; this is the same measurement kept on the record.
      fileSize: attachment.sizeInBytes,
    })
  }

  const remove = (): void => {
    setError(null)
    onUpdate?.(block.id, {
      blob: undefined,
      fileName: undefined,
      fileSize: undefined,
      mimeType: undefined,
    })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <AttachmentPicker
          blockType={blockType}
          label={hasFile ? `Replace ${word}` : `Choose ${word}`}
          maxBytes={maxBytes}
          onSelect={apply}
          onReject={(message) => {
            setError(message)
          }}
        />
        {hasFile ? (
          <button
            type="button"
            onClick={remove}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-600 bg-white border border-red-200 rounded hover:bg-red-50 tactile-btn cursor-pointer"
          >
            <IconX size={14} aria-hidden="true" />
            <span>Remove {word}</span>
          </button>
        ) : null}
      </div>

      {error !== null ? (
        <p className="text-[11px] text-red-600" role="alert" data-attachment-error="true">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The image block's own bytes, drawn.
 *
 * There was a diagram here: a fixed SVG of two circles labelled `CAM_01` and `LIDAR_A` with an
 * `OFFSET: Δ120mm` caption, shown for every image block whether or not it held anything. It read
 * as the user's picture and it was decoration. A row now draws a picture only when it has one.
 */
function ImagePreview({ blob, name }: { blob: Blob; name: string }) {
  const url = useObjectUrl(blob)
  if (url === null) return null

  return (
    <img
      className="max-h-full max-w-full object-contain"
      src={url}
      alt={name}
      data-attachment-preview="true"
    />
  )
}

/**
 * An object URL for `blob`, released on every exit path.
 *
 * `URL.createObjectURL` hands out a reference to the Blob that outlives the component that took
 * it, so the revocation is the effect's cleanup and the dependency is the Blob: replacing a
 * file re-runs the effect, which revokes the URL of the file that is gone before creating the
 * URL of the one that replaced it, and unmounting revokes the last one. Deleting the attachment
 * unmounts this preview entirely, so its URL goes with it.
 *
 * An environment without `createObjectURL` (jsdom unless a test stubs it, as
 * `LibraryItemRow.test.tsx` does) gets `null` and renders no `<img>`, never a crash.
 */
function useObjectUrl(blob: Blob): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return undefined

    const created = URL.createObjectURL(blob)
    setUrl(created)
    return () => {
      URL.revokeObjectURL(created)
      setUrl(null)
    }
  }, [blob])

  return url
}

/**
 * One block of a dossier — the row the editor builds, edits, reorders and locks, and the same
 * row the two session screens reuse for a transfer.
 *
 * DESIGN.md calls the editor an Operate surface, so the row is a **flat, bordered surface with
 * one division rhythm**: the header line (grip, type, state badge, toolbar) over the payload.
 * Nothing inside it is another bordered card — the revealed secret is a sunken inset, the warning
 * is a line of status-coloured text, and the controls are `ActionIcon`s on a transparent field.
 *
 * Two things the row must never get wrong, both learned the expensive way:
 *
 *  - the state it shows is derived from what is **stored**, not from the flag the user last
 *    pressed (`isProtectedBlock` reads the ciphertext tuple). A lock icon over a plaintext
 *    payload is a false claim about the user's secret, so an `Encrypted` badge is only ever
 *    earned by real ciphertext;
 *  - nothing is rendered that the user did not supply: no invented filename, no invented size,
 *    no blurred demo secret painted over whatever the block held. See the comments on
 *    `revealBlock`, `attachmentSizeLabel` and `ImagePreview`.
 */

import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Progress,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import {
  IconChevronDown,
  IconChevronUp,
  IconCircleCheck,
  IconClock,
  IconCopy,
  IconDownload,
  IconFile,
  IconGripVertical,
  IconKey,
  IconLock,
  IconLockOpen,
  IconShieldLock,
  IconShieldOff,
  IconTag,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
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

/*
 * Tokens, not hexes (DESIGN.md, "The No Raw Hex Rule"). The row's resting border is `border`
 * (a division) and its hover border is `border-strong` (an affordance the user must find);
 * both are Tailwind arbitrary values because a hover state cannot be written as an inline
 * style, and an inline style would beat the class rather than complement it.
 */
const ROW_SURFACE =
  'border border-[color:var(--qrbit-border)] hover:border-[color:var(--qrbit-border-strong)]'
/** A protected row states its own condition, in 1px of `locked`, on the row it describes. */
const ROW_PROTECTED = 'border-[color:color-mix(in_srgb,var(--qrbit-locked)_55%,var(--qrbit-border))]'
/** An unprotected secret is a warning that is not yet a failure: 1px of `danger`. */
const ROW_UNPROTECTED = 'border-[color:color-mix(in_srgb,var(--qrbit-danger)_55%,var(--qrbit-border))]'

const DIVISION: CSSProperties = { borderBottom: '1px solid var(--qrbit-border)' }
const INSET: CSSProperties = {
  backgroundColor: 'var(--qrbit-sunken)',
  borderRadius: 'var(--qrbit-radius-sm)',
  padding: 'var(--qrbit-space-sm)',
}

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
   * Props from `useReorderDrag().getHandleProps(index)`, spread onto the grip. The grip stays a
   * real button element (Mantine's `ActionIcon` renders one) because that is what the hook needs:
   * pointer down starts the drag, and ArrowUp/ArrowDown/Home/End on it are the keyboard path.
   * Omitted = no grip rendered.
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

  /**
   * The grabbed row is painted at the pointer, above its neighbours, and nothing else moves. It
   * also takes the sheet shadow: DESIGN.md's "Floating Only" rule makes depth a response to
   * state, and a row under the pointer is the one thing on the page that is above the others.
   */
  const dragStyle: CSSProperties = isReorderDragging
    ? {
        transform: `translateY(${reorderOffset}px)`,
        zIndex: 1,
        position: 'relative',
        boxShadow: 'var(--qrbit-shadow-sheet)',
        borderColor: 'var(--qrbit-signal)',
      }
    : {}

  /**
   * The grip, rendered only when the editor handed this row a drag handle (D16.2).
   *
   * It used to be painted `text-slate-400`, which measured 2.28:1 on the page — documented as
   * the reason the handle read as a smudge rather than a handle. `c="dimmed"` is the `--mantine-color-dimmed`
   * slot, which `theme.ts` points at `--qrbit-ink-secondary` (7.0:1 light, 8:1 dark), so the
   * affordance clears the 3:1 floor in both schemes while staying quieter than the payload.
   */
  const grip =
    isReorderRow && reorderHandleProps !== undefined ? (
      <ActionIcon variant="subtle" size="lg" c="dimmed" {...reorderHandleProps}>
        <IconGripVertical size={16} aria-hidden="true" />
      </ActionIcon>
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

  /**
   * Transfer status for the two session screens. A badge carries an icon *and* a word
   * (DESIGN.md, "Badges and Chips"): colour alone is never the whole message.
   */
  const renderStatusPill = (): ReactNode => {
    if (mode !== 'sender' && mode !== 'receiver') return null
    if (transferStatus === undefined) return null

    if (transferStatus === 'pending') {
      return (
        <Badge variant="light" color="gray" radius="full" leftSection={<IconClock size={12} aria-hidden="true" />}>
          Pending
        </Badge>
      )
    }

    if (transferStatus === 'in_progress') {
      return (
        <Group gap="xs" wrap="nowrap">
          {/* The old bar was two hand-painted divs; Mantine's Progress is the same thing with
              the token radius, the token track and a real value. */}
          <Progress value={transferProgress} size="xs" radius="full" w={80} />
          <Text span className="qrbit-text-data" c="dimmed">
            {Math.round(transferProgress)}%
          </Text>
        </Group>
      )
    }

    if (transferStatus === 'error') {
      return (
        <Badge
          variant="light"
          color="danger"
          radius="full"
          leftSection={<IconX size={12} aria-hidden="true" />}
          data-transfer-error="true"
        >
          Not delivered
        </Badge>
      )
    }

    return (
      <Badge
        variant="light"
        // Verified Green: "a completed transfer" (DESIGN.md, Status). Delivered is a completion.
        color="success"
        radius="full"
        leftSection={<IconCircleCheck size={12} aria-hidden="true" />}
      >
        Delivered
      </Badge>
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
          <ActionIcon
            variant="subtle"
            size="lg"
            c="dimmed"
            aria-label="Delete divider"
            title="Delete divider"
            onClick={() => onDelete?.(block.id)}
          >
            <IconTrash size={16} aria-hidden="true" />
          </ActionIcon>
        )}
        <div className="w-full flex items-center gap-3">
          {/* A division is `border`, and 1px of it. */}
          <span style={{ flex: '1 1 auto', height: 1, backgroundColor: 'var(--qrbit-border)' }} />
          <Text span className="qrbit-text-label" c="dimmed" style={{ textTransform: 'uppercase' }}>
            DIVIDER
          </Text>
          <span style={{ flex: '1 1 auto', height: 1, backgroundColor: 'var(--qrbit-border)' }} />
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
      className={`group relative transition-colors ${ROW_SURFACE} ${
        isProtected ? ROW_PROTECTED : isUnprotected ? ROW_UNPROTECTED : ''
      } ${isReorderDragging ? '' : 'hover:shadow-(--qrbit-shadow-lift)'}`}
      data-reorder-item={isReorderRow ? '' : undefined}
      data-block-protected={isProtected ? 'true' : undefined}
      data-block-unprotected={isUnprotected ? 'true' : undefined}
      style={{ backgroundColor: 'var(--qrbit-raised)', borderRadius: 'var(--qrbit-radius-lg)', ...dragStyle }}
    >
      {/* Header bar of block */}
      <div
        className="px-3 pt-2 pb-2 flex items-center justify-between gap-2"
        style={DIVISION}
      >
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          {grip !== null ? <span className="shrink-0">{grip}</span> : null}
          <Text
            span
            className="qrbit-text-label"
            c="dimmed"
            // The block's type is a classification, not data a user reads back, so it is the
            // sans at the Label role — the row used to set it in mono at 11px.
            style={{ textTransform: 'uppercase', whiteSpace: 'nowrap' }}
          >
            {block.type === 'shortText' ? 'Short Text' : block.type}
          </Text>

          {/*
            The badge is derived from the ciphertext, never from `isLocked`: a lock icon over a
            plaintext payload is the exact claim this row is not allowed to make. An unprotected
            secret says so instead.
          */}
          {isProtected && (
            <Badge
              variant="light"
              // Locked Rust means encryption state and nothing else (DESIGN.md, Status).
              color="locked"
              radius="full"
              leftSection={<IconLock size={12} aria-hidden="true" />}
            >
              Encrypted
            </Badge>
          )}

          {isUnprotected && (
            <Badge
              variant="light"
              color="danger"
              radius="full"
              leftSection={<IconShieldOff size={12} aria-hidden="true" />}
              data-unprotected-badge="true"
            >
              Not encrypted
            </Badge>
          )}

          {/* Label tag indicator if entity has a label */}
          {block.label && block.type !== 'shortText' && (
            <Badge
              variant="light"
              color="gray"
              radius="full"
              leftSection={<IconTag size={12} aria-hidden="true" />}
            >
              {block.label}
            </Badge>
          )}
        </Group>

        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
          {renderStatusPill()}

          {mode === 'edit' && (
            <Group gap={0} wrap="nowrap">
              {/* Lock / Unlock Toggle Button */}
              <ActionIcon
                variant="subtle"
                size="lg"
                c={isProtected ? 'locked' : isUnprotected ? 'danger' : 'dimmed'}
                aria-label={
                  isProtected
                    ? 'Manage encryption for this block'
                    : 'Encrypt this block with a password'
                }
                title={
                  isProtected
                    ? 'Manage encryption for this block'
                    : 'Encrypt this block with a password'
                }
                onClick={() => {
                  setLockError(null)
                  setShowLockConfigModal(true)
                }}
              >
                {isProtected ? (
                  <IconLock size={16} aria-hidden="true" />
                ) : isUnprotected ? (
                  <IconShieldOff size={16} aria-hidden="true" />
                ) : (
                  <IconShieldLock size={16} aria-hidden="true" />
                )}
              </ActionIcon>

              <ActionIcon
                variant="subtle"
                size="lg"
                c="dimmed"
                onClick={() => onMoveUp?.(index)}
                disabled={index === 0}
                title="Move up"
                aria-label={`Move ${block.type} block up`}
              >
                <IconChevronUp size={16} aria-hidden="true" />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                size="lg"
                c="dimmed"
                onClick={() => onMoveDown?.(index)}
                disabled={index === totalBlocks - 1}
                title="Move down"
                aria-label={`Move ${block.type} block down`}
              >
                <IconChevronDown size={16} aria-hidden="true" />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                size="lg"
                c="dimmed"
                onClick={() => onDuplicate?.(block.id)}
                title="Duplicate block"
                aria-label="Duplicate block"
              >
                <IconCopy size={16} aria-hidden="true" />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                size="lg"
                c="dimmed"
                onClick={() => onDelete?.(block.id)}
                title="Delete block"
                aria-label="Delete block"
              >
                <IconTrash size={16} aria-hidden="true" />
              </ActionIcon>
            </Group>
          )}
        </Group>
      </div>

      {/* Main Content Area based on block type */}
      <div className="p-3 space-y-2">
        {/* Optional Label field for entities when editing (User can choose to set label for each entity) */}
        {mode === 'edit' && block.type !== 'shortText' && (
          <Group gap="sm" wrap="nowrap" pb="xs">
            <Text span className="qrbit-text-label" c="dimmed" style={{ flex: 'none', width: 56 }}>
              Label
            </Text>
            <TextInput
              size="sm"
              type="text"
              value={block.label || ''}
              onChange={(e) => onUpdate?.(block.id, { label: e.target.value })}
              placeholder="Label (optional)"
              aria-label={`Label for this ${block.type} block`}
              style={{ flex: '1 1 auto', minWidth: 0 }}
            />
          </Group>
        )}

        {/* HEADING BLOCK */}
        {block.type === 'heading' && (
          <div>
            {canEditPayload ? (
              <TextInput
                size="sm"
                type="text"
                value={block.content || ''}
                onChange={(e) => onUpdate?.(block.id, { content: e.target.value })}
                placeholder="Enter section heading..."
                aria-label="Section heading"
                styles={{ input: { font: 'var(--qrbit-text-title)', letterSpacing: 'var(--qrbit-text-title-tracking)' } }}
              />
            ) : (
              <Text className="qrbit-text-title">{block.content}</Text>
            )}
          </div>
        )}

        {/* SHORT TEXT BLOCK */}
        {block.type === 'shortText' && (
          <div className="space-y-2">
            {mode === 'edit' ? (
              <>
                <Group gap="sm" wrap="nowrap">
                  <Text
                    span
                    className="qrbit-text-label"
                    c="dimmed"
                    style={{ flex: 'none', width: 56 }}
                  >
                    Label
                  </Text>
                  <TextInput
                    size="sm"
                    type="text"
                    value={block.label || ''}
                    onChange={(e) => onUpdate?.(block.id, { label: e.target.value })}
                    placeholder="Field label..."
                    aria-label="Field label"
                    style={{ flex: '1 1 auto', minWidth: 0 }}
                  />
                </Group>
                <Group gap="sm" wrap="nowrap">
                  <Text
                    span
                    className="qrbit-text-label"
                    c="dimmed"
                    style={{ flex: 'none', width: 56 }}
                  >
                    Value
                  </Text>
                  {/*
                    No editable value while the block is encrypted: the tuple is a ciphertext of
                    the bytes that were on the block when it was locked, so a field the user could
                    type into beside it would put one payload on screen and another on the wire.
                    The value appears below, after a real unlock.
                  */}
                  {canEditPayload ? (
                    <TextInput
                      size="sm"
                      type="text"
                      value={block.value || ''}
                      onChange={(e) => onUpdate?.(block.id, { value: e.target.value })}
                      placeholder="Single-line value..."
                      aria-label="Field value"
                      style={{ flex: '1 1 auto', minWidth: 0 }}
                    />
                  ) : (
                    <Text span className="qrbit-text-body-secondary" c="dimmed">
                      Encrypted value — unlock to reveal it
                    </Text>
                  )}
                </Group>
              </>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                <Text span className="qrbit-text-label" c="dimmed">
                  {block.label}
                </Text>
                {/* A field's value is data the user may read back to someone: the Data role. */}
                <Text span className="qrbit-text-data" style={INSET}>
                  {block.value}
                </Text>
              </div>
            )}
          </div>
        )}

        {/* RICH TEXT BLOCK */}
        {block.type === 'richText' && (
          <div>
            {canEditPayload ? (
              <Textarea
                size="sm"
                minRows={3}
                value={block.content || ''}
                onChange={(e) => onUpdate?.(block.id, { content: e.target.value })}
                placeholder="Write formatted notes or documentation..."
                aria-label="Note content"
              />
            ) : (
              <Text className="qrbit-text-body" style={{ whiteSpace: 'pre-line' }}>
                {block.content}
              </Text>
            )}
          </div>
        )}

        {/* IMAGE BLOCK */}
        {block.type === 'image' && (
          <div className="space-y-2">
            <div
              className="relative w-full flex flex-col items-center justify-center overflow-hidden"
              style={{
                // The well is `sunken`, not near-black: a dark box was a stage for a picture
                // that was not there.
                backgroundColor: 'var(--qrbit-sunken)',
                border: '1px solid var(--qrbit-border)',
                borderRadius: 'var(--qrbit-radius-sm)',
                padding: 'var(--qrbit-space-md)',
                minHeight: 96,
              }}
            >
              {canPreviewImage && attachmentBlob instanceof Blob ? (
                <ImagePreview blob={attachmentBlob} name={block.fileName ?? 'Chosen image'} />
              ) : (
                <p
                  className="qrbit-text-body-secondary text-center px-4"
                  style={{ color: 'var(--qrbit-ink-muted)' }}
                  data-attachment-empty="true"
                >
                  {attachmentBlob instanceof Blob
                    ? 'The bytes on this block are not an image, so there is no preview to draw.'
                    : 'No image chosen yet — this block holds no bytes.'}
                </p>
              )}

              {transferStatus === 'in_progress' && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6"
                  style={{ backgroundColor: 'var(--qrbit-sunken)' }}
                >
                  <span className="qrbit-text-body-secondary">
                    Streaming image data… {Math.round(transferProgress)}%
                  </span>
                  <Progress value={transferProgress} size="sm" radius="full" w={192} />
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2">
              <Text span className="qrbit-text-body-secondary" style={{ minWidth: 0 }} truncate>
                {block.fileName ?? 'No file chosen'}
              </Text>
              {/* A byte count is data, so it is mono and tabular. */}
              <Text
                span
                className="qrbit-text-data"
                c="dimmed"
                style={{ flex: 'none' }}
              >
                {attachmentSizeLabel ?? 'no size until a file is chosen'}
              </Text>
            </div>

            {block.caption !== undefined && block.caption !== '' ? (
              <Text className="qrbit-text-body-secondary" c="dimmed">
                {block.caption}
              </Text>
            ) : null}

            {mode === 'edit' ? (
              <AttachmentControls block={block} maxBytes={attachmentMaxBytes} onUpdate={onUpdate} />
            ) : null}
          </div>
        )}

        {/* FILE ATTACHMENT BLOCK */}
        {block.type === 'fileAttachment' && (
          <div className="space-y-2">
            <Group gap="sm" wrap="nowrap">
              {/* A decorative tile, not a control: nothing here is pressable, so nothing is a Button. */}
              <span
                aria-hidden="true"
                style={{
                  flex: 'none',
                  width: 34,
                  height: 34,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--qrbit-signal)',
                  backgroundColor: 'var(--qrbit-sunken)',
                  borderRadius: 'var(--qrbit-radius-sm)',
                }}
              >
                <IconFile size={18} />
              </span>
              <div style={{ minWidth: 0 }}>
                <Text span className="qrbit-text-body" truncate>
                  {block.fileName ?? 'No file chosen'}
                </Text>
                <Text span className="qrbit-text-data" c="dimmed">
                  {attachmentSizeLabel ?? 'no size until a file is chosen'}
                </Text>
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
                  <Text span className="qrbit-text-body-secondary" c="dimmed" data-attachment-no-bytes="true">
                    No bytes to save
                  </Text>
                )
              ) : null}
            </Group>

            {mode === 'edit' ? (
              <AttachmentControls block={block} maxBytes={attachmentMaxBytes} onUpdate={onUpdate} />
            ) : null}
          </div>
        )}

        {/* LOCKED BLOCK OR LOCKED ENTITY CONTENT */}
        {showsLockArea && (
          <div className="space-y-2 pt-1">
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                {isProtected ? (
                  <IconKey size={16} aria-hidden="true" style={{ flex: 'none', color: 'var(--qrbit-locked)' }} />
                ) : (
                  <IconShieldOff size={16} aria-hidden="true" style={{ flex: 'none', color: 'var(--qrbit-danger)' }} />
                )}
                <Text
                  span
                  className="qrbit-text-label"
                  c={isProtected ? 'locked' : 'danger'}
                  style={{ minWidth: 0 }}
                  truncate
                >
                  {block.label || (isProtected ? 'Encrypted payload' : 'Secret field')}
                </Text>
              </Group>

              {/*
                No "Passphrase: •••••••• / (set)" readout, and no `(hint: pass)` anywhere in this
                row. A dossier stores no password (PLAN.md §6.2), so the only honest thing that
                could be shown here was a field that is always empty — and the pair of labels it
                used (`(set)` when unset, dots when set) was inverted as well. The state it was
                trying to show is now shown by the badge in the header, which is derived from the
                ciphertext instead of from a field that no longer exists.
              */}
              {mode === 'edit' && !isProtected ? (
                <Button
                  size="xs"
                  color="locked"
                  leftSection={<IconShieldLock size={14} aria-hidden="true" />}
                  style={{ flex: 'none' }}
                  onClick={() => {
                    setLockError(null)
                    setShowLockConfigModal(true)
                  }}
                >
                  Encrypt this {blockWord}
                </Button>
              ) : null}
            </Group>

            {isProtected ? (
              /*
                An encrypted row shows ciphertext or nothing. There used to be a blurred
                demo vault string from the deleted mock seeder, painted over every locked block
                whatever it held, so the dark box always
                looked like a hidden secret. What is shown now is the shape of what is actually
                stored, and the plaintext only ever after a real decryption.

                The dark bordered box is gone too: a bordered card inside a bordered row is the
                nesting DESIGN.md bans, and a near-black well made a statement about "secrecy"
                rather than about the bytes. The revealed plaintext sits in a `sunken` inset —
                the same treatment the session board gives a secret — and nothing else.
              */
              block.isUnlocked ? (
                <Group justify="space-between" wrap="nowrap" gap="sm" style={INSET}>
                  <Text
                    span
                    className="qrbit-text-body"
                    data-revealed="true"
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'all', minWidth: 0 }}
                  >
                    {revealedPlaintext ??
                      'The decrypted file is back on the block — see the preview above.'}
                  </Text>
                  <Badge
                    variant="light"
                    color="success"
                    radius="full"
                    style={{ flex: 'none' }}
                  >
                    Revealed
                  </Badge>
                </Group>
              ) : (
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <Text span className="qrbit-text-body-secondary" c="dimmed" data-ciphertext-state="true">
                    Encrypted with PBKDF2 + AES-256-GCM. No plaintext is stored for this block.
                  </Text>
                  <Button
                    size="sm"
                    color="locked"
                    leftSection={<IconLockOpen size={14} aria-hidden="true" />}
                    style={{ flex: 'none' }}
                    onClick={() => {
                      setUnlockError(false)
                      setShowUnlockModal(true)
                    }}
                  >
                    Unlock
                  </Button>
                </Group>
              )
            ) : (
              /*
                The honest unprotected state — a locked block that carries plaintext and no tuple,
                which is every locked row written before the editor encrypted on save. It is said
                in the plainest terms available because the alternative is the bug: a lock badge
                over a secret sitting in IndexedDB as text. It is a line of status-coloured prose,
                not a bordered box inside the bordered row.
              */
              <div className="space-y-2">
                <p
                  className="qrbit-text-body-secondary"
                  style={{ color: 'var(--qrbit-danger)' }}
                  data-unprotected-note="true"
                >
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
                  <Textarea
                    size="sm"
                    minRows={2}
                    value={block.content ?? ''}
                    onChange={(e) => onUpdate?.(block.id, { content: e.target.value })}
                    placeholder="Write the secret to protect..."
                    aria-label="Secret to encrypt"
                  />
                ) : null}
                <p className="qrbit-text-body-secondary" style={{ color: 'var(--qrbit-ink-muted)' }}>
                  Encrypt it with a password you choose, or clear the lock to keep it as an
                  ordinary unprotected field.
                </p>
              </div>
            )}

            {/*
              Inline unlock form. This one stays inline rather than in a `Modal` on purpose: it is
              the reveal field set for this row, it belongs beside the ciphertext it opens, and
              `BlockItem.test.tsx` searches the container for it — a portal would turn several of
              this file's security absence-assertions into checks of nothing at all.
            */}
            {showUnlockModal && isProtected && !block.isUnlocked && (
              <form
                onSubmit={handleUnlockSubmit}
                className="flex flex-col gap-2"
                style={{ marginTop: 'var(--qrbit-space-sm)' }}
              >
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <Text span className="qrbit-text-label">
                    {`Enter the password for "${block.label || 'Encrypted payload'}"`}
                  </Text>
                  <Button
                    variant="subtle"
                    size="xs"
                    c="dimmed"
                    onClick={() => setShowUnlockModal(false)}
                    style={{ flex: 'none' }}
                  >
                    Cancel
                  </Button>
                </Group>

                <Group gap="sm" wrap="nowrap">
                  <TextInput
                    size="sm"
                    type="password"
                    autoFocus
                    placeholder="Password for this block"
                    aria-label="Password for this block"
                    value={passwordInput}
                    onChange={(e) => {
                      setPasswordInput(e.target.value)
                      setUnlockError(false)
                    }}
                    style={{ flex: '1 1 auto', minWidth: 0 }}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    color="signal"
                    loading={isDecrypting}
                    style={{ flex: 'none' }}
                  >
                    {isDecrypting ? 'Decrypting...' : 'Decrypt'}
                  </Button>
                </Group>
                {/*
                  One message for every failure. `revealBlock` reports a wrong password, a
                  tampered ciphertext and an unusable tuple identically, the way both other unlock
                  paths in the app do (`LibraryItemRow` and `hooks/useSession`), so nothing on
                  screen distinguishes "you typed it wrong" from "there is nothing here to open".
                */}
                {unlockError && (
                  <p
                    className="qrbit-text-body-secondary"
                    style={{ color: 'var(--qrbit-danger)' }}
                    role="alert"
                    data-unlock-error="true"
                  >
                    Incorrect password. Please try again.
                  </p>
                )}
              </form>
            )}
          </div>
        )}
      </div>

      {/*
        Lock dialog (DESIGN.md, "Dialogs"): a real Mantine `Modal` — radius md, the sheet shadow,
        the Title role, Escape cancelling and focus returning to the grip that opened it. It
        portals above the page rather than being a box painted inside the row it belongs to.
      */}
      <Modal
        opened={showLockConfigModal}
        onClose={() => setShowLockConfigModal(false)}
        title={isProtected ? 'Encrypted block' : 'Encrypt this block with a password'}
        size="sm"
        centered
        padding="lg"
        withCloseButton={false}
      >
        <Stack gap="md">
          <Text className="qrbit-text-body-secondary" c="dimmed">
            {isProtected
              ? 'The payload of this block is stored as AES-256-GCM ciphertext, and nothing else: no plaintext and no password are kept for it.'
              : 'This encrypts the block\u2019s payload with Web Crypto PBKDF2-SHA256 (600,000 iterations) + AES-256-GCM. Only the ciphertext is stored. Each block can have its own password, and there is no recovery for one that is lost.'}
          </Text>

          {!isProtected ? (
            <form onSubmit={handleSetLockPassword}>
              <Stack gap="sm">
                <TextInput
                  size="sm"
                  label="Password for this block"
                  // DESIGN.md's Label role is 12px/600; Mantine's input label is 12px/500, and
                  // the weight is not a theme slot (see theme.ts).
                  styles={{ label: { fontWeight: 600 } }}
                  type="password"
                  autoFocus
                  required
                  placeholder="Enter a password..."
                  value={newLockPassword}
                  onChange={(e) => setNewLockPassword(e.target.value)}
                />
                {lockError !== null ? (
                  <p
                    className="qrbit-text-body-secondary"
                    style={{ color: 'var(--qrbit-danger)' }}
                    role="alert"
                    data-lock-error="true"
                  >
                    {lockError}
                  </p>
                ) : null}

                <Group justify="flex-end" gap="sm" wrap="nowrap">
                  <Button
                    type="button"
                    variant="subtle"
                    size="sm"
                    onClick={() => setShowLockConfigModal(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" color="locked" loading={isEncrypting}>
                    {isEncrypting ? 'Encrypting...' : 'Encrypt block'}
                  </Button>
                </Group>
              </Stack>
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
            <form onSubmit={handleRemoveLock}>
              <Stack gap="sm">
                <Text className="qrbit-text-body-secondary" style={{ color: 'var(--qrbit-ink-secondary)' }}>
                  To reveal this block, use Unlock. To stop encrypting it, open it here first:
                  the password has to be right, or the payload would be discarded with the lock.
                </Text>
                <TextInput
                  size="sm"
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
                />
                {removeLockError ? (
                  <p
                    className="qrbit-text-body-secondary"
                    style={{ color: 'var(--qrbit-danger)' }}
                    role="alert"
                    data-unlock-error="true"
                  >
                    Incorrect password. Please try again.
                  </p>
                ) : null}
                <Group justify="space-between" gap="sm" wrap="nowrap">
                  <Button
                    type="button"
                    variant="subtle"
                    size="sm"
                    onClick={() => setShowLockConfigModal(false)}
                  >
                    Keep it encrypted
                  </Button>
                  {/* Destructive, and it names the consequence (DESIGN.md, "Dialogs"). */}
                  <Button type="submit" size="sm" color="danger" loading={isDecrypting}>
                    {isDecrypting ? 'Opening...' : 'Decrypt and remove lock'}
                  </Button>
                </Group>
              </Stack>
            </form>
          )}
        </Stack>
      </Modal>
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
 *
 * It is an `<a>` rather than a `<Button>` because it is a link to a resource — the browser's
 * download chrome is its confirmation, and DESIGN.md's Button table is for actions.
 */
function AttachmentDownload({ blob, name }: { blob: Blob; name: string }) {
  const url = useObjectUrl(blob)
  if (url === null) return null

  return (
    <a
      className="tactile-btn inline-flex items-center gap-2 shrink-0 hover:border-[color:var(--qrbit-border-strong)]"
      style={{
        padding: '0 12px',
        height: 32,
        alignItems: 'center',
        gap: 'var(--qrbit-space-xs)',
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--qrbit-ink)',
        backgroundColor: 'var(--qrbit-raised)',
        border: '1px solid var(--qrbit-border-strong)',
        borderRadius: 'var(--qrbit-radius-sm)',
        textDecoration: 'none',
      }}
      href={url}
      download={name}
      data-attachment-download="true"
    >
      <IconDownload size={16} aria-hidden="true" />
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
   * A locked block's ciphertext was made from the bytes that were on the block when the lock was
   * set (see `encryptBlockPayload`). Choosing or removing a file after that would leave the row
   * showing one payload and `fileBlocksToLibraryItems` sending the other one — the same species
   * of defect as a fabricated blob, so it is refused here rather than detected later. The guard
   * is the CIPHERTEXT, not the lock flag: a block that is marked locked but holds no tuple is
   * exactly the row that still needs a file choosing, so that it can be encrypted at all.
   */
  if (isProtectedBlock(block)) {
    return (
      <p className="qrbit-text-body-secondary" style={{ color: 'var(--qrbit-ink-muted)' }} data-attachment-locked="true">
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
    <div className="space-y-2">
      <Group gap="sm" wrap="nowrap">
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
          <Button
            type="button"
            variant="default"
            size="sm"
            c="danger"
            leftSection={<IconX size={14} aria-hidden="true" />}
            onClick={remove}
          >
            Remove {word}
          </Button>
        ) : null}
      </Group>

      {error !== null ? (
        <p
          className="qrbit-text-body-secondary"
          style={{ color: 'var(--qrbit-danger)' }}
          role="alert"
          data-attachment-error="true"
        >
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

/**
 * Locked item compose modal (PLAN.md §16 Phase 4, with decisions D6 and D7).
 *
 * The sender's side of a locked item: label, inner type, password, content. Nothing
 * here encrypts anything — the modal collects the four values and hands them to
 * `addLockedItem`, which derives the item key (PBKDF2, 600k iterations, PLAN.md §19
 * decision 9 — around 300ms, which is what the spinner covers) and puts the
 * `locked-payload` frame on the wire. That is why this component imports no crypto:
 * Web Crypto only (AGENTS.md), and none of it belongs to the UI.
 *
 * Three rules are worth stating because they are user-facing consequences, not
 * implementation details:
 *
 *   - D7 — the password is asked for TWICE. It is the only way back into the item
 *     and there is no recovery, so a typo at compose time would lose the secret for
 *     good. The submit button stays disabled until both fields agree.
 *   - D6 — a locked item travels in ONE frame, so its PLAINTEXT is capped at
 *     `maxFileBytes` (3 MiB by default) whatever the inner type: a file is refused at
 *     pick time, text and rich text at submit time once their UTF-8 bytes are known.
 *     Larger content is sent as a regular item instead, which is still end-to-end
 *     encrypted in transit.
 *   - The label is plaintext and stays plaintext (PLAN.md §9): it is the item's
 *     public name, and the receiver needs it to know which password to try.
 *
 * The password lives in this component's state for as long as the modal is open and
 * is never logged or persisted — it unmounts with the modal, on success or cancel.
 */

import { useCallback, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@mantine/core'
import { IconLock } from '@tabler/icons-react'
import { WithMantine } from '../common/WithMantine'
import type { LockedInnerType } from '../../lib/protocol'
import type { RichTextItem as RichTextItemModel } from '../../store/sessionStore'
import { RichTextItem } from './items/RichTextItem'

/** The four values `addLockedItem` encrypts and sends (Phase 4 contract). */
export interface LockedItemInput {
  label: string
  innerType: LockedInnerType
  /** For `text` the raw string, for `richtext` the Tiptap JSON, for `file` the File itself. */
  content: string | File
  password: string
}

export interface LockedItemComposeModalProps {
  /** Encrypts and sends; resolves with the new item's id. */
  onAdd: (input: LockedItemInput) => Promise<string>
  onClose: () => void
  /**
   * Copy overrides for a caller that saves rather than sends.
   *
   * The only caller that needed them — the offline library row (`NewItemBar.tsx`) — was
   * deleted with the orphaned `LibraryBrowser` (ORCHESTRATION D16.4), so today every call
   * site takes the defaults, which keep the in-session wording. The overrides stay because
   * a "Send" button on a flow that sends nothing is how a user starts distrusting the
   * interface, and the next library surface to embed this modal will need the swap.
   */
  title?: string
  submitLabel?: string
  /**
   * D6's plaintext cap for a locked item, in bytes — the whole item travels in one
   * frame, so this applies to every inner type, not only a file. `crypto.ts` owns the
   * constant; it arrives as a prop so this component never imports the crypto
   * module. The default is D6's value for callers that do not pass one.
   */
  maxFileBytes?: number
}

/**
 * D6 (binding): `locked-payload` carries the whole item in one frame and
 * `WIRE_MAX_FRAME_BYTES` is 4 MiB — ciphertext plus iv, salt and msgpack overhead
 * need headroom — so the plaintext of a locked item is capped at 3 MiB.
 */
export const LOCKED_ITEM_DEFAULT_MAX_FILE_BYTES = 3 * 1024 * 1024

const INNER_TYPES: ReadonlyArray<{ value: LockedInnerType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'richtext', label: 'Rich text' },
  { value: 'file', label: 'File' },
]

/**
 * The draft the compose editor renders. `RichTextItem` is this app's only
 * richtext rendering path (it owns the Tiptap setup and the JSON parsing), so the
 * modal feeds it a draft item rather than configuring a second editor. The id is a
 * local placeholder: a draft is not on the board, and the board's id is assigned by
 * `addLockedItem` once the item is created.
 */
const COMPOSE_DRAFT: RichTextItemModel = {
  id: 'locked-compose-draft',
  type: 'richtext',
  status: 'complete',
  createdAt: 0,
  content: '',
}

export function LockedItemComposeModal(props: LockedItemComposeModalProps) {
  return (
    <WithMantine>
      <LockedItemComposeModalInner {...props} />
    </WithMantine>
  )
}

function LockedItemComposeModalInner({
  onAdd,
  onClose,
  title = 'Send a locked item',
  submitLabel = 'Send locked item',
  maxFileBytes = LOCKED_ITEM_DEFAULT_MAX_FILE_BYTES,
}: LockedItemComposeModalProps) {
  const [label, setLabel] = useState('')
  const [innerType, setInnerType] = useState<LockedInnerType>('text')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [text, setText] = useState('')
  const [richTextJson, setRichTextJson] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /*
   * A latch, not state: React batches `setBusy`, so two submits in the same tick (a
   * double click on "Send", or Enter twice) would both see the pre-update `busy`
   * and send the item twice. A ref flips synchronously.
   */
  const inFlight = useRef(false)

  const passwordsMatch = password !== '' && password === confirmPassword
  const showMismatch = confirmPassword !== '' && password !== confirmPassword
  const missingFile = innerType === 'file' && file === null
  // A rich-text item needs content for the same reason a file item does: the editor is
  // remounted empty on every return to this type, so an empty `richTextJson` is the
  // only state that can be sent — and it is not something the user typed.
  const missingRichText = innerType === 'richtext' && richTextJson === ''
  const canSubmit =
    !busy && label.trim() !== '' && passwordsMatch && !missingFile && !missingRichText

  /** Stable so the editor never re-binds its update handler while the modal is open. */
  const handleRichTextChange = useCallback((_id: string, json: string): void => {
    setRichTextJson(json)
  }, [])

  const chooseFile = (chosen: File | null): void => {
    if (chosen !== null && chosen.size > maxFileBytes) {
      // Dropped rather than kept: an oversized item must not be sendable, and the
      // message names the way forward (§16 Phase 4 / D6).
      setFile(null)
      setError(tooLargeMessage(maxFileBytes, 'file'))
      return
    }

    setFile(chosen)
    setError(null)
  }

  /**
   * Switches the content editor to `nextType`.
   *
   * The editor and the file input are conditionally mounted, so the type being left
   * behind remounts EMPTY while its state (`richTextJson`, `file`) would survive the
   * switch — and `submit` reads that state, not the DOM. Clearing it here is what keeps
   * a send to what the user can actually see; locked content has no recovery path, so
   * bytes the composer cannot look at must not be sendable. Plain text is exempt: its
   * textarea is controlled by `text`, so what was typed comes back on screen with it.
   */
  const switchInnerType = (nextType: LockedInnerType): void => {
    if (nextType !== 'richtext') setRichTextJson('')
    if (nextType !== 'file') setFile(null)
    setInnerType(nextType)
    // An error about content that no longer exists would be misleading.
    setError(null)
  }

  const submit = async (): Promise<void> => {
    if (inFlight.current) return

    let content: string | File

    if (innerType === 'file') {
      // The picker already refuses an oversized file; this is the second gate, so a
      // file that arrived some other way still cannot reach the wire (D6).
      if (file === null) {
        setError('Choose a file to lock.')
        return
      }
      if (file.size > maxFileBytes) {
        setError(tooLargeMessage(maxFileBytes, 'file'))
        return
      }
      content = file
    } else {
      const secret = innerType === 'richtext' ? richTextJson : text
      // D6 caps the plaintext of any locked item, and for text that is its UTF-8
      // length. Measured here rather than on every keystroke: the check only has to
      // happen before a frame exists (see `lockedPlaintextFor`, the real gate).
      if (utf8ByteLength(secret) > maxFileBytes) {
        setError(tooLargeMessage(maxFileBytes, innerType === 'richtext' ? 'rich text' : 'text'))
        return
      }
      content = secret
    }

    inFlight.current = true
    setBusy(true)
    setError(null)

    let failure: string | null = null

    try {
      await onAdd({ label: label.trim(), innerType, content, password })
    } catch (cause: unknown) {
      // An inline error, never a crash: the composed values stay put so the send
      // can simply be retried.
      failure = sendFailedMessage(cause)
    }

    setBusy(false)
    inFlight.current = false

    if (failure !== null) {
      setError(failure)
      return
    }

    // The item is announced and the payload is on its way; the row takes over.
    onClose()
  }

  return (
    // One compose modal can be open at a time (it is opened from the add bar and
    // covers it while it is up), so the label id is a fixed string rather than `useId`.
    <div
      className="locked-compose"
      role="dialog"
      aria-modal="true"
      aria-labelledby="locked-compose-title"
    >
      <form
        className="locked-compose__panel"
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          if (!canSubmit) return
          void submit()
        }}
      >
        <h2
          className="locked-compose__title"
          id="locked-compose-title"
          // Title role (15/600), not the shell class's off-scale 17px.
          style={{ font: 'var(--qrbit-text-title)', letterSpacing: 'var(--qrbit-text-title-tracking)' }}
        >
          {title}
        </h2>
        <p className="locked-compose__intro muted">
          Encrypted on this device with your password before it is sent. The password never leaves
          this device.
        </p>

        <label className="locked-compose__field">
          <span className="locked-compose__field-label">Label</span>
          <input
            className="locked-compose__label-input"
            type="text"
            value={label}
            aria-label="Label"
            placeholder="e.g. Uni portal password"
            autoComplete="off"
            autoFocus
            disabled={busy}
            onChange={(event) => {
              setLabel(event.target.value)
            }}
          />
        </label>
        <p className="locked-compose__hint muted">
          The label is visible without the password — it only names the item.
        </p>

        <fieldset className="locked-compose__types">
          <legend className="locked-compose__legend">Content</legend>
          {INNER_TYPES.map((option) => (
            <label className="locked-compose__type" key={option.value}>
              <input
                className="locked-compose__type-radio"
                type="radio"
                name="locked-item-inner-type"
                value={option.value}
                checked={innerType === option.value}
                disabled={busy}
                onChange={() => {
                  switchInnerType(option.value)
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>

        {innerType === 'text' ? (
          <label className="locked-compose__field">
            <span className="locked-compose__field-label">Secret text</span>
            <textarea
              className="locked-compose__text"
              value={text}
              rows={3}
              aria-label="Secret text"
              disabled={busy}
              onChange={(event) => {
                setText(event.target.value)
              }}
            />
          </label>
        ) : null}

        {innerType === 'richtext' ? (
          <div className="locked-compose__editor">
            <span className="locked-compose__field-label">Secret rich text</span>
            <RichTextItem item={COMPOSE_DRAFT} editable onChange={handleRichTextChange} />
          </div>
        ) : null}

        {innerType === 'file' ? (
          <label className="locked-compose__field">
            <span className="locked-compose__field-label">Secret file</span>
            <input
              className="locked-compose__file"
              type="file"
              aria-label="Secret file"
              disabled={busy}
              onChange={(event) => {
                const chosen = event.currentTarget.files?.[0] ?? null
                // Cleared so picking the same file twice in a row still fires a change.
                event.currentTarget.value = ''
                chooseFile(chosen)
              }}
            />
          </label>
        ) : null}

        <label className="locked-compose__field">
          <span className="locked-compose__field-label">Password</span>
          <input
            className="locked-compose__password"
            type="password"
            value={password}
            aria-label="Password"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
          />
        </label>

        <label className="locked-compose__field">
          <span className="locked-compose__field-label">Confirm password</span>
          <input
            className="locked-compose__confirm-password"
            type="password"
            value={confirmPassword}
            aria-label="Confirm password"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              setConfirmPassword(event.target.value)
            }}
          />
        </label>
        <p className="locked-compose__hint muted">
          There is no recovery: without this password the item stays unreadable, for this device and
          the other one.
        </p>
        {showMismatch ? (
          <p className="locked-compose__mismatch item-error" role="alert" data-mismatch="true">
            The two passwords do not match.
          </p>
        ) : null}

        {busy ? (
          <p className="locked-compose__busy" role="status">
            <span className="spinner" aria-hidden="true" />
            Encrypting…
          </p>
        ) : null}

        {error !== null ? (
          <p className="locked-compose__error item-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="locked-compose__actions">
          {/* DESIGN.md's dialog order: quiet first, then the affirmative action. */}
          <Button
            type="button"
            className="locked-compose__cancel"
            variant="default"
            size="sm"
            fullWidth
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="locked-compose__submit"
            color="signal"
            size="sm"
            fullWidth
            leftSection={<IconLock size={16} aria-hidden="true" />}
            disabled={!canSubmit}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  )
}

/**
 * D6's rejection, worded as an action: the regular text, rich text or file item named
 * by `noun` is still encrypted end to end in transit, so the secret is not being
 * asked to travel in the clear.
 */
function tooLargeMessage(limit: number, noun: 'file' | 'text' | 'rich text'): string {
  return `That ${noun} is too large: a locked item carries at most ${formatBytes(limit)}. Send it as a regular ${noun} item instead — regular items are still end-to-end encrypted.`
}

/** The encoded length of a string, which is what the D6 cap is counted in for text. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function formatBytes(bytes: number): string {
  // The cap is MiB-scale, but a caller may pass a smaller one (Lane B hands over
  // crypto.ts's constant), and "0 MiB" would be a lie in that case.
  if (bytes < 1024 * 1024) return `${bytes} bytes`
  const mib = Math.round((bytes / (1024 * 1024)) * 10) / 10
  return `${mib} MiB`
}

function sendFailedMessage(cause: unknown): string {
  const detail = cause instanceof Error && cause.message.trim() !== '' ? ` (${cause.message})` : ''
  return `Could not send the locked item${detail}.`
}

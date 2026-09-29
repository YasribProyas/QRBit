/**
 * Export dialog (PLAN.md §14, §16 Phase 7).
 *
 * The whole of this component is the §14 sketch: a scope choice, an optional password, and
 * one button. It knows nothing about IndexedDB: `lib/export.ts` reads the library, and this
 * modal only decides what to ask for and hands the finished Blob to the browser as a download.
 * That data path is unchanged by the restyle — the same `exportLibrary` call with the same
 * arguments, the same filename from `suggestExportFilename`, the same latch against a
 * double-submit, the same failure behaviour (an inline message, and the dialog left open so
 * the export can be retried).
 *
 * Two consequences of the file format are stated in the UI rather than hidden:
 *
 *   - Locked items stay locked whatever the outer setting is (§14, §19.4). The note is there
 *     because the user's expectation — "if I don't encrypt, I can read everything in the
 *     file" — is wrong in exactly that one case.
 *   - The password is asked for twice. It is the only way back into the file and there is no
 *     recovery, so a typo would cost the whole library (the same reason D7 asks twice when
 *     composing a locked item). Both fields must agree, and neither may be empty, before
 *     Export enables.
 *
 * The password lives in this component's state for as long as the modal is open and is never
 * logged or persisted; it unmounts with the modal.
 *
 * ## Why this is a Mantine `<Modal>`
 *
 * DESIGN.md's Dialog row names the primitive: radius md, the sheet shadow, the title at the
 * Title role, actions right-aligned in the order quiet then primary, Escape always cancels.
 * The hand-rolled panel this file used to render a fixed overlay could not do any of the last
 * three: it had no Escape handler, no focus trap, no focus return, and its two full-width
 * buttons put Export — the affirmative action — first in tab order. Those are the properties
 * that make a confirmation trustworthy, which is why the destructive-dialog rules in
 * `ConfirmDelete.tsx` are written the way they are.
 *
 * The password reveal is now per-field instead of one switch for both, and both switches drive
 * one shared `visible` state, so pressing either reveals both exactly as before.
 */

import { useRef, useState } from 'react'
import type { CSSProperties, FormEvent, ReactElement } from 'react'
import {
  Button,
  Group,
  Modal,
  PasswordInput,
  Radio,
  Stack,
  Switch,
  Text,
} from '@mantine/core'

import { exportLibrary, suggestExportFilename } from '../lib/export'

export interface ExportModalProps {
  onClose: () => void
  /**
   * The folders the library browser has selected; `exportLibrary` is handed exactly
   * these when the scope is "Selected". Empty (the Settings page's case, where there
   * is no selection at all) hides the option rather than offering an empty export.
   */
  selectedFolderIds?: string[]
  /** How many items the selection holds — §14's "Selected (N items)". */
  selectedItemCount?: number
}

type ExportScope = 'all' | 'selected'

/**
 * DESIGN.md's Quiet button: transparent fill, `--qrbit-ink-secondary` label. Mantine's
 * `subtle` variant paints its label from the colour ramp (`gray-9` in light, `gray-0` in
 * dark), which is ink rather than ink-secondary, and the theme object has no slot for a
 * variant's resting label (theme.ts records that limit) — so the one property is stated from
 * the token here. The component's own hover rule is more specific than this class and still
 * wins, which is the documented "hover lifts the label to ink" step.
 */
const QUIET_LABEL_STYLE: Record<'root', CSSProperties> = {
  root: { color: 'var(--qrbit-ink-secondary)' },
}

/**
 * DESIGN.md's Inputs table puts a field label in the Label role (12px/600). Mantine's
 * InputWrapper label is 13px at weight 500, which is not one of the seven roles, and the role
 * cannot be reached through the theme object (theme.ts, "Not expressible through Mantine's
 * theme object") — so it is applied to the label element through the styles API.
 */
const FIELD_LABEL_STYLE: Record<'label', CSSProperties> = {
  label: {
    font: 'var(--qrbit-text-label)',
    letterSpacing: 'var(--qrbit-text-label-tracking)',
  },
}

export function ExportModal({
  onClose,
  selectedFolderIds = [],
  selectedItemCount = 0,
}: ExportModalProps): ReactElement {
  const [scope, setScope] = useState<ExportScope>('all')
  const [encrypt, setEncrypt] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [revealPassword, setRevealPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * A latch, not state: React batches `setBusy`, so two submits in the same tick (a double
   * click on Export, or Enter twice) would both see the pre-update `busy` and export twice. A
   * ref flips synchronously.
   */
  const inFlight = useRef(false)

  /*
   * NOTE: the 'Selected' scope is gated on selectedItemCount > 0 in the UI, so it only appears
   * when a caller provides both selectedFolderIds and selectedItemCount. The Settings page
   * exports 'All' only; a future library-browser integration can pass folder ids when
   * multi-select is wired to folders. Guard here too so an empty selectedFolderIds never
   * silently produces an empty export.
   */
  const effectiveScope = scope === 'selected' && selectedFolderIds.length === 0 ? 'all' : scope
  const selectedAvailable = selectedItemCount > 0
  const passwordsMatch = password !== '' && password === confirmPassword
  const showMismatch = confirmPassword !== '' && password !== confirmPassword
  const canSubmit = !busy && (!encrypt || passwordsMatch)

  /** While an export is running the dialog is not dismissible: the file is being built. */
  const requestClose = (): void => {
    if (!busy) onClose()
  }

  const submit = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)

    let failure: string | null = null

    try {
      const blob = await exportLibrary(effectiveScope === 'all' ? 'all' : selectedFolderIds, {
        encrypt,
        password: encrypt ? password : undefined,
      })
      downloadBlob(blob, suggestExportFilename(new Date()))
    } catch (cause: unknown) {
      failure = exportFailedMessage(cause)
    }

    setBusy(false)
    inFlight.current = false

    if (failure !== null) {
      // Inline, and the modal stays open: the chosen scope and password are still on screen so
      // the export can simply be retried.
      setError(failure)
      return
    }

    onClose()
  }

  return (
    <Modal
      opened
      onClose={requestClose}
      title="Export library"
      closeButtonProps={{ 'aria-label': 'Close export dialog' }}
      size="sm"
      padding="lg"
      centered
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
    >
      <form
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          if (!canSubmit) return
          void submit()
        }}
      >
        <Stack gap="lg">
          <Text className="qrbit-text-body-secondary" c="dimmed">
            Saves this device's library to one file you choose where to put. Nothing is
            uploaded.
          </Text>

          <Radio.Group
            label="What to export"
            styles={FIELD_LABEL_STYLE}
            value={effectiveScope}
            disabled={busy}
            onChange={(value: string) => {
              setScope(value === 'selected' ? 'selected' : 'all')
            }}
          >
            <Stack gap="xs" mt="xs">
              <Radio value="all" label="The whole library" />
              {selectedAvailable ? (
                <Radio value="selected" label={`The selected folders (${String(selectedItemCount)} items)`} />
              ) : null}
            </Stack>
          </Radio.Group>

          <Switch
            label="Encrypt export file"
            description="Protects the file with a password only you know. There is no recovery for a lost one."
            styles={FIELD_LABEL_STYLE}
            checked={encrypt}
            disabled={busy}
            onChange={(event) => {
              const next = event.currentTarget.checked
              setEncrypt(next)
              // Leaving the encrypted path must not leave a typed password behind in state
              // longer than the choice it belonged to.
              if (!next) {
                setPassword('')
                setConfirmPassword('')
                setRevealPassword(false)
              }
            }}
          />

          {encrypt ? (
            <Stack gap="md">
              <PasswordInput
                label="Password"
                placeholder="At least one character"
                styles={FIELD_LABEL_STYLE}
                autoComplete="new-password"
                aria-label="Password"
                value={password}
                visible={revealPassword}
                onVisibilityChange={setRevealPassword}
                disabled={busy}
                onChange={(event) => {
                  setPassword(event.currentTarget.value)
                }}
              />
              <PasswordInput
                label="Confirm password"
                styles={FIELD_LABEL_STYLE}
                autoComplete="new-password"
                aria-label="Confirm password"
                value={confirmPassword}
                visible={revealPassword}
                onVisibilityChange={setRevealPassword}
                disabled={busy}
                error={showMismatch ? 'The two passwords do not match.' : undefined}
                onChange={(event) => {
                  setConfirmPassword(event.currentTarget.value)
                }}
              />
            </Stack>
          ) : null}

          <Text className="qrbit-text-body-secondary" c="dimmed">
            Locked items stay encrypted inside the file regardless of this setting.
          </Text>

          {error !== null ? (
            <Text className="qrbit-text-body" c="error" role="alert">
              {error}
            </Text>
          ) : null}

          {/* DESIGN.md's dialog action row: right-aligned, quiet first, the affirmative last. */}
          <Group justify="flex-end" gap="sm">
            <Button
              variant="subtle"
              color="gray"
              size="sm"
              styles={QUIET_LABEL_STYLE}
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="filled"
              color="signal"
              size="sm"
              loading={busy}
              loaderProps={{ size: 14, color: 'var(--qrbit-raised)' }}
              disabled={!canSubmit}
            >
              {busy ? 'Exporting…' : 'Export'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

/**
 * Hands the finished Blob to the browser as a download.
 *
 * An anchor is used rather than a rendered link because the file only exists after the export
 * resolves, and the object URL is revoked on the next turn of the event loop: immediately would
 * risk cancelling the download in some browsers, and never would pin the whole library in
 * memory for the life of the page.
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)
}

function exportFailedMessage(cause: unknown): string {
  const detail = cause instanceof Error && cause.message.trim() !== '' ? ` (${cause.message})` : ''
  return `Could not export the library${detail}.`
}

/**
 * Export dialog (PLAN.md §14, §16 Phase 7).
 *
 * The whole of this component is the §14 sketch: a scope choice, an optional
 * password, and one button. It knows nothing about IndexedDB: `lib/export.ts` reads
 * the library, and this modal only decides what to ask for and hands the finished
 * Blob to the browser as a download.
 *
 * Two consequences of the file format are stated in the UI rather than hidden:
 *
 *   - Locked items stay locked whatever the outer setting is (§14, §19.4). The note
 *     is verbatim from §14 because the user's expectation — "if I don't encrypt, I
 *     can read everything in the file" — is wrong in exactly that one case.
 *   - The password is asked for twice. It is the only way back into the file and
 *     there is no recovery, so a typo would cost the whole library (the same reason
 *     D7 asks twice when composing a locked item). Both fields must agree, and
 *     neither may be empty, before Export enables.
 *
 * The password lives in this component's state for as long as the modal is open and
 * is never logged or persisted; it unmounts with the modal.
 */

import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

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

export function ExportModal({
  onClose,
  selectedFolderIds = [],
  selectedItemCount = 0,
}: ExportModalProps) {
  const [scope, setScope] = useState<ExportScope>('all')
  const [encrypt, setEncrypt] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [revealPassword, setRevealPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * A latch, not state: React batches `setBusy`, so two submits in the same tick (a
   * double click on Export, or Enter twice) would both see the pre-update `busy` and
   * export twice. A ref flips synchronously.
   */
  const inFlight = useRef(false)

  /**
   * NOTE: the 'Selected' scope is gated on selectedItemCount > 0 in the UI, so it
   * only appears when a caller provides both selectedFolderIds and selectedItemCount.
   * The Settings page exports 'All' only; a future library-browser integration can
   * pass folder ids when multi-select is wired to folders. Guard here too so an
   * empty selectedFolderIds never silently produces an empty export.
   */
  const effectiveScope = scope === 'selected' && selectedFolderIds.length === 0 ? 'all' : scope
  const selectedAvailable = selectedItemCount > 0
  const passwordsMatch = password !== '' && password === confirmPassword
  const showMismatch = confirmPassword !== '' && password !== confirmPassword
  const canSubmit = !busy && (!encrypt || passwordsMatch)

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
      // Inline, and the modal stays open: the chosen scope and password are still on
      // screen so the export can simply be retried.
      setError(failure)
      return
    }

    onClose()
  }

  return (
    <div className="library-modal" role="dialog" aria-modal="true" aria-labelledby="export-modal-title">
      <form
        className="library-modal__panel"
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          if (!canSubmit) return
          void submit()
        }}
      >
        <h2 className="library-modal__title" id="export-modal-title">
          Export library
        </h2>
        <p className="library-modal__hint muted">
          Saves your library to one file on this device. Nothing is uploaded.
        </p>

        <fieldset className="library-modal__field">
          <legend className="library-modal__field-label">Export</legend>
          <label className="library-modal__radio">
            <input
              type="radio"
              name="export-scope"
              value="all"
              checked={scope === 'all'}
              disabled={busy}
              onChange={() => {
                setScope('all')
              }}
            />
            All
          </label>
          {selectedAvailable ? (
            <label className="library-modal__radio">
              <input
                type="radio"
                name="export-scope"
                value="selected"
                checked={scope === 'selected'}
                disabled={busy}
                onChange={() => {
                  setScope('selected')
                }}
              />
              {`Selected (${String(selectedItemCount)} items)`}
            </label>
          ) : null}
        </fieldset>

        <label className="library-modal__radio">
          <input
            type="checkbox"
            checked={encrypt}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.checked
              setEncrypt(next)
              // Leaving the encrypted path must not leave a typed password behind in
              // state longer than the choice it belonged to.
              if (!next) {
                setPassword('')
                setConfirmPassword('')
                setRevealPassword(false)
              }
            }}
          />
          Encrypt export file
        </label>

        {encrypt ? (
          <>
            <label className="library-modal__field">
              <span className="library-modal__field-label">Password</span>
              <input
                className="library-modal__input"
                type={revealPassword ? 'text' : 'password'}
                value={password}
                aria-label="Password"
                autoComplete="new-password"
                disabled={busy}
                onChange={(event) => {
                  setPassword(event.target.value)
                }}
              />
            </label>

            <label className="library-modal__field">
              <span className="library-modal__field-label">Confirm</span>
              <input
                className="library-modal__input"
                type={revealPassword ? 'text' : 'password'}
                value={confirmPassword}
                aria-label="Confirm password"
                autoComplete="new-password"
                disabled={busy}
                onChange={(event) => {
                  setConfirmPassword(event.target.value)
                }}
              />
            </label>

            <button
              type="button"
              className="button button--link library-modal__reveal"
              disabled={busy}
              aria-pressed={revealPassword}
              aria-label={revealPassword ? 'Hide password' : 'Show password'}
              onClick={() => {
                setRevealPassword(!revealPassword)
              }}
            >
              {revealPassword ? 'Hide' : 'Show'}
            </button>

            {showMismatch ? (
              <p className="item-error" role="alert">
                The two passwords do not match.
              </p>
            ) : null}
          </>
        ) : null}

        <p className="library-modal__hint muted">
          Note: Locked items stay locked regardless of this setting.
        </p>

        {error !== null ? (
          <p className="library-modal__error item-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="library-modal__actions">
          <button type="submit" className="button library-modal__export" disabled={!canSubmit}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
          <button
            type="button"
            className="button library-modal__cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Hands the finished Blob to the browser as a download.
 *
 * An anchor is used rather than a rendered link because the file only exists after
 * the export resolves, and the object URL is revoked on the next turn of the event
 * loop: immediately would risk cancelling the download in some browsers, and never
 * would pin the whole library in memory for the life of the page.
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

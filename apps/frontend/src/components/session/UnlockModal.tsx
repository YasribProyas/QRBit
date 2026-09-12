/**
 * Unlock modal (PLAN.md §9's receiver flow, §16 Phase 4, §17).
 *
 * The one place a password is typed on the receiving side. `onSubmit` is the items
 * API's `unlockItem`, which derives the item key with PBKDF2 (600k iterations,
 * PLAN.md §19 decision 9 — roughly 300ms on a mid-range phone, hence the spinner
 * rather than a frozen button) and decrypts the item into memory only.
 *
 * The contract's three outcomes are three different experiences, and confusing them
 * is the failure this component exists to prevent:
 *
 *   - `true`  — unlocked. Close; the row reveals the plaintext.
 *   - `false` — wrong password. PLAN.md §17: show an error, clear the input, never
 *     crash, and stay open so the user can retry. The password field is the only
 *     copy of it, so clearing it is also what keeps a mistyped secret out of a
 *     re-submission.
 *   - a rejection — an infrastructure failure (the item is gone, the channel is
 *     dead). A distinct message, because "wrong password" would be a lie and the
 *     user would keep retyping a password that was never the problem.
 *
 * The password is component state for the duration of the attempt and is never
 * logged, stored, or kept after the modal closes.
 */

import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

export interface UnlockModalProps {
  /** The item's plaintext label, shown so the user knows which password to type. */
  label: string
  /**
   * Decrypts with the given password. Resolves true on success, false for a wrong
   * password, rejects for infrastructure failures.
   */
  onSubmit: (password: string) => Promise<boolean>
  onClose: () => void
}

type UnlockErrorKind = 'wrong-password' | 'failed'

interface UnlockError {
  kind: UnlockErrorKind
  message: string
}

export function UnlockModal({ label, onSubmit, onClose }: UnlockModalProps) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UnlockError | null>(null)

  /*
   * A latch, not state: React batches `setBusy`, so two submits in the same tick
   * (a double Enter) would both see the pre-update `busy` and start two ~300ms
   * derivations. A ref flips synchronously. It holds no password — the password
   * only ever lives in component state for the duration of one attempt.
   */
  const inFlight = useRef(false)

  const submit = async (): Promise<void> => {
    if (inFlight.current) return

    inFlight.current = true
    setBusy(true)
    setError(null)

    let unlocked = false
    let failure: string | null = null

    try {
      unlocked = await onSubmit(password)
    } catch (cause: unknown) {
      failure = failureMessage(cause)
    }

    setBusy(false)
    inFlight.current = false
    // Dropped as soon as the attempt is over, whichever way it went, so no copy of
    // the password outlives the operation it was typed for.
    setPassword('')

    if (failure !== null) {
      setError({ kind: 'failed', message: failure })
      return
    }

    if (unlocked) {
      // The item is unlocked in the store; the row reveals it once this closes.
      onClose()
      return
    }

    setError({ kind: 'wrong-password', message: 'That password is not correct.' })
  }

  return (
    // A fixed label id, not `useId`: one unlock modal can be open at a time, since
    // it is opened from a single row and covers the board while it is up.
    <div className="unlock-modal" role="dialog" aria-modal="true" aria-labelledby="unlock-modal-title">
      <form
        className="unlock-modal__panel"
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          if (busy || password === '') return
          void submit()
        }}
      >
        <h2 className="unlock-modal__title" id="unlock-modal-title">
          Unlock “{label}”
        </h2>

        <label className="unlock-modal__field">
          <span className="unlock-modal__field-label">Password</span>
          <input
            className="unlock-modal__password"
            type="password"
            value={password}
            aria-label="Password"
            autoComplete="off"
            autoFocus
            onChange={(event) => {
              setPassword(event.target.value)
            }}
          />
        </label>

        {busy ? (
          <p className="unlock-modal__busy" role="status">
            <span className="spinner" aria-hidden="true" />
            Unlocking…
          </p>
        ) : null}

        {error !== null ? (
          <p className="unlock-modal__error item-error" role="alert" data-error-kind={error.kind}>
            {error.message}
          </p>
        ) : null}

        <div className="unlock-modal__actions">
          <button
            type="submit"
            className="button unlock-modal__submit"
            disabled={busy || password === ''}
          >
            Unlock
          </button>
          <button
            type="button"
            className="button unlock-modal__cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>

        <p className="unlock-modal__hint muted">
          The password is never sent or stored — it only derives the key that opens this item on this
          device.
        </p>
      </form>
    </div>
  )
}

/**
 * Infrastructure failures are the API's own messages (an item that no longer
 * exists, a dead channel). Anything without a usable message falls back to the
 * bare sentence rather than rendering `[object Object]`.
 */
function failureMessage(cause: unknown): string {
  const detail = cause instanceof Error && cause.message.trim() !== '' ? ` (${cause.message})` : ''
  return `Could not unlock this item${detail}.`
}

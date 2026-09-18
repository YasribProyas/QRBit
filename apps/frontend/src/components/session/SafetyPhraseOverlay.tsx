import type { JSX } from 'react'
import type { SessionRole } from '../../lib/signaling'

/**
 * SafetyPhraseOverlay (PLAN.md §8 Phase 2, decision D14).
 *
 * Renders the three-word safety phrase derived from the ECDH exchange.
 *
 * Under decision D14:
 * - Only the sender (role 'guest') confirms the phrase to gate the session.
 * - The receiver (role 'host') sees the three words prominently in a non-blocking/waiting
 *   state without a gating confirm button.
 * - Both roles have the Abort session button.
 */
export interface SafetyPhraseOverlayProps {
  /** The three words both devices must see identically, in display order. */
  phrase: readonly [string, string, string]
  /** This device has tapped "Confirmed". */
  confirmed: boolean
  /** The peer's phrase-confirm has arrived. */
  peerConfirmed: boolean
  onConfirm: () => void
  onAbort: () => void
  /** Disables buttons while a confirmation is in flight or awaiting the peer. */
  busy?: boolean
  /**
   * D14: Whether this device is the sender (role 'guest').
   * If unspecified, defaults to true (or role === 'guest' if role is provided).
   */
  isSender?: boolean
  role?: SessionRole | null
}

export function SafetyPhraseOverlay({
  phrase,
  confirmed,
  peerConfirmed,
  onConfirm,
  onAbort,
  busy = false,
  isSender,
  role,
}: SafetyPhraseOverlayProps): JSX.Element {
  const sender = isSender ?? (role !== undefined && role !== null ? role === 'guest' : true)

  return (
    <div
      className="safety-phrase"
      role="dialog"
      aria-modal="true"
      aria-labelledby="safety-phrase-instruction"
    >
      <div className="safety-phrase__panel">
        <p id="safety-phrase-instruction" className="safety-phrase__instruction">
          Confirm these match on both devices:
        </p>

        <ul className="safety-phrase__words">
          {phrase.map((word, index) => (
            <li className="safety-phrase__word" key={index}>
              {word}
            </li>
          ))}
        </ul>

        <div className="safety-phrase__status" role="status" aria-live="polite">
          {sender ? (
            <p className="safety-phrase__check" data-state={confirmed ? 'confirmed' : 'pending'}>
              <span className="safety-phrase__check-label">This device</span>
              <span>{confirmed ? 'confirmed ✓' : 'not confirmed yet'}</span>
            </p>
          ) : (
            <p className="safety-phrase__check" data-state={peerConfirmed ? 'confirmed' : 'pending'}>
              <span className="safety-phrase__check-label">Sender</span>
              <span>{peerConfirmed ? 'confirmed ✓' : 'waiting for confirmation…'}</span>
            </p>
          )}
        </div>

        <div className="safety-phrase__actions">
          {sender ? (
            <button
              type="button"
              className="button safety-phrase__confirm"
              onClick={onConfirm}
              disabled={busy || confirmed}
            >
              Confirmed ✓
            </button>
          ) : null}
          <button
            type="button"
            className="button safety-phrase__abort"
            onClick={onAbort}
            disabled={busy}
          >
            Abort session
          </button>
        </div>

        <p className="safety-phrase__footnote muted">
          {sender
            ? confirmed
              ? 'Confirmed — starting the session…'
              : 'The session starts once you confirm the words match.'
            : peerConfirmed
              ? 'Sender confirmed — starting the session…'
              : 'Waiting for the sender to confirm the safety phrase.'}
        </p>
      </div>
    </div>
  )
}

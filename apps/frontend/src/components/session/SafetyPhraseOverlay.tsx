import type { JSX } from 'react'
import { Button } from '@mantine/core'
import { IconCheck, IconX } from '@tabler/icons-react'
import type { SessionRole } from '../../lib/signaling'
import { WithMantine } from '../common/WithMantine'

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
 *
 * The state line is honest about what the code actually knows: this device confirming is a
 * fact about this device, and `peerConfirmed` is a fact about the message that arrived. The
 * app cannot verify that the words match on the other screen — that comparison is the human's
 * job, which is why it is the only step that carries no colour until someone taps it.
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

export function SafetyPhraseOverlay(props: SafetyPhraseOverlayProps): JSX.Element {
  return (
    <WithMantine>
      <SafetyPhraseOverlayInner {...props} />
    </WithMantine>
  )
}

function SafetyPhraseOverlayInner({
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
  // On the sender's screen this device's own tap is the fact; on the receiver's, the
  // arriving confirm message is. Both are shown as what they are, never as "verified".
  const confirmedLine = sender ? confirmed : peerConfirmed

  return (
    <div
      className="safety-phrase"
      role="dialog"
      aria-modal="true"
      aria-labelledby="safety-phrase-instruction"
    >
      <div className="safety-phrase__panel">
        <p
          id="safety-phrase-instruction"
          className="safety-phrase__instruction qrbit-text-title"
        >
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
          <p
            className="safety-phrase__check"
            data-state={confirmedLine ? 'confirmed' : 'pending'}
          >
            <span className="safety-phrase__check-label">{sender ? 'This device' : 'Sender'}</span>
            {/*
              The word carries the meaning and the mark repeats it, so the state survives a
              screen reader, a colour-blind viewer and `prefers-reduced-motion` alike.
            */}
            {/* A drawn mark, from the same icon set as every other control in the app -- the
                U+2713 character that used to sit here was a glyph standing in for an icon, which
                renders differently per platform and is not the app's icon language. The word below
                still carries the meaning; this repeats it. */}
            {confirmedLine ? <IconCheck size={14} aria-hidden="true" /> : null}
            <span>
              {confirmedLine
                ? 'confirmed'
                : sender
                  ? 'not confirmed yet'
                  : 'waiting for confirmation…'}
            </span>
          </p>
        </div>

        <div className="safety-phrase__actions">
          {/* DESIGN.md's dialog order: the quiet action first, the primary last. */}
          <Button
            className="safety-phrase__abort"
            variant="default"
            size="sm"
            fullWidth
            leftSection={<IconX size={16} aria-hidden="true" />}
            onClick={onAbort}
            disabled={busy}
          >
            Abort session
          </Button>
          {sender ? (
            <Button
              className="safety-phrase__confirm"
              color="signal"
              size="sm"
              fullWidth
              leftSection={<IconCheck size={16} aria-hidden="true" />}
              onClick={onConfirm}
              disabled={busy || confirmed}
            >
              Confirmed
            </Button>
          ) : null}
        </div>

        <p className="safety-phrase__footnote muted qrbit-text-body-secondary">
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

/**
 * Safety-phrase confirmation overlay (PLAN.md §8 Phase 2).
 *
 * Presentational and pure by contract: the phrase and both confirmation flags
 * arrive as props and the component only calls `onConfirm` / `onAbort`. It never
 * derives, compares or computes anything crypto-related (the phrase comes from
 * the ECDH exchange handled by `lib/safetyPhrase.ts`) and never touches the
 * session store — the page/hook owns the wiring, which keeps this component
 * testable without any crypto in the module graph.
 *
 * The words are rendered exactly as received. The uppercase look in PLAN.md §8
 * is produced by CSS only, so the compared string is never transformed here.
 *
 * The session must not proceed until both devices confirm (PLAN.md §8), so the
 * overlay covers the viewport and blocks the page behind it until it is unmounted.
 *
 * PHASE 3 SEAM: Lane B removes this component from the session flow once
 * `confirmed && peerConfirmed`; nothing here needs to change for the board to
 * take over. A later phase may wire the `phrase-confirm` wire message, which is
 * also Lane B's concern — this component has no wire knowledge.
 */

import type { JSX } from 'react'

export interface SafetyPhraseOverlayProps {
  /** The three words both devices must see identically, in display order. */
  phrase: readonly [string, string, string]
  /** This device has tapped "Confirmed". */
  confirmed: boolean
  /** The peer's phrase-confirm has arrived. */
  peerConfirmed: boolean
  onConfirm: () => void
  onAbort: () => void
  /** Disables both buttons while a confirmation is in flight or awaiting the peer. */
  busy?: boolean
}

export function SafetyPhraseOverlay({
  phrase,
  confirmed,
  peerConfirmed,
  onConfirm,
  onAbort,
  busy = false,
}: SafetyPhraseOverlayProps): JSX.Element {
  return (
    // The label id is a fixed string, not `useId`: at most one overlay can be
    // mounted per session page, so there is no duplicate-id risk to defend against.
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

        {/*
          A list gives every word its own accessible node, so a screen reader
          reads three separate words rather than one run-on word jumble.
        */}
        <ul className="safety-phrase__words">
          {phrase.map((word, index) => (
            <li className="safety-phrase__word" key={index}>
              {word}
            </li>
          ))}
        </ul>

        <div className="safety-phrase__status" role="status" aria-live="polite">
          <p className="safety-phrase__check" data-state={confirmed ? 'confirmed' : 'pending'}>
            <span className="safety-phrase__check-label">This device</span>
            <span>{confirmed ? 'confirmed ✓' : 'not confirmed yet'}</span>
          </p>
          <p className="safety-phrase__check" data-state={peerConfirmed ? 'confirmed' : 'pending'}>
            <span className="safety-phrase__check-label">Other device</span>
            <span>{peerConfirmed ? 'confirmed ✓' : 'not confirmed yet'}</span>
          </p>
        </div>

        <div className="safety-phrase__actions">
          <button
            type="button"
            className="button safety-phrase__confirm"
            onClick={onConfirm}
            disabled={busy || confirmed}
          >
            Confirmed ✓
          </button>
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
          {confirmed && peerConfirmed
            ? 'Both devices confirmed — starting the session…'
            : 'The session starts only after both devices confirm.'}
        </p>
      </div>
    </div>
  )
}

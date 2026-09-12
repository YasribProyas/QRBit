import { Link, useSearchParams } from 'react-router-dom'
import { AddItemBar } from '../components/session/AddItemBar'
import { SafetyPhraseOverlay } from '../components/session/SafetyPhraseOverlay'
import { SessionBoard, isSenderRole } from '../components/session/SessionBoard'
import { useSession } from '../hooks/useSession'
import { LOCKED_ITEM_MAX_PLAINTEXT_BYTES } from '../lib/crypto'

/**
 * Session page (PLAN.md §8).
 *
 * Role comes from the URL: `?code=XXXXXXXX` means this device scanned a peer and
 * is the guest; no code means this device is the host whose QR was scanned.
 *
 * The page stays presentational: `useSession` owns the handshake, the safety phrase
 * and the both-sides confirmation gate.
 */
export function Session() {
  const [searchParams] = useSearchParams()

  const rawCode = searchParams.get('code')
  const code = rawCode !== null && rawCode.trim() !== '' ? rawCode.trim() : null

  const session = useSession({ code })

  return (
    <main className="page">
      <header className="page__header">
        <Link className="link" to="/">
          ← QRDrop
        </Link>
        <span className="badge">{session.role ?? 'assigning'}</span>
      </header>

      <div className={`status status--${session.status.tone}`} role="status" aria-live="polite">
        <span className="status__dot" aria-hidden="true" />
        <span>{session.status.label}</span>
      </div>

      <p className="muted">{session.roleLabel}</p>

      {session.sessionCode !== null ? (
        <section className="panel">
          <h2 className="panel__title">Session code</h2>
          <p className="code">{session.sessionCode}</p>
          <p className="muted">
            On the other device, open <code>/session?code={session.sessionCode}</code>
          </p>
        </section>
      ) : null}

      {session.errorMessage !== null ? (
        <section className="panel panel--error">
          <h2 className="panel__title">Error</h2>
          <p>{session.errorMessage}</p>
          <button type="button" className="button" onClick={session.restart}>
            Try again
          </button>
        </section>
      ) : null}

      {/*
        A clean end (the overlay's Abort, or the peer ending the session) has no
        error to show, but it still needs a way back to a fresh session: PLAN.md §19
        decision 10 makes sessions single-use, so "again" always means "new".
      */}
      {session.phase === 'ended' && session.errorMessage === null ? (
        <section className="panel">
          <h2 className="panel__title">Session ended</h2>
          <button type="button" className="button" onClick={session.restart}>
            Start a new session
          </button>
        </section>
      ) : null}

      {/*
        PLAN.md §8 Phase 3: the board *is* the active session. The Phase 1/2
        channel-check panel is gone with it — the both-sides encrypted
        phrase-confirm already proved the channel, so a hello exchange would prove
        nothing new about it.

        The add bar is sender-only (PLAN.md §9), but both devices render the board:
        the receiver's copy fills in as items and chunks arrive, which is the
        symmetric view PLAN.md §1 asks for. 'verified' is deliberately not handled:
        the phase sequence is connecting → pairing → active → ended.
      */}
      {session.phase === 'active' ? (
        <>
          {/*
            D6's cap reaches the compose modal from the one module that owns the number
            (`lib/crypto.ts`), rather than from a second copy in the UI.
          */}
          {isSenderRole(session.role) ? (
            <AddItemBar api={session} maxLockedFileBytes={LOCKED_ITEM_MAX_PLAINTEXT_BYTES} />
          ) : null}
          <SessionBoard api={session} role={session.role} />
        </>
      ) : null}

      {/*
        PLAN.md §8 Phase 2: the full-screen overlay is up from the moment the phrase
        exists until BOTH devices have confirmed. `busy` is left at its default so the
        Abort button stays usable while this device waits for the peer to confirm.
      */}
      {session.phase === 'pairing' && session.safetyPhrase !== null ? (
        <SafetyPhraseOverlay
          phrase={session.safetyPhrase}
          confirmed={session.phraseConfirmed}
          peerConfirmed={session.peerConfirmed}
          onConfirm={session.confirmPhrase}
          onAbort={session.abort}
        />
      ) : null}
    </main>
  )
}

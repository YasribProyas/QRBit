import { Link, useSearchParams } from 'react-router-dom'
import { SafetyPhraseOverlay } from '../components/session/SafetyPhraseOverlay'
import { useSession } from '../hooks/useSession'

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
        Phase 1's acceptance criterion (PLAN.md §16) is that the data channel
        opens and greets both ways. That greeting is inside the Phase 2 AES-GCM
        envelope, so a value arriving here proves the encrypted path works. Phase 3
        replaces this panel with the session board (PLAN.md §9).
      */}
      <section className="panel">
        <h2 className="panel__title">Channel check</h2>
        <dl className="kv">
          <dt>Sent</dt>
          <dd>{session.localHello ?? 'Waiting for the data channel…'}</dd>
          <dt>Received</dt>
          <dd>{session.peerHello ?? 'Waiting for the other device…'}</dd>
        </dl>
        <p className="muted">
          Every frame is encrypted with the session key both devices derive from
          the ECDH exchange — nothing crosses the channel in the clear.
        </p>
      </section>

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

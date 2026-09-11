import { Link, useSearchParams } from 'react-router-dom'
import { useSession } from '../hooks/useSession'

/**
 * Session page (PLAN.md §8).
 *
 * Role comes from the URL: `?code=XXXXXXXX` means this device scanned a peer and
 * is the guest; no code means this device is the host whose QR was scanned.
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
        Phase 1's acceptance criterion (PLAN.md §16) is that the data channel
        opens and greets both ways. Phase 3 replaces this panel with the session
        board (PLAN.md §9).
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
          Phase 1 sends a plaintext greeting each way to prove the channel is live.
          End-to-end encryption and the safety phrase arrive in Phase 2.
        </p>
      </section>
    </main>
  )
}

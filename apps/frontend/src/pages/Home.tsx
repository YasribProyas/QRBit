import { Link } from 'react-router-dom'
import { LibraryBrowser } from '../components/library/LibraryBrowser'
import { QRDisplay } from '../components/QRDisplay'
import { buildSessionUrl } from '../config'

/**
 * Home screen (PLAN.md §7). The primary screen — no landing page and no
 * "start / join" split, because the app is symmetric.
 */

/**
 * PLAN.md §16 Phase 1 asks for a hardcoded URL. This is the example code from
 * PLAN.md §8. Phase 6 replaces it with a real code from the worker.
 */
const PLACEHOLDER_SESSION_CODE = 'A7X3K9P2'

export function Home() {
  const sessionUrl = buildSessionUrl(PLACEHOLDER_SESSION_CODE)

  return (
    <main className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">QRDrop</h1>
          <p className="muted">No login. No cloud. No trace.</p>
        </div>
        <Link className="link" to="/settings">
          Settings
        </Link>
      </header>

      <section className="panel">
        <QRDisplay url={sessionUrl} />
      </section>

      {/*
        Phase 1 needs a way to reach the host side of a session by hand: the host
        opens /session with no code, registers a session and shows its code. From
        Phase 6 this happens by tapping the QR itself (PLAN.md §16 Phase 6).
      */}
      <Link className="button" to="/session">
        Start a session on this device
      </Link>

      <h2 className="page__section-title">Your Library</h2>
      <LibraryBrowser />

      <button type="button" className="button" disabled>
        📷 Scan &amp; Send
      </button>
      <p className="muted">
        Camera scanning arrives in Phase 6. Until then, start a session above and
        open its code on the other device.
      </p>
    </main>
  )
}

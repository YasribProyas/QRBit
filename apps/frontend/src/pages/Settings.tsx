import { Link } from 'react-router-dom'

/**
 * Settings page (PLAN.md §5, §14).
 *
 * PHASE 1 STUB: library export/import is Phase 7. Present so the route exists
 * and the Home header has somewhere to point.
 */
export function Settings() {
  return (
    <main className="page">
      <header className="page__header">
        <Link className="link" to="/">
          ← QRDrop
        </Link>
        <h1 className="page__title">Settings</h1>
      </header>

      <section className="panel">
        <h2 className="panel__title">Export &amp; import</h2>
        <p className="muted">
          Exporting and importing your library arrives in Phase 7. Locked items
          stay encrypted inside an export file whether or not the export itself is
          encrypted (PLAN.md §14).
        </p>
      </section>

      <section className="panel">
        <h2 className="panel__title">Privacy</h2>
        <p className="muted">
          QRDrop keeps no history. Session data lives in memory only and is
          discarded when the session ends — it is never written to IndexedDB, the
          Cache API or localStorage.
        </p>
      </section>
    </main>
  )
}

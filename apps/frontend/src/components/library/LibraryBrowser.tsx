/**
 * Local library browser (PLAN.md §6.4).
 *
 * PHASE 1 STUB. The persistent, device-local library is Phase 5; this renders an
 * empty state so the Home layout (PLAN.md §7) is complete and the real tree can
 * drop in without moving anything.
 *
 * It deliberately performs NO IndexedDB access. The library belongs in IDB
 * (PLAN.md §6), but session data must never be written there (AGENTS.md), and
 * keeping the two apart starts here.
 */

export function LibraryBrowser() {
  return (
    <div className="empty">
      <p>Your library arrives in Phase 5.</p>
      <p className="muted">
        It will live in this browser only — never uploaded, never synced.
      </p>
    </div>
  )
}

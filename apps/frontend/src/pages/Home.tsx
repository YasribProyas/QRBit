/**
 * Home screen (PLAN.md §7, §16 Phase 5). The primary screen — no landing page and no
 * "start / join" split, because the app is symmetric.
 *
 * This page owns the library's wiring: it loads the store on mount, keeps the folder
 * the user is looking at, and turns the browser's callbacks into store actions. The
 * browser itself stays presentational, and the page never imports the IndexedDB layer
 * — the store is the only route to it.
 *
 * Two send flows start here (PLAN.md §7):
 *
 *   - **Send selected** (PLAN.md §7 flow A, decision D8). The browser hands back the
 *     selected item ids; the page resolves them against the loaded library, puts them
 *     in the session-scoped pending-send queue and opens a HOST session. The queue is
 *     in-memory only (never localStorage, the Cache API or IndexedDB), and the session
 *     hook drains it the moment the session goes active, so the items transfer as soon
 *     as the peer is paired and verified.
 *   - **Scan & Send** (flow A's Phase 6 entry point) stays disabled with its hint until
 *     the scanner exists. Phase 5 owns the queueing mechanism, not the camera: the
 *     library-driven button above is the entry point that works today.
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { LibraryBrowser } from '../components/library/LibraryBrowser'
import { QRDisplay } from '../components/QRDisplay'
import { buildSessionUrl } from '../config'
import { queueLibrarySends } from '../hooks/useSession'
import { useLibraryStore } from '../store/libraryStore'

/**
 * PLAN.md §16 Phase 1 asks for a hardcoded URL. This is the example code from
 * PLAN.md §8. Phase 6 replaces it with a real code from the worker.
 */
const PLACEHOLDER_SESSION_CODE = 'A7X3K9P2'

/**
 * Stops an unhandled rejection from the browser's `void` callbacks.
 *
 * The store records every failure in `error`, which the browser renders, so the only
 * job left here is not to leave a rejected promise unobserved: rename, delete and move
 * are fire-and-forget from the browser's point of view. Creating a folder is awaited by
 * its dialog instead, and so passes the store's rejection straight through.
 */
function reportToStore(operation: Promise<unknown>): void {
  void operation.catch(() => undefined)
}

export function Home() {
  const sessionUrl = buildSessionUrl(PLACEHOLDER_SESSION_CODE)
  const navigate = useNavigate()

  const folders = useLibraryStore((state) => state.folders)
  const items = useLibraryStore((state) => state.items)
  const loading = useLibraryStore((state) => state.loading)
  const error = useLibraryStore((state) => state.error)
  const refresh = useLibraryStore((state) => state.refresh)
  const createFolder = useLibraryStore((state) => state.createFolder)
  const renameFolder = useLibraryStore((state) => state.renameFolder)
  const deleteFolder = useLibraryStore((state) => state.deleteFolder)
  const renameItem = useLibraryStore((state) => state.renameItem)
  const deleteItem = useLibraryStore((state) => state.deleteItem)
  const moveItem = useLibraryStore((state) => state.moveItem)

  /** The folder whose items are listed; `null` is the tree's Root. */
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)

  // The library lives in IndexedDB, so the first render has no data to show.
  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * PLAN.md §7 flow A / decision D8: hand the selection to the next session and open
   * one as the host (no `?code`, so the peer scans this device's QR).
   *
   * The queue is filled from this page's own copy of the library — the items are already
   * loaded, so a selected id resolves to the exact row the user picked. An id that no
   * longer exists (deleted in another tab between render and tap) is simply not queued.
   */
  const sendSelected = (ids: string[]): void => {
    const selected = items.filter((item) => ids.includes(item.id))
    if (selected.length === 0) return

    queueLibrarySends(selected)
    navigate('/session')
  }

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
      <LibraryBrowser
        folders={folders}
        items={items}
        currentFolderId={currentFolderId}
        onSelectFolder={setCurrentFolderId}
        onCreateFolder={async (name, parentId) => {
          // Awaited by its dialog, which reports the store's rejection itself.
          await createFolder(name, parentId)
        }}
        onRenameFolder={(id, name) => {
          reportToStore(renameFolder(id, name))
        }}
        onDeleteFolder={(id) => {
          reportToStore(deleteFolder(id))
        }}
        onRenameItem={(id, name) => {
          reportToStore(renameItem(id, name))
        }}
        onMoveItem={(id, targetFolderId) => {
          // `null` is the tree's Root; the store knows the id the library layer uses for it,
          // so the sentinel never reaches a component.
          reportToStore(moveItem(id, targetFolderId))
        }}
        onDeleteItem={(id) => {
          reportToStore(deleteItem(id))
        }}
        onSendItems={sendSelected}
        loading={loading}
        error={error}
      />

      <button type="button" className="button" disabled>
        📷 Scan &amp; Send
      </button>
      <p className="muted">
        Camera scanning arrives in Phase 6. Until then, select items above and use
        “Send selected”, or start a session and open its code on the other device.
      </p>
    </main>
  )
}

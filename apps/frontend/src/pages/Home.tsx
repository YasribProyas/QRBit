/**
 * Home screen (PLAN.md §7, §16 Phase 5/6). The primary screen — no landing page and no
 * "start / join" split, because the app is symmetric.
 *
 * This page owns two things: the library's wiring, and the live session QR.
 *
 * QR (PLAN.md §16 Phase 6): on mount the page mints a session through `GET /session/new`
 * and renders it with `QRDisplay`, so the code on screen is a code the worker will
 * actually accept. The code is handed to the Session page through router state when the user
 * opens the session — minting twice would leave the peer that scanned the QR waiting on a session
 * nobody joins (see `useSession`'s `hostSession`). TURN credentials are now fetched separately
 * from `/session/:code/turn` at connect time (ORCHESTRATION.md D10). A tap anywhere on the QR
 * panel refreshes it, which is PLAN.md §7's "tap to refresh": sessions expire (PLAN.md §17),
 * and a stale code is the one failure mode a user cannot see.
 *
 * The two send flows of PLAN.md §7 both start here:
 *
 *   - **Flow A — select, then scan.** The browser reports its selection
 *     (`onSelectionChange`); "Scan & Send" opens `QRScanner` and, on a scan, queues the
 *     selected items into the session-scoped pending-send queue (decision D8) and opens
 *     the peer's session as the guest. The queue is in-memory only (never localStorage,
 *     the Cache API or IndexedDB), and `useSession` drains it the moment the session goes
 *     active, so the items transfer as soon as the peer is paired and verified. With no
 *     selection at all the button still scans, joining as a plain guest session.
 *   - **Flow B — scan first.** The QR encodes a full URL, so any camera app opens
 *     `/session?code=X` directly (PLAN.md §8). The typed fallback for a device that
 *     cannot scan is `ManualCodeEntry`, right here.
 */

import { useCallback, useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { LibraryBrowser } from '../components/library/LibraryBrowser'
import { ManualCodeEntry } from '../components/ManualCodeEntry'
import { QRDisplay } from '../components/QRDisplay'
import { QRScanner } from '../components/QRScanner'
import { APP_URL } from '../config'
import { describeError, isValidSessionCode, mintHostSession, queueLibrarySends, clearLibrarySends } from '../hooks/useSession'
import type { HostSession } from '../hooks/useSession'
import { useLibraryStore } from '../store/libraryStore'

/**
 * Where this device's own session stands. A code minted once per view: 'creating' while
 * the worker is answering, 'ready' with the bundle, 'error' for an unreachable worker
 * (there is no QR to fall back to without a code, so the panel offers a retry).
 */
type MintState =
  | { status: 'creating' }
  | { status: 'ready'; hostSession: HostSession }
  | { status: 'error'; message: string }

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

  const [mint, setMint] = useState<MintState>({ status: 'creating' })
  /** Bumped by a refresh tap; the mint effect below keys off it. */
  const [mintRequest, setMintRequest] = useState(0)

  /** The library browser's current selection (PLAN.md §7 Flow A). */
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const [scanning, setScanning] = useState(false)

  // The library lives in IndexedDB, so the first render has no data to show.
  useEffect(() => {
    void refresh()
  }, [refresh])

  /*
   * Mints this device's session code. Deferred by a tick, like `useSession`'s connect:
   * React 19 StrictMode's throwaway mount/unmount would otherwise ask the worker for two
   * codes (two Durable Objects, two 5-minute alarms) for one page view.
   */
  useEffect(() => {
    let cancelled = false
    setMint({ status: 'creating' })

    const timer = window.setTimeout(() => {
      void mintHostSession().then(
        (hostSession) => {
          if (!cancelled) setMint({ status: 'ready', hostSession })
        },
        (mintError: unknown) => {
          if (!cancelled) setMint({ status: 'error', message: describeError(mintError) })
        },
      )
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mintRequest])

  const newCode = useCallback((): void => {
    setMintRequest((request) => request + 1)
  }, [])

  /**
   * PLAN.md §7's "tap to refresh". The controls inside the panel (Enlarge, New code) keep
   * their own actions, so a tap that lands on one of them is left alone.
   */
  const handleQrTap = (event: MouseEvent<HTMLElement>): void => {
    if (mint.status !== 'ready') return
    if (event.target instanceof Element && event.target.closest('button') !== null) return
    newCode()
  }

  /**
   * Opens this device's session page as the host. The pre-minted bundle travels in the
   * router state so the session page joins the code the QR is already showing rather than
   * minting a second one; without a ready bundle the hook mints its own, which is the only
   * correct fallback when the worker could not be reached from here.
   */
  const openHostSession = (): void => {
    navigate(
      '/session',
      mint.status === 'ready' ? { state: { hostSession: mint.hostSession } } : undefined,
    )
  }

  /**
   * PLAN.md §7 flow A / decision D8: hand the selection to the next session and open one
   * as the host (no `?code`, so the peer scans this device's QR).
   *
   * The queue is filled from this page's own copy of the library — the items are already
   * loaded, so a selected id resolves to the exact row the user picked. An id that no
   * longer exists (deleted in another tab between render and tap) is simply not queued.
   */
  const sendSelected = (ids: string[]): void => {
    const selected = items.filter((item) => ids.includes(item.id))
    if (selected.length === 0) return

    queueLibrarySends(selected)
    openHostSession()
  }

  const handleSelectionChange = useCallback((ids: readonly string[]): void => {
    setSelectedIds(ids)
  }, [])

  /**
   * The scan's landing point (PLAN.md §7 flow A). The code goes through the Phase 1
   * alphabet once more before it becomes a navigation: `QRScanner` only reports codes it
   * parsed out of a QRDrop URL, but a navigation is the expensive mistake, so the check
   * that guards it is stated where the navigation happens too.
   */
  const handleScan = (code: string): void => {
    setScanning(false)
    if (!isValidSessionCode(code)) {
      // Malformed code — clear any items that were staged for this scan so they
      // don't silently carry over into the next scan attempt.
      clearLibrarySends()
      return
    }

    // Clear first: if the user queued items for a previous scan that was cancelled,
    // those items must not mix with the current selection.
    clearLibrarySends()
    if (selectedIds.length > 0) {
      const selected = items.filter((item) => selectedIds.includes(item.id))
      if (selected.length > 0) queueLibrarySends(selected)
    }

    navigate(`/session?code=${encodeURIComponent(code)}`)
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

      <section className="panel home__qr" onClick={handleQrTap}>
        {import.meta.env.DEV && new URL(APP_URL).origin !== location.origin ? (
          <p className="item-error" role="alert">
            Dev warning: VITE_APP_URL ({APP_URL}) does not match this page's origin
            ({location.origin}). The QR code will encode the wrong URL and cannot be
            scanned. Set VITE_APP_URL={location.origin} in your .env to fix this.
          </p>
        ) : null}
        {mint.status === 'creating' ? (
          <p className="muted" role="status">
            Creating your session code…
          </p>
        ) : null}

        {mint.status === 'ready' ? (
          <QRDisplay code={mint.hostSession.code} onRefresh={newCode} />
        ) : null}

        {mint.status === 'error' ? (
          <div className="home__qr-error" role="alert">
            <p className="muted">Could not reach the signaling server to create your code.</p>
            <p className="item-error">{mint.message}</p>
            <button type="button" className="button" onClick={newCode}>
              Try again
            </button>
          </div>
        ) : null}
      </section>

      <button type="button" className="button" onClick={openHostSession}>
        Start a session on this device
      </button>

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
        onSelectionChange={handleSelectionChange}
        loading={loading}
        error={error}
      />

      <button
        type="button"
        className="button home__scan"
        onClick={() => {
          // The camera is only requested when the scanner mounts — never on page load.
          setScanning(true)
        }}
      >
        📷 Scan &amp; Send{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
      </button>
      <p className="muted">
        Opens the camera to scan the other device’s code. Anything selected above sends as
        soon as the session is active — with nothing selected this just joins the session,
        and you can add items on the board.
      </p>

      <ManualCodeEntry />

      {scanning ? <QRScanner onScan={handleScan} onCancel={() => { clearLibrarySends(); setScanning(false) }} /> : null}
    </main>
  )
}

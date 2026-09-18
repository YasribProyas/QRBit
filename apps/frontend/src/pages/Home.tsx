import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LibraryBrowser } from '../components/library/LibraryBrowser'
import { ManualCodeEntry } from '../components/ManualCodeEntry'
import { QRScanner } from '../components/QRScanner'
import { SessionView } from '../components/session/SessionView'
import { AppLayout } from '../components/layout/AppLayout'
import { clearLibrarySends, isValidSessionCode, queueLibrarySends, useSession } from '../hooks/useSession'
import { useLibraryStore } from '../store/libraryStore'

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

/**
 * Home screen (PLAN.md §7, §16 Phase 5/6, ORCHESTRATION.md D13).
 *
 * Upgraded with Mantine UI: Dual-Pane responsive layout (Vault on left, Live Session/QR
 * on right on desktop; mobile-responsive flow with drawer).
 *
 * Home BECOMES the host: on mount it starts `useSession({ code: null })` which mints
 * a fresh session code and joins the signaling server as host immediately. The QR code
 * and honest status line ("Host — waiting for another device to scan your code") are
 * rendered right here on the home page so a visiting peer gets a joinable QR from the start.
 *
 * Beside the QR, the library is visible and usable while waiting. When a peer joins and
 * pairing begins, the session surface (SessionView) replaces the library view. Once the
 * session ends, Home auto-recovers (or lets the user save received items and tap Start a
 * new session) to mint a fresh live code.
 */
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

  /** The library browser's current selection (PLAN.md §7 Flow A). */
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const [scanning, setScanning] = useState(false)

  // Home mounts the host session directly so the QR is visible and joinable immediately.
  const session = useSession({ code: null })

  // The library lives in IndexedDB, so the first render has no data to show.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // When a session ends on Home without received items or errors, auto-recover by restarting
  // to mint a fresh code so the next peer gets a joinable QR rather than a burned one.
  useEffect(() => {
    if (session.phase === 'ended' && session.receivedItems.length === 0 && session.errorMessage === null) {
      session.restart()
    }
  }, [session.phase, session.receivedItems.length, session.errorMessage, session.restart])

  /**
   * PLAN.md §7 flow A / decision D8: hand the selection to the session.
   * Since Home is the host, queued items will send as soon as the session goes active.
   */
  const sendSelected = (ids: string[]): void => {
    const selected = items.filter((item) => ids.includes(item.id))
    if (selected.length === 0) return

    queueLibrarySends(selected)
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
      clearLibrarySends()
      return
    }

    clearLibrarySends()
    if (selectedIds.length > 0) {
      const selected = items.filter((item) => selectedIds.includes(item.id))
      if (selected.length > 0) queueLibrarySends(selected)
    }

    navigate(`/session?code=${encodeURIComponent(code)}`)
  }

  // Active or pairing session (or ended with received items to save) renders the session surface
  // in place of the library.
  const isSessionSurface =
    session.phase === 'pairing' ||
    session.phase === 'active' ||
    (session.phase === 'ended' && session.receivedItems.length > 0)

  return (
    <AppLayout
      session={session}
      showVault={!isSessionSurface}
      vaultContent={
        !isSessionSurface ? (
          <>
            <h2 className="page__section-title">Your Library</h2>
            <LibraryBrowser
              folders={folders}
              items={items}
              currentFolderId={currentFolderId}
              onSelectFolder={setCurrentFolderId}
              onCreateFolder={async (name, parentId) => {
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
          </>
        ) : null
      }
      mainContent={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)' }}>
          <SessionView session={session} showConnectingCode={!isSessionSurface} />

          {!isSessionSurface ? (
            <>
              <button
                type="button"
                className="button home__scan"
                onClick={() => {
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

              {scanning ? (
                <QRScanner
                  onScan={handleScan}
                  onCancel={() => {
                    clearLibrarySends()
                    setScanning(false)
                  }}
                />
              ) : null}
            </>
          ) : null}
        </div>
      }
    />
  )
}

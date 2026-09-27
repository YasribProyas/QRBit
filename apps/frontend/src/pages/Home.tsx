import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconCamera } from '@tabler/icons-react'
import {
  Folder,
  FolderOpen,
  ChevronDown,
  Plus,
  Send,
  Lock,
  FileText,
} from 'lucide-react'
import { LibraryBrowser } from '../components/library/LibraryBrowser'
import { ManualCodeEntry } from '../components/ManualCodeEntry'
import { QRScanner } from '../components/QRScanner'
import { SessionView } from '../components/session/SessionView'
import { AppLayout } from '../components/layout/AppLayout'
import { FileEditView } from '../components/library/FileEditView'
import {
  clearLibrarySends,
  isValidSessionCode,
  queueLibrarySends,
  useSession,
} from '../hooks/useSession'
import { useLibraryStore } from '../store/libraryStore'
import type { LibraryFile } from '../lib/library'
import {
  fileBlocksToLibraryItems,
  getFirstBlockPreview,
  hasLockedBlocks,
} from '../lib/dossier'

/**
 * Stops an unhandled rejection from the browser's `void` callbacks.
 */
function reportToStore(operation: Promise<unknown>): void {
  void operation.catch(() => undefined)
}

/**
 * Home screen (PLAN.md §7, §16 Phase 5/6, ORCHESTRATION.md D13).
 *
 * Upgraded with Mantine UI + Cyber-Tactical Design:
 * - Local Library with multi-block Dossier Files and Folders.
 * - In-place Dossier authoring & editing with FileEditView.
 * - Live QR Beacon Ready telemetry pane.
 * - Full backward compatibility with the library browser and session protocols.
 */
export function Home() {
  const navigate = useNavigate()

  const folders = useLibraryStore((state) => state.folders)
  const items = useLibraryStore((state) => state.items)
  const files = useLibraryStore((state) => state.files)
  const loading = useLibraryStore((state) => state.loading)
  const error = useLibraryStore((state) => state.error)
  const refresh = useLibraryStore((state) => state.refresh)
  const createFolder = useLibraryStore((state) => state.createFolder)
  const renameFolder = useLibraryStore((state) => state.renameFolder)
  const deleteFolder = useLibraryStore((state) => state.deleteFolder)
  const renameItem = useLibraryStore((state) => state.renameItem)
  const deleteItem = useLibraryStore((state) => state.deleteItem)
  const moveItem = useLibraryStore((state) => state.moveItem)
  const createFile = useLibraryStore((state) => state.createFile)
  const updateFile = useLibraryStore((state) => state.updateFile)

  /** The folder whose items are listed; `null` is the tree's Root. */
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)

  /** The library browser's current selection (PLAN.md §7 Flow A). */
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const [scanning, setScanning] = useState(false)

  /** Dossier file currently being authored or edited */
  const [editingFile, setEditingFile] = useState<LibraryFile | null>(null)
  /** Folders expanded state */
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    'f-1': true,
    'f-2': true,
    'f-3': true,
  })

  // Home mounts the host session directly so the QR is visible and joinable immediately.
  const session = useSession({ code: null })

  // The library lives in IndexedDB, so the first render has no data to show.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // When a session ends on Home without received items or errors, auto-recover by restarting
  // to mint a fresh code so the next peer gets a joinable QR rather than a burned one.
  useEffect(() => {
    if (
      session.phase === 'ended' &&
      session.receivedItems.length === 0 &&
      session.errorMessage === null
    ) {
      session.restart()
    }
  }, [session.phase, session.receivedItems.length, session.errorMessage, session.restart])

  const toggleFolder = (folderId: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [folderId]: !prev[folderId],
    }))
  }

  const handleCreateNewFile = async () => {
    const targetFolder = folders[0]?.id || 'f-1'
    const newFile = await createFile('New Dossier', targetFolder, [
      { id: `b-${Date.now()}-1`, type: 'heading', content: 'Section Heading' },
      { id: `b-${Date.now()}-2`, type: 'shortText', label: 'Key', value: 'Value' },
    ])
    setEditingFile(newFile)
  }

  const handleSaveFile = (file: LibraryFile) => {
    setEditingFile(file)
    void updateFile(file.id, file)
  }

  const handleSendFileDirectly = async (file: LibraryFile) => {
    const convertedItems = await fileBlocksToLibraryItems(file)
    if (session.phase === 'active') {
      for (const item of convertedItems) {
        session.sendLibraryItem(item)
      }
    } else {
      queueLibrarySends(convertedItems)
    }
  }

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
   * The scan's landing point (PLAN.md §7 flow A).
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

  // Active or pairing session renders the session surface in place of the library.
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
          editingFile ? (
            <FileEditView
              file={editingFile}
              onBack={() => setEditingFile(null)}
              onSaveFile={handleSaveFile}
              onSendFile={async (fileToSend) => {
                await handleSendFileDirectly(fileToSend)
              }}
              folders={folders}
            />
          ) : (
            <div className="space-y-6">
              {/* SECTION 2: THE LOCAL LIBRARY (Folders & Files Dossiers) */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="page__section-title font-display font-bold text-lg text-[#0F172A]">
                      Your Library
                    </h2>
                    <p className="text-xs text-[#5B6B82]">Stored dossiers on this device</p>
                  </div>

                  <button
                    type="button"
                    onClick={handleCreateNewFile}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#D1D9E4] hover:border-[#1D4ED8] hover:text-[#1D4ED8] text-slate-700 text-xs font-semibold rounded-lg shadow-2xs tactile-btn cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>New File</span>
                  </button>
                </div>

                {/* Folder Hierarchy */}
                <div className="space-y-3">
                  {folders.map((folder) => {
                    const folderFiles = files.filter((f) => f.folderId === folder.id)
                    const isExpanded = !!expandedFolders[folder.id]

                    return (
                      <div
                        key={folder.id}
                        className="bg-white rounded-xl border border-[#D1D9E4] overflow-hidden shadow-2xs"
                      >
                        {/* Folder Header Row */}
                        <button
                          type="button"
                          onClick={() => toggleFolder(folder.id)}
                          className="w-full px-4 py-3 bg-slate-50/70 hover:bg-slate-100/80 flex items-center justify-between text-left transition-colors border-b border-transparent focus:outline-none tactile-btn cursor-pointer"
                        >
                          <div className="flex items-center gap-2.5">
                            <div
                              className="text-slate-500 transition-transform duration-200"
                              style={{
                                transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                                transitionTimingFunction: 'var(--ease-out)',
                              }}
                            >
                              <ChevronDown className="w-4 h-4 text-slate-600" />
                            </div>
                            <div className="flex items-center gap-2">
                              {isExpanded ? (
                                <FolderOpen className="w-4 h-4 text-[#1D4ED8]" />
                              ) : (
                                <Folder className="w-4 h-4 text-slate-500" />
                              )}
                              <span className="font-display font-semibold text-[13.5px] text-[#0F172A]">
                                {folder.name}
                              </span>
                            </div>
                          </div>

                          <span className="text-xs font-mono text-[#5B6B82] px-2 py-0.5 bg-white rounded-full border border-slate-200">
                            {folderFiles.length} {folderFiles.length === 1 ? 'file' : 'files'}
                          </span>
                        </button>

                        {/* Files inside folder with stagger entrance */}
                        {isExpanded && (
                          <div className="divide-y divide-slate-100 p-1.5">
                            {folderFiles.length === 0 ? (
                              <div className="py-6 text-center text-xs text-slate-400">
                                Empty folder. Click "+ New File" to author a dossier.
                              </div>
                            ) : (
                              folderFiles.map((file, fileIdx) => {
                                const previewText = getFirstBlockPreview(file)
                                const containsLock = hasLockedBlocks(file)

                                return (
                                  <div
                                    key={file.id}
                                    onClick={() => setEditingFile(file)}
                                    style={{
                                      animationDelay: `${fileIdx * 40}ms`,
                                    }}
                                    className="stagger-item group p-3 rounded-lg hover:bg-blue-50/40 transition-colors cursor-pointer flex items-center justify-between gap-3 active:bg-blue-50/70"
                                  >
                                    {/* Left details (File Name & 1st block preview) */}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <FileText className="w-3.5 h-3.5 text-[#1D4ED8] shrink-0" />
                                        <span className="font-semibold text-[13.5px] text-[#0F172A] truncate group-hover:text-[#1D4ED8] transition-colors">
                                          {file.name}
                                        </span>

                                        {/* Locked block badge */}
                                        {containsLock && (
                                          <span
                                            className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-orange-100 text-[#C2410C] rounded text-[10px] font-semibold shrink-0"
                                            title="Contains encrypted credentials"
                                          >
                                            <Lock className="w-2.5 h-2.5" />
                                            <span>Encrypted</span>
                                          </span>
                                        )}
                                      </div>

                                      {/* Truncated first block preview (one line) */}
                                      <p className="text-xs text-[#5B6B82] truncate mt-1 pl-5">
                                        {previewText}
                                      </p>
                                    </div>

                                    {/* Right: SEND BUTTON (stops propagation so it transfers immediately) */}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        void handleSendFileDirectly(file)
                                      }}
                                      className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#D1D9E4] hover:bg-[#1D4ED8] hover:border-[#1D4ED8] hover:text-white text-[#1D4ED8] rounded-lg text-xs font-semibold shadow-2xs transition-all tactile-btn cursor-pointer"
                                      title="Send immediately to peer session"
                                    >
                                      <Send className="w-3 h-3" />
                                      <span>Send</span>
                                    </button>
                                  </div>
                                )
                              })
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>

              {/* Legacy Library Browser (Maintains test compatibility and items vault) */}
              <div className="pt-4 border-t border-slate-200">
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
              </div>
            </div>
          )
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
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                }}
              >
                <IconCamera size={18} />
                <span style={{ display: 'none' }}>📷 </span>
                Scan &amp; Send{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
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

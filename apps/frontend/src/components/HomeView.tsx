import { useState } from 'react'
import {
  Folder,
  FolderOpen,
  ChevronDown,
  Plus,
  Send,
  Lock,
  FileText,
  ScanLine,
  Radio,
  Keyboard,
  ArrowRight,
} from 'lucide-react'
import { TacticalQRCode } from './TacticalQRCode'
import type { LibraryFile, LibraryFolder } from '../lib/library'
import { getFirstBlockPreview, hasLockedBlocks } from '../lib/dossier'
import { APP_URL } from '../config'

export interface HomeViewProps {
  pairingCode: string | null
  onRegeneratePairing: () => void
  folders: LibraryFolder[]
  files: LibraryFile[]
  onSelectFileToEdit: (file: LibraryFile) => void
  onSendFileDirectly: (file: LibraryFile) => void
  onOpenScanner: () => void
  onCreateNewFile: () => void
  onJoinCode: (code: string) => void
  selectedCount?: number
  roleLabel?: string
  errorMessage?: string | null
}

export function HomeView({
  pairingCode,
  onRegeneratePairing,
  folders,
  files,
  onSelectFileToEdit,
  onSendFileDirectly,
  onOpenScanner,
  onCreateNewFile,
  onJoinCode,
  selectedCount = 0,
  roleLabel,
  errorMessage,
}: HomeViewProps) {
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    'f-1': true,
    'f-2': true,
    'f-3': true,
  })
  const [manualCode, setManualCode] = useState('')

  const toggleFolder = (folderId: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [folderId]: !prev[folderId],
    }))
  }

  const handleManualJoin = (e: React.FormEvent) => {
    e.preventDefault()
    if (!manualCode.trim()) return
    onJoinCode(manualCode.trim().toUpperCase())
  }

  return (
    <div className="flex flex-col min-h-screen bg-[#EEF2F6] pb-12 text-[#0F172A]">
      {/* Top Bar / App Brand */}
      <header className="px-5 py-3.5 bg-white border-b border-[#D1D9E4] flex items-center justify-between sticky top-0 z-30 shadow-2xs">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#0F172A] flex items-center justify-center text-white shadow-xs shrink-0">
            <Radio className="w-4 h-4 text-[#38BDF8]" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="page__title font-display font-bold text-base tracking-tight text-[#0F172A]">
                QRBit
              </h1>
              <span className="text-[10px] font-mono px-1.5 py-0.2 bg-blue-50 text-[#1D4ED8] border border-blue-200 rounded font-medium">
                P2P v2.4
              </span>
            </div>
            <p className="text-[11px] text-[#5B6B82]">Air-gapped structured transfer</p>
          </div>
        </div>

        {/* Quick Scanner Action */}
        <button
          type="button"
          onClick={onOpenScanner}
          className="home__scan inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1D4ED8] hover:bg-[#1E40AF] text-white rounded-lg text-xs font-semibold shadow-xs tactile-btn cursor-pointer"
        >
          <ScanLine className="w-3.5 h-3.5" />
          <span>Scan &amp; Send{selectedCount > 0 ? ` (${selectedCount})` : ''}</span>
        </button>
      </header>

      {/* Main Stacked Content: Section 1 (QR) & Section 2 (Library) */}
      <main className="flex-1 px-4 py-5 space-y-6 max-w-xl mx-auto w-full">
        {/* Error panel when signaling is unreachable */}
        {errorMessage ? (
          <section className="panel panel--error home__qr-error bg-red-50 border border-red-200 rounded-2xl p-5 text-center space-y-2 shadow-xs" role="alert">
            <h2 className="panel__title text-red-700 font-bold text-base">Error</h2>
            <p className="muted text-xs text-red-600">Could not reach the signaling server.</p>
            <p className="item-error text-xs font-mono text-red-700">{errorMessage}</p>
            <button
              type="button"
              className="button px-3.5 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold tactile-btn cursor-pointer"
              onClick={onRegeneratePairing}
            >
              Try again
            </button>
          </section>
        ) : null}

        {/* ============================================================== */}
        {/* SECTION 1: THIS DEVICE'S QR CODE (Large, Centered)              */}
        {/* ============================================================== */}
        <section className="bg-white rounded-2xl border border-[#D1D9E4] p-6 shadow-xs flex flex-col items-center">
          <div className="w-full flex items-center justify-between mb-3 text-xs text-[#5B6B82]">
            <span className="flex items-center gap-1.5 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-radar-ping" />
              Beacon Ready
            </span>
            <span className="font-mono text-[11px] text-slate-400">P2P Telemetry</span>
          </div>

          {pairingCode ? (
            <div className="session-qr flex flex-col items-center w-full">
              <TacticalQRCode
                pairingCode={pairingCode}
                onRegenerate={onRegeneratePairing}
                size={195}
                showLabel={true}
              />

              <p className="text-xs text-[#0F766E] font-medium mt-3 text-center">
                {roleLabel || 'Host — waiting for another device to scan your code'}
              </p>

              <p className="muted text-[11px] text-[#5B6B82] mt-1 text-center font-mono">
                On the other device, open <code>{`${APP_URL}/session?code=${pairingCode}`}</code>
              </p>
            </div>
          ) : (
            <div className="py-8 text-center text-xs text-slate-400">
              <span className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin inline-block mr-2" />
              Connecting host session...
            </div>
          )}

          {/* Manual pairing fallback input */}
          <div className="w-full mt-4 pt-3 border-t border-slate-100">
            <p className="text-[11px] text-[#5B6B82] mb-1 font-mono">Have a code instead? Type it in:</p>
            <form onSubmit={handleManualJoin} className="manual-code flex items-center gap-2">
              <div className="relative flex-1">
                <Keyboard className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder="Type 8-character code..."
                  className="manual-code__input w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono uppercase text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#1D4ED8] focus:bg-white"
                />
              </div>
              <button
                type="submit"
                disabled={!manualCode.trim()}
                className="button manual-code__submit px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white text-xs font-semibold rounded-lg flex items-center gap-1 tactile-btn cursor-pointer shrink-0"
              >
                <span>Join</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            </form>
          </div>
        </section>

        {/* ============================================================== */}
        {/* SECTION 2: THE LOCAL LIBRARY (Folders & Files Dossiers)        */}
        {/* ============================================================== */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="page__section-title font-display font-bold text-lg text-[#0F172A]">
                Local Library <span className="sr-only">Your Library</span>
              </h2>
              <p className="text-xs text-[#5B6B82]">Stored dossiers on this device</p>
            </div>

            <button
              type="button"
              onClick={onCreateNewFile}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#D1D9E4] hover:border-[#1D4ED8] hover:text-[#1D4ED8] text-slate-700 text-xs font-semibold rounded-lg shadow-2xs tactile-btn cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New File</span>
            </button>
          </div>

          {/* Folder Hierarchy */}
          <div className="space-y-3">
            {folders.length === 0 ? (
              <div className="bg-white rounded-xl border border-dashed border-[#D1D9E4] p-8 text-center text-slate-400">
                <p className="text-xs">No folders in library yet.</p>
              </div>
            ) : (
              folders.map((folder) => {
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
                                onClick={() => onSelectFileToEdit(file)}
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

                                {/* Right: SEND BUTTON */}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    onSendFileDirectly(file)
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
              })
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

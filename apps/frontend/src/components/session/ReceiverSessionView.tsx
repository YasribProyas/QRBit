import { useState } from 'react'
import {
  Monitor,
  CheckCircle2,
  Clock,
  PowerOff,
  FolderDown,
  ShieldCheck,
  Activity,
  Layers,
  Smartphone,
} from 'lucide-react'
import type { UseSessionResult } from '../../hooks/useSession'
import type { LibraryFolder, FileBlock, LibraryFile } from '../../lib/library'
import { BlockItem } from '../library/BlockItem'
import { FolderPickerModal, type FolderPickerChoice } from '../library/FolderPickerModal'
import { sessionItemsToLibraryFile } from '../../lib/dossier'

export interface ReceiverSessionViewProps {
  session: UseSessionResult
  folders: LibraryFolder[]
  peerName?: string
  onSaveToLibrary: (file: LibraryFile) => void
  onEndSession: () => void
}

export function ReceiverSessionView({
  session,
  folders,
  peerName = 'Connected Peer (Optical Air-Gap)',
  onSaveToLibrary,
  onEndSession,
}: ReceiverSessionViewProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [hasSaved, setHasSaved] = useState(false)

  const receivedItems = session.receivedItems || []
  const safetyWords = session.safetyPhrase || ['COBALT', 'TIMBER', 'FALCON']

  // Convert received session items into display FileBlocks
  const arrivedFile = sessionItemsToLibraryFile(
    'Incoming Transferred Dossier',
    folders[0]?.id || 'f-1',
    receivedItems,
  )
  const arrivedBlocks: FileBlock[] = arrivedFile.blocks

  const handleSelectFolder = (folderChoice: FolderPickerChoice) => {
    setHasSaved(true)
    const targetFolderId = folderChoice.folderId || folders[0]?.id || 'f-1'
    const completeItems = receivedItems.filter((i) => i.status === 'complete')
    const finalFile = sessionItemsToLibraryFile(
      'Incoming Transferred Dossier',
      targetFolderId,
      completeItems,
    )
    onSaveToLibrary(finalFile)
  }

  const isComplete = receivedItems.length > 0 && receivedItems.every((i) => i.status === 'complete')

  return (
    <div className="session-board flex flex-col min-h-screen bg-[#EEF2F6] text-[#0F172A]">
      {/* Top Telemetry Header */}
      <header className="px-6 py-3.5 bg-[#0F172A] text-white border-b border-slate-800 flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#1D4ED8] flex items-center justify-center text-white font-bold">
            <Monitor className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display font-bold text-sm tracking-wide text-white">
                QRBit Receiver Station
              </h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-900/60 text-blue-300 border border-blue-700">
                P2P-HOST
              </span>
            </div>
            <p className="text-[11px] text-slate-400">Incoming Air-Gap Optical Stream</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 text-xs text-slate-300 font-mono bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-700">
            <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            <span>Link Quality: 99.8% (Air-Gap)</span>
          </div>

          <button
            type="button"
            onClick={onEndSession}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors tactile-btn cursor-pointer"
          >
            <PowerOff className="w-3.5 h-3.5" />
            <span>End Session</span>
          </button>
        </div>
      </header>

      {/* Main Asymmetric Layout: Left Panel (320px) + Main Stage */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-7xl mx-auto w-full p-4 lg:p-6 gap-6">
        {/* LEFT PANEL: CONNECTION STATUS, VERIFICATION WORDS, LIVE LIST */}
        <aside className="w-full lg:w-80 shrink-0 space-y-4">
          {/* Card 1: Connection & Safety Words */}
          <div className="bg-white rounded-xl border border-[#D1D9E4] p-4 shadow-2xs space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-radar-ping" />
                Connection Active
              </span>
              <span className="text-[11px] font-mono text-slate-400">P2P Telemetry</span>
            </div>

            <div className="space-y-1">
              <span className="text-[11px] text-[#5B6B82]">Connected Peer:</span>
              <div className="flex items-center gap-2 font-medium text-xs text-[#0F172A] bg-slate-50 p-2 rounded border border-slate-200">
                <Smartphone className="w-3.5 h-3.5 text-[#1D4ED8]" />
                <span className="truncate">{peerName}</span>
              </div>
            </div>

            {/* Three Verification Words */}
            <div className="space-y-1.5 pt-1">
              <span className="text-[11px] font-mono text-[#5B6B82] uppercase flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
                Verification Words:
              </span>
              <div className="grid grid-cols-3 gap-1 text-center font-mono font-bold text-xs">
                {safetyWords.map((word) => (
                  <div
                    key={word}
                    className="py-1.5 px-1 bg-blue-50 text-[#1D4ED8] border border-blue-200 rounded uppercase"
                  >
                    {word}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Card 2: Live Compact List of Blocks Received */}
          <div className="bg-white rounded-xl border border-[#D1D9E4] p-4 shadow-2xs space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-display font-semibold text-xs text-[#0F172A] flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-[#1D4ED8]" />
                Blocks Received Live ({arrivedBlocks.length})
              </span>
              {isComplete && (
                <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                  All Arrived
                </span>
              )}
            </div>

            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {arrivedBlocks.length === 0 ? (
                <div className="py-6 text-center text-xs text-slate-400">
                  Awaiting first incoming block...
                </div>
              ) : (
                arrivedBlocks.map((b, i) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between p-2 rounded bg-slate-50 border border-slate-200/80 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[10px] text-slate-400 w-4">
                        0{i + 1}
                      </span>
                      <span className="font-medium text-slate-800 truncate">
                        {b.label || b.content || b.fileName || b.type}
                      </span>
                    </div>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  </div>
                ))
              )}

              {!isComplete && arrivedBlocks.length > 0 && (
                <div className="flex items-center gap-2 p-2 rounded bg-blue-50/50 border border-dashed border-blue-200 text-xs text-blue-700 animate-pulse">
                  <Clock className="w-3.5 h-3.5" />
                  <span>Awaiting remaining blocks...</span>
                </div>
              )}
            </div>
          </div>

          {/* Action: Save Whole Dossier to Library */}
          {arrivedBlocks.length > 0 && (
            <div className="bg-white rounded-xl border border-emerald-300 p-4 shadow-sm space-y-2.5">
              <div className="flex items-center gap-2 text-emerald-700 font-semibold text-xs">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>Payload ready to persist</span>
              </div>
              <p className="text-[11px] text-slate-500">
                Save incoming dossier blocks directly into your encrypted library.
              </p>
              <button
                type="button"
                onClick={() => setIsFolderPickerOpen(true)}
                disabled={hasSaved}
                className={`w-full py-2.5 rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-all tactile-btn cursor-pointer ${
                  hasSaved
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                    : 'bg-[#1D4ED8] hover:bg-[#1E40AF] text-white'
                }`}
              >
                <FolderDown className="w-4 h-4" />
                <span>{hasSaved ? 'Saved to Local Library ✓' : 'Save Whole Dossier to Library'}</span>
              </button>
            </div>
          )}
        </aside>

        {/* MAIN AREA: BLOCKS ARRIVING IN REAL TIME */}
        <main className="flex-1 space-y-4">
          <div className="bg-white rounded-xl border border-[#D1D9E4] p-5 shadow-2xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-100 gap-2">
              <div>
                <span className="text-[11px] font-mono text-[#5B6B82] uppercase">
                  Live Assembling Dossier
                </span>
                <h2 className="font-display font-bold text-xl text-[#0F172A]">
                  Incoming Transferred Dossier
                </h2>
              </div>

              {arrivedBlocks.length > 0 && (
                <button
                  type="button"
                  onClick={() => setIsFolderPickerOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1D4ED8] hover:bg-[#1E40AF] text-white rounded-lg text-xs font-semibold shadow-xs transition-colors tactile-btn cursor-pointer self-start sm:self-auto"
                >
                  <FolderDown className="w-3.5 h-3.5" />
                  <span>Save to Library</span>
                </button>
              )}
            </div>

            {/* Arriving Blocks Stage */}
            <div className="space-y-4 pt-4">
              {arrivedBlocks.length === 0 ? (
                <div className="py-16 text-center text-slate-400 space-y-2">
                  <div className="w-10 h-10 rounded-full border-2 border-[#1D4ED8] border-t-transparent animate-spin mx-auto" />
                  <p className="text-sm font-medium text-slate-700">Connecting optical stream...</p>
                  <p className="text-xs">Blocks will materialize here in real time as packets land.</p>
                </div>
              ) : (
                arrivedBlocks.map((block, index) => (
                  <BlockItem
                    key={block.id}
                    block={block}
                    index={index}
                    totalBlocks={arrivedBlocks.length}
                    mode="receiver"
                    transferStatus="sent"
                    transferProgress={100}
                  />
                ))
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Folder Picker Modal */}
      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        onClose={() => setIsFolderPickerOpen(false)}
        folders={folders}
        fileName="Incoming Dossier"
        onSelectFolder={handleSelectFolder}
      />
    </div>
  )
}

import { useState } from 'react'
import {
  CheckCircle2,
  FolderDown,
  RotateCcw,
  Library,
} from 'lucide-react'
import type { UseSessionResult } from '../../hooks/useSession'
import type { LibraryFolder, LibraryFile } from '../../lib/library'
import { FolderPickerModal, type FolderPickerChoice } from '../library/FolderPickerModal'
import { sessionItemsToLibraryFile } from '../../lib/dossier'

export interface SessionEndedViewProps {
  session: UseSessionResult
  folders: LibraryFolder[]
  onSaveFileToLibrary: (file: LibraryFile) => void
  onStartNewSession: () => void
  onGoToLibrary: () => void
}

export function SessionEndedView({
  session,
  folders,
  onSaveFileToLibrary,
  onStartNewSession,
  onGoToLibrary,
}: SessionEndedViewProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [hasSavedWholeFile, setHasSavedWholeFile] = useState(false)

  const receivedItems = session.receivedItems || []
  const completeItems = receivedItems.filter((i) => i.status === 'complete')

  const handleSelectFolder = (folderChoice: FolderPickerChoice) => {
    setHasSavedWholeFile(true)
    const targetFolderId = folderChoice.folderId || folders[0]?.id || 'f-1'
    const file = sessionItemsToLibraryFile('Transferred Dossier', targetFolderId, completeItems)
    onSaveFileToLibrary(file)
  }

  const encryptedCount = completeItems.filter((i) => i.type === 'locked').length

  return (
    <div className="flex flex-col min-h-screen bg-[#EEF2F6] text-[#0F172A] max-w-xl mx-auto w-full px-4 py-8 space-y-6 pb-16">
      {/* 1. CONFIRMATION SUMMARY CARD */}
      <section className="bg-white rounded-2xl border border-emerald-200 p-6 shadow-sm text-center relative overflow-hidden">
        <div className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center mx-auto mb-3">
          <CheckCircle2 className="w-6 h-6" />
        </div>

        <h2 className="font-display font-bold text-xl text-[#0F172A]">
          Transfer Complete
        </h2>
        <p className="text-xs text-[#5B6B82] mt-1">
          Optical peer channel disconnected cleanly with zero checksum errors.
        </p>

        {/* 3 Metric Pills */}
        <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-slate-100">
          <div className="p-2 bg-slate-50 rounded-lg">
            <span className="text-[11px] text-[#5B6B82] block">Total Blocks</span>
            <span className="font-mono font-bold text-sm text-[#0F172A]">
              {completeItems.length}
            </span>
          </div>

          <div className="p-2 bg-slate-50 rounded-lg">
            <span className="text-[11px] text-[#5B6B82] block">Encrypted</span>
            <span className="font-mono font-bold text-sm text-[#C2410C]">
              {encryptedCount}
            </span>
          </div>

          <div className="p-2 bg-slate-50 rounded-lg">
            <span className="text-[11px] text-[#5B6B82] block">Air-Gap Link</span>
            <span className="font-mono font-bold text-sm text-[#0F766E]">
              100%
            </span>
          </div>
        </div>
      </section>

      {/* 2. SAVE DOSSIER TO LOCAL LIBRARY */}
      {completeItems.length > 0 && (
        <section className="bg-white rounded-2xl border border-[#D1D9E4] p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <span className="text-[11px] font-mono text-[#1D4ED8] uppercase font-semibold">
                Air-Gapped Dossier
              </span>
              <h3 className="font-display font-bold text-base text-[#0F172A]">
                Transferred Dossier
              </h3>
            </div>

            <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
              {completeItems.length} {completeItems.length === 1 ? 'block' : 'blocks'}
            </span>
          </div>

          <p className="text-xs text-[#5B6B82]">
            Save the incoming dossier directly into a folder on this device.
          </p>

          <button
            type="button"
            onClick={() => setIsFolderPickerOpen(true)}
            disabled={hasSavedWholeFile}
            className={`session-ended__save w-full py-3 rounded-xl font-display font-semibold text-xs shadow-xs flex items-center justify-center gap-2 transition-all tactile-btn cursor-pointer ${
              hasSavedWholeFile
                ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                : 'bg-[#1D4ED8] hover:bg-[#1E40AF] text-white'
            }`}
          >
            <FolderDown className="w-4 h-4" />
            <span>
              {hasSavedWholeFile
                ? 'Saved to Local Library ✓'
                : 'Save to Library →'}
            </span>
          </button>
        </section>
      )}

      {/* 3. NAVIGATION ACTIONS */}
      <div className="space-y-2 pt-2">
        <button
          type="button"
          onClick={onStartNewSession}
          className="w-full py-3 bg-white hover:bg-slate-50 text-[#0F172A] border border-[#D1D9E4] rounded-xl font-display font-semibold text-xs flex items-center justify-center gap-2 shadow-2xs tactile-btn cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5 text-[#1D4ED8]" />
          <span>Start New Air-Gap Session</span>
        </button>

        <button
          type="button"
          onClick={onGoToLibrary}
          className="w-full py-2.5 text-[#5B6B82] hover:text-[#0F172A] rounded-xl font-medium text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
        >
          <Library className="w-3.5 h-3.5" />
          <span>Return to Local Library</span>
        </button>
      </div>

      {/* Destination Folder Picker Modal */}
      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        onClose={() => setIsFolderPickerOpen(false)}
        folders={folders}
        fileName="Transferred Dossier"
        onSelectFolder={handleSelectFolder}
      />
    </div>
  )
}

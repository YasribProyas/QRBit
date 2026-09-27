import { useState } from 'react'
import { Folder, FolderPlus, Check, X } from 'lucide-react'
import type { LibraryFolder } from '../../lib/library'

export interface FolderPickerChoice {
  isNew: boolean
  folderId?: string
  folderName?: string
}

export interface FolderPickerModalProps {
  isOpen: boolean
  onClose: () => void
  folders: LibraryFolder[]
  onSelectFolder: (choice: FolderPickerChoice) => void
  fileName?: string
}

export function FolderPickerModal({
  isOpen,
  onClose,
  folders = [],
  onSelectFolder,
  fileName = 'Received Dossier',
}: FolderPickerModalProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string>(folders[0]?.id || '')
  const [newFolderName, setNewFolderName] = useState('')
  const [isCreatingNew, setIsCreatingNew] = useState(false)

  if (!isOpen) return null

  const handleConfirm = () => {
    if (isCreatingNew && newFolderName.trim()) {
      onSelectFolder({ isNew: true, folderName: newFolderName.trim() })
    } else {
      onSelectFolder({ isNew: false, folderId: selectedFolderId })
    }
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs transition-opacity duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-white rounded-xl border border-[#D1D9E4] shadow-2xl p-5 modal-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div>
            <h3 className="font-display font-bold text-base text-[#0F172A]">Save to Library</h3>
            <p className="text-xs text-[#5B6B82] truncate max-w-[240px]">Target: {fileName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 tactile-btn cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-4 space-y-2">
          <label className="text-xs font-semibold text-slate-700">Select Destination Folder:</label>

          <div className="space-y-1.5 max-h-48 overflow-y-auto scroll-contain pr-1">
            {folders.map((folder) => {
              const isSelected = !isCreatingNew && selectedFolderId === folder.id
              return (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => {
                    setSelectedFolderId(folder.id)
                    setIsCreatingNew(false)
                  }}
                  className={`w-full flex items-center justify-between p-2.5 rounded-lg border text-left tactile-btn cursor-pointer ${
                    isSelected
                      ? 'border-[#1D4ED8] bg-blue-50/50 text-[#1D4ED8]'
                      : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Folder
                      className={`w-4 h-4 ${isSelected ? 'text-[#1D4ED8]' : 'text-slate-400'}`}
                    />
                    <span className="text-[13px] font-medium">{folder.name}</span>
                  </div>
                  {isSelected && <Check className="w-4 h-4 text-[#1D4ED8]" />}
                </button>
              )
            })}
          </div>

          <div className="pt-2">
            {!isCreatingNew ? (
              <button
                type="button"
                onClick={() => setIsCreatingNew(true)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1D4ED8] hover:underline tactile-btn cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                <span>+ Create new folder</span>
              </button>
            ) : (
              <div className="space-y-2 p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                <input
                  type="text"
                  autoFocus
                  placeholder="New folder name..."
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  className="w-full text-base sm:text-xs px-2.5 py-1.5 bg-white border border-[#D1D9E4] rounded focus:outline-none focus:border-[#1D4ED8]"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsCreatingNew(false)}
                    className="text-xs text-slate-500 hover:text-slate-700 tactile-btn cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg tactile-btn cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-4 py-1.5 bg-[#1D4ED8] hover:bg-[#1E40AF] text-white text-xs font-semibold rounded-lg shadow-xs tactile-btn cursor-pointer"
          >
            Save File
          </button>
        </div>
      </div>
    </div>
  )
}

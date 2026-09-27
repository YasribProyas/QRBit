import { useState } from 'react'
import {
  ArrowLeft,
  Send,
  Plus,
  Edit2,
  Check,
  Layers,
} from 'lucide-react'
import { BlockItem } from './BlockItem'
import { AddBlockModal } from './AddBlockModal'
import type { BlockType, FileBlock, LibraryFile, LibraryFolder } from '../../lib/library'

export interface FileEditViewProps {
  file: LibraryFile
  onBack: () => void
  onSaveFile: (file: LibraryFile) => void
  onSendFile: (file: LibraryFile) => void
  folders: LibraryFolder[]
}

export function FileEditView({
  file,
  onBack,
  onSaveFile,
  onSendFile,
}: FileEditViewProps) {
  const [fileName, setFileName] = useState(file.name)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [blocks, setBlocks] = useState<FileBlock[]>(file.blocks || [])
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)

  // Reordering blocks
  const handleMoveUp = (index: number) => {
    if (index <= 0) return
    const next = [...blocks]
    const moved = next.splice(index, 1)[0]
    if (moved) {
      next.splice(index - 1, 0, moved)
      setBlocks(next)
      onSaveFile({ ...file, name: fileName, blocks: next })
    }
  }

  const handleMoveDown = (index: number) => {
    if (index >= blocks.length - 1) return
    const next = [...blocks]
    const moved = next.splice(index, 1)[0]
    if (moved) {
      next.splice(index + 1, 0, moved)
      setBlocks(next)
      onSaveFile({ ...file, name: fileName, blocks: next })
    }
  }

  const handleUpdateBlock = (blockId: string, changes: Partial<FileBlock>) => {
    const updated = blocks.map((b) => (b.id === blockId ? { ...b, ...changes } : b))
    setBlocks(updated)
    onSaveFile({ ...file, name: fileName, blocks: updated })
  }

  const handleDeleteBlock = (blockId: string) => {
    const updated = blocks.filter((b) => b.id !== blockId)
    setBlocks(updated)
    onSaveFile({ ...file, name: fileName, blocks: updated })
  }

  const handleDuplicateBlock = (blockId: string) => {
    const item = blocks.find((b) => b.id === blockId)
    if (!item) return
    const copy: FileBlock = {
      ...item,
      id: `b-${Date.now()}`,
      content: item.content ? `${item.content} (Copy)` : undefined,
    }
    const index = blocks.findIndex((b) => b.id === blockId)
    const updated = [...blocks]
    updated.splice(index + 1, 0, copy)
    setBlocks(updated)
    onSaveFile({ ...file, name: fileName, blocks: updated })
  }

  const handleAddBlockType = (type: BlockType) => {
    const newBlockId = `b-${Date.now()}`
    const newBlock: FileBlock = { id: newBlockId, type }

    switch (type) {
      case 'heading':
        newBlock.content = 'New Section Heading'
        break
      case 'shortText':
        newBlock.label = 'Key'
        newBlock.value = 'Value'
        break
      case 'richText':
        newBlock.content = 'New documentation or notes...'
        break
      case 'image':
        newBlock.fileName = 'attachment_photo.png'
        newBlock.caption = 'Telemetry capture'
        break
      case 'fileAttachment':
        newBlock.fileName = 'data_export.bin'
        newBlock.fileSize = '2.4 MB'
        break
      case 'locked':
        newBlock.label = 'Encrypted Key'
        newBlock.content = 'sec_k982_token_payload'
        newBlock.password = 'pass'
        newBlock.isLocked = true
        newBlock.isUnlocked = false
        break
      case 'divider':
        break
    }

    const updated = [...blocks, newBlock]
    setBlocks(updated)
    onSaveFile({ ...file, name: fileName, blocks: updated })
  }

  const handleTitleSubmit = () => {
    setIsEditingTitle(false)
    onSaveFile({ ...file, name: fileName, blocks })
  }

  const handleUnlockCredential = (blockId: string) => {
    handleUpdateBlock(blockId, { isUnlocked: true })
  }

  return (
    <div className="flex flex-col min-h-full pb-14">
      {/* Top Bar: Back, Editable Title, Send File Button */}
      <header className="px-4 py-3 bg-white border-b border-[#D1D9E4] flex items-center justify-between sticky top-0 z-30 shadow-2xs">
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <button
            type="button"
            onClick={onBack}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors tactile-btn cursor-pointer"
            title="Return to library"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          {/* Editable Inline Title */}
          <div className="min-w-0 flex-1">
            {isEditingTitle ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  onBlur={handleTitleSubmit}
                  onKeyDown={(e) => e.key === 'Enter' && handleTitleSubmit()}
                  className="w-full font-display font-bold text-base text-[#0F172A] bg-slate-50 border border-[#1D4ED8] rounded px-2 py-0.5 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleTitleSubmit}
                  className="p-1 text-emerald-600 hover:bg-emerald-50 rounded cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div
                onClick={() => setIsEditingTitle(true)}
                className="group flex items-center gap-1.5 cursor-pointer py-0.5 rounded hover:bg-slate-50 transition-colors max-w-fit"
                title="Click to rename"
              >
                <h2 className="font-display font-bold text-base text-[#0F172A] truncate">
                  {fileName}
                </h2>
                <Edit2 className="w-3.5 h-3.5 text-slate-400 group-hover:text-[#1D4ED8] shrink-0 transition-colors" />
              </div>
            )}
          </div>
        </div>

        {/* Send File CTA */}
        <button
          type="button"
          onClick={() => onSendFile({ ...file, name: fileName, blocks })}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[#1D4ED8] hover:bg-[#1E40AF] text-white text-xs font-semibold rounded-lg shadow-xs tactile-btn shrink-0 cursor-pointer"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send File</span>
        </button>
      </header>

      {/* Main Content: Ordered List of Blocks */}
      <main className="flex-1 px-4 py-5 max-w-xl mx-auto w-full space-y-4">
        {/* Meta pill bar */}
        <div className="flex items-center justify-between px-2 text-xs text-[#5B6B82]">
          <span className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-slate-400" />
            <span>
              {blocks.length} {blocks.length === 1 ? 'block' : 'blocks'} in payload
            </span>
          </span>
          <span className="text-[11px] font-mono text-slate-400">
            Drag handle or arrows to reorder
          </span>
        </div>

        {/* Blocks list */}
        <div className="space-y-3">
          {blocks.map((block, index) => (
            <BlockItem
              key={block.id}
              block={block}
              index={index}
              totalBlocks={blocks.length}
              mode="edit"
              onUpdate={handleUpdateBlock}
              onDelete={handleDeleteBlock}
              onDuplicate={handleDuplicateBlock}
              onMoveUp={handleMoveUp}
              onMoveDown={handleMoveDown}
              onUnlockCredential={handleUnlockCredential}
            />
          ))}
        </div>

        {/* Add Block Row / Button at bottom */}
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setIsAddModalOpen(true)}
            className="w-full py-3 border-2 border-dashed border-[#D1D9E4] hover:border-[#1D4ED8] hover:bg-blue-50/30 rounded-xl flex items-center justify-center gap-2 text-xs font-semibold text-[#1D4ED8] transition-all tactile-btn cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Block to Dossier</span>
          </button>
        </div>
      </main>

      {/* Block Type Picker Modal */}
      <AddBlockModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSelectType={handleAddBlockType}
      />
    </div>
  )
}

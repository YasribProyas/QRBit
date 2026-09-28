import { useState } from 'react'
import {
  PowerOff,
  Plus,
  SendHorizontal,
} from 'lucide-react'
import type { UseSessionResult } from '../../hooks/useSession'
import type { BlockType, FileBlock, LibraryFile } from '../../lib/library'
import { useSessionStore } from '../../store/sessionStore'
import { BlockItem } from '../library/BlockItem'
import { AddBlockModal } from '../library/AddBlockModal'

export interface SenderSessionViewProps {
  session: UseSessionResult
  sessionFile?: LibraryFile | null
  peerName?: string
  onEndSession: () => void
}

export function SenderSessionView({
  session,
  sessionFile,
  peerName = 'Receiver Workstation',
  onEndSession,
}: SenderSessionViewProps) {
  const [blocks, setBlocks] = useState<FileBlock[]>(sessionFile?.blocks || [])
  const [isAddBlockOpen, setIsAddBlockOpen] = useState(false)

  const handleAddBlock = (type: BlockType) => {
    const newId = `b-${Date.now()}`
    const newBlock: FileBlock = { id: newId, type }

    switch (type) {
      case 'heading':
        newBlock.content = 'Ad-hoc Section Heading'
        session.addTextItem('# Ad-hoc Section Heading')
        break
      case 'shortText':
        newBlock.label = 'Ad-hoc Key'
        newBlock.value = 'adhoc-value'
        session.addTextItem('Ad-hoc Key: adhoc-value')
        break
      case 'richText':
        newBlock.content = 'Ad-hoc note dispatched mid-session.'
        session.addTextItem('Ad-hoc note dispatched mid-session.')
        break
      case 'locked':
        newBlock.label = 'Temporary Token'
        newBlock.content = 'temp_token_sec'
        newBlock.password = 'pass'
        newBlock.isLocked = true
        newBlock.isUnlocked = false
        void session.addLockedItem({
          label: 'Temporary Token',
          innerType: 'text',
          password: 'pass',
          content: 'temp_token_sec',
        })
        break
      case 'divider':
        break
      case 'image':
      case 'fileAttachment':
        break
    }

    setBlocks((prev) => [...prev, newBlock])
  }

  const safetyWords = session.safetyPhrase || ['COBALT', 'TIMBER', 'FALCON']
  const sessionItems = useSessionStore((state) => state.items)
  const sentCount = sessionItems.filter((i) => i.status === 'complete').length
  const allCount = Math.max(blocks.length, sessionItems.length)

  return (
    <div className="session-board flex flex-col min-h-screen bg-[#EEF2F6] pb-14 text-[#0F172A]">
      {/* Session Active Top Header */}
      <header className="px-4 py-3 bg-[#0F172A] text-white sticky top-0 z-30 shadow-md">
        <div className="flex items-center justify-between pb-2 border-b border-slate-700/60">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-radar-ping" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display font-bold text-sm text-white">Active Channel</span>
                <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/80 px-1.5 py-0.5 rounded border border-emerald-800">
                  {sentCount} / {allCount} sent
                </span>
              </div>
              <p className="text-[11px] text-slate-300 truncate max-w-[200px]">Peer: {peerName}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={onEndSession}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600/90 hover:bg-red-600 text-white text-xs font-semibold rounded-lg transition-colors tactile-btn cursor-pointer"
          >
            <PowerOff className="w-3.5 h-3.5" />
            <span>End Session</span>
          </button>
        </div>

        {/* 3 Verification Words for reference */}
        <div className="pt-2 flex items-center justify-between text-xs">
          <span className="text-[11px] text-slate-400 font-mono">Verification:</span>
          <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-sky-400">
            {safetyWords.map((w) => (
              <span key={w} className="px-1.5 py-0.5 bg-slate-800/80 rounded border border-slate-700 uppercase">
                {w}
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 px-4 py-5 max-w-xl mx-auto w-full space-y-5">
        {/* File Container Title */}
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <SendHorizontal className="w-4 h-4 text-[#1D4ED8]" />
            <div>
              <h2 className="font-display font-bold text-base text-[#0F172A]">
                {sessionFile?.name || 'Active Transmitting Dossier'}
              </h2>
              <p className="text-xs text-[#5B6B82]">Streaming data blocks over air-gap WebRTC channel</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsAddBlockOpen(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border border-[#D1D9E4] hover:border-[#1D4ED8] hover:text-[#1D4ED8] text-slate-700 text-xs font-semibold rounded-lg shadow-2xs tactile-btn cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Block</span>
          </button>
        </div>

        {/* Blocks streaming view */}
        <div className="space-y-3">
          {blocks.length === 0 ? (
            <div className="bg-white rounded-xl border border-[#D1D9E4] p-8 text-center text-slate-400">
              <p className="text-sm font-medium text-slate-700">Ready to transfer</p>
              <p className="text-xs mt-1">Tap "+ Add Block" to compose entities on the live channel.</p>
            </div>
          ) : (
            blocks.map((block, idx) => (
              <BlockItem
                key={block.id}
                block={block}
                index={idx}
                totalBlocks={blocks.length}
                mode="sender"
                transferStatus={idx < sentCount ? 'sent' : 'in_progress'}
                transferProgress={idx < sentCount ? 100 : 75}
              />
            ))
          )}
        </div>
      </main>

      {/* Add Block Modal */}
      <AddBlockModal
        isOpen={isAddBlockOpen}
        onClose={() => setIsAddBlockOpen(false)}
        onSelectType={handleAddBlock}
      />
    </div>
  )
}

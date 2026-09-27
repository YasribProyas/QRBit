import {
  Heading,
  Type,
  AlignLeft,
  Image,
  Paperclip,
  KeyRound,
  Minus,
  X,
} from 'lucide-react'
import type { BlockType } from '../../lib/library'

export interface AddBlockModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectType: (type: BlockType) => void
}

const BLOCK_DEFINITIONS: {
  type: BlockType
  name: string
  desc: string
  icon: typeof Heading
  color: string
}[] = [
  {
    type: 'heading',
    name: 'Section Heading',
    desc: 'Primary title or topical header',
    icon: Heading,
    color: 'text-blue-600 bg-blue-50',
  },
  {
    type: 'shortText',
    name: 'Short Text Pair',
    desc: 'Key-value or labeled single-line string',
    icon: Type,
    color: 'text-indigo-600 bg-indigo-50',
  },
  {
    type: 'richText',
    name: 'Rich Text / Notes',
    desc: 'Multiline formatted markdown or documentation',
    icon: AlignLeft,
    color: 'text-teal-600 bg-teal-50',
  },
  {
    type: 'image',
    name: 'Image Payload',
    desc: 'Sensor schematic, diagram or screenshot',
    icon: Image,
    color: 'text-amber-600 bg-amber-50',
  },
  {
    type: 'fileAttachment',
    name: 'File Attachment',
    desc: 'Binary payload, yaml config, or dataset',
    icon: Paperclip,
    color: 'text-violet-600 bg-violet-50',
  },
  {
    type: 'locked',
    name: 'Locked Credential',
    desc: 'Password-encrypted secret or private key',
    icon: KeyRound,
    color: 'text-orange-600 bg-orange-50',
  },
  {
    type: 'divider',
    name: 'Divider Line',
    desc: 'Visual separator between blocks',
    icon: Minus,
    color: 'text-slate-600 bg-slate-100',
  },
]

export function AddBlockModal({ isOpen, onClose, onSelectType }: AddBlockModalProps) {
  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-xs transition-opacity duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white rounded-t-2xl sm:rounded-xl border border-[#D1D9E4] shadow-2xl p-5 modal-enter"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div>
            <h3 className="font-display font-bold text-base text-[#0F172A]">Insert Block</h3>
            <p className="text-xs text-[#5B6B82]">Select a block type to append to this dossier</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors tactile-btn cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-2 pt-3 max-h-[60vh] overflow-y-auto scroll-contain">
          {BLOCK_DEFINITIONS.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.type}
                type="button"
                onClick={() => {
                  onSelectType(item.type)
                  onClose()
                }}
                className="w-full flex items-center gap-3 p-2.5 rounded-lg border border-transparent hover:border-[#D1D9E4] hover:bg-slate-50 text-left group tactile-btn cursor-pointer"
              >
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center ${item.color} shrink-0`}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[13px] text-[#0F172A] group-hover:text-[#1D4ED8]">
                    {item.name}
                  </div>
                  <div className="text-[11.5px] text-[#5B6B82] truncate">{item.desc}</div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

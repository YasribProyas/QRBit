import { useState } from 'react'
import {
  GripVertical,
  Lock,
  Unlock,
  KeyRound,
  FileCode,
  Download,
  UploadCloud,
  Trash2,
  Copy,
  ChevronUp,
  ChevronDown,
  CheckCircle2,
  Clock,
  Loader2,
  Shield,
  Tag,
} from 'lucide-react'
import type { FileBlock } from '../../lib/library'
import { decryptItem, encryptItem } from '../../lib/crypto'
import type { ReorderHandleProps } from '../../hooks/useReorderDrag'

export interface BlockItemProps {
  block: FileBlock
  index: number
  totalBlocks: number
  mode?: 'edit' | 'sender' | 'receiver'
  transferStatus?: 'pending' | 'in_progress' | 'sent'
  transferProgress?: number
  onUpdate?: (id: string, changes: Partial<FileBlock>) => void
  onDelete?: (id: string) => void
  onDuplicate?: (id: string) => void
  /**
   * The keyboard/accessible twin of the grip drag (ORCHESTRATION D16.3). Both this and
   * `reorderHandleProps` are wired by the editor to ONE reorder reducer, so a click on an
   * arrow and a released drag cannot drift apart.
   */
  onMoveUp?: (index: number) => void
  onMoveDown?: (index: number) => void
  onUnlockCredential?: (id: string, plaintextContent: string) => void
  /**
   * Props from `useReorderDrag().getHandleProps(index)`, spread onto the grip. The grip is a
   * real `<button>` because that is what the hook needs: pointer down starts the drag, and
   * ArrowUp/ArrowDown/Home/End on it are the keyboard path. Omitted = no grip rendered.
   */
  reorderHandleProps?: ReorderHandleProps
  /** True while THIS row is the one under the pointer; it is the row that gets translated. */
  isReorderDragging?: boolean
  /** Pixels the grabbed row sits below its normal position. Only read while dragging. */
  reorderOffset?: number
}

export function BlockItem({
  block,
  index,
  totalBlocks,
  mode = 'edit',
  transferStatus = 'sent',
  transferProgress = 100,
  onUpdate,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onUnlockCredential,
  reorderHandleProps,
  isReorderDragging = false,
  reorderOffset = 0,
}: BlockItemProps) {
  const [passwordInput, setPasswordInput] = useState('')
  const [unlockError, setUnlockError] = useState(false)
  const [showUnlockModal, setShowUnlockModal] = useState(false)
  const [isDecrypting, setIsDecrypting] = useState(false)

  // Per-block Lock with Password Modal
  const [showLockConfigModal, setShowLockConfigModal] = useState(false)
  const [newLockPassword, setNewLockPassword] = useState('')
  const [isEncrypting, setIsEncrypting] = useState(false)

  // Every edit-mode row is a measured reorder item, grip or no grip: the hook counts those
  // markers to index a drag, so the set of them has to be the whole list.
  const isReorderRow = mode === 'edit'

  /** The grabbed row is painted at the pointer, above its neighbours, and nothing else moves. */
  const dragStyle = isReorderDragging
    ? { transform: `translateY(${reorderOffset}px)`, zIndex: 1 }
    : undefined

  /** The grip, rendered only when the editor handed this row a drag handle (D16.2). */
  const grip =
    isReorderRow && reorderHandleProps !== undefined ? (
      <button
        {...reorderHandleProps}
        className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded p-0.5 tactile-btn"
      >
        <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    ) : null

  const handleUnlockSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setIsDecrypting(true)
    setUnlockError(false)

    try {
      if (block.lockedData) {
        const { ciphertext, iv, salt } = block.lockedData
        const rawCipher =
          typeof ciphertext === 'string'
            ? new TextEncoder().encode(ciphertext)
            : ciphertext
        const rawIv =
          typeof iv === 'string' ? new TextEncoder().encode(iv) : iv
        const rawSalt =
          typeof salt === 'string' ? new TextEncoder().encode(salt) : salt

        const decrypted = await decryptItem(passwordInput, rawSalt, rawIv, rawCipher)
        const plainText = new TextDecoder().decode(decrypted)

        onUpdate?.(block.id, { isUnlocked: true, content: plainText })
        onUnlockCredential?.(block.id, plainText)
        setIsDecrypting(false)
        setShowUnlockModal(false)
        setPasswordInput('')
        return
      }

      // Check against stored password or mock default
      const expectedPassword = block.password || 'pass'
      if (passwordInput === expectedPassword || passwordInput === 'pass') {
        const secret = block.content || 'sys_x94#kK99!Alpha2'
        onUpdate?.(block.id, { isUnlocked: true })
        onUnlockCredential?.(block.id, secret)
        setIsDecrypting(false)
        setShowUnlockModal(false)
        setPasswordInput('')
      } else {
        setIsDecrypting(false)
        setUnlockError(true)
      }
    } catch {
      setIsDecrypting(false)
      setUnlockError(true)
    }
  }

  const handleSetLockPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newLockPassword.trim()) return

    setIsEncrypting(true)
    try {
      const plaintext = block.content || block.value || ''
      const enc = await encryptItem(
        newLockPassword,
        new TextEncoder().encode(plaintext),
      )

      onUpdate?.(block.id, {
        isLocked: true,
        password: newLockPassword,
        lockedData: {
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          salt: enc.salt,
        },
        isUnlocked: false,
      })

      setShowLockConfigModal(false)
      setNewLockPassword('')
    } finally {
      setIsEncrypting(false)
    }
  }

  const handleRemoveLock = () => {
    onUpdate?.(block.id, {
      isLocked: false,
      password: undefined,
      lockedData: undefined,
      isUnlocked: true,
    })
    setShowLockConfigModal(false)
  }

  // Render Transfer Status Pill for session screens
  const renderStatusPill = () => {
    if (mode !== 'sender' && mode !== 'receiver') return null

    if (transferStatus === 'pending') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
          <Clock className="w-3 h-3 text-slate-400" />
          <span>Pending</span>
        </span>
      )
    }

    if (transferStatus === 'in_progress') {
      return (
        <div className="flex items-center gap-2">
          <div className="w-20 h-1.5 bg-blue-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#1D4ED8] rounded-full transition-all duration-300"
              style={{ width: `${transferProgress}%` }}
            />
          </div>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-[#1D4ED8] border border-blue-200">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{Math.round(transferProgress)}%</span>
          </span>
        </div>
      )
    }

    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
        <span>Delivered</span>
      </span>
    )
  }

  // DIVIDER BLOCK
  if (block.type === 'divider') {
    return (
      <div
        className="group relative my-3 flex items-center gap-2"
        data-reorder-item={isReorderRow ? '' : undefined}
        style={dragStyle}
      >
        {grip !== null ? <span className="shrink-0">{grip}</span> : null}
        {mode === 'edit' && (
          <div className="absolute -left-8 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={() => onDelete?.(block.id)}
              className="p-1 text-slate-400 hover:text-red-600 rounded tactile-btn cursor-pointer"
              title="Delete divider"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <div className="w-full flex items-center gap-3">
          <div className="h-[1px] flex-1 bg-[#D1D9E4]" />
          <span className="text-[10px] tracking-wider text-slate-400 font-mono select-none">
            DIVIDER
          </span>
          <div className="h-[1px] flex-1 bg-[#D1D9E4]" />
        </div>
        {renderStatusPill()}
      </div>
    )
  }

  return (
    <div
      className={`group relative bg-white rounded-lg border transition-all ${
        block.isLocked
          ? 'border-[#C2410C]/40 bg-orange-50/15'
          : 'border-[#D1D9E4]'
      } hover:border-[#94A3B8] shadow-2xs ${isReorderDragging ? 'shadow-md' : ''}`}
      data-reorder-item={isReorderRow ? '' : undefined}
      style={dragStyle}
    >
      {/* Header bar of block */}
      <div className="px-3.5 pt-2.5 pb-1.5 flex items-center justify-between border-b border-slate-100">
        <div className="flex items-center gap-2">
          {grip !== null ? <span className="shrink-0">{grip}</span> : null}
          <span className="text-[11px] font-mono font-medium text-[#5B6B82] uppercase">
            {block.type === 'shortText' ? 'Short Text' : block.type}
          </span>

          {/* Locked status pill */}
          {block.isLocked && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-100 text-[#C2410C]">
              <Lock className="w-2.5 h-2.5" />
              <span>Locked Payload</span>
            </span>
          )}

          {/* Label tag indicator if entity has a label */}
          {block.label && block.type !== 'shortText' && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-700">
              <Tag className="w-2.5 h-2.5 text-slate-400" />
              <span>{block.label}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {renderStatusPill()}

          {mode === 'edit' && (
            <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
              {/* Lock / Unlock Toggle Button */}
              <button
                type="button"
                onClick={() => setShowLockConfigModal(true)}
                className={`p-1 rounded tactile-btn cursor-pointer ${
                  block.isLocked
                    ? 'text-[#C2410C] hover:bg-orange-50'
                    : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                }`}
                title={block.isLocked ? 'Manage password lock' : 'Lock this entity with password'}
              >
                {block.isLocked ? <Lock className="w-3.5 h-3.5" /> : <Shield className="w-3.5 h-3.5" />}
              </button>

              <button
                type="button"
                onClick={() => onMoveUp?.(index)}
                disabled={index === 0}
                className="p-1 text-slate-500 hover:text-slate-800 disabled:opacity-30 rounded tactile-btn cursor-pointer"
                title="Move up"
                aria-label={`Move ${block.type} block up`}
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onMoveDown?.(index)}
                disabled={index === totalBlocks - 1}
                className="p-1 text-slate-500 hover:text-slate-800 disabled:opacity-30 rounded tactile-btn cursor-pointer"
                title="Move down"
                aria-label={`Move ${block.type} block down`}
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDuplicate?.(block.id)}
                className="p-1 text-slate-500 hover:text-slate-800 rounded tactile-btn cursor-pointer"
                title="Duplicate block"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDelete?.(block.id)}
                className="p-1 text-slate-500 hover:text-red-600 rounded tactile-btn cursor-pointer"
                title="Delete block"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main Content Area based on block type */}
      <div className="p-3.5 space-y-2">
        {/* Optional Label field for entities when editing (User can choose to set label for each entity) */}
        {mode === 'edit' && block.type !== 'shortText' && (
          <div className="flex items-center gap-2 pb-1">
            <span className="text-[11px] font-medium text-[#5B6B82] w-12 shrink-0">Label:</span>
            <input
              type="text"
              value={block.label || ''}
              onChange={(e) => onUpdate?.(block.id, { label: e.target.value })}
              placeholder="Entity label (optional)..."
              className="flex-1 text-xs font-medium text-slate-600 bg-slate-50/70 px-2 py-1 rounded border border-slate-200 focus:outline-none focus:border-[#1D4ED8]"
            />
          </div>
        )}

        {/* HEADING BLOCK */}
        {block.type === 'heading' && (
          <div>
            {mode === 'edit' ? (
              <input
                type="text"
                value={block.content || ''}
                onChange={(e) => onUpdate?.(block.id, { content: e.target.value })}
                placeholder="Enter section heading..."
                className="w-full font-display text-lg font-bold text-[#0F172A] bg-transparent border-0 border-b border-transparent focus:border-[#1D4ED8] focus:outline-none pb-0.5"
              />
            ) : (
              <h3 className="font-display text-lg font-bold text-[#0F172A]">{block.content}</h3>
            )}
          </div>
        )}

        {/* SHORT TEXT BLOCK */}
        {block.type === 'shortText' && (
          <div className="space-y-1.5">
            {mode === 'edit' ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-[#5B6B82] w-12 shrink-0">Label:</span>
                  <input
                    type="text"
                    value={block.label || ''}
                    onChange={(e) => onUpdate?.(block.id, { label: e.target.value })}
                    placeholder="Field label..."
                    className="flex-1 text-xs font-medium text-slate-600 bg-slate-50 px-2 py-1 rounded border border-slate-200 focus:outline-none focus:border-[#1D4ED8]"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-[#5B6B82] w-12 shrink-0">Value:</span>
                  <input
                    type="text"
                    value={block.value || ''}
                    onChange={(e) => onUpdate?.(block.id, { value: e.target.value })}
                    placeholder="Single-line value..."
                    className="flex-1 font-mono text-xs text-[#0F172A] bg-white px-2 py-1 rounded border border-[#D1D9E4] focus:outline-none focus:border-[#1D4ED8]"
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                <span className="text-[12px] font-medium text-[#5B6B82]">{block.label}</span>
                <span className="font-mono text-[13px] text-[#0F172A] bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                  {block.value}
                </span>
              </div>
            )}
          </div>
        )}

        {/* RICH TEXT BLOCK */}
        {block.type === 'richText' && (
          <div>
            {mode === 'edit' ? (
              <textarea
                rows={3}
                value={block.content || ''}
                onChange={(e) => onUpdate?.(block.id, { content: e.target.value })}
                placeholder="Write formatted notes or documentation..."
                className="w-full text-xs leading-relaxed text-[#0F172A] bg-slate-50/50 p-2.5 rounded border border-[#D1D9E4] focus:outline-none focus:border-[#1D4ED8] focus:bg-white resize-y"
              />
            ) : (
              <p className="text-[13.5px] leading-relaxed text-[#0F172A] whitespace-pre-line">
                {block.content}
              </p>
            )}
          </div>
        )}

        {/* IMAGE BLOCK */}
        {block.type === 'image' && (
          <div className="space-y-2">
            <div className="relative aspect-video max-h-48 w-full bg-[#0F172A] rounded-md overflow-hidden border border-[#D1D9E4] flex flex-col items-center justify-center p-4">
              <svg className="w-full h-full max-h-36 opacity-85" viewBox="0 0 400 160" fill="none">
                <rect
                  x="10"
                  y="10"
                  width="380"
                  height="140"
                  rx="4"
                  stroke="#334155"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
                <circle cx="100" cy="80" r="36" stroke="#2563EB" strokeWidth="2" fill="#1E3A8A" fillOpacity="0.2" />
                <circle cx="300" cy="80" r="36" stroke="#059669" strokeWidth="2" fill="#065F46" fillOpacity="0.2" />
                <path d="M136 80 H264" stroke="#94A3B8" strokeWidth="1.5" strokeDasharray="3 3" />
                <path d="M200 40 V120" stroke="#F59E0B" strokeWidth="1.5" />
                <circle cx="200" cy="80" r="6" fill="#F59E0B" />
                <text x="100" y="84" fill="#93C5FD" fontSize="11" textAnchor="middle" fontFamily="monospace">
                  CAM_01
                </text>
                <text x="300" y="84" fill="#6EE7B7" fontSize="11" textAnchor="middle" fontFamily="monospace">
                  LIDAR_A
                </text>
                <text x="200" y="138" fill="#CBD5E1" fontSize="10" textAnchor="middle" fontFamily="monospace">
                  OFFSET: Δ120mm
                </text>
              </svg>

              {transferStatus === 'in_progress' && (
                <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex flex-col items-center justify-center p-6">
                  <span className="text-white text-xs font-mono mb-2">
                    Streaming image data... {Math.round(transferProgress)}%
                  </span>
                  <div className="w-48 h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all"
                      style={{ width: `${transferProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between text-xs text-[#5B6B82] pt-1">
              <span className="font-mono text-slate-800 font-medium">
                {block.fileName || 'image_attachment.png'}
              </span>
              <span>{block.caption || '1920×1080 · 412 KB'}</span>
            </div>
          </div>
        )}

        {/* FILE ATTACHMENT BLOCK */}
        {block.type === 'fileAttachment' && (
          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-md border border-[#D1D9E4]">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded bg-white border border-[#D1D9E4] flex items-center justify-center text-[#1D4ED8] shrink-0">
                <FileCode className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-mono font-medium text-[#0F172A] truncate">
                  {block.fileName || 'file_attachment.bin'}
                </p>
                <p className="text-[11px] text-[#5B6B82]">{block.fileSize || 'Unknown size'}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {mode === 'edit' ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#1D4ED8] bg-white border border-[#D1D9E4] rounded hover:bg-blue-50 tactile-btn cursor-pointer"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>Replace</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => alert(`Saved ${block.fileName} to local sandbox.`)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-[#D1D9E4] rounded hover:bg-slate-100 tactile-btn cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Save</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* LOCKED BLOCK OR LOCKED ENTITY CONTENT */}
        {(block.type === 'locked' || block.isLocked) && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-[#C2410C] flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" />
                <span>{block.label || 'Protected Secret'}</span>
              </span>

              {mode === 'edit' && (
                <span className="text-[11px] text-slate-500 font-mono">
                  Passphrase: {block.password ? '••••••••' : '(set)'}
                </span>
              )}
            </div>

            {/* Credential Content (Hidden behind blur or revealed) */}
            <div className="relative rounded-md border border-[#D1D9E4] bg-slate-900 text-slate-100 p-3 overflow-hidden font-mono text-[13px]">
              {block.isUnlocked ? (
                <div
                  className="flex items-center justify-between transition-all duration-200"
                  style={{
                    filter: isDecrypting ? 'blur(2px)' : 'none',
                  }}
                >
                  <span className="text-emerald-400 select-all">{block.content}</span>
                  <span className="text-[11px] text-slate-400 px-1.5 py-0.5 bg-slate-800 rounded">
                    Unlocked
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="filter blur-sm select-none opacity-60">
                    sys_x94#kK99!Alpha2_protected_vault
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowUnlockModal(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#C2410C] hover:bg-[#9A3412] text-white text-xs font-semibold rounded shadow-xs tactile-btn cursor-pointer"
                  >
                    <Unlock className="w-3.5 h-3.5" />
                    <span>Unlock</span>
                  </button>
                </div>
              )}
            </div>

            {/* Inline unlock form modal */}
            {showUnlockModal && !block.isUnlocked && (
              <form
                onSubmit={handleUnlockSubmit}
                className="modal-enter p-3 bg-white border border-[#C2410C] rounded-md shadow-md mt-2 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-800">
                    Enter Decryption Key for "{block.label || 'Protected Secret'}"
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowUnlockModal(false)}
                    className="text-xs text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    autoFocus
                    placeholder="Enter password (hint: pass)"
                    value={passwordInput}
                    onChange={(e) => {
                      setPasswordInput(e.target.value)
                      setUnlockError(false)
                    }}
                    className={`flex-1 text-xs px-2.5 py-1.5 rounded border ${
                      unlockError ? 'border-red-500 bg-red-50' : 'border-[#D1D9E4]'
                    } focus:outline-none focus:border-[#1D4ED8]`}
                  />
                  <button
                    type="submit"
                    disabled={isDecrypting}
                    className="px-3.5 py-1.5 bg-[#1D4ED8] hover:bg-blue-700 text-white text-xs font-semibold rounded tactile-btn cursor-pointer"
                  >
                    {isDecrypting ? 'Decrypting...' : 'Decrypt'}
                  </button>
                </div>
                {unlockError && (
                  <p className="text-[11px] text-red-600">Incorrect password. Please try again.</p>
                )}
              </form>
            )}
          </div>
        )}

        {/* Lock Configuration Modal (Allows locking any entity with custom password) */}
        {showLockConfigModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs"
            onClick={() => setShowLockConfigModal(false)}
          >
            <div
              className="w-full max-w-sm bg-white rounded-xl border border-[#D1D9E4] shadow-2xl p-5 modal-enter"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="font-display font-bold text-sm text-[#0F172A] mb-1">
                {block.isLocked ? 'Entity Encryption Settings' : 'Lock Entity with Password'}
              </h3>
              <p className="text-xs text-[#5B6B82] mb-3">
                {block.isLocked
                  ? 'This entity is currently protected with AES-256-GCM.'
                  : 'Protect this entity with Web Crypto PBKDF2 + AES-256-GCM. Each entity can have a distinct password.'}
              </p>

              {!block.isLocked ? (
                <form onSubmit={handleSetLockPassword} className="space-y-3">
                  <div>
                    <label className="text-[11px] font-semibold text-slate-700 block mb-1">
                      Set Password for this Entity:
                    </label>
                    <input
                      type="password"
                      autoFocus
                      required
                      placeholder="Enter a password..."
                      value={newLockPassword}
                      onChange={(e) => setNewLockPassword(e.target.value)}
                      className="w-full text-xs px-2.5 py-1.5 rounded border border-[#D1D9E4] focus:outline-none focus:border-[#1D4ED8]"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowLockConfigModal(false)}
                      className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg tactile-btn cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isEncrypting}
                      className="px-3.5 py-1.5 bg-[#C2410C] hover:bg-[#9A3412] text-white text-xs font-semibold rounded-lg tactile-btn cursor-pointer"
                    >
                      {isEncrypting ? 'Encrypting...' : 'Lock Entity'}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-slate-600 bg-orange-50 p-2.5 rounded border border-orange-200">
                    Locked entities require entering this entity's password to reveal.
                  </p>
                  <div className="flex justify-between items-center pt-2">
                    <button
                      type="button"
                      onClick={handleRemoveLock}
                      className="text-xs text-red-600 hover:underline tactile-btn cursor-pointer"
                    >
                      Remove Lock
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowLockConfigModal(false)}
                      className="px-3.5 py-1.5 bg-slate-900 text-white text-xs font-semibold rounded-lg tactile-btn cursor-pointer"
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The sender's live session screen (PLAN.md §7, §8, §9; ORCHESTRATION D16).
 *
 * This is what the host device shows while a session is active and this side is the sender: the
 * dossier that was queued when the peer joined, plus a bar to put something else on the channel
 * mid-flight.
 *
 * The mid-flight bar used to be the defect. Picking a type *sent invented content immediately* —
 * an invented heading, an invented key/value pair, an invented note, and for a locked item a
 * fabricated token encrypted under the same guessable password every block shared. A product that
 * puts words on the wire nobody typed is not a cosmetic bug, and the invented token was the worst
 * of it: a "secret" whose content and password both came from the source. Nothing is invented here
 * any more, and nothing is sent until the user has written it:
 *
 *   - a text-bearing block opens a compose form; submitting sends **exactly the characters in the
 *     form**, and an empty form is refused with a message rather than a placeholder payload;
 *   - an image or file block opens the same form around a real file input, so the bytes are the
 *     user's choice (`addFileItem`) or nothing is sent;
 *   - a locked block opens `LockedItemComposeModal` — the app's one locked-item composer, with
 *     label, inner type, the password twice (decision D7) and content — and `addLockedItem` does
 *     the PBKDF2 + AES-256-GCM work (PLAN.md §11.4). This file imports no crypto and holds no
 *     password.
 *   - a divider carries no payload, so it says so instead of appending a row that would be
 *     counted as a thing that was sent.
 *
 * Status claims come from the session store now. Each row this screen created remembers the item
 * id the items API returned, so its pill is that item's real `status`; the blocks that arrived
 * with the queued dossier have no such link on this side and therefore show **no** pill, rather
 * than the old index arithmetic (`idx < sentCount ? 'sent' : 'in_progress'`) that announced
 * "Delivered" for whichever rows happened to sit above the count. The header ratio is the same
 * correction: complete items over items, both read from the store.
 *
 * The two honesty fixes in the copy are the other half of why this file changed. `safetyPhrase` is
 * `null` until the keys have been exchanged; rendering `['COBALT', 'TIMBER', 'FALCON']` in its
 * place put three invented verification words under the label the safety phrase exists to earn
 * (PLAN.md §11.6), so it now says the phrase is not available yet. And the channel is
 * end-to-end-encrypted WebRTC over the data connection — P2P when ICE allows it, TURN when it does
 * not (PLAN.md §12) — never an air gap, so the subtitle stopped claiming one.
 */

import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { PowerOff, Plus, SendHorizontal } from 'lucide-react'
import type { UseSessionResult } from '../../hooks/useSession'
import type { BlockType, FileBlock, LibraryFile } from '../../lib/library'
import { useSessionStore } from '../../store/sessionStore'
import type { SessionItem } from '../../store/sessionStore'
import { BlockItem } from '../library/BlockItem'
import { AddBlockModal } from '../library/AddBlockModal'
import { LockedItemComposeModal } from './LockedItemComposeModal'
import type { LockedItemInput } from './LockedItemComposeModal'

export interface SenderSessionViewProps {
  /**
   * The slice of the session this screen drives, declared as a `Pick` so the component's reach is
   * visible in its type: three ways to put something on the channel and the verification words to
   * show. `pages/Home.tsx` hands it the whole `useSession` result.
   */
  session: SenderSessionApi
  sessionFile?: LibraryFile | null
  peerName?: string
  onEndSession: () => void
}

/** What this screen may ask a session to do — and nothing else. */
export type SenderSessionApi = Pick<
  UseSessionResult,
  'addTextItem' | 'addFileItem' | 'addLockedItem' | 'safetyPhrase'
>

/** One row of this screen's board, and the session item behind it when there is one. */
interface SenderRow {
  block: FileBlock
  /** The id the items API returned for what this row sent; `null` for a queued dossier block. */
  itemId: string | null
}

/** The kinds the compose form takes text for. A rich-text item's content is Tiptap JSON, which a
 * one-line form cannot honestly produce, so all three go out as plain text items. */
const TEXT_BLOCK_TYPES: readonly BlockType[] = ['heading', 'shortText', 'richText']

function isTextType(type: BlockType): boolean {
  return TEXT_BLOCK_TYPES.some((candidate) => candidate === type)
}

function isFileType(type: BlockType): boolean {
  return type === 'image' || type === 'fileAttachment'
}

/**
 * The pill a row wears, from the store's own item.
 *
 * `undefined` status means the item id was not on the board (a session that ended underneath the
 * send), which is rendered as no pill at all rather than as a delivery claim.
 */
function pillFor(item: SessionItem | undefined): 'pending' | 'in_progress' | 'sent' | 'error' | undefined {
  if (item === undefined) return undefined
  // The store's vocabulary and the row's are not the same words for the same state, and
  // `'complete'` is not a status a row can render: it is the frame having arrived, which is what
  // "sent" means here.
  if (item.status === 'transferring') return 'in_progress'
  if (item.status === 'complete') return 'sent'
  return item.status
}

export function SenderSessionView({
  session,
  sessionFile,
  peerName = 'Connected peer',
  onEndSession,
}: SenderSessionViewProps) {
  const [rows, setRows] = useState<SenderRow[]>(() =>
    (sessionFile?.blocks ?? []).map((block) => ({ block, itemId: null })),
  )
  const [isAddBlockOpen, setIsAddBlockOpen] = useState(false)
  /** The block type the compose form is filling in; `null` closes the form. */
  const [composing, setComposing] = useState<BlockType | null>(null)
  const [draftText, setDraftText] = useState('')
  const [draftFile, setDraftFile] = useState<File | null>(null)
  /** Why a send was refused, in words the user can act on. Cleared by the next edit. */
  const [composeError, setComposeError] = useState<string | null>(null)
  const [isLockedComposeOpen, setLockedComposeOpen] = useState(false)

  const items = useSessionStore((state) => state.items)

  const handleAddBlock = (type: BlockType): void => {
    setIsAddBlockOpen(false)
    setComposeError(null)
    setDraftText('')
    setDraftFile(null)

    if (type === 'divider') {
      // Nothing to send, so nothing is appended: a divider on a board whose header counts
      // delivered items would be counted as one.
      setComposing(null)
      setComposeError('A divider carries no payload, so there is nothing to send.')
      return
    }

    if (type === 'locked') {
      setComposing(null)
      setLockedComposeOpen(true)
      return
    }

    setComposing(type)
  }

  /**
   * Send what the form holds, or refuse.
   *
   * The item's content is `draftText` itself — no heading marker, no `label: value` scaffold, no
   * default. An empty or whitespace-only form is the refusal case, which is what replaced the
   * auto-sent placeholder.
   */
  const handleSendText = (): void => {
    if (composing === null || !isTextType(composing)) return
    const content = draftText
    if (content.trim() === '') {
      setComposeError('Write what the peer should receive. Nothing was sent.')
      return
    }

    const itemId = session.addTextItem(content)
    if (itemId === '') {
      // `useSession` refuses outside an active session; a row here would claim a send that
      // never reached the wire.
      setComposeError('The session is no longer active, so nothing was sent.')
      return
    }

    setRows((current) => [...current, { block: { id: itemId, type: composing, content }, itemId }])
    closeForm()
  }

  /** Send the file the user chose, through the ordinary chunk pipeline. */
  const handleSendFile = (): void => {
    if (composing === null || !isFileType(composing)) return
    const file = draftFile
    if (file === null) {
      setComposeError('Choose a file first. Nothing was sent.')
      return
    }

    const itemId = session.addFileItem(file)
    if (itemId === '') {
      setComposeError('The session is no longer active, so nothing was sent.')
      return
    }

    const block: FileBlock = {
      id: itemId,
      // The bytes decide the kind, the same way the store's item does: what a camera hands over as
      // `image/*` is an image row, and everything else is an attachment.
      type: file.type.startsWith('image/') ? 'image' : 'fileAttachment',
      fileName: file.name,
      mimeType: file.type,
      // Measured from the file, never typed in.
      fileSize: file.size,
      blob: file,
    }
    setRows((current) => [...current, { block, itemId }])
    closeForm()
  }

  const closeForm = (): void => {
    setComposing(null)
    setDraftText('')
    setDraftFile(null)
    setComposeError(null)
  }

  /**
   * The compose modal's `onAdd`: encrypt and send through the items API, then wear the row that
   * item's real tuple produced.
   *
   * The tuple is read back out of the store because it is the payload that left the device — this
   * component never holds the plaintext, the password, or a copy of anything that would need
   * zeroing (PLAN.md §11.4, §17; AGENTS.md: no session data persisted). Rejects pass straight
   * through to the modal, which is where the reason belongs, and no row is appended.
   */
  const handleAddLockedItem = async (input: LockedItemInput): Promise<string> => {
    const itemId = await session.addLockedItem(input)
    const item = useSessionStore.getState().items.find((candidate) => candidate.id === itemId)

    if (item !== undefined && item.type === 'locked') {
      const block: FileBlock = {
        id: itemId,
        type: 'locked',
        label: item.label,
        isLocked: true,
        isUnlocked: false,
        lockedData: {
          ciphertext: item.ciphertext,
          iv: item.iv,
          salt: item.salt,
          innerType: item.innerType === 'file' ? 'fileAttachment' : 'shortText',
        },
      }
      setRows((current) => [...current, { block, itemId }])
    }

    setLockedComposeOpen(false)
    return itemId
  }

  const completedCount = items.filter((item) => item.status === 'complete').length
  const safetyWords = session.safetyPhrase
  const isFileDialog = composing !== null && isFileType(composing)

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
                  {completedCount} / {items.length} delivered
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

        {/* Verification words, or the honest absence of them (PLAN.md §11.6). */}
        <div className="pt-2 flex items-center justify-between text-xs">
          <span className="text-[11px] text-slate-400 font-mono">Verification:</span>
          {safetyWords === null ? (
            <span className="text-[11px] font-mono text-amber-300" data-safety-phrase="absent">
              not available until both keys are exchanged
            </span>
          ) : (
            <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-sky-400">
              {safetyWords.map((word) => (
                <span key={word} className="px-1.5 py-0.5 bg-slate-800/80 rounded border border-slate-700 uppercase">
                  {word}
                </span>
              ))}
            </div>
          )}
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
                {sessionFile?.name || 'Ad-hoc sends'}
              </h2>
              <p className="text-xs text-[#5B6B82]">
                End-to-end encrypted over the peer data channel
              </p>
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

        {/* The mid-session compose form: text or file, and nothing leaves without being written. */}
        {composing !== null ? (
          <form
            className="bg-white rounded-xl border border-[#D1D9E4] p-3.5 space-y-2.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (isFileDialog) handleSendFile()
              else handleSendText()
            }}
          >
            <p className="text-xs font-semibold text-[#0F172A]">
              {isFileDialog
                ? `Choose the ${composing === 'image' ? 'image' : 'file'} to send`
                : 'Write what the peer should receive'}
            </p>

            {isFileDialog ? (
              <input
                type="file"
                aria-label="File to send"
                accept={composing === 'image' ? 'image/*' : undefined}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setDraftFile(event.currentTarget.files?.[0] ?? null)
                  setComposeError(null)
                }}
                className="w-full text-xs text-[#5B6B82] border border-[#D1D9E4] rounded px-2 py-1.5 bg-slate-50"
              />
            ) : (
              <textarea
                autoFocus
                rows={3}
                aria-label="Text to send"
                value={draftText}
                onChange={(event) => {
                  setDraftText(event.target.value)
                  setComposeError(null)
                }}
                placeholder="Type the message. Nothing is sent until you press Send."
                className="w-full text-xs leading-relaxed text-[#0F172A] bg-slate-50/50 p-2.5 rounded border border-[#D1D9E4] focus:outline-none focus:border-[#1D4ED8] resize-y"
              />
            )}

            {composeError !== null ? (
              <p className="text-[11px] text-red-600" role="alert" data-compose-error="true">
                {composeError}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeForm}
                className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg tactile-btn cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3.5 py-1.5 bg-[#1D4ED8] hover:bg-blue-700 text-white text-xs font-semibold rounded-lg tactile-btn cursor-pointer"
              >
                Send
              </button>
            </div>
          </form>
        ) : null}

        {/* Blocks streaming view */}
        <div className="space-y-3">
          {composeError !== null && composing === null ? (
            <p
              className="text-[11px] text-red-600 px-1"
              role="alert"
              data-compose-error="true"
            >
              {composeError}
            </p>
          ) : null}

          {rows.length === 0 ? (
            <div className="bg-white rounded-xl border border-[#D1D9E4] p-8 text-center text-slate-400">
              <p className="text-sm font-medium text-slate-700">Ready to transfer</p>
              <p className="text-xs mt-1">
                Use &quot;+ Add Block&quot; to compose an item on the live channel. Nothing is sent
                until you write it.
              </p>
            </div>
          ) : (
            rows.map((row, index) => {
              const item = row.itemId === null ? undefined : items.find((candidate) => candidate.id === row.itemId)
              // Only the chunked types report progress (PLAN.md §9); text and locked items go out
              // in one frame, so there is no percentage to draw for them.
              const progress =
                item !== undefined && (item.type === 'image' || item.type === 'file')
                  ? item.progress
                  : 0

              return (
                <BlockItem
                  key={row.block.id}
                  block={row.block}
                  index={index}
                  totalBlocks={rows.length}
                  mode="sender"
                  {...(row.itemId === null ? {} : { transferStatus: pillFor(item) })}
                  transferProgress={progress}
                />
              )
            })
          )}
        </div>
      </main>

      {/* Add Block Modal */}
      <AddBlockModal
        isOpen={isAddBlockOpen}
        onClose={() => setIsAddBlockOpen(false)}
        onSelectType={handleAddBlock}
      />

      {/*
        A locked item goes through the app's one composer (PLAN.md §16 Phase 4, decisions D6 and
        D7): it collects label, inner type, the password twice and the content, refuses an
        over-cap or empty payload before encrypting, and calls `addLockedItem`. Mounted only while
        open, so the draft and the password exist for as long as the user is composing and no
        longer.
      */}
      {isLockedComposeOpen ? (
        <LockedItemComposeModal
          onAdd={handleAddLockedItem}
          onClose={() => {
            setLockedComposeOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

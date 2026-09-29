/**
 * The dossier editor (ORCHESTRATION D16.1/D16.2/D16.3; spec rows 6-8 of
 * `.pi/specs/desktop-ui.md`).
 *
 * Three things this file is now the contract for:
 *
 *  - **Explicit save.** `name` and `blocks` live in a local draft and nothing reaches the
 *    library until the user presses `Save` (or `Send`, which persists first). The previous
 *    version called `updateFile` on every keystroke, which made a Save button theatre.
 *    `Save` is disabled while the draft is clean and "Unsaved changes" is visible while it
 *    is not (D16.1). Dirty is a flag, not a diff: an edit that is typed and then typed back
 *    still counts as unsaved work, which is the safe direction to err in.
 *  - **No silent loss.** The corollary of D16.1 is that a draft can be thrown away, so Back
 *    while dirty raises a real dialog — keep editing, save and leave, or discard. A toast
 *    would not stop anyone leaving.
 *  - **Real reordering.** The grip in each row is a `useReorderDrag` handle. A released
 *    drag, ArrowUp/ArrowDown/Home/End on the grip, and the two arrow buttons all land in the
 *    single `applyMove` reducer below, which reorders the draft with `lib/reorder.moveIndex`.
 *    The meta-bar hint about dragging is therefore no longer fictional (D16.3).
 *
 * Re-seeding: the host may swap the `file` prop without unmounting (a two-panel shell keeps
 * the editor mounted while the selection changes), so `seededFromId` re-seeds the draft
 * during render whenever the dossier *identity* changes, before anything can read stale
 * state. A new object for the SAME id deliberately does not re-seed: after `Save` the host
 * echoes the file back (and a store refresh may hand over a fresh-but-equal copy), and
 * overwriting the draft there would clobber edits typed while the write was in flight.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  IconArrowLeft,
  IconCheck,
  IconFolder,
  IconFolderPlus,
  IconPencil,
  IconPlus,
  IconSend,
  IconStack,
  IconDeviceFloppy,
} from '@tabler/icons-react'
import { Button } from '@mantine/core'
import { BlockItem } from './BlockItem'
import { AddBlockModal } from './AddBlockModal'
import { FolderPickerModal } from './FolderPickerModal'
import type { FolderPickerChoice } from './FolderPickerModal'
import { REORDER_ITEM_ATTRIBUTE, useReorderDrag } from '../../hooks/useReorderDrag'
import { DEFAULT_ITEM_HEIGHT, moveIndex } from '../../lib/reorder'
import { ROOT_FOLDER_ID } from '../../lib/library'
import { useLibraryStore } from '../../store/libraryStore'
import type { BlockType, FileBlock, LibraryFile, LibraryFolder } from '../../lib/library'

export interface FileEditViewProps {
  file: LibraryFile
  onBack: () => void
  /** Persists the whole draft. Called by `Save`, by `Save & leave`, and once before `Send`. */
  onSaveFile: (file: LibraryFile) => void
  /** Hands the dossier to the transfer path — always with the current draft, after it was persisted. */
  onSendFile: (file: LibraryFile) => void
  /** Candidate destinations for the folder picker; the file's own folder is looked up here for the label. */
  folders: LibraryFolder[]
  /**
   * Lets a host that renders the editor inside a larger shell mirror the dirty state (a
   * library row that must show a dot while the panel holds unsaved edits). Fires on mount
   * and on every dirty/clean transition; the editor works identically without it.
   */
  onDirtyChange?: (isDirty: boolean) => void
}

/** The gap `space-y-3` puts between block rows, in px at the default root size. */
const ROW_GAP_PX = 12

/** A store failure, as something safe to put on screen. */
function describeMoveFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  return 'The dossier could not be moved.'
}

export function FileEditView({
  file,
  onBack,
  onSaveFile,
  onSendFile,
  folders,
  onDirtyChange,
}: FileEditViewProps) {
  // --- the draft (D16.1) ---------------------------------------------------
  const [seededFromId, setSeededFromId] = useState(file.id)
  const [draftName, setDraftName] = useState(file.name)
  const [draftBlocks, setDraftBlocks] = useState<FileBlock[]>(file.blocks)
  const [isDirty, setIsDirty] = useState(false)

  // Folder membership is NOT part of the draft: a move is a single deliberate action that
  // writes through the store the moment it is taken. It is still held locally because the
  // host's `file` prop can lag behind it.
  const [folderId, setFolderId] = useState(file.folderId)

  // --- local UI state ------------------------------------------------------
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [isMoving, setIsMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false)

  if (seededFromId !== file.id) {
    // React's "adjust state when a prop changes" during render: no effect, no frame drawn
    // against the previous dossier, and no chance for a stale draft to be saved over it.
    setSeededFromId(file.id)
    setDraftName(file.name)
    setDraftBlocks(file.blocks)
    setFolderId(file.folderId)
    setIsDirty(false)
    setIsEditingTitle(false)
    setIsLeaveDialogOpen(false)
    setIsFolderPickerOpen(false)
    setMoveError(null)
  }

  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => {
    // Read through a ref so an inline arrow prop cannot re-run the announcement effect.
    onDirtyChangeRef.current = onDirtyChange
  })
  useEffect(() => {
    onDirtyChangeRef.current?.(isDirty)
  }, [isDirty])

  /**
   * What the screen shows, as a record — the shape `Save`, `Send` and the host all need.
   *
   * `sortOrder` is deliberately absent: the library panel owns where a dossier sits in its
   * folder, and this editor only ever rewrites what the user edited here. `updateFile` merges
   * a patch over the stored row, so a key that is not present keeps whatever is stored — a
   * reorder that landed while the dossier was open survives the save instead of being rolled
   * back to the ordering the screen was opened with.
   */
  const draftFile = useCallback((): LibraryFile => {
    const draft: LibraryFile = { ...file, name: draftName, blocks: draftBlocks, folderId }
    delete draft.sortOrder
    return draft
  }, [file, draftName, draftBlocks, folderId])

  // --- draft mutations -----------------------------------------------------
  const commitBlocks = useCallback((update: (current: FileBlock[]) => FileBlock[]): void => {
    setDraftBlocks((current) => update(current))
    setIsDirty(true)
  }, [])

  /**
   * THE reorder reducer (D16.3). A released grip drag, a key on the grip and an arrow button
   * each call this and nothing else, so the two paths are the same path by construction.
   * Out-of-range indices are ignored rather than thrown: `moveIndex` is strict on purpose,
   * and a list that shrank under a drag is a cancelled move, not a crash.
   */
  const applyMove = useCallback(
    (from: number, to: number): void => {
      if (from === to) return
      commitBlocks((current) => {
        if (from < 0 || to < 0 || from >= current.length || to >= current.length) return current
        return moveIndex(current, from, to)
      })
    },
    [commitBlocks],
  )

  const handleMoveUp = (index: number): void => {
    if (index > 0) applyMove(index, index - 1)
  }

  const handleMoveDown = (index: number): void => {
    if (index < draftBlocks.length - 1) applyMove(index, index + 1)
  }

  const handleUpdateBlock = (blockId: string, changes: Partial<FileBlock>): void => {
    commitBlocks((current) =>
      current.map((block) => (block.id === blockId ? { ...block, ...changes } : block)),
    )
  }

  const handleDeleteBlock = (blockId: string): void => {
    commitBlocks((current) => current.filter((block) => block.id !== blockId))
  }

  /** Unlocking a credential is an edit like any other: it lands in the draft, not the library. */
  const handleUnlockCredential = (blockId: string): void => {
    handleUpdateBlock(blockId, { isUnlocked: true })
  }

  const handleDuplicateBlock = (blockId: string): void => {
    commitBlocks((current) => {
      const index = current.findIndex((block) => block.id === blockId)
      const item = current[index]
      if (item === undefined) return current
      const copy: FileBlock = {
        ...item,
        id: `b-${Date.now()}`,
        content: item.content ? `${item.content} (Copy)` : undefined,
      }
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)]
    })
  }

  const handleAddBlockType = (type: BlockType): void => {
    const newBlock: FileBlock = { id: `b-${Date.now()}`, type }

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

    commitBlocks((current) => [...current, newBlock])
  }

  // --- drag ----------------------------------------------------------------
  const listRef = useRef<HTMLDivElement | null>(null)

  /**
   * Block rows are wildly different heights (a divider vs an image), so the hook asks the
   * DOM for each pitch rather than assuming the grabbed row's. A row that reports 0 has no
   * layout — hidden, or jsdom — and gets the shared default pitch.
   */
  const measureRowPitch = useCallback((index: number): number => {
    const row = listRef.current?.querySelectorAll(`[${REORDER_ITEM_ATTRIBUTE}]`).item(index)
    if (row === undefined || row === null) return DEFAULT_ITEM_HEIGHT
    const height = row.getBoundingClientRect().height
    return height > 0 ? height + ROW_GAP_PX : DEFAULT_ITEM_HEIGHT
  }, [])

  const { drag, getHandleProps } = useReorderDrag({
    length: draftBlocks.length,
    onMove: applyMove,
    getItemHeight: measureRowPitch,
  })

  // --- save / send / leave -------------------------------------------------
  const canPersist = draftName.trim() !== ''

  /**
   * Writes one draft to the library and marks it clean. Refuses a nameless dossier: `lib`
   * rejects an empty name, so offering to save one would only produce an error the user has
   * no way to fix from here.
   */
  const persist = (draft: LibraryFile): boolean => {
    if (draft.name.trim() === '') return false
    onSaveFile(draft)
    setIsDirty(false)
    return true
  }

  const handleSave = (): void => {
    persist(draftFile())
  }

  /** Send gives the channel what is on screen: the draft is persisted, then the same record goes out. */
  const handleSend = (): void => {
    const current = draftFile()
    if (persist(current)) onSendFile(current)
  }

  const handleSaveAndLeave = (): void => {
    if (persist(draftFile())) {
      setIsLeaveDialogOpen(false)
      onBack()
    }
  }

  const handleBackRequest = (): void => {
    if (isDirty) {
      setIsLeaveDialogOpen(true)
      return
    }
    onBack()
  }

  const handleTitleSubmit = (): void => {
    setIsEditingTitle(false)
    // An empty title is not persistable, and the Save button would sit disabled on it.
    if (draftName.trim() === '') setDraftName(file.name)
  }

  // --- folder membership ---------------------------------------------------
  const currentFolderName =
    folderId === ROOT_FOLDER_ID
      ? 'Library root'
      : (folders.find((folder) => folder.id === folderId)?.name ?? 'Unfiled')

  const handleFolderChoice = async (choice: FolderPickerChoice): Promise<void> => {
    setIsMoving(true)
    setMoveError(null)
    try {
      const store = useLibraryStore.getState()
      let targetFolderId = choice.folderId
      if (choice.isNew && choice.folderName !== undefined) {
        const created = await store.createFolder(choice.folderName, null)
        targetFolderId = created.id
      }
      if (targetFolderId === undefined || targetFolderId === '') {
        setMoveError('Choose a folder to move this dossier into.')
        return
      }
      if (targetFolderId !== folderId) await store.moveFile(file.id, targetFolderId)
      setFolderId(targetFolderId)
      setIsFolderPickerOpen(false)
    } catch (cause: unknown) {
      setMoveError(describeMoveFailure(cause))
    } finally {
      setIsMoving(false)
    }
  }

  return (
    <div className="flex flex-col min-h-full pb-14">
      {/* Top bar: back, editable title, dirty state, Save, Send */}
      <header className="px-4 py-3 bg-white border-b border-[#D1D9E4] flex items-center justify-between sticky top-0 z-30 shadow-2xs gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            type="button"
            onClick={handleBackRequest}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors tactile-btn cursor-pointer shrink-0"
            title="Return to library"
            aria-label="Return to library"
          >
            <IconArrowLeft size={16} aria-hidden="true" />
          </button>

          {/* Editable inline title — drafts only, never a write (D16.1) */}
          <div className="min-w-0 flex-1">
            {isEditingTitle ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={draftName}
                  onChange={(event) => {
                    setDraftName(event.target.value)
                    setIsDirty(true)
                  }}
                  onBlur={handleTitleSubmit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleTitleSubmit()
                  }}
                  aria-label="Dossier name"
                  className="w-full font-display font-bold text-base text-[#0F172A] bg-slate-50 border border-[#1D4ED8] rounded px-2 py-0.5 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleTitleSubmit}
                  className="p-1 text-emerald-600 hover:bg-emerald-50 rounded cursor-pointer shrink-0"
                  title="Done renaming"
                  aria-label="Done renaming"
                >
                  <IconCheck size={16} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div
                onClick={() => setIsEditingTitle(true)}
                className="group flex items-center gap-1.5 cursor-pointer py-0.5 rounded hover:bg-slate-50 transition-colors max-w-fit"
                title="Click to rename"
              >
                <h2 className="font-display font-bold text-base text-[#0F172A] truncate">
                  {draftName}
                </h2>
                <IconPencil
                  size={14}
                  className="text-slate-400 group-hover:text-[#1D4ED8] shrink-0 transition-colors"
                  aria-hidden="true"
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isDirty ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#B45309] whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B]" aria-hidden="true" />
              <span>Unsaved changes</span>
            </span>
          ) : null}

          {/* The explicit save that replaced per-keystroke autosave */}
          <Button
            color="signal"
            size="sm"
            leftSection={<IconDeviceFloppy size={14} aria-hidden="true" />}
            disabled={!isDirty || !canPersist}
            onClick={handleSave}
          >
            Save
          </Button>

          <Button
            variant="light"
            color="signal"
            size="sm"
            leftSection={<IconSend size={14} aria-hidden="true" />}
            disabled={!canPersist}
            onClick={handleSend}
          >
            Send
          </Button>
        </div>
      </header>

      <main className="flex-1 px-4 py-5 max-w-xl mx-auto w-full space-y-4">
        {/* Meta bar: block count, and the reorder hint — now true (D16.2/D16.3) */}
        <div className="flex items-center justify-between px-2 text-xs text-[#5B6B82]">
          <span className="flex items-center gap-1.5">
            <IconStack size={14} className="text-slate-400" aria-hidden="true" />
            <span>
              {draftBlocks.length} {draftBlocks.length === 1 ? 'block' : 'blocks'} in payload
            </span>
          </span>
          {draftBlocks.length > 1 ? (
            <span className="text-[11px] font-mono text-slate-400">
              Drag the grip, or use the arrows, to reorder
            </span>
          ) : null}
        </div>

        {/* Folder membership, and the way to change it */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50/80 border border-[#D1D9E4] rounded-lg">
          <span className="flex items-center gap-1.5 min-w-0">
            <IconFolder size={14} className="text-slate-400 shrink-0" aria-hidden="true" />
            <span className="text-[11px] text-[#5B6B82] shrink-0">Folder</span>
            <span className="text-xs font-semibold text-[#0F172A] truncate">
              {currentFolderName}
            </span>
          </span>
          <Button
            variant="default"
            size="xs"
            disabled={isMoving}
            leftSection={<IconFolderPlus size={14} aria-hidden="true" />}
            onClick={() => {
              setMoveError(null)
              setIsFolderPickerOpen(true)
            }}
          >
            {isMoving ? 'Moving...' : 'Move to...'}
          </Button>
        </div>
        {moveError ? (
          <p className="px-3 text-[11px] text-red-600" role="status">
            {moveError}
          </p>
        ) : null}

        {/* Blocks list — each row is a measured reorder item */}
        <div ref={listRef} className="space-y-3">
          {draftBlocks.map((block, index) => (
            <BlockItem
              key={block.id}
              block={block}
              index={index}
              totalBlocks={draftBlocks.length}
              mode="edit"
              onUpdate={handleUpdateBlock}
              onDelete={handleDeleteBlock}
              onDuplicate={handleDuplicateBlock}
              onMoveUp={handleMoveUp}
              onMoveDown={handleMoveDown}
              onUnlockCredential={handleUnlockCredential}
              reorderHandleProps={getHandleProps(index)}
              isReorderDragging={drag?.from === index}
              reorderOffset={drag !== null && drag.from === index ? drag.offset : 0}
            />
          ))}
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={() => setIsAddModalOpen(true)}
            className="w-full py-3 border-2 border-dashed border-[#D1D9E4] hover:border-[#1D4ED8] hover:bg-blue-50/30 rounded-xl flex items-center justify-center gap-2 text-xs font-semibold text-[#1D4ED8] transition-all tactile-btn cursor-pointer"
          >
            <IconPlus size={16} aria-hidden="true" />
            <span>Add Block to Dossier</span>
          </button>
        </div>
      </main>

      {/* Block type picker */}
      <AddBlockModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSelectType={handleAddBlockType}
      />

      {/* Folder picker: move this dossier out of the folder it was created in */}
      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        onClose={() => setIsFolderPickerOpen(false)}
        folders={folders}
        fileName={draftName}
        onSelectFolder={(choice) => {
          void handleFolderChoice(choice)
        }}
      />

      {/* D16.1: leaving with an unsaved draft has to be a decision */}
      {isLeaveDialogOpen ? (
        <LeaveDraftDialog
          dossierName={draftName}
          canSave={canPersist}
          onCancel={() => setIsLeaveDialogOpen(false)}
          onSaveAndLeave={handleSaveAndLeave}
          onDiscard={() => {
            setIsLeaveDialogOpen(false)
            onBack()
          }}
        />
      ) : null}
    </div>
  )
}

interface LeaveDraftDialogProps {
  dossierName: string
  /** False when the draft's name makes it unpersistable, so "Save & leave" is not offered. */
  canSave: boolean
  onCancel: () => void
  onSaveAndLeave: () => void
  onDiscard: () => void
}

/**
 * The confirm that makes D16.1's trade acceptable: an explicit save can lose an in-progress
 * draft on a mis-click, which per-keystroke autosave could not.
 *
 * `window.confirm()` is not usable here (it is blocked in cross-origin iframes and embedded
 * web views — see `components/ConfirmDelete.tsx`) and a toast would not stop the departure.
 * Escape and "Keep editing" both leave everything exactly as it is; the destructive option
 * is last in DOM order, so tab order meets the safe controls first.
 */
function LeaveDraftDialog({
  dossierName,
  canSave,
  onCancel,
  onSaveAndLeave,
  onDiscard,
}: LeaveDraftDialogProps) {
  // A real dialog id: two editors mounted at once must not describe each other's dialog.
  const headingId = useId()
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onCancelRef.current = onCancel
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancelRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
    >
      <div className="w-full max-w-sm bg-white rounded-xl border border-[#D1D9E4] shadow-2xl p-5 modal-enter">
        <h3 id={headingId} className="font-display font-bold text-base text-[#0F172A] mb-1">
          Discard changes?
        </h3>
        <p className="text-xs text-[#5B6B82] mb-4">
          &ldquo;{dossierName}&rdquo; has unsaved edits. Leaving now loses them.
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg tactile-btn cursor-pointer"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onSaveAndLeave}
            disabled={!canSave}
            className="px-3.5 py-1.5 bg-[#1D4ED8] hover:bg-[#1E40AF] disabled:opacity-40 text-white text-xs font-semibold rounded-lg tactile-btn cursor-pointer"
          >
            Save &amp; leave
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="px-3.5 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 tactile-btn cursor-pointer"
          >
            Discard changes
          </button>
        </div>
      </div>
    </div>
  )
}

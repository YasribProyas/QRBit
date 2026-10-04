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

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCheck,
  IconFolderPlus,
  IconFolderSymlink,
  IconLock,
  IconLockOpen,
  IconPencil,
  IconPlugConnectedX,
  IconPlus,
  IconSend,
  IconStack,
  IconDeviceFloppy,
} from '@tabler/icons-react'
import { ActionIcon, Badge, Button, Group, Modal, PasswordInput, Stack, Text, TextInput } from '@mantine/core'
import { BlockItem } from './BlockItem'
import { AddBlockModal } from './AddBlockModal'
import { FolderPickerModal } from './FolderPickerModal'
import type { FolderPickerChoice } from './FolderPickerModal'
import { DossierPickerModal } from '../session/DossierPickerModal'
import { REORDER_ITEM_ATTRIBUTE, useReorderDrag } from '../../hooks/useReorderDrag'
import { DEFAULT_ITEM_HEIGHT, moveIndex } from '../../lib/reorder'
import {
  describeSendFailure,
  deserializeDossierBlocks,
  encryptBlockPayload,
  fileBlocksToLibraryItems,
  findUnsendableBlocks,
  serializeDossierBlocks,
  sessionItemsToFileBlocks,
} from '../../lib/dossier'
import { decryptItem, encryptItem, toBase64 } from '../../lib/crypto'
import { ROOT_FOLDER_ID, unprotectedSecretBlocks } from '../../lib/library'
import { useLibraryStore } from '../../store/libraryStore'
import { useSessionStore } from '../../store/sessionStore'
import type { BlockType, FileBlock, LibraryFile, LibraryFolder } from '../../lib/library'
import type { UseSessionResult } from '../../hooks/useSession'

function serializeBlock(block: FileBlock): string {
  return JSON.stringify({
    __blockType: block.type,
    content: block.isLocked ? '' : (block.content ?? ''),
    label: block.label ?? '',
    value: block.isLocked ? '' : (block.value ?? ''),
    fileName: block.fileName,
    fileSize: block.fileSize,
    mimeType: block.mimeType,
    isLocked: block.isLocked ?? false,
    lockedData: block.lockedData
      ? {
          ciphertext: toBase64(block.lockedData.ciphertext),
          iv: toBase64(block.lockedData.iv),
          salt: toBase64(block.lockedData.salt),
          innerType: block.lockedData.innerType,
        }
      : undefined,
  })
}

export interface FileEditViewProps {
  file: LibraryFile
  initialPassword?: string
  onBack: () => void
  /** Persists the whole draft. Called by `Save`, by `Save & leave`, and once before `Send`. */
  onSaveFile: (file: LibraryFile) => void
  /** Hands the dossier to the transfer path — always with the current draft, after it was persisted. */
  onSendFile?: (file: LibraryFile) => void | Promise<void>
  /** Candidate destinations for the folder picker; the file's own folder is looked up here for the label. */
  folders: LibraryFolder[]
  /**
   * Lets a host that renders the editor inside a larger shell mirror the dirty state (a
   * library row that must show a dot while the panel holds unsaved edits). Fires on mount
   * and on every dirty/clean transition; the editor works identically without it.
   */
  onDirtyChange?: (isDirty: boolean) => void
  session?: UseSessionResult
  isSharedSession?: boolean
  onEndSession?: () => void
}

/** The gap `space-y-3` puts between block rows, in px at the default root size. */
const ROW_GAP_PX = 12

/**
 * What the user pressed, and therefore what the editor owes them once a blocked Save unblocks.
 *
 * `'save'` and `'leave'` are the two paths through `persist`; `'send'` is the one that must never
 * put a payload on the wire that the user did not write, so it runs the unsendable gate on the
 * way out.
 */
type SaveIntent = 'save' | 'leave' | 'send'

/** The open "this block is not encrypted" prompt: what to encrypt, and what to do afterwards. */
interface EncryptPrompt {
  block: FileBlock
  /** The draft as it was when the prompt opened, so answering resumes exactly that save. */
  draft: LibraryFile
  intent: SaveIntent
}

/** A store failure, as something safe to put on screen. */
function describeMoveFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  return 'The dossier could not be moved.'
}

export function FileEditView({
  file,
  initialPassword,
  onBack,
  onSaveFile,
  onSendFile,
  folders,
  onDirtyChange,
  session,
  isSharedSession,
  onEndSession,
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
  const [isDossierPickerOpen, setIsDossierPickerOpen] = useState(false)
  const [isMoving, setIsMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  /** Why a Send was refused, in words the user can act on. Cleared by the next Send. */
  const [sendError, setSendError] = useState<string | null>(null)
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false)

  /*
   * ---------------------------------------------------------------------
   * Save cannot leave a block "locked" while its secret is plaintext: the record must hold the
   * ciphertext tuple and nothing else (PLAN.md §6.2, and D16.1's explicit-save contract).
   *
   * Encryption needs a password, and a password is not a field of a stored block — inventing one
   * is exactly the bug this editor had: the block's own password written down beside the secret,
   * under an "Encrypted" badge. So when a Save, a Save-and-leave or a Send meets a block that is
   * marked as a secret and holds plaintext with no tuple, the editor STOPS and asks for the
   * password, in the foreground, naming the block. It never encrypts behind the user's back and
   * it never writes a row that pretends to be safe.
   *
   * Two ways out of that prompt, and each of them is the user's decision:
   *   - a password (typed twice, per decision D7): the block is encrypted through the same
   *     `encryptBlockPayload` the row's Lock button uses, the draft is rewritten with the tuple,
   *     and the interrupted action continues;
   *   - "Cancel the save": nothing is written. The way to keep this block as plaintext is the
   *     row's own `Remove lock`, an explicit per-block act that also takes the lock claim off it.
   *
   * There is deliberately no "save it anyway" option: a block the user still calls locked is a
   * block they expect to be ciphertext, and offering to write it as text is how the old build
   * came to hold a guessable password next to the secret it claimed to protect.
   * ---------------------------------------------------------------------
   */
  const [encryptPrompt, setEncryptPrompt] = useState<EncryptPrompt | null>(null)
  const [encryptPassword, setEncryptPassword] = useState('')
  const [encryptConfirm, setEncryptConfirm] = useState('')
  const [encryptError, setEncryptError] = useState<string | null>(null)
  const [isEncrypting, setIsEncrypting] = useState(false)
  const [draftIsLocked, setDraftIsLocked] = useState(Boolean(file.isLocked))
  const [seededIsLocked, setSeededIsLocked] = useState(file.isLocked)

  // Whole-dossier lock modal states
  const [showDossierLockModal, setShowDossierLockModal] = useState(false)
  const [dossierLockPassword, setDossierLockPassword] = useState('')
  const [dossierLockConfirm, setDossierLockConfirm] = useState('')
  const [dossierLockError, setDossierLockError] = useState<string | null>(null)
  const [isDossierLocking, setIsDossierLocking] = useState(false)

  // Whole-dossier unlock modal states
  const [showDossierUnlockModal, setShowDossierUnlockModal] = useState(false)
  const [dossierUnlockPassword, setDossierUnlockPassword] = useState('')
  const [dossierUnlockError, setDossierUnlockError] = useState<string | null>(null)
  const [isDossierUnlocking, setIsDossierUnlocking] = useState(false)

  const dossierPasswordRef = useRef<string>(initialPassword ?? '')
  const savedLibraryIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (initialPassword !== undefined) {
      dossierPasswordRef.current = initialPassword
    }
  }, [initialPassword])

  if (seededIsLocked !== file.isLocked) {
    setSeededIsLocked(file.isLocked)
    setDraftIsLocked(Boolean(file.isLocked))
  }

  if (seededFromId !== file.id) {
    // React's "adjust state when a prop changes" during render: no effect, no frame drawn
    // against the previous dossier, and no chance for a stale draft to be saved over it.
    setSeededFromId(file.id)
    setSeededIsLocked(file.isLocked)
    setDraftName(file.name)
    setDraftBlocks(file.blocks)
    setFolderId(file.folderId)
    setDraftIsLocked(Boolean(file.isLocked))
    setIsDirty(false)
    setIsEditingTitle(false)
    setIsLeaveDialogOpen(false)
    setIsFolderPickerOpen(false)
    setShowDossierLockModal(false)
    setDossierLockPassword('')
    setDossierLockConfirm('')
    setDossierLockError(null)
    setShowDossierUnlockModal(false)
    setDossierUnlockPassword('')
    setDossierUnlockError(null)
    setEncryptPrompt(null)
    setEncryptPassword('')
    setEncryptConfirm('')
    setEncryptError(null)
    setMoveError(null)
    setSendError(null)
  } else if (
    file.blocks &&
    file.blocks.length > 0 &&
    draftBlocks.length === 0 &&
    !draftIsLocked &&
    !file.isLocked
  ) {
    setDraftBlocks(file.blocks)
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
    const draft: LibraryFile = {
      ...file,
      name: draftName,
      blocks: draftBlocks,
      folderId,
      isLocked: draftIsLocked,
    }
    delete draft.sortOrder
    return draft
  }, [file, draftName, draftBlocks, folderId, draftIsLocked])

  // --- draft mutations -----------------------------------------------------
  const commitBlocks = useCallback((update: (current: FileBlock[]) => FileBlock[]): void => {
    setDraftBlocks((current) => update(current))
    setIsDirty(true)
    // Any edit is the user acting on a refused Send — picking the file that was missing, or
    // deleting the block — so the complaint goes away with the edit that answers it.
    setSendError(null)
  }, [])

  // --- realtime session sync -----------------------------------------------
  const sessionItems = useSessionStore((state) => state.items)
  const localUpdatedIdsRef = useRef<Set<string>>(new Set())
  const syncedBlockIdsRef = useRef<Set<string>>(new Set())
  const initialBroadcastRef = useRef(false)

  // Keep local draft blocks in sync with collaborative session items
  useEffect(() => {
    if (!isSharedSession) return

    const incomingBlocks = sessionItemsToFileBlocks(sessionItems)
    for (const b of incomingBlocks) {
      syncedBlockIdsRef.current.add(b.id)
    }

    setDraftBlocks((current) => {
      if (current.length === 0) {
        return incomingBlocks
      }

      const currentMap = new Map(current.map((b) => [b.id, b]))
      const incomingIds = new Set(incomingBlocks.map((b) => b.id))

      let changed = false
      const nextBlocks: FileBlock[] = []

      // 1. Process incoming blocks from session
      for (const inc of incomingBlocks) {
        const existing = currentMap.get(inc.id)
        if (!existing) {
          nextBlocks.push(inc)
          changed = true
        } else {
          const isLocallyModified = localUpdatedIdsRef.current.has(inc.id)
          if (!isLocallyModified) {
            const hasChanged =
              existing.content !== inc.content ||
              existing.value !== inc.value ||
              existing.label !== inc.label ||
              existing.type !== inc.type ||
              (inc.blob !== undefined && existing.blob !== inc.blob) ||
              existing.fileSize !== inc.fileSize ||
              existing.isUnlocked !== inc.isUnlocked ||
              existing.isLocked !== inc.isLocked ||
              Boolean(existing.lockedData) !== Boolean(inc.lockedData)

            if (hasChanged) {
              nextBlocks.push({
                ...existing,
                ...inc,
                blob: inc.blob ?? existing.blob,
                isUnlocked: existing.isUnlocked || inc.isUnlocked,
                isLocked: inc.isLocked,
                lockedData: inc.lockedData,
              })
              changed = true
            } else {
              nextBlocks.push(existing)
            }
          } else {
            nextBlocks.push(existing)
          }
        }
      }

      // 2. Keep any newly added local blocks not yet in sessionItems AND not previously synced
      for (const b of current) {
        if (!incomingIds.has(b.id) && !syncedBlockIdsRef.current.has(b.id)) {
          nextBlocks.push(b)
        } else if (!incomingIds.has(b.id) && syncedBlockIdsRef.current.has(b.id)) {
          // Block was previously synced, but peer deleted it from sessionItems
          changed = true
        }
      }

      return changed ? nextBlocks : current
    })
  }, [isSharedSession, sessionItems])

  // Broadcast initial blocks if entering session with pre-existing draft blocks
  useEffect(() => {
    if (!isSharedSession || !session || session.phase !== 'active') return
    if (initialBroadcastRef.current) return

    if (sessionItems && sessionItems.length > 0) {
      initialBroadcastRef.current = true
      return
    }

    if (draftBlocks.length > 0) {
      initialBroadcastRef.current = true
      draftBlocks.forEach((block) => {
        if (
          block.lockedData ||
          block.type === 'heading' ||
          block.type === 'shortText' ||
          block.type === 'richText' ||
          block.type === 'divider' ||
          block.type === 'locked'
        ) {
          const content = serializeBlock(block)
          const newId = session.addTextItem(content)
          if (newId) {
            syncedBlockIdsRef.current.add(newId)
            setDraftBlocks((current) =>
              current.map((b) => (b.id === block.id ? { ...b, id: newId } : b)),
            )
          }
        } else if (
          (block.type === 'image' || block.type === 'fileAttachment') &&
          block.blob instanceof Blob
        ) {
          const file = new File([block.blob], block.fileName || 'file', {
            type: block.mimeType || block.blob.type,
          })
          session.addFileItem(file)
        }
      })
    }
  }, [isSharedSession, session, session?.phase, sessionItems, draftBlocks])

  const handleAppendDossier = async (appendFile: LibraryFile): Promise<void> => {
    try {
      if (isSharedSession && session && session.phase === 'active') {
        for (const block of appendFile.blocks) {
          if (
            block.lockedData ||
            block.type === 'heading' ||
            block.type === 'shortText' ||
            block.type === 'richText' ||
            block.type === 'divider' ||
            block.type === 'locked'
          ) {
            const content = serializeBlock(block)
            const newId = session.addTextItem(content)
            if (newId) {
              syncedBlockIdsRef.current.add(newId)
            }
          } else if (
            (block.type === 'image' || block.type === 'fileAttachment') &&
            block.blob instanceof Blob
          ) {
            const file = new File([block.blob], block.fileName || 'file', {
              type: block.mimeType || block.blob.type,
            })
            session.addFileItem(file)
          }
        }
      } else {
        const newBlocks = appendFile.blocks.map((b) => ({
          ...b,
          id: `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }))
        commitBlocks((current) => [...current, ...newBlocks])
      }
    } catch (err: unknown) {
      setSendError(describeSendFailure(err))
    }
  }

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
    // If this update is only revealing an in-memory unlocked secret (keeping lockedData),
    // it is in-memory RAM reveal only — never mark dirty, never trigger autosave!
    const isOnlyReveal =
      changes.isUnlocked === true && !('lockedData' in changes && changes.lockedData === undefined)

    if (isOnlyReveal) {
      setDraftBlocks((current) =>
        current.map((block) => (block.id === blockId ? { ...block, ...changes } : block)),
      )
      return
    }

    commitBlocks((current) =>
      current.map((block) => (block.id === blockId ? { ...block, ...changes } : block)),
    )

    if (isSharedSession && session && session.phase === 'active') {
      localUpdatedIdsRef.current.add(blockId)
      setTimeout(() => {
        localUpdatedIdsRef.current.delete(blockId)
      }, 500)

      if (changes.blob instanceof Blob) {
        const file = new File([changes.blob], changes.fileName || 'file', {
          type: changes.mimeType || changes.blob.type,
        })
        const newId = session.addFileItem(file)
        if (newId) {
          syncedBlockIdsRef.current.add(newId)
          if (sessionItems.some((s) => s.id === blockId)) {
            session.deleteItem(blockId)
            syncedBlockIdsRef.current.delete(blockId)
          }
          commitBlocks((current) =>
            current.map((b) => (b.id === blockId ? { ...b, ...changes, id: newId } : b)),
          )
          return
        }
      }

      const target = draftBlocks.find((b) => b.id === blockId)
      const updated: FileBlock = { ...(target ?? { id: blockId, type: 'shortText' }), ...changes }

      // Encrypted block: don't sync when added/unencrypted, only sync the moment it's encrypted
      if (updated.type === 'locked' && !updated.lockedData) {
        return
      }

      const isAlreadySynced = sessionItems.some((s) => s.id === blockId)
      if (isAlreadySynced) {
        session.updateTextItem(blockId, serializeBlock(updated))
      } else {
        const newId = session.addTextItem(serializeBlock(updated))
        if (newId) {
          syncedBlockIdsRef.current.add(newId)
          commitBlocks((current) =>
            current.map((b) => (b.id === blockId ? { ...b, ...changes, id: newId } : b)),
          )
        }
      }
    }
  }

  const handleDeleteBlock = (blockId: string): void => {
    syncedBlockIdsRef.current.delete(blockId)
    commitBlocks((current) => current.filter((block) => block.id !== blockId))
    if (isSharedSession && session && session.phase === 'active') {
      session.deleteItem(blockId)
    }
  }

  /** Unlocking a credential is an in-memory RAM reveal only — never marks dirty or writes to storage. */
  const handleUnlockCredential = (blockId: string, revealedContent?: string): void => {
    setDraftBlocks((current) =>
      current.map((block) =>
        block.id === blockId
          ? {
              ...block,
              isUnlocked: true,
              ...(revealedContent !== undefined ? { content: revealedContent } : {}),
            }
          : block,
      ),
    )
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
    if (isSharedSession && session && session.phase === 'active') {
      let newId = ''
      if (type === 'heading') {
        newId = session.addTextItem(JSON.stringify({ __blockType: 'heading', content: '' }))
      } else if (type === 'shortText') {
        newId = session.addTextItem(
          JSON.stringify({ __blockType: 'shortText', label: '', value: '' }),
        )
      } else if (type === 'richText') {
        newId = session.addTextItem(JSON.stringify({ __blockType: 'richText', content: '' }))
      } else if (type === 'divider') {
        newId = session.addTextItem(JSON.stringify({ __blockType: 'divider' }))
      } else if (type === 'image') {
        newId = session.addTextItem(JSON.stringify({ __blockType: 'image' }))
      } else if (type === 'fileAttachment') {
        newId = session.addTextItem(JSON.stringify({ __blockType: 'fileAttachment' }))
      }

      if (newId) {
        syncedBlockIdsRef.current.add(newId)
        const newBlock: FileBlock = {
          id: newId,
          type,
          content: '',
          label: '',
          value: '',
        }
        commitBlocks((current) => [...current, newBlock])
        return
      }
    }

    const newBlock: FileBlock = {
      id: `b-${Date.now()}`,
      type,
      content: '',
      label: '',
      value: '',
    }
    if (type === 'locked') {
      newBlock.isLocked = true
      newBlock.isUnlocked = false
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
   * Encrypts the entire dossier if locked before writing to IndexedDB.
   * Ensures that revealed values of encrypted blocks are NEVER written to storage.
   */
  const preparePersistFile = async (draft: LibraryFile): Promise<LibraryFile> => {
    // Strip plaintext and isUnlocked from any block that has lockedData (encrypted blocks):
    // Revealed secrets MUST ONLY live in RAM and NEVER in browser storage!
    const cleanedBlocks = (draft.blocks || []).map((b) => {
      if (b.lockedData) {
        const { content, value, blob, isUnlocked, ...rest } = b
        return rest as FileBlock
      }
      return b
    })

    const draftWithCleanedBlocks = {
      ...draft,
      blocks: cleanedBlocks,
    }

    if (draft.isLocked) {
      const password = dossierPasswordRef.current
      if (password) {
        const serialized = await serializeDossierBlocks(cleanedBlocks)
        const plaintext = new TextEncoder().encode(serialized)
        const { ciphertext, iv, salt } = await encryptItem(password, plaintext)
        return {
          ...draftWithCleanedBlocks,
          isLocked: true,
          ciphertext,
          iv,
          salt,
          blocks: [],
        }
      } else if (file.ciphertext && draftBlocks.length === 0) {
        return {
          ...draftWithCleanedBlocks,
          isLocked: true,
          ciphertext: file.ciphertext,
          iv: file.iv,
          salt: file.salt,
          blocks: [],
        }
      }
    }
    return {
      ...draftWithCleanedBlocks,
      isLocked: false,
      ciphertext: undefined,
      iv: undefined,
      salt: undefined,
    }
  }

  /**
   * Writes one draft to the library and marks it clean. Refuses a nameless dossier: `lib`
   * rejects an empty name, so offering to save one would only produce an error the user has
   * no way to fix from here.
   */
  const persist = (draft: LibraryFile): boolean | Promise<boolean> => {
    if (draft.name.trim() === '') return false

    let resolvedDraft = draft
    if (isSharedSession || draft.id.startsWith('shared-')) {
      if (!savedLibraryIdRef.current) {
        savedLibraryIdRef.current = globalThis.crypto.randomUUID()
      }
      resolvedDraft = {
        ...draft,
        id: savedLibraryIdRef.current,
      }
      setSeededFromId(savedLibraryIdRef.current)
    }

    if (!resolvedDraft.isLocked) {
      const cleanedBlocks = (resolvedDraft.blocks || []).map((b) => {
        if (b.lockedData) {
          const { content, value, blob, isUnlocked, ...rest } = b
          return rest as FileBlock
        }
        return b
      })
      const fileToSave: LibraryFile = {
        ...resolvedDraft,
        blocks: cleanedBlocks,
        isLocked: false,
        ciphertext: undefined,
        iv: undefined,
        salt: undefined,
      }
      onSaveFile(fileToSave)
      setIsDirty(false)
      return true
    }

    return (async () => {
      const fileToSave = await preparePersistFile(resolvedDraft)
      onSaveFile(fileToSave)
      setIsDirty(false)
      return true
    })()
  }

  // Debounced autosave: automatically saves changes after 1500ms of inactivity in local dossiers
  useEffect(() => {
    if (isSharedSession || !isDirty || !canPersist || isLeaveDialogOpen) return

    const timer = setTimeout(() => {
      persist(draftFile())
    }, 1500)

    return () => {
      clearTimeout(timer)
    }
  }, [isSharedSession, isDirty, canPersist, isLeaveDialogOpen, draftFile])

  const closeEncryptPrompt = (): void => {
    setEncryptPrompt(null)
    // The password exists only while the prompt is open (PLAN.md §6.2: it is stored nowhere),
    // so leaving it goes — typed, half-typed, successful or cancelled.
    setEncryptPassword('')
    setEncryptConfirm('')
    setEncryptError(null)
  }

  /** The rest of whatever the user pressed, once nothing needs a password any more. */
  const finishSave = (draft: LibraryFile, intent: SaveIntent): void => {
    const needsPassword = unprotectedSecretBlocks(draft)[0]
    if (needsPassword !== undefined) {
      setSendError(null)
      setEncryptPrompt({ block: needsPassword, draft, intent })
      return
    }

    if (intent === 'send') {
      if (!onSendFile) return
      /*
       * The refusal happens HERE, before a byte of the draft is handed over. `lib/dossier.ts`
       * throws for an attachment block with no file and for a locked block that was never
       * encrypted, which is the backstop; this is the front line, and it is what turns "the
       * transfer silently carried fake data" into a sentence on screen that names what to do
       * about it. A draft can still be SAVED with an empty attachment block — that is work in
       * progress, not a payload.
       */
      const first = findUnsendableBlocks(draft)[0]
      if (first !== undefined) {
        setSendError(describeSendFailure(first))
        return
      }
      const res = persist(draft)
      if (res === false) return
      if (res instanceof Promise) {
        void res.then((saved) => {
          if (!saved) return
          void Promise.resolve(onSendFile(draft)).catch((cause: unknown) => {
            setSendError(describeSendFailure(cause))
          })
        })
        return
      }

      // The host's send is allowed to be async (that is how `pages/Home.tsx` wires it, and the
      // conversion inside it can still reject). Awaiting it here is what keeps the failure visible
      // without this editor having to own a page-level file.
      void Promise.resolve(onSendFile(draft)).catch((cause: unknown) => {
        setSendError(describeSendFailure(cause))
      })
      return
    }

    const res = persist(draft)
    if (res === false) return
    if (res instanceof Promise) {
      void res.then((saved) => {
        if (saved && intent === 'leave') {
          setIsLeaveDialogOpen(false)
          onBack()
        }
      })
      return
    }
    if (intent === 'leave') {
      setIsLeaveDialogOpen(false)
      onBack()
    }
  }

  const handleSave = (): void => {
    if (draftIsLocked && !dossierPasswordRef.current) {
      setShowDossierLockModal(true)
      return
    }
    finishSave(draftFile(), 'save')
  }

  /** Send gives the channel what is on screen: the draft is persisted, then the same record goes out. */
  const handleSend = (): void => {
    if (!onSendFile) return
    setSendError(null)
    if (draftIsLocked && !dossierPasswordRef.current) {
      setShowDossierLockModal(true)
      return
    }
    void finishSave(draftFile(), 'send')
  }

  const handleSaveAndLeave = (): void => {
    if (draftIsLocked && !dossierPasswordRef.current) {
      setShowDossierLockModal(true)
      return
    }
    void finishSave(draftFile(), 'leave')
  }

  /** "Encrypt and save": the block becomes a tuple, then the interrupted action resumes. */
  const submitEncryptPrompt = async (): Promise<void> => {
    if (encryptPrompt === null) return
    const { block, draft, intent } = encryptPrompt
    if (encryptPassword !== encryptConfirm) {
      setEncryptError('The two passwords do not match. Nothing was encrypted or saved.')
      return
    }

    setIsEncrypting(true)
    setEncryptError(null)
    try {
      const lockedData = await encryptBlockPayload(block, encryptPassword)
      const nextDraft: LibraryFile = {
        ...draft,
        blocks: draft.blocks.map((row) =>
          row.id === block.id
            ? { ...row, isLocked: true, isUnlocked: false, lockedData }
            : row,
        ),
      }
      // The rows on screen have to show what was just written, or the editor would go on
      // displaying a secret as unprotected next to a ciphertext that replaces it.
      setDraftBlocks(nextDraft.blocks)
      // Only after the ciphertext exists: a prompt that closes on a failed encryption would
      // hide the reason it is still open.
      closeEncryptPrompt()
      await finishSave(nextDraft, intent)
    } catch (cause: unknown) {
      setEncryptError(describeSendFailure(cause))
    } finally {
      setIsEncrypting(false)
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
  const folderDisplayName =
    folderId === ROOT_FOLDER_ID
      ? 'Root'
      : (folders.find((folder) => folder.id === folderId)?.name ?? 'Root')

  const handleConfirmDossierLock = async (): Promise<void> => {
    if (!dossierLockPassword) {
      setDossierLockError('Enter a password to encrypt this dossier.')
      return
    }
    if (dossierLockPassword !== dossierLockConfirm) {
      setDossierLockError('Passwords do not match.')
      return
    }
    setIsDossierLocking(true)
    setDossierLockError(null)
    try {
      dossierPasswordRef.current = dossierLockPassword
      setDraftIsLocked(true)
      setIsDirty(true)
      setShowDossierLockModal(false)
      setDossierLockPassword('')
      setDossierLockConfirm('')
      void persist({
        ...draftFile(),
        isLocked: true,
      })
    } catch (err: unknown) {
      setDossierLockError(err instanceof Error ? err.message : 'Encryption failed')
    } finally {
      setIsDossierLocking(false)
    }
  }

  const handleConfirmDossierUnlock = async (): Promise<void> => {
    if (!dossierUnlockPassword) {
      setDossierUnlockError('Enter the password to unlock this dossier.')
      return
    }

    setIsDossierUnlocking(true)
    setDossierUnlockError(null)
    try {
      let decryptedBlocks: FileBlock[] = []
      if (file.ciphertext && file.salt && file.iv) {
        const decryptedBytes = await decryptItem(
          dossierUnlockPassword,
          file.salt,
          file.iv,
          file.ciphertext,
        )
        const json = new TextDecoder().decode(decryptedBytes)
        decryptedBlocks = deserializeDossierBlocks(json)
      } else if (dossierPasswordRef.current && dossierPasswordRef.current !== dossierUnlockPassword) {
        throw new Error('Incorrect password')
      } else {
        decryptedBlocks = draftBlocks.length > 0 ? draftBlocks : (file.blocks ?? [])
      }

      setDraftBlocks(decryptedBlocks)
      setDraftIsLocked(false)
      dossierPasswordRef.current = ''
      setShowDossierUnlockModal(false)
      setDossierUnlockPassword('')
      setDossierUnlockError(null)
      setIsDirty(true)

      void persist({
        ...draftFile(),
        blocks: decryptedBlocks,
        isLocked: false,
        ciphertext: undefined,
        iv: undefined,
        salt: undefined,
      })
    } catch {
      setDossierUnlockError('Incorrect password. Could not unlock dossier.')
    } finally {
      setIsDossierUnlocking(false)
    }
  }

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
    <div className="file-edit-view session-board flex flex-col min-h-full pb-14">
      {/*
        Top bar: back, editable title, dirty state, Save, Send. It is sticky, so it is one of the
        few surfaces that genuinely floats above the page — it takes the sheet shadow rather than
        the old zero-offset halo, which DESIGN.md names as a defect ("The Offset-and-Blur Rule").

        The `flex-wrap` on it is not decoration. Mantine's `Button` root is `overflow: hidden` and
        its label part is `white-space: nowrap`, so a control that a row squeezes below its own
        content width does not shrink its text — it cuts the text off. Letting the action cluster
        take a line of its own, with every control on it `flex: none`, is what keeps
        `Save dossier` and `Send` whole on a 320px phone — which is the device this product is
        used on.
      */}
      <header
        className="file-edit-view__header px-4 py-3 flex items-center justify-between flex-wrap sticky top-0 z-30 gap-2"
        style={{
          backgroundColor: 'var(--qrbit-raised)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderBottom: '1px solid var(--qrbit-border)',
          boxShadow: 'var(--qrbit-shadow-lift)',
        }}
      >
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: '1 1 16rem' }}>
          <ActionIcon
            variant="subtle"
            size="lg"
            c="dimmed"
            onClick={handleBackRequest}
            title="Return to library"
            aria-label="Return to library"
            style={{ flex: 'none' }}
          >
            <IconArrowLeft size={16} aria-hidden="true" />
          </ActionIcon>

          {/* Editable inline title — drafts only, never a write (D16.1) */}
          <div className="min-w-0 flex-1">
            {isEditingTitle ? (
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <span className="qrbit-text-title shrink-0 font-medium" style={{ color: 'var(--qrbit-ink-muted)' }}>
                  {folderDisplayName}/
                </span>
                <TextInput
                  size="sm"
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
                  styles={{
                    input: {
                      font: 'var(--qrbit-text-title)',
                      letterSpacing: 'var(--qrbit-text-title-tracking)',
                    },
                  }}
                  style={{ flex: '1 1 auto', minWidth: 0 }}
                />
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  color="success"
                  onClick={handleTitleSubmit}
                  title="Done renaming"
                  aria-label="Done renaming"
                  style={{ flex: 'none' }}
                >
                  <IconCheck size={16} aria-hidden="true" />
                </ActionIcon>
              </Group>
            ) : (
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <Text
                  span
                  className="qrbit-text-title"
                  style={{ minWidth: 0 }}
                  truncate
                >
                  <span className="font-medium" style={{ color: 'var(--qrbit-ink-muted)' }}>
                    {folderDisplayName}/
                  </span>
                  {draftName}
                </Text>
                <ActionIcon
                  variant="subtle"
                  size="md"
                  c="dimmed"
                  onClick={() => setIsEditingTitle(true)}
                  title="Rename dossier"
                  aria-label="Rename dossier"
                  style={{ flex: 'none' }}
                >
                  <IconPencil size={14} aria-hidden="true" />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  size="md"
                  c="dimmed"
                  disabled={isMoving}
                  onClick={() => {
                    setMoveError(null)
                    setIsFolderPickerOpen(true)
                  }}
                  title="Move to folder"
                  aria-label="Move to folder"
                  style={{ flex: 'none' }}
                >
                  <IconFolderSymlink size={15} aria-hidden="true" />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  size="md"
                  c={draftIsLocked ? 'locked' : 'dimmed'}
                  onClick={() => {
                    if (draftIsLocked) {
                      setShowDossierUnlockModal(true)
                      setDossierUnlockPassword('')
                      setDossierUnlockError(null)
                    } else {
                      setShowDossierLockModal(true)
                      setDossierLockPassword('')
                      setDossierLockConfirm('')
                      setDossierLockError(null)
                    }
                  }}
                  title={draftIsLocked ? 'Unlock dossier (remove encryption)' : 'Lock dossier'}
                  aria-label={draftIsLocked ? 'Unlock dossier (remove encryption)' : 'Lock dossier'}
                  style={{
                    flex: 'none',
                    color: draftIsLocked ? 'var(--qrbit-locked)' : undefined,
                  }}
                >
                  {draftIsLocked ? (
                    <IconLock size={15} aria-hidden="true" />
                  ) : (
                    <IconLockOpen size={15} aria-hidden="true" />
                  )}
                </ActionIcon>
              </Group>
            )}
          </div>
        </Group>

        <Group gap="sm" wrap="wrap" justify="flex-end" style={{ flex: 'none', maxWidth: '100%' }}>
          {isSharedSession && session ? (
            <Group gap="xs" wrap="nowrap" align="center">
              {session.phase === 'active' ? (
                <div
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border"
                  style={{
                    backgroundColor: 'rgba(34, 197, 94, 0.08)',
                    borderColor: 'rgba(34, 197, 94, 0.25)',
                    color: 'var(--qrbit-success, #16a34a)',
                  }}
                  title={
                    session.safetyPhrase
                      ? `Safety Phrase: ${session.safetyPhrase.join(' • ')}`
                      : 'Live session active'
                  }
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span>Live Shared</span>
                  {session.safetyPhrase ? (
                    <span className="hidden md:inline font-mono opacity-75 text-[11px] ml-1">
                      ({session.safetyPhrase.join(' • ')})
                    </span>
                  ) : null}
                </div>
              ) : (
                <div
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border"
                  style={{
                    backgroundColor: 'var(--qrbit-sunken)',
                    borderColor: 'var(--qrbit-border)',
                    color: 'var(--qrbit-ink-muted)',
                  }}
                  title="Peer disconnected. This dossier is preserved and can be saved to library."
                >
                  <span className="w-2 h-2 rounded-full bg-stone-400" />
                  <span>Peer disconnected</span>
                </div>
              )}

              {/* Append from library button */}
              <Button
                variant="default"
                size="sm"
                leftSection={<IconFolderPlus size={14} aria-hidden="true" />}
                onClick={() => setIsDossierPickerOpen(true)}
                title="Append an existing dossier from your local computer"
              >
                Append dossier
              </Button>

              {/* Save dossier button */}
              <Button
                variant="default"
                size="sm"
                leftSection={
                  isDirty ? (
                    <IconDeviceFloppy size={14} aria-hidden="true" />
                  ) : (
                    <IconCheck size={14} aria-hidden="true" />
                  )
                }
                data-save-state={isDirty ? 'dirty' : 'clean'}
                onClick={handleSave}
              >
                {isDirty ? 'Save to library' : 'Saved to library'}
              </Button>

              {/* Disconnect button if active */}
              {session.phase === 'active' ? (
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="lg"
                  onClick={() => {
                    session.abort()
                    onEndSession?.()
                  }}
                  title="Disconnect session (dossier remains here)"
                  aria-label="Disconnect session"
                >
                  <IconPlugConnectedX size={16} stroke={1.6} />
                </ActionIcon>
              ) : null}
            </Group>
          ) : (
            <>
              {isDirty ? (
                /*
                  Caution Amber means "a warning that is not a failure" — an unsaved draft — and the
                  badge carries an icon AND a word, because colour alone is never the message. It sits
                  beside Save, so the state and the control that clears it are adjacent.
                */
                <Badge
                  variant="light"
                  color="warning"
                  radius="full"
                  leftSection={<IconAlertCircle size={12} aria-hidden="true" />}
                  style={{ flex: 'none' }}
                >
                  Unsaved changes
                </Badge>
              ) : null}

              {/*
                DESIGN.md's Button table gives this screen exactly two roles, and they are now
                different ones. `Send` is the filled `signal` primary: the product is one motion —
                put something in, show a code, hand it across — so the control that starts that motion
                owns the accent, and the One Blue Rule means only one control on this bar may.
                `Save dossier` is the Default role: raised fill, 1px `--qrbit-border-strong`, ink
                label — DESIGN.md's own definition of "the outline of a control the user must find",
                which is why it does not need the accent to be found. It is also the control the user
                comes back to dozens of times per dossier, and a repeated action styled as the primary
                would make the primary mean nothing.

                Its state is in its own word and icon, not only in the amber badge next to it: clean
                reads `Saved` with a check and is disabled, dirty reads `Save dossier` with the floppy
                and is live. `data-save-state` is the same fact for anything that needs to read it
                without matching on a label that changes.
              */}
              <Button
                variant="default"
                size="sm"
                leftSection={
                  isDirty ? (
                    <IconDeviceFloppy size={14} aria-hidden="true" />
                  ) : (
                    <IconCheck size={14} aria-hidden="true" />
                  )
                }
                disabled={!isDirty || !canPersist}
                data-save-state={isDirty ? 'dirty' : 'clean'}
                style={{ flex: 'none' }}
                onClick={handleSave}
              >
                {isDirty ? 'Save dossier' : 'Saved'}
              </Button>

              {/* The screen's purpose: hand the dossier across. Filled signal, white label, both states. */}
              {onSendFile ? (
                <Button
                  variant="filled"
                  color="signal"
                  size="sm"
                  leftSection={<IconSend size={14} aria-hidden="true" />}
                  disabled={!canPersist}
                  style={{ flex: 'none' }}
                  onClick={handleSend}
                >
                  Send
                </Button>
              ) : null}
            </>
          )}
        </Group>
      </header>

      <main className="flex-1 px-4 py-5 max-w-2xl lg:max-w-3xl xl:max-w-4xl mx-auto w-full space-y-4">
        {/* Meta bar: block count, and the reorder hint — now true (D16.2/D16.3) */}
        <Group justify="space-between" wrap="nowrap" gap="sm" px="xs">
          <Group gap="xs" wrap="nowrap">
            <IconStack size={16} aria-hidden="true" style={{ color: 'var(--qrbit-ink-muted)' }} />
            <Text span className="qrbit-text-body-secondary" c="dimmed">
              {draftBlocks.length} {draftBlocks.length === 1 ? 'block' : 'blocks'} in payload
            </Text>
          </Group>
          {draftBlocks.length > 1 ? (
            <Text
              span
              className="qrbit-text-body-secondary"
              c="dimmed"
              style={{ textAlign: 'right' }}
            >
              Drag the grip, or use the arrows, to reorder
            </Text>
          ) : null}
        </Group>


        {moveError ? (
          <p className="qrbit-text-body-secondary px-3" style={{ color: 'var(--qrbit-danger)' }} role="status">
            {moveError}
          </p>
        ) : null}
        {sendError !== null ? (
          <p
            className="qrbit-text-body-secondary px-3"
            style={{ color: 'var(--qrbit-danger)' }}
            role="alert"
            data-send-error="true"
          >
            {sendError}
          </p>
        ) : null}

        {/* Blocks list — each row is a measured reorder item */}
        <div
          ref={listRef}
          className="space-y-3 pl-3.5 pr-11 py-5"
          style={{
            backgroundColor: 'var(--qrbit-raised)',
            borderRadius: 'var(--qrbit-radius-lg)',
            border: '1px solid var(--qrbit-border)',
          }}
        >
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

        <div className="add-item-bar pt-2">
          {/*
            A labelled action is a `Button` (DESIGN.md, "Buttons"), and the border is 1px
            `border-strong` like every other control — the old 2px dashed outline was a shape the
            system does not have.
          */}
          <Button
            type="button"
            variant="default"
            size="md"
            fullWidth
            leftSection={<IconPlus size={16} aria-hidden="true" />}
            onClick={() => setIsAddModalOpen(true)}
          >
            Add Block to Dossier
          </Button>
        </div>
      </main>

      {/* Block type picker */}
      <AddBlockModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSelectType={handleAddBlockType}
      />

      {/* Dossier Picker Modal for appending local dossiers */}
      <DossierPickerModal
        isOpen={isDossierPickerOpen}
        onClose={() => setIsDossierPickerOpen(false)}
        onSelectDossier={(selected) => {
          void handleAppendDossier(selected)
        }}
      />

      {/* Folder picker: move this dossier out of the folder it was created in */}
      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        onClose={() => setIsFolderPickerOpen(false)}
        folders={folders}
        fileName={draftName}
        // This dialog moves an existing dossier between folders; it does not save anything. Without
        // `purpose` the modal falls back to its 'save' wording and offers "Save to library" as the
        // answer to "Move to..." — found by the folder-membership tests, which asserted the old
        // labels and were right to fail.
        purpose="move"
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

      {/* A locked block cannot be written down until the user gives it a password. */}
      {encryptPrompt !== null ? (
        <EncryptBeforeSaveDialog
          blockLabel={encryptPrompt.block.label ?? encryptPrompt.block.id}
          password={encryptPassword}
          confirm={encryptConfirm}
          busy={isEncrypting}
          error={encryptError}
          onPassword={(value) => {
            setEncryptPassword(value)
            setEncryptError(null)
          }}
          onConfirm={(value) => {
            setEncryptConfirm(value)
            setEncryptError(null)
          }}
          onCancel={closeEncryptPrompt}
          onSubmit={() => {
            void submitEncryptPrompt()
          }}
        />
      ) : null}

      {/* Whole-dossier lock modal */}
      {showDossierLockModal ? (
        <Modal
          opened
          onClose={() => {
            if (!isDossierLocking) setShowDossierLockModal(false)
          }}
          title="Lock Dossier"
          size="sm"
          centered
          padding="lg"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleConfirmDossierLock()
            }}
          >
            <Stack gap="md">
              <Text className="qrbit-text-body-secondary" c="dimmed">
                Set a password to encrypt “{draftName}”. The entire dossier will be encrypted with PBKDF2 + AES-256-GCM.
              </Text>

              <PasswordInput
                label="Password"
                placeholder="Enter a password"
                autoFocus
                required
                value={dossierLockPassword}
                onChange={(e) => setDossierLockPassword(e.currentTarget.value)}
              />

              <PasswordInput
                label="Confirm password"
                placeholder="Repeat the password"
                required
                value={dossierLockConfirm}
                onChange={(e) => setDossierLockConfirm(e.currentTarget.value)}
              />

              {dossierLockError !== null ? (
                <Text size="xs" c="danger">
                  {dossierLockError}
                </Text>
              ) : null}

              <Group justify="flex-end" gap="sm" mt="xs">
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  c="dimmed"
                  disabled={isDossierLocking}
                  onClick={() => setShowDossierLockModal(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  color="locked"
                  size="sm"
                  loading={isDossierLocking}
                >
                  Lock dossier
                </Button>
              </Group>
            </Stack>
          </form>
        </Modal>
      ) : null}

      {/* Whole-dossier unlock modal */}
      {showDossierUnlockModal ? (
        <Modal
          opened
          onClose={() => {
            if (!isDossierUnlocking) {
              setShowDossierUnlockModal(false)
              setDossierUnlockPassword('')
              setDossierUnlockError(null)
            }
          }}
          title="Unlock Dossier"
          size="sm"
          centered
          padding="lg"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleConfirmDossierUnlock()
            }}
          >
            <Stack gap="md">
              <Text className="qrbit-text-body-secondary" c="dimmed">
                Enter the password to unlock and remove encryption from “{draftName}”.
              </Text>

              <PasswordInput
                label="Password"
                placeholder="Enter dossier password"
                autoFocus
                required
                value={dossierUnlockPassword}
                onChange={(e) => {
                  setDossierUnlockPassword(e.currentTarget.value)
                  setDossierUnlockError(null)
                }}
              />

              {dossierUnlockError !== null ? (
                <Text size="xs" c="danger">
                  {dossierUnlockError}
                </Text>
              ) : null}

              <Group justify="flex-end" gap="sm" mt="xs">
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  c="dimmed"
                  disabled={isDossierUnlocking}
                  onClick={() => {
                    setShowDossierUnlockModal(false)
                    setDossierUnlockPassword('')
                    setDossierUnlockError(null)
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  color="locked"
                  size="sm"
                  loading={isDossierUnlocking}
                >
                  Unlock and Decrypt
                </Button>
              </Group>
            </Stack>
          </form>
        </Modal>
      ) : null}
    </div>
  )
}

interface EncryptBeforeSaveDialogProps {
  /** The block the save is stuck on, named the way the row names it. */
  blockLabel: string
  password: string
  confirm: string
  busy: boolean
  error: string | null
  onPassword: (value: string) => void
  onConfirm: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}

/**
 * The prompt behind requirement "saving it must encrypt it": a block the user marked as a secret
 * is written as ciphertext or not at all, and the password that makes that possible is asked for
 * here, in the foreground, at the moment of saving.
 *
 * Two fields, because decision D7 already settled the argument for a session locked item: this
 * password is the only way back in and there is no recovery, so a typo would lock the user out
 * of their own secret with nothing to show for it. Submit is disabled until both agree.
 *
 * Cancelling writes nothing. The alternative — saving the block as plaintext with a warning — is
 * a legitimate thing for a user to want, but it is the row's `Remove lock` action that says
 * "this is not a secret", which keeps the claim and the record in one place instead of letting a
 * dialog quietly persist a key under a label nobody read.
 */
function EncryptBeforeSaveDialog({
  blockLabel,
  password,
  confirm,
  busy,
  error,
  onPassword,
  onConfirm,
  onCancel,
  onSubmit,
}: EncryptBeforeSaveDialogProps) {
  const canSubmit = password !== '' && password === confirm

  return (
    <Modal
      opened
      onClose={busy ? () => undefined : onCancel}
      title={`Encrypt "${blockLabel}" before saving`}
      size="sm"
      centered
      padding="lg"
      withCloseButton={false}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit && !busy) onSubmit()
        }}
      >
        <Stack gap="md">
          <Text className="qrbit-text-body-secondary" c="dimmed">
            This block is marked as a secret but still holds plaintext, which means it is stored in
            the library as readable text. Choose a password and it will be saved as PBKDF2 +
            AES-256-GCM ciphertext instead. A lost password cannot be recovered, and nothing is
            written while this dialog is open.
          </Text>

          <TextInput
            size="sm"
            type="password"
            autoFocus
            label="Password for this block"
            styles={{ label: { fontWeight: 600 } }}
            autoComplete="new-password"
            value={password}
            disabled={busy}
            onChange={(event) => {
              onPassword(event.target.value)
            }}
          />
          <TextInput
            size="sm"
            type="password"
            label="Repeat the password"
            styles={{ label: { fontWeight: 600 } }}
            autoComplete="new-password"
            value={confirm}
            disabled={busy}
            onChange={(event) => {
              onConfirm(event.target.value)
            }}
          />

          {error !== null ? (
            <p
              className="qrbit-text-body-secondary"
              style={{ color: 'var(--qrbit-danger)' }}
              role="alert"
              data-encrypt-error="true"
            >
              {error}
            </p>
          ) : null}

          {/* Quiet then Primary, right-aligned (DESIGN.md, "Dialogs"). */}
          <Group justify="flex-end" gap="sm" wrap="wrap">
            {/*
              `c="dimmed"` is not a colour choice made here: it points the label at Mantine's
              `--mantine-color-dimmed` slot, which `theme.ts` bridges to `--qrbit-ink-secondary` in
              both schemes. Without it a `subtle` control takes its label from the primary ramp
              (`--button-color: var(--mantine-color-signal-light-color)` = signal-9, the foot of the
              accent's ramp, in the light scheme), which is not DESIGN.md's Quiet row and is why a
              "Cancel"-class control reads as a smudge on paper. The slot is reported to the theme
              lane; this prop is the semantic name, not a hand-painted value.
            */}
            <Button
              type="button"
              variant="subtle"
              c="dimmed"
              size="sm"
              disabled={busy}
              style={{ flex: 'none', maxWidth: '100%' }}
              onClick={onCancel}
            >
              Cancel the save
            </Button>
            <Button
              type="submit"
              size="sm"
              color="locked"
              loading={busy}
              disabled={!canSubmit}
              style={{ flex: 'none', maxWidth: '100%' }}
            >
              {busy ? 'Encrypting...' : 'Encrypt and save'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
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
 * web views — see `components/ConfirmDelete.tsx`) and a toast would not stop the departure, so
 * this is a real dialog. Escape and "Keep editing" both leave everything exactly as it is.
 */
function LeaveDraftDialog({
  dossierName,
  canSave,
  onCancel,
  onSaveAndLeave,
  onDiscard,
}: LeaveDraftDialogProps) {
  return (
    /*
     * A Mantine `Modal`: Escape cancels (D16.1's "keep editing"), the sheet carries
     * `--qrbit-shadow-sheet`, the title is the Title role, and focus returns to the Back control
     * that raised it. The destructive option is last in DOM order, so tab order meets the safe
     * controls first.
     */
    <Modal
      opened
      onClose={onCancel}
      title="Discard changes?"
      size="sm"
      centered
      padding="lg"
      withCloseButton={false}
    >
      <Stack gap="md">
        <Text className="qrbit-text-body-secondary" c="dimmed">
          &ldquo;{dossierName}&rdquo; has unsaved edits. Leaving now loses them.
        </Text>

        {/*
          Three actions, three DESIGN.md roles, and the row that holds them may wrap.

          `wrap="nowrap"` was the bug the owner saw as "texts on all of the buttons are partially
          cut off": a `size="sm"` sheet is 380px wide, its content box is 348px (316px on a 320px
          phone), and `Keep editing` + `Save & leave` + `Discard unsaved edits` want about 390px.
          In a nowrap row flex items shrink, and because Mantine's button root is
          `overflow: hidden` with a `white-space: nowrap` label, the shrink cut the words instead
          of moving them. `wrap="wrap"` plus `flex: none` on each control makes each one exactly
          as wide as its own words and lets the row become two lines instead.

          The roles are the hierarchy: Quiet for the answer that costs nothing, Primary for the
          one that keeps the work, and a Danger-labelled Default for the one that throws it away.
          The destructive option is deliberately not a second filled control — two filled buttons
          on one sheet is the same indistinguishability the top bar just had.
        */}
        <Group justify="flex-end" gap="sm" wrap="wrap">
          <Button
            variant="subtle"
            c="dimmed"
            size="sm"
            autoFocus
            style={{ flex: 'none', maxWidth: '100%' }}
            onClick={onCancel}
          >
            Keep editing
          </Button>
          <Button
            variant="filled"
            color="signal"
            size="sm"
            disabled={!canSave}
            style={{ flex: 'none', maxWidth: '100%' }}
            onClick={onSaveAndLeave}
          >
            Save &amp; leave
          </Button>
          {/* Names the consequence instead of promising a vague "Discard". */}
          <Button
            variant="default"
            c="danger"
            size="sm"
            style={{ flex: 'none', maxWidth: '100%' }}
            onClick={onDiscard}
          >
            Discard unsaved edits
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

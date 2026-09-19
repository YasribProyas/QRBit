/**
 * The library's new-item bar (PLAN.md §6.1, §6.4) — the offline creation row.
 *
 * It sits under the header in `LibraryBrowser`, beside '+ New Folder', and it is the answer
 * to a library that could only hold what someone sent you: every §6.1 item type can now be
 * made on this device, in the folder on screen, with no session, no signaling worker and no
 * network at all.
 *
 *   - `T` and `¶` open `TextComposeModal` / `RichTextComposeModal`, which reuse
 *     `components/session/items/`'s own editors — so a richtext note is stored as the same
 *     Tiptap JSON string `saveFromSession` writes (§6.1) and a locally authored note previews
 *     exactly like an imported one.
 *   - `🖼` and `📎` open the OS picker (`accept="image/*"` / `accept="*"`) and read the file
 *     through `File.arrayBuffer()` — the read is the check that the bytes are actually
 *     there, and it happens before anything is written. The name defaults to the filename
 *     and is editable in the step that follows, then the item stores the native `Blob` with
 *     `mimeType` and `size` taken from the `File`.
 *   - `🔒` reuses the in-session `LockedItemComposeModal` (D7's password typed twice, its
 *     no-recovery line, D6's 3 MiB plaintext cap) and encrypts here with
 *     `crypto.encryptItem`, so only `{ ciphertext, iv, salt }` reaches IndexedDB — the
 *     PBKDF2 key and the plaintext are never stored (§6.2, §19.3), and the plaintext buffer
 *     is zeroed as soon as the ciphertext exists.
 *
 * The one thing that must not be confused with `components/session/AddItemBar.tsx`, whose
 * iconography and aria-labels this bar copies deliberately so the two read as one product:
 * **this bar saves, it does not send.** Nothing here reaches a `PeerConnection`, and no
 * session state is touched — a library item is device-local data, which is the only thing
 * PLAN.md §17 allows into IndexedDB.
 *
 * Every write goes to `libraryStore.saveItem` (or the `onSaveItem` seam a caller supplies)
 * with a fresh `crypto.randomUUID()` and both timestamps set. The store re-reads IndexedDB
 * after a successful write, so the new row appears in the list without a refresh; a failed
 * one says so here and leaves the compose dialog open for a retry.
 */

import { useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import {
  IconBlockquote,
  IconLock,
  IconNotes,
  IconPaperclip,
  IconPhoto,
} from '@tabler/icons-react'
import { ROOT_FOLDER_ID } from '../../lib/library'
import type {
  LibraryFileItem,
  LibraryImageItem,
  LibraryItem,
  LibraryLockedItem,
  LibraryRichTextItem,
  LibraryTextItem,
} from '../../lib/library'
import { LOCKED_ITEM_MAX_PLAINTEXT_BYTES, encryptItem } from '../../lib/crypto'
import { useLibraryStore } from '../../store/libraryStore'
import { LockedItemComposeModal } from '../session/LockedItemComposeModal'
import type { LockedItemInput } from '../session/LockedItemComposeModal'
import { TextComposeModal } from './TextComposeModal'
import { RichTextComposeModal } from './RichTextComposeModal'

export interface NewItemBarProps {
  /** The folder new items belong to; `null` (and the root sentinel) is the tree's Root. */
  currentFolderId: string | null
  /** The same folder's name, for the compose dialogs to say where the item is going. */
  currentFolderName?: string
  /**
   * The save seam. Unset, as Home leaves it, the bar writes through
   * `libraryStore.saveItem`; a caller (or a test) that wants to see the §6.1 row first can
   * pass its own handler.
   */
  onSaveItem?: (item: LibraryItem) => Promise<void> | void
  /**
   * D6's plaintext cap for a locked item, forwarded to the compose modal and re-checked
   * before encrypting. Defaults to `crypto.ts`'s own constant so the number has one home.
   */
  maxLockedFileBytes?: number
}

/** A picked file, read and ready to store once the user has settled on a name. */
interface PendingFileDraft {
  blob: Blob
  mimeType: string
  size: number
  isImage: boolean
  defaultName: string
}

export function NewItemBar({
  currentFolderId,
  currentFolderName,
  onSaveItem,
  maxLockedFileBytes = LOCKED_ITEM_MAX_PLAINTEXT_BYTES,
}: NewItemBarProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [textOpen, setTextOpen] = useState(false)
  const [richTextOpen, setRichTextOpen] = useState(false)
  const [lockedOpen, setLockedOpen] = useState(false)
  const [pendingFile, setPendingFile] = useState<PendingFileDraft | null>(null)
  const [error, setError] = useState<string | null>(null)

  /*
   * The folder every row created here is filed under. The browser names the root two ways
   * — `null` for the tree's Root node, and the library layer's own sentinel for an item
   * that is uncategorised — and §6.1 letters `folderId` as a string, so both spellings
   * collapse to the sentinel here rather than in four save handlers.
   */
  const targetFolderId =
    currentFolderId === null || currentFolderId === ROOT_FOLDER_ID
      ? ROOT_FOLDER_ID
      : currentFolderId

  /**
   * Hands one finished §6.1 row to the save seam.
   *
   * The failure is recorded here AND rethrown: rethrowing is what keeps the compose dialog
   * open with its draft intact (every modal catches it), and the message staying up after
   * the user gives up is the point — an item that is not in the library was not saved, and
   * silence would read as success.
   */
  const doSave = async (item: LibraryItem): Promise<void> => {
    setError(null)
    try {
      if (onSaveItem) {
        await onSaveItem(item)
      } else {
        await useLibraryStore.getState().saveItem(item)
      }
    } catch (cause: unknown) {
      setError(
        cause instanceof Error && cause.message.trim() !== ''
          ? cause.message
          : 'Could not save the item.',
      )
      throw cause
    }
  }

  const handleSaveText = async (name: string, content: string): Promise<void> => {
    const now = Date.now()
    const item: LibraryTextItem = {
      id: globalThis.crypto.randomUUID(),
      folderId: targetFolderId,
      name,
      type: 'text',
      content,
      createdAt: now,
      updatedAt: now,
    }
    await doSave(item)
  }

  const handleSaveRichText = async (name: string, content: string): Promise<void> => {
    const now = Date.now()
    const item: LibraryRichTextItem = {
      id: globalThis.crypto.randomUUID(),
      folderId: targetFolderId,
      name,
      type: 'richtext',
      content,
      createdAt: now,
      updatedAt: now,
    }
    await doSave(item)
  }

  /**
   * Reads what the picker chose and opens the name step.
   *
   * The read is the gate: a file that cannot be read is refused here rather than stored as
   * an empty row, and `size`/`mimeType` come from the `File` itself (PLAN.md §6.1). A
   * browser that cannot guess a type at all leaves `File.type` blank, and an item with no
   * type cannot be previewed or handed to a download, so the picker's own accept filter
   * decides the fallback. The `File` handle is then dropped: the bytes are in the blob.
   */
  const preparePickedFile = async (
    event: ChangeEvent<HTMLInputElement>,
    isImage: boolean,
  ): Promise<void> => {
    const file = event.currentTarget.files?.[0]
    // Cleared so picking the same file twice in a row still fires a change.
    event.currentTarget.value = ''
    if (!file) return

    try {
      const buffer = await readFileAsArrayBuffer(file)
      const mimeType = file.type || (isImage ? 'image/png' : 'application/octet-stream')
      const blob = new Blob([buffer], { type: mimeType })
      setPendingFile({
        blob,
        mimeType,
        size: blob.size,
        isImage,
        defaultName: file.name,
      })
      setError(null)
    } catch (cause: unknown) {
      setError(
        cause instanceof Error && cause.message.trim() !== ''
          ? cause.message
          : `Could not read the ${isImage ? 'image' : 'file'}.`,
      )
    }
  }

  const handleImageSelected = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    await preparePickedFile(event, true)
  }

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    await preparePickedFile(event, false)
  }

  const handleSaveLocked = async (input: LockedItemInput): Promise<string> => {
    /*
     * The compose modal already refuses content over D6's cap; this is the second gate, so
     * a locked row can only ever be written with plaintext that fits, whoever called it.
     */
    let plaintext: Uint8Array
    if (input.innerType === 'file') {
      if (!(input.content instanceof File)) {
        throw new Error('A locked file item needs a File to encrypt')
      }
      if (input.content.size > maxLockedFileBytes) {
        throw new Error(
          `That file is too large: a locked item carries at most ${formatBytes(maxLockedFileBytes)}.`,
        )
      }
      const buffer = await readFileAsArrayBuffer(input.content)
      plaintext = new Uint8Array(buffer)
    } else {
      if (typeof input.content !== 'string') {
        throw new Error(`A locked ${input.innerType} item needs a string to encrypt`)
      }
      plaintext = new TextEncoder().encode(input.content)
      if (plaintext.byteLength > maxLockedFileBytes) {
        throw new Error(
          `That content is too large: a locked item carries at most ${formatBytes(maxLockedFileBytes)}.`,
        )
      }
    }

    let encrypted: { ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }
    try {
      encrypted = await encryptItem(input.password, plaintext)
    } finally {
      plaintext.fill(0)
    }

    const now = Date.now()
    const id = globalThis.crypto.randomUUID()
    const lockedItem: LibraryLockedItem = {
      id,
      folderId: targetFolderId,
      name: input.label.trim() || 'Locked item',
      type: 'locked',
      label: input.label.trim(),
      innerType: input.innerType,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      salt: encrypted.salt,
      createdAt: now,
      updatedAt: now,
    }

    await doSave(lockedItem)
    return id
  }

  return (
    <>
      <div className="add-item-bar new-item-bar" role="toolbar" aria-label="Add to library">
        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add text item"
          title="Text"
          onClick={() => {
            setTextOpen(true)
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconNotes size={18} />
          <span style={{ display: 'none' }}>T</span>
        </button>

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add rich text item"
          title="Rich text"
          onClick={() => {
            setRichTextOpen(true)
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconBlockquote size={18} />
          <span style={{ display: 'none' }}>¶</span>
        </button>

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add images"
          title="Image"
          onClick={() => {
            imageInputRef.current?.click()
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconPhoto size={18} />
          <span style={{ display: 'none' }}>🖼</span>
        </button>
        <input
          ref={imageInputRef}
          className="add-item-bar__image-input"
          type="file"
          accept="image/*"
          hidden
          tabIndex={-1}
          onChange={handleImageSelected}
        />

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add files"
          title="File"
          onClick={() => {
            fileInputRef.current?.click()
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconPaperclip size={18} />
          <span style={{ display: 'none' }}>📎</span>
        </button>
        <input
          ref={fileInputRef}
          className="add-item-bar__file-input"
          type="file"
          accept="*"
          hidden
          tabIndex={-1}
          onChange={handleFileSelected}
        />

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add locked item"
          title="Locked item"
          onClick={() => {
            setLockedOpen(true)
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconLock size={18} />
          <span style={{ display: 'none' }}>🔒</span>
        </button>

        <p className="add-item-bar__hint muted">
          Saved items are stored in your library on this device — nothing is sent anywhere
        </p>
        <p className="add-item-bar__hint new-item-bar__locked-hint muted">
          <IconLock size={14} color="#f87171" style={{ verticalAlign: 'middle', marginRight: '4px' }} />
          <span style={{ display: 'none' }}>🔒 </span>
          There is no recovery for a locked item: lose its password and it is unreadable for good
        </p>
      </div>

      {error !== null ? (
        <p className="new-item-bar__error item-error" role="alert">
          {error}
        </p>
      ) : null}

      {textOpen ? (
        <TextComposeModal
          folderName={currentFolderName}
          onSave={handleSaveText}
          onClose={() => {
            setTextOpen(false)
          }}
        />
      ) : null}

      {richTextOpen ? (
        <RichTextComposeModal
          folderName={currentFolderName}
          onSave={handleSaveRichText}
          onClose={() => {
            setRichTextOpen(false)
          }}
        />
      ) : null}

      {lockedOpen ? (
        <LockedItemComposeModal
          onAdd={handleSaveLocked}
          title="Save a locked item"
          submitLabel="Save to library"
          onClose={() => {
            setLockedOpen(false)
          }}
          maxFileBytes={maxLockedFileBytes}
        />
      ) : null}

      {pendingFile !== null ? (
        <FileSaveModal
          draft={pendingFile}
          folderName={currentFolderName}
          onSave={async (name) => {
            const now = Date.now()
            const item: LibraryImageItem | LibraryFileItem = {
              id: globalThis.crypto.randomUUID(),
              folderId: targetFolderId,
              name,
              type: pendingFile.isImage ? 'image' : 'file',
              blob: pendingFile.blob,
              mimeType: pendingFile.mimeType,
              size: pendingFile.size,
              createdAt: now,
              updatedAt: now,
            }
            await doSave(item)
            setPendingFile(null)
          }}
          onClose={() => {
            setPendingFile(null)
          }}
        />
      ) : null}
    </>
  )
}

interface FileSaveModalProps {
  draft: PendingFileDraft
  folderName?: string
  onSave: (name: string) => Promise<void> | void
  onClose: () => void
}

function FileSaveModal({ draft, folderName, onSave, onClose }: FileSaveModalProps) {
  const [name, setName] = useState(draft.defaultName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Latch beside `busy` — see `TextComposeModal` on storing the same file twice. */
  const inFlight = useRef(false)

  const trimmed = name.trim()

  const submit = async (): Promise<void> => {
    if (inFlight.current || busy || trimmed === '') return

    inFlight.current = true
    setBusy(true)
    setError(null)

    try {
      await onSave(trimmed)
    } catch (cause: unknown) {
      inFlight.current = false
      setBusy(false)
      const detail = cause instanceof Error && cause.message.trim() !== '' ? ` (${cause.message})` : ''
      setError(`Could not save the ${draft.isImage ? 'image' : 'file'}${detail}.`)
    }
  }

  return (
    <div
      className="library-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-save-title"
    >
      <form
        className="library-modal__panel"
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2 className="library-modal__title" id="file-save-title">
          Save {draft.isImage ? 'image' : 'file'}{folderName ? ` in ${folderName}` : ''}
        </h2>

        <label className="library-modal__field">
          <span className="library-modal__field-label">Name</span>
          <input
            className="library-modal__input"
            type="text"
            value={name}
            aria-label="Name"
            autoComplete="off"
            autoFocus
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </label>

        <p className="library-modal__hint muted">
          {formatBytes(draft.size)} · {draft.mimeType}
        </p>

        {error !== null ? (
          <p className="library-modal__error item-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="library-modal__actions">
          <button
            type="submit"
            className="button library-modal__submit"
            disabled={busy || trimmed === ''}
          >
            {busy ? 'Saving…' : 'Save to library'}
          </button>
          <button
            type="button"
            className="button library-modal__cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Reads the picked file before anything is written.
 *
 * §6.1 stores a `Blob`, so the bytes are taken once and held as a Blob rather than as a
 * `File` handle: a handle can go stale (the picker's backing file changes, the tab is a
 * service-worker hand-off) and a row that stores nothing readable is worse than a failed
 * save that says so.
 */
async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return await file.arrayBuffer()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

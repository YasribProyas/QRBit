/**
 * Add item bar (PLAN.md §9: "Add item bar (sender only)").
 *
 * Six actions are specified there — T text, ¶ rich text, 🖼 image, 📎 file,
 * 🔒 locked, 📚 from library — and all six exist now:
 *
 *   - 🔒 opens the Phase 4 compose modal (label, inner type, password twice,
 *     content). The bar only opens it: the modal owns the draft and calls
 *     `addLockedItem`, which encrypts and sends.
 *   - 📚 opens the Phase 5 library sheet: folders on top (PLAN.md §6.4's tree as a
 *     picker), the chosen folder's items below, and tapping an item sends it through
 *     `sendLibraryItem` immediately. The sheet stays open, so a user can send several
 *     items in a row, and it shows 'Sent' against what has already gone.
 *
 * Every action calls the items API and the new item appears on the board through
 * the store immediately — the bar never writes item state itself.
 *
 * The sheet is the only place in this file that knows about the library store, and it
 * does so as the store's consumer: `useLibraryStore` is the UI's one route to
 * IndexedDB, so the sheet lists folders and items through it and asks it to refresh.
 * The items themselves are handed back as data — this component never touches the
 * IndexedDB layer, and never knows that the library has one.
 */

import { useEffect, useRef, useState } from 'react'
import {
  IconBlockquote,
  IconBooks,
  IconLock,
  IconNotes,
  IconPaperclip,
  IconPhoto,
} from '@tabler/icons-react'
import type { ItemsApi } from './SessionBoard'
import { LockedItemComposeModal } from './LockedItemComposeModal'
import type { LockedItemInput } from './LockedItemComposeModal'
import { FolderPicker } from '../library/FolderPicker'
import { itemsInFolder } from '../../lib/folders'
import { ITEM_TYPE_ICONS } from '../../lib/itemType'
import type { LibraryItem } from '../../lib/library'
import { useLibraryStore } from '../../store/libraryStore'
import { fileBlocksToLibraryItems } from '../../lib/dossier'

/**
 * What this bar needs from the items API: the three add methods the board also
 * declares, the Phase 4 locked-item add (which encrypts before it sends and
 * therefore resolves asynchronously), and the Phase 5 library send.
 */
export type AddItemBarApi = Pick<ItemsApi, 'addTextItem' | 'addRichTextItem' | 'addFileItem'> & {
  addLockedItem: (input: LockedItemInput) => Promise<string>
  /** Sends one library item as session traffic (PLAN.md §7, decision D8). */
  sendLibraryItem: (item: LibraryItem) => void
}

export interface AddItemBarProps {
  /** Only the add methods are used here; the rest of the API belongs to the board. */
  api: AddItemBarApi
  /**
   * D6's plaintext cap for a locked file item, forwarded to the compose modal.
   * Left unset by default so the modal's own D6 default applies; a caller that has
   * `crypto.ts`'s constant can pass it here to keep one source for the number.
   */
  maxLockedFileBytes?: number
}

export function AddItemBar({ api, maxLockedFileBytes }: AddItemBarProps) {
  const imageInput = useRef<HTMLInputElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [lockedComposeOpen, setLockedComposeOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)

  /** Multi-select fans out to one item per file (PLAN.md §9: items are independent). */
  const addAll = (files: FileList | null): void => {
    if (files === null) return
    for (const file of Array.from(files)) {
      api.addFileItem(file)
    }
  }

  return (
    <>
      <div className="add-item-bar" role="toolbar" aria-label="Add item">
        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add text item"
          title="Text"
          onClick={() => {
            api.addTextItem()
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
            api.addRichTextItem()
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
            imageInput.current?.click()
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconPhoto size={18} />
          <span style={{ display: 'none' }}>🖼</span>
        </button>
        <input
          ref={imageInput}
          className="add-item-bar__image-input"
          type="file"
          accept="image/*"
          multiple
          hidden
          tabIndex={-1}
          onChange={(event) => {
            addAll(event.currentTarget.files)
            // Cleared so picking the same file twice in a row still fires a change.
            event.currentTarget.value = ''
          }}
        />

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add files"
          title="File"
          onClick={() => {
            fileInput.current?.click()
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconPaperclip size={18} />
          <span style={{ display: 'none' }}>📎</span>
        </button>
        <input
          ref={fileInput}
          className="add-item-bar__file-input"
          type="file"
          multiple
          hidden
          tabIndex={-1}
          onChange={(event) => {
            addAll(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add locked item"
          title="Locked item"
          onClick={() => {
            setLockedComposeOpen(true)
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconLock size={18} />
          <span style={{ display: 'none' }}>🔒</span>
        </button>

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Send from library"
          title="From library"
          onClick={() => {
            setLibraryOpen(true)
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconBooks size={18} />
          <span style={{ display: 'none' }}>📚</span>
        </button>
        <p className="add-item-bar__hint muted">
          <IconLock size={14} color="#f87171" style={{ verticalAlign: 'middle', marginRight: '4px' }} />
          <span style={{ display: 'none' }}>🔒 </span>
          locked items also need a password to open — the label stays visible
        </p>
      </div>

      {/*
        Outside the toolbar: it is a modal dialog covering the page, not another
        control in the bar. Mounted only while open so the draft (and the password
        in it) exists for as long as the user is composing and no longer.
      */}
      {lockedComposeOpen ? (
        <LockedItemComposeModal
          onAdd={api.addLockedItem}
          onClose={() => {
            setLockedComposeOpen(false)
          }}
          maxFileBytes={maxLockedFileBytes}
        />
      ) : null}

      {/* Mounted only while open, so a closed sheet holds no library data at all. */}
      {libraryOpen ? (
        <LibrarySendSheet
          onSend={api.sendLibraryItem}
          onClose={() => {
            setLibraryOpen(false)
          }}
        />
      ) : null}
    </>
  )
}

export interface LibrarySendSheetProps {
  /** Called once per tap, with the item whose row was tapped. */
  onSend: (item: LibraryItem) => void
  onClose: () => void
}

/**
 * The 📚 sheet (PLAN.md §9/§16 Phase 5).
 *
 * Lightweight on purpose: the folder tree picks a source folder and the list below
 * shows that folder's items, so one tap is one send. There is no rename, move or
 * delete here — managing the library is the Home screen's job — and nothing is
 * selected-then-confirmed: the tap IS the send, which is what makes tapping three
 * items in a row work.
 *
 * The folders and items are the store's, refreshed on mount because a session page can
 * be the first screen this tab opened (a scanned `/session?code=…` URL never renders
 * Home). The 'Sent' badge is this sheet's own memory of what it has handed over — it
 * marks a row, it never gates a second send of the same item, which is a legitimate
 * thing to ask for.
 */
export function LibrarySendSheet({ onSend, onClose }: LibrarySendSheetProps) {
  const folders = useLibraryStore((state) => state.folders)
  const items = useLibraryStore((state) => state.items)
  const loading = useLibraryStore((state) => state.loading)
  const error = useLibraryStore((state) => state.error)
  const refresh = useLibraryStore((state) => state.refresh)

  /** The folder whose items are listed; `null` is the tree's Root. */
  const [folderId, setFolderId] = useState<string | null>(null)
  const [sentIds, setSentIds] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const listed = itemsInFolder(items, folders, folderId)

  /**
   * Hands one item to the session. A rejection here is the API's (a stored locked tuple
   * over D6's cap) — it belongs to this row, not to the session, so it is reported in
   * the sheet and the session is left alone.
   */
  const send = (item: LibraryItem): void => {
    try {
      onSend(item)
    } catch (cause: unknown) {
      setProblem(cause instanceof Error && cause.message.trim() !== '' ? cause.message : 'That item could not be sent.')
      return
    }

    setProblem(null)
    setSentIds((ids) => (ids.includes(item.id) ? ids : [...ids, item.id]))
  }

  return (
    <div
      className="library-modal library-modal--send"
      role="dialog"
      aria-modal="true"
      aria-labelledby="library-send-title"
    >
      <div className="library-modal__panel">
        <h2 className="library-modal__title" id="library-send-title">
          Send from library
        </h2>
        <p className="library-modal__hint muted">
          Tap an item to send it. Send as many as you like — nothing leaves this browser
          until you tap.
        </p>

        <FolderPicker folders={folders} value={folderId} onChange={setFolderId} label="Library folder" />

        {loading ? (
          <p className="library-modal__empty muted" role="status">
            Loading your library…
          </p>
        ) : listed.length === 0 ? (
          <p className="library-modal__empty muted">Nothing in this folder.</p>
        ) : (
          <ul className="library-modal__items">
            {listed.map((item) => (
              <li className="library-modal__item" key={item.id}>
                <span className="library-item__icon" aria-hidden="true">
                  {ITEM_TYPE_ICONS[item.type]}
                </span>
                <button
                  type="button"
                  className="button button--link library-modal__item-name library-send__item"
                  onClick={() => {
                    send(item)
                  }}
                >
                  {item.name}
                </button>
                {sentIds.includes(item.id) ? (
                  <span className="badge library-modal__saved">Sent</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {error !== null ? (
          <p className="library-modal__error item-error" role="alert">
            {error}
          </p>
        ) : null}

        {problem !== null ? (
          <p className="library-modal__error item-error" role="alert">
            {problem}
          </p>
        ) : null}

        <div className="library-modal__actions">
          <button type="button" className="button library-modal__done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

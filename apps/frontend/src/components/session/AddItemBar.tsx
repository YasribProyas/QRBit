/**
 * Add item bar (PLAN.md §9: "Add item bar (sender only)").
 *
 * Six actions are specified there — text, rich text, image, file, locked, and from
 * library — and all six exist now, each as one icon-only `ActionIcon` with an `aria-label`:
 *
 *   - Locked opens the Phase 4 compose modal (label, inner type, password twice,
 *     content). The bar only opens it: the modal owns the draft and calls
 *     `addLockedItem`, which encrypts and sends.
 *   - From library opens the Phase 5 library sheet: folders on top (PLAN.md §6.4's tree as a
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
import type { ReactElement, ReactNode } from 'react'
import { ActionIcon, Badge, Button, Group, Text } from '@mantine/core'
import {
  IconBlockquote,
  IconBooks,
  IconLock,
  IconNotes,
  IconPaperclip,
  IconPhoto,
} from '@tabler/icons-react'
import { WithMantine } from '../common/WithMantine'
import type { ItemsApi } from './SessionBoard'
import { LockedItemComposeModal } from './LockedItemComposeModal'
import type { LockedItemInput } from './LockedItemComposeModal'
import { FolderPicker } from '../library/FolderPicker'
import { itemsInFolder } from '../../lib/folders'
import { ITEM_TYPE_ICONS, ITEM_TYPE_MARK_STYLE } from '../../lib/itemType'
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

export function AddItemBar(props: AddItemBarProps) {
  return (
    <WithMantine>
      <AddItemBarInner {...props} />
    </WithMantine>
  )
}

/**
 * One affordance in the bar: an icon-only `ActionIcon` with a 44px box (DESIGN.md's touch
 * minimum — this is tapped on a phone while the other phone is being aimed) and a real
 * `aria-label`, which is also what the tests and the screen reader both read.
 */
function AddItemBarInner({ api, maxLockedFileBytes }: AddItemBarProps) {
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

  const addAction = (label: string, icon: ReactNode, onClick: () => void): ReactElement => (
    <ActionIcon
      key={label}
      variant="default"
      size="md"
      radius="sm"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {icon}
    </ActionIcon>
  )

  return (
    <>
      <Group
        className="add-item-bar"
        role="toolbar"
        aria-label="Add item"
        gap="sm"
        wrap="wrap"
        align="center"
      >
        {addAction(
          'Add text item',
          <IconNotes size={20} aria-hidden="true" />, () => {
            api.addTextItem()
          },
        )}
        {addAction(
          'Add rich text item',
          <IconBlockquote size={20} aria-hidden="true" />, () => {
            api.addRichTextItem()
          },
        )}
        {addAction(
          'Add images',
          <IconPhoto size={20} aria-hidden="true" />, () => {
            imageInput.current?.click()
          },
        )}
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
        {addAction(
          'Add files',
          <IconPaperclip size={20} aria-hidden="true" />, () => {
            fileInput.current?.click()
          },
        )}
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
        {addAction(
          'Add locked item',
          <IconLock size={20} aria-hidden="true" />, () => {
            setLockedComposeOpen(true)
          },
        )}
        {addAction(
          'Send from library',
          <IconBooks size={20} aria-hidden="true" />, () => {
            setLibraryOpen(true)
          },
        )}
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconLock size={15} aria-hidden="true" style={{ color: 'var(--qrbit-locked)', flex: 'none' }} />
          <Text component="span" size="xs" c="dimmed">
            Locked items need a password to open; the label stays visible.
          </Text>
        </Group>
      </Group>

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
 * The "from library" sheet (PLAN.md §9/§16 Phase 5).
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
export function LibrarySendSheet(props: LibrarySendSheetProps) {
  return (
    <WithMantine>
      <LibrarySendSheetInner {...props} />
    </WithMantine>
  )
}

function LibrarySendSheetInner({ onSend, onClose }: LibrarySendSheetProps) {
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
        <h2
          className="library-modal__title"
          id="library-send-title"
          // Title role (15/600), not the shell class's off-scale 17px.
          style={{ font: 'var(--qrbit-text-title)', letterSpacing: 'var(--qrbit-text-title-tracking)' }}
        >
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
            {listed.map((item) => {
              const { Icon, label } = ITEM_TYPE_ICONS[item.type]

              return (
                <li className="library-modal__item" key={item.id}>
                  {/* Glyph decorative, word carries the name — see lib/itemType.ts. */}
                  <span className="library-item__icon" style={ITEM_TYPE_MARK_STYLE}>
                    <Icon size={16} aria-hidden="true" />
                    <Text span className="qrbit-text-label" c="dimmed">
                      {label}
                    </Text>
                  </span>
                  <Button
                    type="button"
                    className="library-modal__item-name library-send__item"
                    variant="subtle"
                    size="xs"
                    justify="flex-start"
                    style={{ flex: '1 1 auto', minWidth: 0 }}
                    onClick={() => {
                      send(item)
                    }}
                  >
                    {item.name}
                  </Button>
                  {sentIds.includes(item.id) ? (
                    <Badge className="library-modal__saved" variant="light" color="success" radius="full" ff="sans">
                      Sent
                    </Badge>
                  ) : null}
                </li>
              )
            })}
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
          <Button
            type="button"
            className="library-modal__done"
            variant="default"
            size="sm"
            fullWidth
            onClick={onClose}
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * One library item row (PLAN.md §6.4, §16 Phase 5).
 *
 * The item types below are a structural mirror of the PLAN.md §6.1 types that
 * `lib/library.ts` owns. These components take everything as props and never import the
 * IndexedDB layer — the store is the UI's only route to it — so the shapes are restated
 * instead. They are field-for-field identical, which is what lets the store's real
 * `LibraryItem` values satisfy these props without a cast; because the check is
 * structural, a drift in either definition fails to compile at the page that wires them
 * rather than mismatching silently.
 *
 * The row is presentational plus three things only it can own:
 *
 *   - the expanded preview. Tapping a text/richtext item shows it inline, an image
 *     shows a thumbnail, a file offers a download (PLAN.md §6.4). The object URLs
 *     behind the thumbnail and the download are created when the preview mounts and
 *     revoked when it unmounts — collapsing the row, re-locking it or leaving the
 *     page all take that path.
 *   - the `···` menu (rename, move, send, delete) and the inline rename.
 *   - the unlock of a locked item. PLAN.md §6.4: tap → password prompt → reveal
 *     inline, then 'Lock again' to re-hide. The library is not session-scoped, so
 *     the row owns its own unlock and calls PLAN.md §11.4 crypto directly. Nothing
 *     the password protects is persisted: the item keeps `{ciphertext, iv, salt}`
 *     (§6.2) and the decrypted plaintext lives in this component's state until
 *     'Lock again' or unmount, at which point it is gone. The decrypted bytes are
 *     zeroed as soon as the reveal is built from them.
 *
 * `LibraryLockedItem` has both a `name` (the base, user-editable field every item
 * has) and a `label` (§9's session field, which is the plaintext name of the locked
 * payload). The row shows `name`; PLAN.md §6.1 does not say the label is shown
 * anywhere in the library, and after a rename the two legitimately differ.
 *
 * Two session components are reused rather than reimplemented: `UnlockModal` already
 * is the one password prompt in the app (spinner during the ~300ms PBKDF2, the
 * wrong-password error, the cleared field), and `RichTextItem` is the app's only
 * richtext renderer. Neither touches session state; they take props and callbacks.
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react'
import {
  IconDotsVertical,
  IconFileText,
  IconLock,
  IconNotes,
  IconPaperclip,
  IconPhoto,
} from '@tabler/icons-react'
import { decryptItem } from '../../lib/crypto'
import { UnlockModal } from '../session/UnlockModal'
import { RichTextItem } from '../session/items/RichTextItem'
import type { RichTextItemViewProps } from '../session/items/RichTextItem'
import { FolderPicker } from './FolderNode'
import type { LibraryFolder } from './FolderNode'

// ---------------------------------------------------------------------------
// Types (mirror of PLAN.md §6.1 — see the file header)
// ---------------------------------------------------------------------------

export type LibraryItemType = 'text' | 'richtext' | 'image' | 'file' | 'locked'

export interface LibraryItemBase {
  id: string
  /** The containing folder's id; the library layer's root sentinel for an uncategorized item. */
  folderId: string
  /** Display name, user-editable. */
  name: string
  type: LibraryItemType
  createdAt: number
  updatedAt: number
}

export interface LibraryTextItem extends LibraryItemBase {
  type: 'text'
  content: string
}

export interface LibraryRichTextItem extends LibraryItemBase {
  type: 'richtext'
  /** Tiptap JSON, the same representation the session uses (PLAN.md §9/§10). */
  content: string
}

export interface LibraryImageItem extends LibraryItemBase {
  type: 'image'
  blob: Blob
  mimeType: string
  size: number
}

export interface LibraryFileItem extends LibraryItemBase {
  type: 'file'
  blob: Blob
  mimeType: string
  size: number
}

export interface LibraryLockedItem extends LibraryItemBase {
  type: 'locked'
  /** §9's label: the plaintext name of the encrypted payload. */
  label: string
  innerType: 'text' | 'richtext' | 'file'
  ciphertext: Uint8Array
  iv: Uint8Array
  salt: Uint8Array
}

export type LibraryItem =
  | LibraryTextItem
  | LibraryRichTextItem
  | LibraryImageItem
  | LibraryFileItem
  | LibraryLockedItem

// ---------------------------------------------------------------------------

/**
 * PLAN.md §6.4's type icons. Exported so the save-to-library dialog names the same
 * types with the same glyphs; an item is an item wherever it is listed.
 */
export const ITEM_TYPE_ICONS: Record<LibraryItemType, string> = {
  text: '¶',
  richtext: '✎',
  image: '🖼',
  file: '📎',
  locked: '🔒',
}

/** How long a press must last to mean "select" rather than "open" (PLAN.md §6.4). */
export const LONG_PRESS_MS = 500

export interface LibraryItemRowProps {
  item: LibraryItem
  /** Every folder, for the Move picker's tree. */
  folders: LibraryFolder[]
  /** True while the browser is in multi-select mode (PLAN.md §6.4). */
  selectionMode: boolean
  /** True while this item is part of the current selection. */
  selected: boolean
  onToggleSelected: (id: string) => void
  /** Long-press, right-click or shift-click: enter selection mode on this row. */
  onEnterSelectionMode: (id: string) => void
  /** The `···` menu took over, so the browser leaves multi-select (PLAN.md §6.4). */
  onOpenMenu: () => void
  onRename: (id: string, name: string) => void
  /** `targetFolderId: null` is the tree's Root; the page maps it to the store's sentinel id. */
  onMove: (id: string, targetFolderId: string | null) => void
  onDelete: (id: string) => void
  onSend: (id: string) => void
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const MONTH_MS = 30 * DAY_MS

/**
 * PLAN.md §6.4's "2h ago". Unit-switching is monotone and locale-free: a
 * `toLocaleString` would render differently per device and cannot be tested
 * deterministically. A timestamp in the future (a clock that moved back) reads as
 * "just now" rather than a negative age.
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const elapsed = now - timestamp
  if (elapsed < MINUTE_MS) return 'just now'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`
  if (elapsed < MONTH_MS) return `${Math.floor(elapsed / WEEK_MS)}w ago`
  return `${Math.floor(elapsed / MONTH_MS)}mo ago`
}

/** What an unlocked locked item shows inline; `null` means "locked again". */
type LockedReveal =
  | { kind: 'text'; text: string }
  | { kind: 'richtext'; json: string }
  | { kind: 'file'; blob: Blob }

function ItemTypeSvgIcon({ type }: { type: LibraryItemType }) {
  switch (type) {
    case 'text':
      return <IconNotes size={16} color="#4ade80" style={{ verticalAlign: 'middle' }} />
    case 'richtext':
      return <IconFileText size={16} color="#60a5fa" style={{ verticalAlign: 'middle' }} />
    case 'image':
      return <IconPhoto size={16} color="#f472b6" style={{ verticalAlign: 'middle' }} />
    case 'file':
      return <IconPaperclip size={16} color="#fbbf24" style={{ verticalAlign: 'middle' }} />
    case 'locked':
      return <IconLock size={16} color="#f87171" style={{ verticalAlign: 'middle' }} />
  }
}

export function LibraryItemRow({
  item,
  folders,
  selectionMode,
  selected,
  onToggleSelected,
  onEnterSelectionMode,
  onOpenMenu,
  onRename,
  onMove,
  onDelete,
  onSend,
}: LibraryItemRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(item.name)
  const [moving, setMoving] = useState(false)
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [revealed, setRevealed] = useState<LockedReveal | null>(null)

  const longPressTimer = useRef<number | null>(null)
  /*
   * Set when the long-press fires so the click that ends the same gesture does not
   * also run the tap action (which would toggle the selection straight back off).
   * Cleared at the start of the next press; a touch long-press that produces no
   * click at all therefore costs nothing.
   */
  const longPressFired = useRef(false)

  useEffect(() => {
    return () => {
      if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current)
    }
  }, [])

  const startLongPress = (): void => {
    longPressFired.current = false
    if (selectionMode || longPressTimer.current !== null) return
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null
      longPressFired.current = true
      onEnterSelectionMode(item.id)
    }, LONG_PRESS_MS)
  }

  const cancelLongPress = (): void => {
    if (longPressTimer.current === null) return
    window.clearTimeout(longPressTimer.current)
    longPressTimer.current = null
  }

  const tap = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (longPressFired.current) {
      longPressFired.current = false
      return
    }
    if (selectionMode) {
      onToggleSelected(item.id)
      return
    }
    // Desktop's alternative to holding a finger down (PLAN.md §6.4).
    if (event.shiftKey) {
      onEnterSelectionMode(item.id)
      return
    }
    if (item.type === 'locked') {
      // The prompt is the only way to the plaintext. An already-revealed item folds
      // away without re-locking: folding is display state, and the reveal stays the
      // only copy of the plaintext until 'Lock again' or unmount drops it.
      if (revealed === null) setUnlockOpen(true)
      else setExpanded(!expanded)
      return
    }
    setExpanded(!expanded)
  }

  const openMenu = (): void => {
    onOpenMenu()
    setMenuOpen(!menuOpen)
  }

  const closeMenu = (): void => {
    setMenuOpen(false)
  }

  const startRename = (): void => {
    setDraftName(item.name)
    setRenaming(true)
    closeMenu()
  }

  const commitRename = (): void => {
    const name = draftName.trim()
    if (name === '') return
    onRename(item.id, name)
    setRenaming(false)
  }

  const startMove = (): void => {
    setMoving(true)
    closeMenu()
  }

  /**
   * Opens the item with the typed password (PLAN.md §11.4).
   *
   * `true` reveals, `false` means this password does not open this item, and a
   * rejection is a real failure (the row has no locked ciphertext) that the modal
   * reports as such instead of dressing it up as a wrong password. The decrypted
   * bytes become the reveal and are zeroed on the way; nothing derived from the
   * password is kept.
   */
  const unlockWith = async (password: string): Promise<boolean> => {
    if (item.type !== 'locked') return false

    let decrypted: Uint8Array
    try {
      decrypted = await decryptItem(password, item.salt, item.iv, item.ciphertext)
    } catch (error: unknown) {
      if (isFailedDecryption(error)) return false
      throw error
    }

    setRevealed(revealFromDecrypted(item.innerType, decrypted))
    setExpanded(true)
    return true
  }

  const lockAgain = (): void => {
    setRevealed(null)
    setExpanded(false)
  }

  const locked = item.type === 'locked'
  const previewOpen = expanded && !selectionMode

  return (
    <li className="library-item" data-selected={selected ? 'true' : undefined}>
      <div
        className="library-item__row"
        onPointerDown={startLongPress}
        onPointerUp={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onContextMenu={(event) => {
          event.preventDefault()
          onEnterSelectionMode(item.id)
        }}
      >
        {selectionMode ? (
          <input
            type="checkbox"
            className="library-item__checkbox"
            checked={selected}
            aria-label={`Select ${item.name}`}
            onChange={() => {
              onToggleSelected(item.id)
            }}
          />
        ) : null}

        <span className="library-item__icon" aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <ItemTypeSvgIcon type={item.type} />
          <span style={{ display: 'none' }}>{ITEM_TYPE_ICONS[item.type]}</span>
        </span>

        {renaming ? (
          <form
            className="library-item__rename"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              commitRename()
            }}
          >
            <input
              className="library-item__rename-input"
              type="text"
              value={draftName}
              aria-label={`Rename ${item.name}`}
              autoFocus
              onChange={(event) => {
                setDraftName(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setRenaming(false)
              }}
            />
            <button
              type="submit"
              className="button button--link library-item__rename-save"
              disabled={draftName.trim() === ''}
            >
              Save
            </button>
            <button
              type="button"
              className="button button--link library-item__rename-cancel"
              onClick={() => {
                setRenaming(false)
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="library-item__name" onClick={tap}>
            {item.name}
          </button>
        )}

        {locked ? <span className="badge library-item__lock-badge">Locked</span> : null}

        {locked && revealed !== null ? (
          <button
            type="button"
            className="button button--link library-item__lock-again"
            onClick={lockAgain}
          >
            Lock again
          </button>
        ) : null}

        <span className="library-item__updated muted">
          {formatRelativeTime(item.updatedAt, Date.now())}
        </span>

        <button
          type="button"
          className="library-item__menu-toggle"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Actions for ${item.name}`}
          onClick={openMenu}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconDotsVertical size={16} style={{ verticalAlign: 'middle' }} />
          <span style={{ display: 'none' }}>···</span>
        </button>
      </div>

      {menuOpen ? (
        <div className="library-item__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="library-item__menu-item"
            onClick={startRename}
          >
            Rename
          </button>
          <button type="button" role="menuitem" className="library-item__menu-item" onClick={startMove}>
            Move
          </button>
          <button
            type="button"
            role="menuitem"
            className="library-item__menu-item"
            onClick={() => {
              closeMenu()
              onSend(item.id)
            }}
          >
            Send
          </button>
          <button
            type="button"
            role="menuitem"
            className="library-item__menu-item library-item__menu-item--danger"
            onClick={() => {
              closeMenu()
              onDelete(item.id)
            }}
          >
            Delete
          </button>
        </div>
      ) : null}

      {moving ? (
        <div className="library-item__move">
          <p className="library-item__move-label muted">Move to…</p>
          <FolderPicker
            folders={folders}
            value={item.folderId}
            label={`Move ${item.name} to folder`}
            onChange={(folderId) => {
              setMoving(false)
              onMove(item.id, folderId)
            }}
          />
          <button
            type="button"
            className="button button--link library-item__move-cancel"
            onClick={() => {
              setMoving(false)
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {previewOpen ? (
        <div className="library-item__preview">{renderPreview(item, revealed)}</div>
      ) : null}

      {unlockOpen ? (
        <UnlockModal
          label={item.name}
          onSubmit={unlockWith}
          onClose={() => {
            setUnlockOpen(false)
          }}
        />
      ) : null}
    </li>
  )
}

/** PLAN.md §6.4's inline preview, one path per type. */
function renderPreview(item: LibraryItem, revealed: LockedReveal | null) {
  switch (item.type) {
    case 'text':
      return item.content.trim() === '' ? (
        <p className="library-item__placeholder muted">This note is empty.</p>
      ) : (
        <p className="library-item__text">{item.content}</p>
      )

    case 'richtext':
      return <RichTextReveal id={item.id} createdAt={item.createdAt} json={item.content} />

    case 'image':
      return <ImagePreview blob={item.blob} name={item.name} />

    case 'file':
      return <FileDownload blob={item.blob} name={item.name} />

    case 'locked':
      if (revealed === null) return null
      if (revealed.kind === 'text') return <p className="library-item__text">{revealed.text}</p>
      if (revealed.kind === 'richtext') {
        return <RichTextReveal id={item.id} createdAt={item.createdAt} json={revealed.json} />
      }
      // PLAN.md §6.1 gives a locked item no file name — only its bytes are
      // encrypted — so the item's own name becomes the download name.
      return <FileDownload blob={revealed.blob} name={item.name} />
  }
}

/**
 * Read-only rich text. `RichTextItem` is the app's only richtext renderer — it owns
 * the Tiptap setup and the JSON parsing — so the preview reuses it with a draft item,
 * exactly the path an unlocked locked-richtext row in a session takes.
 */
function RichTextReveal({ id, createdAt, json }: { id: string; createdAt: number; json: string }) {
  // The renderer's own item contract, rather than the store's type: this file does not
  // reach into the session store, and the draft is what the component actually needs.
  const draft: RichTextItemViewProps['item'] = {
    id,
    type: 'richtext',
    status: 'complete',
    createdAt,
    content: json,
  }

  return <RichTextItem item={draft} editable={false} onChange={NO_EDIT} />
}

/** Never called: `editable={false}` keeps the preview from emitting an update. */
const NO_EDIT = (): void => {}

function ImagePreview({ blob, name }: { blob: Blob; name: string }) {
  const url = useObjectUrl(blob)
  if (url === null) return null

  return (
    <div className="library-item__frame">
      <img className="library-item__thumbnail" src={url} alt={name} />
    </div>
  )
}

function FileDownload({ blob, name }: { blob: Blob; name: string }) {
  const url = useObjectUrl(blob)
  if (url === null) return null

  return (
    <a className="library-item__download" href={url} download={name}>
      Download
    </a>
  )
}

/**
 * An object URL for `blob`, revoked when the component that asked for it unmounts.
 *
 * Only one blob is ever passed per mounted component (the preview mounts when the
 * row expands and unmounts when it collapses or the item is re-locked), so the
 * cleanup is the revocation — there is no "blob changed" case to handle.
 */
function useObjectUrl(blob: Blob): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const created = URL.createObjectURL(blob)
    setUrl(created)
    return () => {
      URL.revokeObjectURL(created)
    }
  }, [blob])

  return url
}

/**
 * Turns decrypted bytes into the inline reveal and drops them (PLAN.md §11.4, §6.2).
 *
 * A locked file's plaintext becomes a Blob — §6.1's locked item carries no MIME type
 * and nothing stored announces one, so the bytes are handed over untyped and the
 * download name falls back to the item's name. Everything else is UTF-8 text,
 * `richtext` included, whose plaintext is a Tiptap JSON document.
 */
function revealFromDecrypted(
  innerType: LibraryLockedItem['innerType'],
  decrypted: Uint8Array,
): LockedReveal {
  try {
    if (innerType !== 'file') {
      const text = new TextDecoder().decode(decrypted)
      return innerType === 'richtext' ? { kind: 'richtext', json: text } : { kind: 'text', text }
    }

    const bytes = decrypted.slice()
    try {
      return { kind: 'file', blob: new Blob([bytes]) }
    } finally {
      zeroBytes(bytes)
    }
  } finally {
    zeroBytes(decrypted)
  }
}

/** Overwrites a byte buffer this module no longer needs. */
function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0)
}

/**
 * Whether a rejection means "this password did not open this item".
 *
 * Matched by name rather than `instanceof DOMException`: the error comes from
 * whichever realm implements Web Crypto (under jsdom that is Node's), and Web
 * Crypto's AES-GCM raises `OperationError` for a failed tag check, a wrong-length IV
 * and a ciphertext too short to hold a tag — all of which mean "did not decrypt",
 * never something a retry with the same inputs would fix.
 */
function isFailedDecryption(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return 'name' in error && error.name === 'OperationError'
}

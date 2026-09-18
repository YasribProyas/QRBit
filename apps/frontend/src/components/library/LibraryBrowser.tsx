/**
 * Local library browser (PLAN.md §6.4, §16 Phase 5).
 *
 * Two regions, because a phone screen cannot show PLAN.md §6.4's whole sketch at
 * once: the folder tree (recursive `FolderNode`s, each collapsible) and the item list
 * of the folder the user has selected. The sketch interleaves items under their
 * folders; splitting them keeps every row thumb-sized and keeps the item list to the
 * folder actually being looked at — the tree is navigation, the list is content.
 *
 * Data and actions arrive as props from the library store (the UI's only route to
 * IndexedDB); this component never imports `lib/library.ts` and never touches the
 * session store. `LibraryFolder` and `LibraryItem` are imported from the two
 * components that render them, which mirror the PLAN.md §6.1 shapes in `lib/library.ts`.
 *
 * `currentFolderId` is `null` for the root. The browser also accepts the library
 * layer's own root sentinel id, because neither spelling has a folder row to find: a
 * current id that names no folder is the root, both for the list and for the title.
 *
 * Multi-select is PLAN.md §6.4's: a long press (or a right-click, or shift-click on a
 * desktop) starts selection mode, the header swaps to "Send selected (N)", every row
 * grows a checkbox, Escape or Cancel leaves, and opening a row's `···` menu leaves too
 * — the menu means the user wants to act on that one item instead. Selection lives
 * here rather than in the store because it is not library state: nothing outside this
 * component needs it, and it must not outlive the view.
 *
 * The Root row is the browser's own node rather than a `FolderNode`: the root is not a
 * `LibraryFolder` (every folder has a `parentId`, and PLAN.md §6.3 spells the root as
 * `null`), so there is no folder to hand a `FolderNode`.
 *
 * Below the header sits `NewItemBar` — the offline creation row (text, rich text, image,
 * file, locked) that writes straight into the folder currently open. It is hidden while
 * multi-select is on, because in that mode the header's action is "Send selected" and a
 * row that creates content next to it reads as a second send control. Saving goes
 * through `onSaveItem` when the page supplies one and through the library store's own
 * `saveItem` when it does not; the store re-reads IndexedDB after a write, so a new item
 * appears in this list without a refresh.
 *
 * Every delete is confirmed first (Phase 5 review P2). PLAN.md §6.3's `deleteFolder` is
 * "a folder tree dies whole": one mis-tap on a phone used to take the folder, every
 * folder nested inside it and every item in all of them out of IndexedDB, permanently,
 * with nothing to undo it from — the library never leaves the device, so there is no
 * server copy and no trash. The gate is the only new behaviour: the browser counts the
 * doomed subtree from the props it already has, hands `ConfirmDelete` the numbers, and on
 * confirmation calls exactly the same prop, with the same id, that it used to call on
 * click. Nothing about the cascade, the selection or the root changes.
 */

import { useEffect, useState } from 'react'
import { FolderNode, childFolders } from './FolderNode'
import type { LibraryFolder } from './FolderNode'
import { LibraryItemRow } from './LibraryItemRow'
import type { LibraryItem } from './LibraryItemRow'
import { NewFolderModal } from './NewFolderModal'
import { NewItemBar } from './NewItemBar'
import { ConfirmDelete } from '../ConfirmDelete'

export interface LibraryBrowserProps {
  folders: LibraryFolder[]
  items: LibraryItem[]
  /** The folder whose items are listed. `null` is the tree's Root. */
  currentFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
  onCreateFolder: (name: string, parentId: string | null) => Promise<void> | void
  onRenameFolder: (id: string, name: string) => void
  /** Cascades: PLAN.md §6.3 deletes the folder's items, recursively. */
  onDeleteFolder: (id: string) => void
  onRenameItem: (id: string, name: string) => void
  /**
   * Saves one item created offline (PLAN.md §6.1) into the folder on screen.
   *
   * `NewItemBar` builds the §6.1 row — id, folderId, timestamps and all — and this is the
   * seam a page may take over. Left unset it goes to the library store's `saveItem`, which
   * is what Home does: the store re-reads the database after the write, so the new item is
   * already in `items` on the next render.
   */
  onSaveItem?: (item: LibraryItem) => Promise<void> | void
  /**
   * `targetFolderId: null` is the tree's Root. The library layer spells the root with
   * a sentinel id of its own (nothing is stored with `parentId: null`), so the page that
   * owns the store maps `null` to it — the id never appears in these components.
   */
  onMoveItem: (id: string, targetFolderId: string | null) => void
  onDeleteItem: (id: string) => void
  /** The one send entry point (PLAN.md §6.4/§7): the selected library item ids. */
  onSendItems: (ids: string[]) => void
  /**
   * The current selection, reported on EVERY change (PLAN.md §7 Flow A, §16 Phase 6).
   *
   * The selection is owned here because it is not library state, but Phase 6's other
   * Flow A entry point — the page's "Scan & Send" button — lives outside this component
   * and has to know what to queue before it opens the camera. Every transition is
   * reported, including the clears (cancel, Escape, opening a row menu), so the page can
   * never hold an id the user has since deselected.
   */
  onSelectionChange?: (ids: readonly string[]) => void
  /** True while the store is still loading, so the empty state is not a lie. */
  loading?: boolean
  /** The store's error surface; PLAN.md §17 keeps it out of the render path. */
  error?: string | null
}

/**
 * The items directly inside `folderId`.
 *
 * For a real folder this is the obvious filter. For the root it is "not inside any
 * folder at all": PLAN.md §6.1 letters `folderId` as a string and gives the root no
 * folder row, so the library layer spells the root with a sentinel id that matches no
 * folder (`lib/library.ts`'s `ROOT_FOLDER_ID`). Stating the filter that way means the
 * root works whether the caller names it `null` or uses the store's own sentinel, and
 * an item whose folder has gone away is shown at the root rather than hidden.
 */
export function itemsInFolder(
  items: LibraryItem[],
  folders: LibraryFolder[],
  folderId: string | null,
): LibraryItem[] {
  if (folders.some((folder) => folder.id === folderId)) {
    return items.filter((item) => item.folderId === folderId)
  }

  const folderIds = new Set(folders.map((folder) => folder.id))
  return items.filter((item) => !folderIds.has(item.folderId))
}

/** Most recently changed first; the id breaks ties so the order is stable. */
function byMostRecent(a: LibraryItem, b: LibraryItem): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/** What a folder delete would cost, counted over the flat lists the store hands down. */
export interface DeleteImpact {
  /** Folder rows destroyed: the named folder plus every folder nested inside it. */
  folders: number
  /** Items destroyed, at any depth. */
  items: number
}

/**
 * Counts the subtree a folder delete takes with it.
 *
 * PLAN.md §6.3's `deleteFolder` walks the same parent links in IndexedDB — "a folder tree
 * dies whole", because an item whose folder is gone would be unreachable — so the warning
 * can only be truthful if it counts the same way. The folder itself is included: it is
 * destroyed too. The browser already has every folder and every item as props, so this is
 * arithmetic on those, not a second read of the database.
 */
export function folderDeleteImpact(
  folders: LibraryFolder[],
  items: LibraryItem[],
  folderId: string,
): DeleteImpact {
  const doomed = new Set<string>([folderId])

  /*
   * A Set's iterator visits values added during iteration, so widening `doomed` in place
   * walks the whole tree without a queue of its own. The `has` guard is what makes a
   * malformed cycle in the stored parent links terminate instead of looping forever.
   */
  for (const ancestor of doomed) {
    for (const folder of folders) {
      if (folder.parentId === ancestor && !doomed.has(folder.id)) doomed.add(folder.id)
    }
  }

  let itemCount = 0
  for (const item of items) {
    if (doomed.has(item.folderId)) itemCount += 1
  }

  return { folders: doomed.size, items: itemCount }
}

/** The delete the user asked for, by id. `null` in state means no dialog is open. */
export type PendingDelete = { kind: 'folder'; id: string } | { kind: 'item'; id: string }

/** The words `ConfirmDelete` shows for one pending delete. */
export interface DeletePrompt {
  title: string
  message: string
  confirmLabel: string
}

/**
 * The prompt for a pending delete, read from the live props.
 *
 * Derived on every render rather than frozen when the dialog opened, so the counts the
 * user is about to act on are the counts the library has now. It returns `null` when the
 * target is gone — the folder was deleted from another tab while the question was up —
 * which drops the dialog instead of letting it quote a subtree that no longer exists.
 */
export function describeDelete(
  request: PendingDelete,
  folders: LibraryFolder[],
  items: LibraryItem[],
): DeletePrompt | null {
  if (request.kind === 'item') {
    const item = items.find((candidate) => candidate.id === request.id)
    if (item === undefined) return null

    // PLAN.md §6.4's item delete takes one thing, so the name is the whole warning.
    return {
      title: `Delete “${item.name}”?`,
      message: `“${item.name}” will be permanently deleted from this device. This cannot be undone.`,
      confirmLabel: 'Delete item permanently',
    }
  }

  const folder = folders.find((candidate) => candidate.id === request.id)
  if (folder === undefined) return null

  const impact = folderDeleteImpact(folders, items, folder.id)
  return {
    title: `Delete “${folder.name}”?`,
    message:
      `This permanently deletes ${countNouns(impact.folders, 'folder')} and ` +
      `${countNouns(impact.items, 'item')} from this device — “${folder.name}” and every ` +
      'folder and file nested inside it. This cannot be undone.',
    confirmLabel: 'Delete folder and contents permanently',
  }
}

/** "2 folders", "1 folder", "no items" — the phrasing the cascade warning is read in. */
function countNouns(count: number, noun: string): string {
  if (count === 0) return `no ${noun}s`
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function LibraryBrowser({
  folders,
  items,
  currentFolderId,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onRenameItem,
  onSaveItem,
  onMoveItem,
  onDeleteItem,
  onSendItems,
  onSelectionChange,
  loading = false,
  error = null,
}: LibraryBrowserProps) {
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)

  /*
   * Reports the selection upward on every change, including the empty ones
   * (PLAN.md §7 Flow A, §16 Phase 6). `selectedIds` is state, so its identity is stable
   * between changes and the page can store it without a render loop.
   */
  useEffect(() => {
    onSelectionChange?.(selectedIds)
  }, [selectedIds, onSelectionChange])

  /*
   * Escape leaves selection mode (PLAN.md §6.4). A document listener rather than a
   * key handler on a row: the user may have focus anywhere, including nowhere.
   */
  useEffect(() => {
    if (!selectionMode) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setSelectionMode(false)
      setSelectedIds([])
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [selectionMode])

  const enterSelection = (id: string): void => {
    setSelectionMode(true)
    setSelectedIds([id])
  }

  const toggleSelected = (id: string): void => {
    setSelectionMode(true)
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((selected) => selected !== id) : [...ids, id]))
  }

  const exitSelection = (): void => {
    setSelectionMode(false)
    setSelectedIds([])
  }

  /*
   * The delete gate (Phase 5 review P2). Both handlers only record what was asked for;
   * the row and folder menus keep their own behaviour, including leaving multi-select
   * when a menu opens.
   */
  const askToDeleteFolder = (id: string): void => {
    setPendingDelete({ kind: 'folder', id })
  }

  const askToDeleteItem = (id: string): void => {
    setPendingDelete({ kind: 'item', id })
  }

  const cancelPendingDelete = (): void => {
    setPendingDelete(null)
  }

  /** The one path to a deletion: the same props, called with the same ids as before. */
  const confirmPendingDelete = (): void => {
    if (pendingDelete === null) return
    if (pendingDelete.kind === 'folder') {
      onDeleteFolder(pendingDelete.id)
    } else {
      onDeleteItem(pendingDelete.id)
    }
    setPendingDelete(null)
  }

  const sendSelected = (): void => {
    if (selectedIds.length === 0) return
    onSendItems(selectedIds)
    // The send is the end of the selection: the page hands the ids to a session.
    exitSelection()
  }

  const currentItems = itemsInFolder(items, folders, currentFolderId).sort(byMostRecent)
  const rootCount = itemsInFolder(items, folders, null).length
  const currentFolder = folders.find((folder) => folder.id === currentFolderId)
  // Whatever the current id is, if no folder matches it the view is the root — which is
  // also where `itemsInFolder` just put the items. That covers the root spelled as
  // `null` and the library layer's own sentinel, and it means a folder deleted while it
  // was open leaves a coherent screen rather than an empty one titled with its name.
  const currentName = currentFolder?.name ?? 'Root'
  /*
   * The folder the creation row writes into. `currentFolderId` may name no folder at all
   * (the root, the store's sentinel, or a folder deleted while it was open), and the
   * library layer refuses an item whose folder has no row — so the row is handed the
   * resolved folder id, or `null` for the root, exactly as the list above is.
   */
  const openFolderId = currentFolder?.id ?? null
  const libraryEmpty = folders.length === 0 && items.length === 0
  const rootSelected = currentFolder === undefined
  const deletePrompt = pendingDelete === null ? null : describeDelete(pendingDelete, folders, items)

  return (
    <div className="library-browser">
      <div className="library-browser__header">
        <h3 className="library-browser__folder-name">
          <span aria-hidden="true">📁</span> {currentName}
        </h3>

        {selectionMode ? (
          <div className="library-browser__actions">
            <button
              type="button"
              className="button button--link library-browser__selection-cancel"
              onClick={exitSelection}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button library-browser__send-selected"
              disabled={selectedIds.length === 0}
              onClick={sendSelected}
            >
              Send selected ({selectedIds.length})
            </button>
          </div>
        ) : (
          <div className="library-browser__actions">
            {/*
              The checkbox fallback: a long press is undiscoverable, and a desktop has
              no finger to hold down, so selection mode also has a plain button.
            */}
            <button
              type="button"
              className="button button--link library-browser__select"
              onClick={() => {
                setSelectionMode(true)
              }}
            >
              Select
            </button>
            <button
              type="button"
              className="button button--link library-browser__new-folder"
              onClick={() => {
                setNewFolderOpen(true)
              }}
            >
              + New Folder
            </button>
          </div>
        )}
      </div>

      {/*
        The offline creation row: T / ¶ / 🖼 / 📎 / 🔒, writing into the folder on screen.
        It is a sibling of the header rather than part of `library-browser__actions`,
        because that box is swapped for the selection controls; this row stays for every
        state — an empty library included, which is exactly when being able to make an item
        with nothing connected matters most.
      */}
      {selectionMode ? null : (
        <NewItemBar
          currentFolderId={openFolderId}
          currentFolderName={currentName}
          onSaveItem={onSaveItem}
        />
      )}

      {error !== null ? (
        <p className="library-browser__error item-error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="library-browser__loading muted" role="status">
          Loading your library…
        </p>
      ) : libraryEmpty ? (
        <p className="library-browser__empty empty">
          Your library is empty. Use “+ New Folder” to start organising what you keep, or
          the row above to write a note, save an image or lock a secret — all of it on this
          device, with nothing connected.
        </p>
      ) : (
        <>
          <ul className="library-browser__tree">
            <li
              className="folder-node folder-node--root"
              data-current={rootSelected ? 'true' : undefined}
            >
              <div className="folder-node__row">
                <span className="folder-node__chevron folder-node__chevron--root" aria-hidden="true">
                  ▾
                </span>
                <button
                  type="button"
                  className="folder-node__name folder-node__name--root"
                  aria-current={rootSelected ? 'true' : undefined}
                  onClick={() => {
                    onSelectFolder(null)
                  }}
                >
                  <span className="folder-node__icon" aria-hidden="true">
                    📁
                  </span>{' '}
                  Root
                </button>
                <span
                  className="folder-node__count badge"
                  aria-label={`${rootCount} ${rootCount === 1 ? 'item' : 'items'}`}
                >
                  {rootCount}
                </span>
              </div>
            </li>

            {childFolders(folders, null).map((folder) => (
              <FolderNode
                key={folder.id}
                folder={folder}
                folders={folders}
                items={items}
                currentFolderId={currentFolderId}
                onSelectFolder={onSelectFolder}
                onRenameFolder={onRenameFolder}
                onDeleteFolder={askToDeleteFolder}
              />
            ))}
          </ul>

          <ul className="library-browser__items">
            {currentItems.map((item) => (
              <LibraryItemRow
                key={item.id}
                item={item}
                folders={folders}
                selectionMode={selectionMode}
                selected={selectedIds.includes(item.id)}
                onToggleSelected={toggleSelected}
                onEnterSelectionMode={enterSelection}
                onOpenMenu={() => {
                  if (selectionMode) exitSelection()
                }}
                onRename={onRenameItem}
                onMove={onMoveItem}
                onDelete={askToDeleteItem}
                onSend={(id) => {
                  onSendItems([id])
                }}
              />
            ))}
          </ul>

          {currentItems.length === 0 ? (
            <p className="library-browser__empty empty">This folder is empty.</p>
          ) : null}
        </>
      )}

      {newFolderOpen ? (
        <NewFolderModal
          parentId={currentFolderId}
          parentName={currentName}
          onCreate={onCreateFolder}
          onClose={() => {
            setNewFolderOpen(false)
          }}
        />
      ) : null}

      {deletePrompt !== null ? (
        <ConfirmDelete
          title={deletePrompt.title}
          message={deletePrompt.message}
          confirmLabel={deletePrompt.confirmLabel}
          onConfirm={confirmPendingDelete}
          onCancel={cancelPendingDelete}
        />
      ) : null}
    </div>
  )
}

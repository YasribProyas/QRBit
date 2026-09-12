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
 */

import { useEffect, useState } from 'react'
import { FolderNode, childFolders } from './FolderNode'
import type { LibraryFolder } from './FolderNode'
import { LibraryItemRow } from './LibraryItemRow'
import type { LibraryItem } from './LibraryItemRow'
import { NewFolderModal } from './NewFolderModal'

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
   * `targetFolderId: null` is the tree's Root. The library layer spells the root with
   * a sentinel id of its own (nothing is stored with `parentId: null`), so the page that
   * owns the store maps `null` to it — the id never appears in these components.
   */
  onMoveItem: (id: string, targetFolderId: string | null) => void
  onDeleteItem: (id: string) => void
  /** The one send entry point (PLAN.md §6.4/§7): the selected library item ids. */
  onSendItems: (ids: string[]) => void
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

export function LibraryBrowser({
  folders,
  items,
  currentFolderId,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onRenameItem,
  onMoveItem,
  onDeleteItem,
  onSendItems,
  loading = false,
  error = null,
}: LibraryBrowserProps) {
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [newFolderOpen, setNewFolderOpen] = useState(false)

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
  const libraryEmpty = folders.length === 0 && items.length === 0
  const rootSelected = currentFolder === undefined

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
          Your library is empty. Use “+ New Folder” to start organising what you keep.
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
                onDeleteFolder={onDeleteFolder}
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
                onDelete={onDeleteItem}
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
    </div>
  )
}

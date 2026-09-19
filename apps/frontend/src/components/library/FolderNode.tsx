/**
 * One node of the library's folder tree (PLAN.md §6.4, §16 Phase 5).
 *
 * `LibraryFolder` here is a structural mirror of the PLAN.md §6.1 type that
 * `lib/library.ts` owns. These components take everything as props and never import the
 * IndexedDB layer — the store is the UI's only route to it — so the shape is restated
 * instead. The two are field-for-field identical, which is what lets the store's real
 * `LibraryFolder` values satisfy these props without a cast; because the check is
 * structural, a drift in either definition fails to compile at the page that wires
 * them rather than mismatching silently.
 *
 * A node owns two pieces of state, both presentation: whether it is expanded
 * (PLAN.md §6.4 makes folders collapsible, and nothing outside the tree needs to
 * know) and whether its `···` menu or inline rename is open. Every mutation leaves
 * through a callback — this file never touches IndexedDB.
 *
 * The menu holds Rename and Delete and deliberately no Move: PLAN.md §6.3 gives the
 * library layer `renameFolder` and `deleteFolder` and no `moveFolder`, and a menu
 * entry with nothing behind it would be a lie. Delete cascades (§6.3 deletes the
 * items inside, recursively for subfolders), which is why the label says so.
 *
 * `FolderPicker` lives here too: it is the folder domain's other rendering of the
 * tree, shared by the item row's Move picker and the save-to-library dialog. One
 * spelling of the tree, one ordering (`childFolders`).
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  IconChevronDown,
  IconChevronRight,
  IconDotsVertical,
  IconFolderFilled,
} from '@tabler/icons-react'
import type { LibraryItem } from './LibraryItemRow'

/** Mirrors PLAN.md §6.1's `LibraryFolder`. `parentId: null` is the tree's root. */
export interface LibraryFolder {
  id: string
  name: string
  parentId: string | null
  createdAt: number
  updatedAt: number
}

export interface FolderNodeProps {
  /** The folder this node renders. */
  folder: LibraryFolder
  /** Every folder, so the node finds its own children in the store's flat list. */
  folders: LibraryFolder[]
  /** Every item, for the count badge of the items directly inside this folder. */
  items: LibraryItem[]
  /** The folder whose item list is on screen. `null` is the root. */
  currentFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string) => void
}

/**
 * The child folders of `parentId`, in the one order the whole UI uses.
 *
 * The store hands back folders in IndexedDB key order (uuid order, i.e. arbitrary),
 * so the tree would reshuffle between loads without this. Case-insensitive name
 * order, falling back to the id, is deterministic and locale-independent — a
 * `localeCompare` would order differently on different devices.
 */
export function childFolders(folders: LibraryFolder[], parentId: string | null): LibraryFolder[] {
  return folders.filter((folder) => folder.parentId === parentId).sort(byNameThenId)
}

function byNameThenId(a: LibraryFolder, b: LibraryFolder): number {
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

export function FolderNode({
  folder,
  folders,
  items,
  currentFolderId,
  onSelectFolder,
  onRenameFolder,
  onDeleteFolder,
}: FolderNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(folder.name)

  const children = childFolders(folders, folder.id)
  const itemCount = items.filter((item) => item.folderId === folder.id).length
  const current = currentFolderId === folder.id

  const closeMenu = (): void => {
    setMenuOpen(false)
  }

  const startRename = (): void => {
    setDraftName(folder.name)
    setRenaming(true)
    closeMenu()
  }

  const commitRename = (): void => {
    const name = draftName.trim()
    if (name === '') return
    onRenameFolder(folder.id, name)
    setRenaming(false)
  }

  return (
    <li className="folder-node" data-current={current ? 'true' : undefined}>
      <div className="folder-node__row">
        <button
          type="button"
          className="folder-node__chevron"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${folder.name}`}
          onClick={() => {
            setExpanded(!expanded)
          }}
        >
          {expanded ? (
            <IconChevronDown size={14} style={{ verticalAlign: 'middle' }} />
          ) : (
            <IconChevronRight size={14} style={{ verticalAlign: 'middle' }} />
          )}
          <span style={{ display: 'none' }}>{expanded ? '▾' : '▸'}</span>
        </button>

        {renaming ? (
          <form
            className="folder-node__rename"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              commitRename()
            }}
          >
            <input
              className="folder-node__rename-input"
              type="text"
              value={draftName}
              aria-label={`Rename ${folder.name}`}
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
              className="button button--link folder-node__rename-save"
              disabled={draftName.trim() === ''}
            >
              Save
            </button>
            <button
              type="button"
              className="button button--link folder-node__rename-cancel"
              onClick={() => {
                setRenaming(false)
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="folder-node__name"
            aria-current={current ? 'true' : undefined}
            onClick={() => {
              onSelectFolder(folder.id)
              // Selecting a folder whose children are hidden would look like an empty
              // tree, so opening it is part of what tapping the name means.
              setExpanded(true)
            }}
          >
            <span className="folder-node__icon" aria-hidden="true">
              <IconFolderFilled size={16} color="#4ade80" style={{ verticalAlign: 'middle', marginRight: '6px' }} />
              <span style={{ display: 'none' }}>📁</span>
            </span>{' '}
            {folder.name}
          </button>
        )}

        <span
          className="folder-node__count badge"
          aria-label={`${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
        >
          {itemCount}
        </span>

        <button
          type="button"
          className="folder-node__menu-toggle"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Actions for ${folder.name}`}
          onClick={() => {
            setMenuOpen(!menuOpen)
          }}
        >
          <IconDotsVertical size={16} style={{ verticalAlign: 'middle' }} />
          <span style={{ display: 'none' }}>···</span>
        </button>
      </div>

      {menuOpen ? (
        <div className="folder-node__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="folder-node__menu-item"
            onClick={startRename}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="folder-node__menu-item folder-node__menu-item--danger"
            onClick={() => {
              closeMenu()
              onDeleteFolder(folder.id)
            }}
          >
            Delete folder and contents
          </button>
        </div>
      ) : null}

      {expanded && children.length > 0 ? (
        <ul className="folder-node__children">
          {children.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              folders={folders}
              items={items}
              currentFolderId={currentFolderId}
              onSelectFolder={onSelectFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export interface FolderPickerProps {
  folders: LibraryFolder[]
  /**
   * The chosen folder; `null` is the tree's Root. An id that names no folder reads as
   * the Root too — see `FolderPicker`.
   */
  value: string | null
  /** Fires with the chosen folder id, or `null` for Root. */
  onChange: (folderId: string | null) => void
  /** Accessible name for the group, e.g. "Move to folder". */
  label: string
}

/**
 * The folder tree as a single-choice list — used to move an item and to choose a
 * folder to save into. Nested lists rather than a flat list with computed indent:
 * the depth is the markup's, so there is no per-depth class or inline style.
 */
export function FolderPicker({ folders, value, onChange, label }: FolderPickerProps) {
  // A value that names no known folder is the Root, which is the rule `itemsInFolder`
  // already states: the library layer spells the root with a sentinel id that matches
  // no folder (`lib/library.ts`'s `ROOT_FOLDER_ID`), and an item whose folder has gone
  // away belongs at the root as well. A root item's own `folderId` is exactly that
  // sentinel, so without this the picker opened on a root item marked nothing at all.
  const rootSelected = value === null || !folders.some((folder) => folder.id === value)

  return (
    <div className="folder-picker" role="radiogroup" aria-label={label}>
      <FolderPickerOption
        name="Root"
        selected={rootSelected}
        onSelect={() => {
          onChange(null)
        }}
      />
      <FolderPickerChildren folders={folders} parentId={null} value={value} onChange={onChange} />
    </div>
  )
}

function FolderPickerChildren({
  folders,
  parentId,
  value,
  onChange,
}: {
  folders: LibraryFolder[]
  parentId: string | null
  value: string | null
  onChange: (folderId: string | null) => void
}) {
  const children = childFolders(folders, parentId)
  if (children.length === 0) return null

  return (
    <ul className="folder-picker__list">
      {children.map((folder) => (
        <li key={folder.id} className="folder-picker__node">
          <FolderPickerOption
            name={folder.name}
            selected={value === folder.id}
            onSelect={() => {
              onChange(folder.id)
            }}
          />
          <FolderPickerChildren
            folders={folders}
            parentId={folder.id}
            value={value}
            onChange={onChange}
          />
        </li>
      ))}
    </ul>
  )
}

function FolderPickerOption({
  name,
  selected,
  onSelect,
}: {
  name: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`folder-picker__option${selected ? ' folder-picker__option--selected' : ''}`}
      onClick={onSelect}
    >
      <span className="folder-picker__icon" aria-hidden="true">
        <IconFolderFilled size={16} color="#4ade80" style={{ verticalAlign: 'middle', marginRight: '6px' }} />
        <span style={{ display: 'none' }}>📁</span>
      </span>{' '}
      {name}
    </button>
  )
}

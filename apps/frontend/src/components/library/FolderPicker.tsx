/**
 * The folder tree as a single-choice list, and the row that spells one choice (PLAN.md §6.4).
 *
 * This used to be the part of `components/library/FolderNode.tsx` that anything still
 * rendered; the tree rows around it were deleted when nothing mounted them any more
 * (ORCHESTRATION D16 replaced that item UI with the dossier/block editor), so the file is
 * named after the thing in it. `AddItemBar.tsx`, `SaveToLibraryModal.tsx` and
 * `FolderPickerModal.tsx` all take the same choice row, which is why `FolderOptionRow` is
 * exported: one spelling of a selectable folder row, not three that can drift. The ordering
 * comes from `lib/folders.ts` rather than being recomputed here — one spelling of the tree.
 *
 * Nested `<ul>` lists rather than a flat list with a computed indent: the depth is the
 * markup's, so there is no per-depth class or inline style, and a screen reader hears the
 * hierarchy instead of a guess.
 *
 * A row is a `role="radio"` inside a `role="radiogroup"`, which is what `aria-checked` means
 * on it; the group's accessible name comes from `label`, because a list of folders with no
 * question above it is a list of folders the user has to interpret.
 */

import { IconFolder } from '@tabler/icons-react'
import { UnstyledButton } from '@mantine/core'
import type { CSSProperties, ReactNode } from 'react'

import { WithMantine } from '../common/WithMantine'
import { childFolders } from '../../lib/folders'
import type { LibraryFolder } from '../../lib/library'

/**
 * A flat list row: 44px tall, one 1px division supplied by the container, no card of its own
 * (DESIGN.md, "Panels and Rows" — a bordered card inside a bordered container is nesting).
 */
const ROW_STYLE: CSSProperties = {
  minHeight: 44,
  padding: '0 10px',
  borderRadius: 'var(--qrbit-radius-sm)',
  color: 'var(--qrbit-ink)',
}

/**
 * The selected row: `--qrbit-selected` fill plus the 2px signal inset on the leading edge.
 *
 * That inset is the only coloured edge the design system allows, and only where it means
 * *this one is chosen* (DESIGN.md, "Panels and Rows"). It is a `box-shadow`, not a border, so
 * it changes nothing about the row's box. Set through the CSSOM because it has to win over
 * the stylesheet's legacy `.folder-picker__option` rule for the same properties — React
 * writes styles through the CSSOM, which the CSP permits.
 */
const SELECTED_ROW_STYLE: CSSProperties = {
  ...ROW_STYLE,
  backgroundColor: 'var(--qrbit-selected)',
  boxShadow: 'inset 2px 0 0 var(--qrbit-signal)',
  fontWeight: 600,
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
 * The folder tree as a single-choice list.
 *
 * Root is always the first option, because "not in a folder" is a destination: it is where
 * an item goes when its folder is gone and where a save lands when the user has not made one.
 */
export function FolderPicker({ folders, value, onChange, label }: FolderPickerProps) {
  // A value that names no known folder is the Root, which is the rule `itemsInFolder`
  // already states: the library layer spells the root with a sentinel id that matches
  // no folder (`lib/library.ts`'s `ROOT_FOLDER_ID`), and an item whose folder has gone
  // away belongs at the root as well. A root item's own `folderId` is exactly that
  // sentinel, so without this the picker opened on a root item marked nothing at all.
  const rootSelected = value === null || !folders.some((folder) => folder.id === value)

  return (
    // The rows are Mantine `UnstyledButton`s, which need a provider; every surface that
    // mounts this picker is inside one in the app, and `WithMantine` is how this repo keeps
    // a component mounted in isolation (a test, a story) from throwing about it.
    <WithMantine>
      <div className="folder-picker" role="radiogroup" aria-label={label}>
        <FolderOptionRow
          name="Root"
          selected={rootSelected}
          onSelect={() => {
            onChange(null)
          }}
        />
        <FolderPickerChildren folders={folders} parentId={null} value={value} onChange={onChange} />
      </div>
    </WithMantine>
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
          <FolderOptionRow
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

export interface FolderOptionRowProps {
  /** The folder's display name — also the row's accessible name. */
  name: string
  selected: boolean
  onSelect: () => void
  /** Anything after the name, for a surface that has to say more (a dossier count). */
  trailing?: ReactNode
  /**
   * The stylesheet hook a caller's tests reach the row through. `folder-picker__option` is
   * the name the existing surfaces already use; it also carries the legacy row rules, which
   * are all token values (hairline box, sunken hover, 5px radius).
   */
  className?: string
}

/**
 * One choice in a folder list.
 *
 * `UnstyledButton` rather than `Button` because the row is not a labelled action: it is a
 * selectable row whose content is an icon, a name and whatever the caller appends. It still
 * gets the tokens, the states and the focus ring (DESIGN.md, "Don't write `<button>`").
 */
export function FolderOptionRow({
  name,
  selected,
  onSelect,
  trailing,
  className = 'folder-picker__option',
}: FolderOptionRowProps) {
  return (
    <UnstyledButton
      className={`flex items-center gap-[8px] text-left ${className}`}
      type="button"
      role="radio"
      aria-checked={selected}
      style={selected ? SELECTED_ROW_STYLE : ROW_STYLE}
      onClick={onSelect}
    >
      {/* The same glyph for Root and for a folder, as the tree has always drawn it: the row's
          word is what distinguishes them, and one icon style means one stroke (DESIGN.md). */}
      <IconFolder
        size={16}
        aria-hidden="true"
        className="shrink-0 text-[color:var(--qrbit-ink-secondary)]"
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {trailing ?? null}
    </UnstyledButton>
  )
}

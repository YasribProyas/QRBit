/**
 * The library panel — the left half of the desktop shell (ORCHESTRATION D16).
 *
 * It replaces the `sr-only` `LibraryBrowser` mount (D16.4) with the library the owner
 * actually sees: top-level folders, the dossiers inside each one, and every action in
 * the row it belongs to. Built on `LibraryFile` (the dossier model) rather than
 * `LibraryItem`, because dossiers are what this screen creates, orders and edits
 * (D16 finding 5). `LibraryItem` stays on the receive path; merging the two models is
 * out of scope.
 *
 * **Shape.** One Panel (DESIGN.md: Raised, 1px Border, radius lg, no shadow at rest) holding
 * flat rows — 44px minimum, one 1px division between them, and never a bordered card inside
 * this bordered container. Every control is a Mantine primitive (`Button`, `ActionIcon`,
 * `Menu`, `TextInput`, `Badge`): the panel used to carry thirteen hand-written `<button>`s,
 * which is a large part of why it looked assembled from parts. Colour, radius and spacing come
 * from `--qrbit-*` tokens or from the theme's semantic slots, so both schemes come from one
 * set of declarations and nothing here knows which scheme it is in.
 *
 * **State ownership.** The panel reads and writes `store/libraryStore` directly: the store
 * is the UI's only route to IndexedDB, and it re-reads the database after every write, so
 * the list on screen is the list that was just stored. That is what makes a drag, a rename
 * and a cascade delete observable from outside the component. The page keeps only the two
 * things the panel cannot know — which dossier opens in the editor, and what a brand-new
 * dossier is made of (`onCreateFile`).
 *
 * **Ordering.** Two kinds of drag share this screen, and each index means something only
 * inside the one list it was counted against. Folders reorder among the folders that share
 * their parent (`lib/library.ts` `reorderFolder` and `siblingFolders`); this panel lists one
 * level, so its folder grips reorder the top level and a subfolder's run is never touched.
 * Dossiers reorder inside the folder whose list they are in, because their `sortOrder` is per
 * folder. The `Root` section is a bucket rather than a folder — it holds whatever no listed
 * folder does — so neither its rows nor its header get a grip: it is openable, renamable,
 * movable and deletable, but it has no order the store could honour, and the hook is never
 * given an index counted against a list the store does not have.
 *
 * **Expansion** is "collapsed ids", not "expanded ids": a folder is open unless the user
 * collapsed it, so folders that arrive after the first render are open without the
 * panel ever naming an id it has not seen (this is what replaced `['f-1','f-2','f-3']`).
 * It is UI state only, and nothing here writes to `localStorage`, IndexedDB or the
 * Cache API (AGENTS.md).
 *
 * Every delete is confirmed first, and the folder prompt states the cascade in numbers —
 * folders, dossiers and loose items, nested included — counted by `lib/folders.ts`'s
 * `describeDelete`, the same arithmetic `deleteFolder` runs (PLAN.md §6.3, "a folder tree
 * dies whole"). The panel keeps no second copy of that math: the library never leaves the
 * device, so there is no other copy to restore, and a confirmation that quotes numbers has to
 * promise the true ones.
 */

import { useCallback, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, ReactNode } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { useHover } from '@mantine/hooks'
import {
  IconArrowsMove,
  IconChevronDown,
  IconChevronRight,
  IconDotsVertical,
  IconFileText,
  IconFolder,
  IconGripVertical,
  IconLock,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'

import { ConfirmDelete } from '../ConfirmDelete'
import { WithMantine } from '../common/WithMantine'
import { FolderPickerModal } from './FolderPickerModal'
import type { FolderPickerChoice } from './FolderPickerModal'
import { NewFolderModal } from './NewFolderModal'
import { REORDER_ITEM_ATTRIBUTE, useReorderDrag } from '../../hooks/useReorderDrag'
import type { ReorderHandleProps } from '../../hooks/useReorderDrag'
import { getFirstBlockPreview, hasLockedBlocks } from '../../lib/dossier'
import { describeDelete } from '../../lib/folders'
import type { PendingDelete } from '../../lib/folders'
import { ROOT_FOLDER_ID, siblingFolders } from '../../lib/library'
import type { LibraryFile, LibraryFolder } from '../../lib/library'
import { DEFAULT_ITEM_HEIGHT } from '../../lib/reorder'
import { useLibraryStore } from '../../store/libraryStore'

export interface LibraryPanelProps {
  /** A dossier row was opened: the page hands it to the editor. */
  onSelectFile(file: LibraryFile): void
  /**
   * `+ New file` in the list of `folderId`. The page owns the create, because it owns
   * what a new dossier contains and opens the result; `ROOT_FOLDER_ID` is the unfiled
   * bucket, so a dossier can be made without picking a folder first.
   */
  onCreateFile(folderId: string): void
}

/** The actions a row can ask for, bundled so a row takes one prop instead of seven. */
interface PanelActions {
  createFile(folderId: string): void
  openFile(file: LibraryFile): void
  renameFile(file: LibraryFile, name: string): void
  askMoveFile(file: LibraryFile): void
  askDeleteFile(file: LibraryFile): void
  /** Persists a reorder inside `file`'s own folder; `targetIndex` is the row's index in the list as displayed. */
  reorderFile(file: LibraryFile, targetIndex: number, folderId: string): void
  /**
   * Persists a reorder within the folder's own sibling group; `targetIndex` is the section's
   * index among the folders listed with the same parent.
   */
  reorderFolder(folder: LibraryFolder, targetIndex: number): void
  renameFolder(folder: LibraryFolder, name: string): void
  askDeleteFolder(folder: LibraryFolder): void
}

/** The single 1px division between rows. `--qrbit-border` divides; it is not a box. */
const ROW_DIVISION: CSSProperties = { borderTop: '1px solid var(--qrbit-border)' }

/** The Panel itself: Raised, 1px Border, radius lg, no shadow at rest. */
const PANEL_STYLE: CSSProperties = {
  background: 'var(--qrbit-raised)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-lg)',
}

/**
 * The two-line dossier row, drawn by a `Button`.
 *
 * Mantine stretches and ellipsises a button label, which is right for one line and wrong for
 * a name over a preview, so the label keeps its own wrapping and alignment. Fill, hover,
 * radius and the focus ring stay the theme's.
 */
const ROW_BUTTON_STYLES = {
  root: { minWidth: 0, height: 'auto', minHeight: 44 },
  inner: { alignItems: 'center', width: '100%' },
  label: { minWidth: 0, textAlign: 'left', whiteSpace: 'normal' },
} as const

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function LibraryPanel({ onSelectFile, onCreateFile }: LibraryPanelProps) {
  const folders = useLibraryStore((state) => state.folders)
  const files = useLibraryStore((state) => state.files)
  const items = useLibraryStore((state) => state.items)
  const loading = useLibraryStore((state) => state.loading)
  const error = useLibraryStore((state) => state.error)
  const createFolder = useLibraryStore((state) => state.createFolder)
  const renameFolder = useLibraryStore((state) => state.renameFolder)
  const reorderFolder = useLibraryStore((state) => state.reorderFolder)
  const deleteFolder = useLibraryStore((state) => state.deleteFolder)
  const updateFile = useLibraryStore((state) => state.updateFile)
  const deleteFile = useLibraryStore((state) => state.deleteFile)
  const moveFile = useLibraryStore((state) => state.moveFile)
  const reorderFile = useLibraryStore((state) => state.reorderFile)

  /** Collapsed folders only — see the module comment for why this is the inverted form. */
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([])
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  /** The dossier whose "Move to folder" dialog is open; `null` means none. */
  const [moveRequest, setMoveRequest] = useState<LibraryFile | null>(null)

  // One level, in the one order the library UI uses; a dossier in a folder this panel
  // does not list (the root, a subfolder, or a folder that went away) belongs to `Root`.
  const listedFolders = siblingFolders(folders, null)
  const rootFiles = files.filter(
    (file) => !listedFolders.some((folder) => folder.id === file.folderId),
  )

  const actions: PanelActions = {
    createFile: (folderId) => {
      onCreateFile(folderId)
    },
    openFile: (file) => {
      onSelectFile(file)
    },
    renameFile: (file, name) => {
      reportToStore(updateFile(file.id, { name }))
    },
    askMoveFile: (file) => {
      setMoveRequest(file)
    },
    askDeleteFile: (file) => {
      setPendingDelete({ kind: 'file', id: file.id })
    },
    reorderFile: (file, targetIndex, folderId) => {
      reportToStore(reorderFile(file.id, targetIndex, folderId))
    },
    reorderFolder: (folder, targetIndex) => {
      // The parent is sent along so the store checks this panel's index against the group the
      // folder really belongs to, rather than trusting what is on screen.
      reportToStore(reorderFolder(folder.id, targetIndex, folder.parentId))
    },
    renameFolder: (folder, name) => {
      reportToStore(renameFolder(folder.id, name))
    },
    askDeleteFolder: (folder) => {
      setPendingDelete({ kind: 'folder', id: folder.id })
    },
  }

  /** The list the folder sections are stacked in, for `measureFolderPitch` to read. */
  const sectionListRef = useRef<HTMLDivElement | null>(null)

  /**
   * The pitch of folder row `index`, measured from the DOM.
   *
   * Folder sections are wildly different heights — an expanded one carries its whole file list
   * — so the folder list gives `useReorderDrag` one pitch per row instead of letting it assume
   * the grabbed row's, which is what `FileEditView` does for blocks.
   *
   * The rows are the *marked direct children* of the section list. A folder row and a dossier
   * row carry the same `data-reorder-item` marker and the dossier rows are nested inside the
   * folder's own section, so this walks children rather than querying the whole subtree:
   * a subtree query would hand the folder hook the dossier rows' geometry, and the two drag
   * instances on this screen would then be counting positions against each other's lists.
   * Unmarked children (the `Root` bucket, the empty-library note) are skipped, so index `i` is
   * `listedFolders[i]` — the same order both were rendered in.
   */
  const measureFolderPitch = useCallback((index: number): number => {
    const rows = markedRows(sectionListRef.current)
    const row = rows[index]
    if (row === undefined) return DEFAULT_ITEM_HEIGHT
    const following = rows[index + 1]
    // `offsetTop`, not a bounding box: a transform does not move it, so measuring the row that
    // is currently being dragged still reports the layout the user grabbed.
    const pitch = following === undefined ? row.offsetHeight : following.offsetTop - row.offsetTop
    // jsdom lays nothing out and a hidden row reports 0 — both mean the shared default, which
    // is also what the hook itself falls back to.
    return pitch > 0 ? pitch : DEFAULT_ITEM_HEIGHT
  }, [])

  /**
   * The folder rows' drag and its keyboard twin (D16.2/D16.3) — the screen's second
   * `useReorderDrag` instance.
   *
   * Each `ReorderableFileList` below makes its own for that folder's dossiers, and the
   * instances cannot step on each other: every one of them is handed a `length` and an `onMove`
   * for exactly one list, a grip only ever carries the props of the instance that made it, and
   * the hook measures the row that owns the handle it was given — the folder hook through
   * `measureFolderPitch`, the dossier hook through its own nearest `data-reorder-item`.
   */
  const { drag: folderDrag, getHandleProps: getFolderHandleProps } = useReorderDrag({
    length: listedFolders.length,
    onMove: (from, to) => {
      const moved = listedFolders[from]
      if (moved !== undefined) actions.reorderFolder(moved, to)
    },
    getItemHeight: measureFolderPitch,
  })

  const toggleFolder = (folderId: string): void => {
    setCollapsedFolders((current) =>
      current.includes(folderId) ? current.filter((id) => id !== folderId) : [...current, folderId],
    )
  }

  /**
   * The destination the picker chose.
   *
   * `FolderPickerModal` can also answer "make a folder called X and put it there", so
   * both branches land in the same place: the dossier ends up in a folder row that
   * exists. A choice with no usable id or name is nothing chosen at all.
   */
  const handleMoveChoice = (file: LibraryFile, choice: FolderPickerChoice): void => {
    if (choice.isNew) {
      const name = choice.folderName
      if (name === undefined) return
      reportToStore(
        (async (): Promise<void> => {
          const created = await createFolder(name, null)
          await moveFile(file.id, created.id)
        })(),
      )
      return
    }

    const targetFolderId = choice.folderId
    if (targetFolderId === undefined || targetFolderId === '') return
    reportToStore(moveFile(file.id, targetFolderId))
  }

  /** The one path to a deletion: the same store action, with the same id that was asked for. */
  const confirmPendingDelete = (): void => {
    if (pendingDelete === null) return
    if (pendingDelete.kind === 'folder') {
      reportToStore(deleteFolder(pendingDelete.id))
    } else if (pendingDelete.kind === 'file') {
      reportToStore(deleteFile(pendingDelete.id))
    }
    setPendingDelete(null)
  }

  // Derived on every render, so the numbers the user is about to act on are the numbers
  // the library has now — and a target that vanished while the question was up closes
  // the dialog instead of quoting a subtree that is gone. `describeDelete` is the only
  // cascade arithmetic in the app: it counts what `deleteFolder` destroys.
  const deletePrompt =
    pendingDelete === null ? null : describeDelete(pendingDelete, folders, files, items)

  return (
    <WithMantine>
      <div className="library-panel flex min-w-0 flex-col gap-[12px]">
        {/*
          The heading and what it holds. Nothing sits above it as an eyebrow (a heading
          carries its own weight), and the line under it is the subline DESIGN.md's rhythm
          asks for, at the Body Secondary role.
        */}
        <Group justify="space-between" align="flex-end" wrap="nowrap" gap="md">
          <div className="min-w-0">
            <Title order={2} className="qrbit-text-headline">
              Library
            </Title>
            <Text className="qrbit-text-body-secondary" mt="xs">
              Dossiers stored on this device
            </Text>
          </div>
          <Button
            className="library-panel__new-folder"
            // `default`, not the accent: this panel is not the page's primary action, and
            // DESIGN.md keeps Signal Blue for the one that is.
            variant="default"
            size="sm"
            px="md"
            leftSection={<IconPlus size={16} aria-hidden="true" />}
            onClick={() => {
              setNewFolderOpen(true)
            }}
          >
            New folder
          </Button>
        </Group>

        {error !== null ? (
          <Alert
            className="library-panel__error"
            // The theme's own status colour rather than Mantine's default `red` ramp, so the
            // message is Fault Red in light and a readable tint in dark.
            color="danger"
            title="The library could not be updated"
            role="alert"
          >
            {error}
          </Alert>
        ) : null}

        {loading ? (
          <Group
            className="library-panel__loading"
            role="status"
            aria-live="polite"
            gap="xs"
            wrap="nowrap"
          >
            <Loader size="sm" />
            <Text className="qrbit-text-body-secondary">Loading your library…</Text>
          </Group>
        ) : (
          <div
            className="library-panel__sections flex min-w-0 flex-col"
            ref={sectionListRef}
            // The rows run edge to edge inside this Panel: each row supplies its own 10px
            // inset (DESIGN.md's list-row padding), which is what lets the hairlines meet the
            // border without a second bordered surface appearing inside the first.
            style={PANEL_STYLE}
          >
            {/*
              `Root` first, always: it is where a dossier goes when it has no folder, and
              where a dossier in a folder this panel does not list still turns up.
              Rendering it unconditionally is what keeps nothing unreachable.
            */}
            <FolderSection
              first
              folder={null}
              files={rootFiles}
              actions={actions}
              collapsed={collapsedFolders.includes(ROOT_FOLDER_ID)}
              onToggleCollapsed={() => {
                toggleFolder(ROOT_FOLDER_ID)
              }}
              handleProps={null}
              dragOffset={null}
            />

            {listedFolders.map((folder, index) => (
              <FolderSection
                key={folder.id}
                folder={folder}
                files={files.filter((file) => file.folderId === folder.id)}
                actions={actions}
                collapsed={collapsedFolders.includes(folder.id)}
                onToggleCollapsed={() => {
                  toggleFolder(folder.id)
                }}
                handleProps={getFolderHandleProps(index)}
                dragOffset={folderDrag !== null && folderDrag.from === index ? folderDrag.offset : null}
              />
            ))}

            {folders.length === 0 ? (
              // `.empty` is the stylesheet's dashed empty state, which is token values and
              // radius sm — this is the one place in the panel that asks for it, because it is
              // the one place with nothing inside it at all.
              <p className="library-panel__empty-folders empty m-0">
                Your library has no folders yet. Use “New folder” to make one, or “New file” in
                Root to start a dossier that is not in a folder.
              </p>
            ) : null}
          </div>
        )}

        {newFolderOpen ? (
          <NewFolderModal
            parentId={null}
            parentName="Root"
            onCreate={async (name, parentId) => {
              await createFolder(name, parentId)
            }}
            onClose={() => {
              setNewFolderOpen(false)
            }}
          />
        ) : null}

        {moveRequest !== null ? (
          <FolderPickerModal
            isOpen
            purpose="move"
            folders={listedFolders}
            fileName={moveRequest.name}
            onClose={() => {
              setMoveRequest(null)
            }}
            onSelectFolder={(choice) => {
              handleMoveChoice(moveRequest, choice)
            }}
          />
        ) : null}

        {deletePrompt !== null ? (
          <ConfirmDelete
            title={deletePrompt.title}
            message={deletePrompt.message}
            confirmLabel={deletePrompt.confirmLabel}
            onConfirm={confirmPendingDelete}
            onCancel={() => {
              setPendingDelete(null)
            }}
          />
        ) : null}
      </div>
    </WithMantine>
  )
}

// ---------------------------------------------------------------------------
// One level of the tree: the folder sections and their drag rows
// ---------------------------------------------------------------------------

/**
 * The `data-reorder-item` direct children of `container`, in document order.
 *
 * Scoped to children on purpose — see `measureFolderPitch` for why the folder list must not
 * reach the dossier rows nested inside each section.
 */
function markedRows(container: HTMLElement | null): HTMLElement[] {
  if (container === null) return []
  const rows: HTMLElement[] = []
  for (const child of Array.from(container.children)) {
    if (child instanceof HTMLElement && child.hasAttribute(REORDER_ITEM_ATTRIBUTE)) rows.push(child)
  }
  return rows
}

/** A section or a row: one hairline above (except the first), translated while it is dragged. */
function rowStyle(first: boolean, dragOffset: number | null): CSSProperties {
  const style: CSSProperties = first ? {} : ROW_DIVISION
  if (dragOffset === null) return style
  // The grabbed row rides above the list for the length of the drag: a translation and the
  // sheet shadow, which is the only shadow this screen is allowed to show (DESIGN.md,
  // "The Floating Only Rule").
  return { ...style, transform: `translateY(${dragOffset}px)`, position: 'relative', zIndex: 1, boxShadow: 'var(--qrbit-shadow-sheet)' }
}

// ---------------------------------------------------------------------------
// One section: a folder's header row and its file list
// ---------------------------------------------------------------------------

interface FolderSectionProps {
  /** `null` is the Root bucket: no folder row, so no rename, no delete, no reorder. */
  folder: LibraryFolder | null
  files: LibraryFile[]
  actions: PanelActions
  collapsed: boolean
  onToggleCollapsed(): void
  /**
   * The folder grip's props from the panel's own `useReorderDrag`, or `null` for the Root
   * bucket — which is a bucket across several folders, so no single index describes it.
   */
  handleProps: ReorderHandleProps | null
  /** Pixels to translate by while this folder is the section being dragged, else `null`. */
  dragOffset: number | null
  /** The first section draws no division above itself: it is already against the Panel edge. */
  first?: boolean
}

function FolderSection({
  folder,
  files,
  actions,
  collapsed,
  onToggleCollapsed,
  handleProps,
  dragOffset,
  first = false,
}: FolderSectionProps) {
  const name = folder?.name ?? 'Root'
  // The id every action in this section is about: the folder's own, or the root
  // sentinel, which the library layer accepts as a real target for a file.
  const folderId = folder?.id ?? ROOT_FOLDER_ID
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(name)

  const startRename = (): void => {
    setDraftName(name)
    setRenaming(true)
  }

  const commitRename = (): void => {
    const next = draftName.trim()
    if (folder === null || next === '') return
    actions.renameFolder(folder, next)
    setRenaming(false)
  }

  return (
    <section
      className="library-panel__folder min-w-0"
      // The marker the panel's folder-level `useReorderDrag` measures. The whole section is the
      // row — an expanded folder's file list travels with it — while the dossier rows nested
      // inside carry the same marker for their own, separate list.
      data-reorder-item={handleProps === null ? undefined : ''}
      style={rowStyle(first, dragOffset)}
    >
      <div className="library-panel__folder-row flex min-h-[44px] min-w-0 items-center gap-[4px] px-[10px]">
        {handleProps === null ? null : (
          <ReorderGrip
            handleProps={handleProps}
            className="library-panel__folder-grip"
            // The hook's own label gives a position in the list; with two drag lists on one
            // screen, the folder the grip belongs to is the part worth hearing.
            label={`Reorder folder ${name}`}
            dragging={dragOffset !== null}
          />
        )}

        <ActionIcon
          variant="subtle"
          size="lg"
          className="library-panel__folder-toggle shrink-0"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <IconChevronRight size={16} aria-hidden="true" />
          ) : (
            <IconChevronDown size={16} aria-hidden="true" />
          )}
        </ActionIcon>

        {renaming ? (
          <RenameField
            className="library-panel__folder-rename"
            inputClassName="library-panel__folder-rename-field"
            saveClassName="library-panel__folder-rename-save"
            cancelClassName="library-panel__folder-rename-cancel"
            label={`Rename ${name}`}
            draft={draftName}
            onDraftChange={setDraftName}
            onCancel={() => {
              setRenaming(false)
            }}
            onSubmit={commitRename}
          />
        ) : (
          <Button
            // The name does what the chevron does, on a bigger target. `aria-expanded` stays
            // on the chevron, which is the control that owns the state.
            className="library-panel__folder-name min-w-0 flex-1"
            variant="subtle"
            size="xs"
            justify="flex-start"
            px="xs"
            leftSection={<IconFolder size={16} aria-hidden="true" />}
            onClick={onToggleCollapsed}
          >
            <span className="truncate">{name}</span>
          </Button>
        )}

        <Text className="library-panel__folder-count qrbit-text-label shrink-0" c="dimmed">
          {files.length}
        </Text>

        {folder === null ? null : (
          <RowMenu
            className="library-panel__folder-menu-toggle"
            label={`Actions for ${name}`}
            items={[
              {
                label: 'New file in this folder',
                icon: <IconPlus size={16} aria-hidden="true" />,
                onSelect: () => {
                  actions.createFile(folderId)
                },
              },
              {
                label: 'Rename folder',
                icon: <IconPencil size={16} aria-hidden="true" />,
                onSelect: startRename,
              },
              {
                label: 'Delete folder and contents',
                icon: <IconTrash size={16} aria-hidden="true" />,
                danger: true,
                divider: true,
                onSelect: () => {
                  actions.askDeleteFolder(folder)
                },
              },
            ]}
          />
        )}
      </div>

      {folder === null ? (
        // The bucket needs a line of its own: it is reachable precisely because dossiers can
        // live where this one-level panel does not list them.
        <Text
          className="library-panel__folder-hint qrbit-text-body-secondary"
          px="md"
          pb="xs"
          fz={13}
        >
          {collapsed ? `${files.length} dossier${files.length === 1 ? '' : 's'} hidden — ` : ''}
          Dossiers that are not in a folder listed here.
        </Text>
      ) : null}

      {collapsed ? null : (
        <div className="px-[10px] pb-[12px] pt-[4px]">
          {/*
            Root is a bucket across several folders, so its rows are listed but not reordered:
            one index cannot describe several `sortOrder` runs.
          */}
          <FileList
            files={files}
            folderId={folderId}
            actions={actions}
            reorderable={folder !== null}
            emptyHint={
              folder === null
                ? 'Nothing here — every dossier is inside a folder you can see.'
                : `No dossiers in ${name} yet.`
            }
          />
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Inline rename, and the row's menu and grip
// ---------------------------------------------------------------------------

interface RenameFieldProps {
  /** The folder or dossier being renamed, in the field's accessible name. */
  label: string
  draft: string
  onDraftChange(value: string): void
  onSubmit(): void
  onCancel(): void
  className: string
  inputClassName: string
  saveClassName: string
  cancelClassName: string
}

/**
 * The inline rename, spelled once.
 *
 * A folder row and a dossier row both need this and were keeping two copies — which is how
 * one of them ended up with a save control that could be pressed while empty. The rule lives
 * here: a trimmed empty name cannot be submitted, Escape abandons the edit, and the field
 * keeps the focus it was given.
 */
function RenameField({
  label,
  draft,
  onDraftChange,
  onSubmit,
  onCancel,
  className,
  inputClassName,
  saveClassName,
  cancelClassName,
}: RenameFieldProps) {
  return (
    <form
      className={`flex min-w-0 flex-1 items-center gap-[8px] py-[8px] ${className}`}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <TextInput
        className={`${inputClassName} min-w-0 flex-1`}
        size="xs"
        type="text"
        value={draft}
        aria-label={label}
        autoFocus
        onChange={(event) => {
          onDraftChange(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      />
      <Button
        type="submit"
        size="xs"
        color="signal"
        disabled={draft.trim() === ''}
        className={saveClassName}
      >
        Save
      </Button>
      <Button
        type="button"
        size="xs"
        variant="subtle"
        className={cancelClassName}
        onClick={onCancel}
      >
        Cancel
      </Button>
    </form>
  )
}

/**
 * The drag handle, which is also the keyboard handle (D16.3).
 *
 * DESIGN.md's "Invisible Is Not Quiet" rule is the reason this is its own component: the grip
 * used to be `#94A3B8` on the page — 2.28:1, which is why it read as a smudge rather than a
 * handle. At rest it is `--qrbit-ink-muted` (5.41:1 on Raised in light, 6.19:1 in dark), on
 * hover `--qrbit-ink` (18.72 / 14.21), `grab`/`grabbing` to say what a press does, and the
 * global 2px `:focus-visible` ring for the keyboard path. Hover is read through
 * `useHover`'s ref because a component that owns no stylesheet cannot write a `:hover` rule.
 */
function ReorderGrip({
  handleProps,
  label,
  dragging,
  className,
}: {
  handleProps: ReorderHandleProps
  label: string
  dragging: boolean
  /** Which list this grip belongs to: `library-panel__folder-grip` or `library-panel__grip`. */
  className: string
}) {
  const { hovered, ref } = useHover<HTMLButtonElement>()

  return (
    <ActionIcon
      ref={ref}
      {...handleProps}
      // The hook's own label is positional ("item 2 of 5"); naming the row is the part a
      // screen with two drag lists needs.
      aria-label={label}
      variant="subtle"
      size="lg"
      className={`${className} shrink-0`}
      style={{
        ...handleProps.style,
        cursor: dragging ? 'grabbing' : 'grab',
        color: hovered ? 'var(--qrbit-ink)' : 'var(--qrbit-ink-muted)',
      }}
    >
      <IconGripVertical size={16} aria-hidden="true" />
    </ActionIcon>
  )
}

/** One entry of a row menu. */
interface RowMenuItem {
  label: string
  icon: ReactNode
  onSelect: () => void
  /** Draws the division above this entry — used to separate the destructive answer. */
  divider?: boolean
  /** Fault Red, and the consequence in the words: this entry opens a confirmation. */
  danger?: boolean
}

/**
 * The `···` menu every row has, spelled once.
 *
 * Folder and dossier rows used to hand-roll two nearly identical inline menus, which is how
 * one said "Move to…" and the other said nothing about moving, and how a menu entry became a
 * `<button role="menuitem">` with the role pasted onto it. Mantine's `Menu` owns the open
 * state, the `menu`/`menuitem` roles, the Escape and click-outside close, and the focus ring;
 * a row only says what its actions are.
 */
function RowMenu({ label, items, className }: { label: string; items: RowMenuItem[]; className: string }) {
  return (
    <Menu position="bottom-end" offset={4}>
      <Menu.Target>
        <ActionIcon variant="subtle" size="lg" className={className} aria-label={label}>
          <IconDotsVertical size={16} aria-hidden="true" />
        </ActionIcon>
      </Menu.Target>

      <Menu.Dropdown>
        {items.map((item) => (
          <FragmentRow key={item.label} divider={item.divider === true}>
            <Menu.Item
              // `danger` resolves through the theme's Fault Red ramp, which is scheme-aware:
              // #B4232A as text on the dark canvas would be 2.53:1, so a bare token cannot be
              // written here.
              color={item.danger === true ? 'danger' : undefined}
              leftSection={item.icon}
              onClick={item.onSelect}
            >
              {item.label}
            </Menu.Item>
          </FragmentRow>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}

/** The division that separates a destructive entry from the constructive ones above it. */
function FragmentRow({
  divider,
  children,
}: {
  divider: boolean
  children: ReactNode
}) {
  if (!divider) return <>{children}</>
  return (
    <>
      <Menu.Divider />
      {children}
    </>
  )
}

// ---------------------------------------------------------------------------
// The file list of one folder
// ---------------------------------------------------------------------------

interface FileListProps {
  files: LibraryFile[]
  /** The folder these files belong to; `ROOT_FOLDER_ID` for the unfiled bucket. */
  folderId: string
  actions: PanelActions
  /** False for the Root bucket, where one index cannot describe several folders' order. */
  reorderable: boolean
  /** The line printed when the folder holds nothing — never shown while loading. */
  emptyHint: string
}

function FileList({ files, folderId, actions, reorderable, emptyHint }: FileListProps) {
  return (
    <Stack gap="xs">
      {/*
        `+ New file` sits at the TOP of the list it creates into (D16 requirement 3), so
        the dossier lands in the folder the user is looking at rather than whichever one
        the page happened to remember.
      */}
      <Button
        className="library-panel__new-file"
        variant="subtle"
        size="xs"
        w="fit-content"
        leftSection={<IconPlus size={16} aria-hidden="true" />}
        onClick={() => {
          actions.createFile(folderId)
        }}
      >
        New file
      </Button>

      {files.length === 0 ? (
        <p className="library-panel__empty-folder qrbit-text-body-secondary m-0 px-[10px] py-[8px]">
          {emptyHint}
        </p>
      ) : reorderable ? (
        <ReorderableFileList files={files} folderId={folderId} actions={actions} />
      ) : (
        <ul className="library-panel__files m-0 flex list-none flex-col p-0">
          {files.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              actions={actions}
              handleProps={null}
              dragOffset={null}
            />
          ))}
        </ul>
      )}
    </Stack>
  )
}

/**
 * The rows of one folder, with the grip drag and its keyboard twin (D16.2/D16.3).
 *
 * One `useReorderDrag` instance per folder, beside the panel's own instance for the folder rows:
 * the indices of neither mean anything to the other.
 *
 * `useReorderDrag` is used exactly as its own example shows: the hook owns the pointer
 * and key handling, `onMove(from, to)` is the only way anything leaves it, and both fire
 * once per completed reorder with indices into the list as it renders. So a drag and an
 * arrow-key press persist through the same `store.reorderFile(id, to, folderId)` call,
 * and the store's re-read redraws the list in its new order.
 */
function ReorderableFileList({
  files,
  folderId,
  actions,
}: {
  files: LibraryFile[]
  folderId: string
  actions: PanelActions
}) {
  const { drag, getHandleProps } = useReorderDrag({
    length: files.length,
    onMove: (from, to) => {
      const moved = files[from]
      if (moved !== undefined) actions.reorderFile(moved, to, folderId)
    },
  })

  return (
    <ul className="library-panel__files m-0 flex list-none flex-col p-0">
      {files.map((file, index) => (
        <FileRow
          key={file.id}
          file={file}
          actions={actions}
          handleProps={getHandleProps(index)}
          dragOffset={drag !== null && drag.from === index ? drag.offset : null}
        />
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// One dossier row
// ---------------------------------------------------------------------------

interface FileRowProps {
  file: LibraryFile
  actions: PanelActions
  /** The grip's props, or `null` where a reorder would be a lie (the Root bucket). */
  handleProps: ReorderHandleProps | null
  /** Pixels to translate by while this row is the one being dragged, else `null`. */
  dragOffset: number | null
}

function FileRow({ file, actions, handleProps, dragOffset }: FileRowProps) {
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(file.name)

  const preview = getFirstBlockPreview(file)
  const encrypted = hasLockedBlocks(file)

  const startRename = (): void => {
    setDraftName(file.name)
    setRenaming(true)
  }

  const commitRename = (): void => {
    const next = draftName.trim()
    if (next === '') return
    actions.renameFile(file, next)
    setRenaming(false)
  }

  return (
    <li
      className="library-panel__file flex min-h-[44px] min-w-0 items-center gap-[4px] px-[10px]"
      // The marker `useReorderDrag` measures to find a row's pitch (see its module comment).
      data-reorder-item={handleProps === null ? undefined : ''}
      style={rowStyle(false, dragOffset)}
    >
      {handleProps === null ? null : (
        <ReorderGrip
          handleProps={handleProps}
          className="library-panel__grip"
          label={`Reorder dossier ${file.name}`}
          dragging={dragOffset !== null}
        />
      )}

      {renaming ? (
        <RenameField
          className="library-panel__file-rename"
          inputClassName="library-panel__file-rename-field"
          saveClassName="library-panel__file-rename-save"
          cancelClassName="library-panel__file-rename-cancel"
          label={`Rename ${file.name}`}
          draft={draftName}
          onDraftChange={setDraftName}
          onCancel={() => {
            setRenaming(false)
          }}
          onSubmit={commitRename}
        />
      ) : (
        // The whole row (minus the grip and the menu) opens the editor.
        <Button
          className="library-panel__file-open min-w-0 flex-1"
          variant="subtle"
          size="sm"
          justify="flex-start"
          px="xs"
          styles={ROW_BUTTON_STYLES}
          leftSection={<IconFileText size={16} aria-hidden="true" />}
          aria-label={`Open ${file.name}`}
          onClick={() => {
            actions.openFile(file)
          }}
        >
          <span className="block min-w-0">
            <span className="flex items-center gap-[8px]">
              <span className="library-panel__file-name truncate">{file.name}</span>
              {encrypted ? (
                <Badge
                  className="library-panel__encrypted-badge"
                  // Locked Rust: the one colour the product reserves for encryption state,
                  // wearing a word as well as a glyph (DESIGN.md, "Badges and Chips"). It used
                  // to ask for a `shield` colour, which the theme never defined.
                  color="locked"
                  variant="light"
                  size="sm"
                  radius="full"
                  leftSection={<IconLock size={14} aria-hidden="true" />}
                >
                  Encrypted
                </Badge>
              ) : null}
            </span>
            <span className="library-panel__file-preview qrbit-text-body-secondary block truncate">
              {preview}
            </span>
          </span>
        </Button>
      )}

      <RowMenu
        className="library-panel__file-menu-toggle"
        label={`Actions for ${file.name}`}
        items={[
          {
            label: 'Rename dossier',
            icon: <IconPencil size={16} aria-hidden="true" />,
            onSelect: startRename,
          },
          {
            label: 'Move to folder',
            icon: <IconArrowsMove size={16} aria-hidden="true" />,
            onSelect: () => {
              actions.askMoveFile(file)
            },
          },
          {
            label: 'Delete dossier',
            icon: <IconTrash size={16} aria-hidden="true" />,
            danger: true,
            divider: true,
            onSelect: () => {
              actions.askDeleteFile(file)
            },
          },
        ]}
      />
    </li>
  )
}

// ---------------------------------------------------------------------------
// The store calls
// ---------------------------------------------------------------------------

/**
 * Runs a store write whose rejection the panel cannot act on.
 *
 * The store already records the message in `error`, which this panel renders, so the
 * handler's job is only to keep the rejection out of the browser's unhandled-rejection
 * path. Nothing here re-throws into React's render path (PLAN.md §17).
 */
function reportToStore(operation: Promise<unknown>): void {
  void operation.catch(() => undefined)
}

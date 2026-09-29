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
 * **State ownership.** The panel reads and writes `store/libraryStore` directly: the
 * store is the UI's only route to IndexedDB, and it re-reads the database after every
 * write, so the list on screen is the list that was just stored. That is what makes a
 * drag, a rename and a cascade delete observable from outside the component. The page
 * keeps only the two things the panel cannot know — which dossier opens in the editor,
 * and what a brand-new dossier is made of (`onCreateFile`).
 *
 * **Ordering.** Two kinds of drag share this screen, and each index means something only inside
 * the one list it was counted against. Folders reorder among the folders that share their
 * parent (`lib/library.ts` `reorderFolder` and `siblingFolders`); this panel lists one level, so
 * its folder grips reorder the top level and a subfolder's run is never touched. Dossiers
 * reorder inside the folder whose list they are in, because their `sortOrder` is per folder. The
 * `Root` section is a bucket rather than a folder — it holds whatever no listed folder does — so
 * neither its rows nor its header get a grip: it is openable, renamable, movable and deletable,
 * but it has no order the store could honour, and the hook is never given an index counted
 * against a list the store does not have.
 *
 * **Expansion** is "collapsed ids", not "expanded ids": a folder is open unless the user
 * collapsed it, so folders that arrive after the first render are open without the
 * panel ever naming an id it has not seen (this is what replaced `['f-1','f-2','f-3']`).
 * It is UI state only, and nothing here writes to `localStorage`, IndexedDB or the
 * Cache API (AGENTS.md).
 *
 * Every delete is confirmed first, and the folder prompt states the cascade in numbers,
 * because `deleteFolder` takes the subtree and everything in it permanently (PLAN.md
 * §6.3) — the library never leaves the device, so there is no other copy to restore.
 */

import { useCallback, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Alert, Badge, Button, Group, Loader, Stack, Text, Title } from '@mantine/core'
import {
  IconChevronDown,
  IconChevronRight,
  IconDotsVertical,
  IconFileText,
  IconFolderFilled,
  IconGripVertical,
  IconLock,
  IconPlus,
} from '@tabler/icons-react'

import { ConfirmDelete } from '../ConfirmDelete'
import { WithMantine } from '../common/WithMantine'
import { FolderPickerModal } from './FolderPickerModal'
import type { FolderPickerChoice } from './FolderPickerModal'
import { NewFolderModal } from './NewFolderModal'
import { REORDER_ITEM_ATTRIBUTE, useReorderDrag } from '../../hooks/useReorderDrag'
import type { ReorderHandleProps } from '../../hooks/useReorderDrag'
import { getFirstBlockPreview, hasLockedBlocks } from '../../lib/dossier'
import { ROOT_FOLDER_ID, siblingFolders } from '../../lib/library'
import type { LibraryFile, LibraryFolder, LibraryItem } from '../../lib/library'
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

/** The delete the user asked for. `null` in state means no dialog is open. */
type PendingDelete = { kind: 'folder'; id: string } | { kind: 'file'; id: string }

/** The words `ConfirmDelete` shows, counted from the live props. */
interface ConfirmPrompt {
  title: string
  message: string
  confirmLabel: string
}

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
  /** The dossier whose "Move to…" dialog is open; `null` means none. */
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
    } else {
      reportToStore(deleteFile(pendingDelete.id))
    }
    setPendingDelete(null)
  }

  // Derived on every render, so the numbers the user is about to act on are the numbers
  // the library has now — and a target that vanished while the question was up closes
  // the dialog instead of quoting a subtree that is gone.
  const deletePrompt =
    pendingDelete === null ? null : describePendingDelete(pendingDelete, folders, files, items)

  return (
    <WithMantine>
      <div className="library-panel flex min-w-0 flex-col gap-3">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <div className="min-w-0">
            <Title order={2} size="h6" className="page__section-title library-panel__title">
              Local Library
            </Title>
            <Text size="xs" c="dimmed">
              Dossiers stored on this device
            </Text>
          </div>
          <Button
            className="library-panel__new-folder"
            variant="light"
            size="xs"
            leftSection={<IconPlus size={16} aria-hidden="true" />}
            onClick={() => {
              setNewFolderOpen(true)
            }}
          >
            New Folder
          </Button>
        </Group>

        {error !== null ? (
          <Alert
            className="library-panel__error"
            color="red"
            title="The library could not be updated"
            role="alert"
          >
            <Text size="xs">{error}</Text>
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
            <Text size="sm" c="dimmed">
              Loading your library…
            </Text>
          </Group>
        ) : (
          <div className="library-panel__sections flex flex-col gap-3" ref={sectionListRef}>
            {/*
              `Root` first, always: it is where a dossier goes when it has no folder, and
              where a dossier in a folder this panel does not list still turns up.
              Rendering it unconditionally is what keeps nothing unreachable.
            */}
            <FolderSection
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
              <p className="library-panel__empty library-panel__empty-folders rounded-lg border border-dashed border-[#D1D9E4] px-3 py-3 text-center text-xs text-[#5B6B82]">
                Your library has no folders yet. Use “New Folder” to make one, or
                “New file” in Root to start a dossier that is not in a folder.
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
}

function FolderSection({
  folder,
  files,
  actions,
  collapsed,
  onToggleCollapsed,
  handleProps,
  dragOffset,
}: FolderSectionProps) {
  const name = folder?.name ?? 'Root'
  // The id every action in this section is about: the folder's own, or the root
  // sentinel, which the library layer accepts as a real target for a file.
  const folderId = folder?.id ?? ROOT_FOLDER_ID
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(name)

  const closeMenu = (): void => {
    setMenuOpen(false)
  }

  const startRename = (): void => {
    setDraftName(name)
    setRenaming(true)
    closeMenu()
  }

  const commitRename = (): void => {
    const next = draftName.trim()
    if (folder === null || next === '') return
    actions.renameFolder(folder, next)
    setRenaming(false)
  }

  return (
    <section
      className="library-panel__folder rounded-lg border border-[#D1D9E4] bg-white"
      // The marker the panel's folder-level `useReorderDrag` measures. The whole section is the
      // row — an expanded folder's file list travels with it — while the dossier rows nested
      // inside carry the same marker for their own, separate list.
      data-reorder-item={handleProps === null ? undefined : ''}
      style={
        dragOffset === null
          ? undefined
          : { transform: `translateY(${dragOffset}px)`, position: 'relative', zIndex: 1 }
      }
    >
      <div className="library-panel__folder-row flex items-center gap-1.5 px-2 py-1.5">
        {handleProps === null ? null : (
          <button
            {...handleProps}
            // The hook's own label gives a position in the list; with two drag lists on one
            // screen, the folder the grip belongs to is the part worth hearing.
            aria-label={`Reorder folder ${name}`}
            className="library-panel__folder-grip shrink-0 rounded p-1 text-[#94A3B8] hover:bg-slate-100 hover:text-[#0F172A]"
          >
            <IconGripVertical size={16} aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          className="library-panel__folder-toggle shrink-0 rounded p-1 text-[#5B6B82] hover:bg-slate-100"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <IconChevronRight size={16} aria-hidden="true" /> : <IconChevronDown size={16} aria-hidden="true" />}
        </button>

        {renaming ? (
          <form
            className="library-panel__folder-rename flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              commitRename()
            }}
          >
            <input
              className="library-panel__folder-rename-input desktop-sm min-w-0 flex-1 rounded border border-[#D1D9E4] px-2 py-1 text-sm"
              type="text"
              value={draftName}
              aria-label={`Rename ${name}`}
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
              className="library-panel__folder-rename-save text-xs font-semibold text-[#1D4ED8]"
              disabled={draftName.trim() === ''}
            >
              Save
            </button>
            <button
              type="button"
              className="library-panel__folder-rename-cancel text-xs text-[#5B6B82]"
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
            className="library-panel__folder-name flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={onToggleCollapsed}
          >
            <IconFolderFilled size={16} className="shrink-0 text-[#0F766E]" aria-hidden="true" />
            <span className="truncate text-sm font-semibold text-[#0F172A]">{name}</span>
          </button>
        )}

        <span className="library-panel__folder-count shrink-0 font-mono text-xs text-[#5B6B82]">
          {files.length}
        </span>

        {folder === null ? null : (
          <button
            type="button"
            className="library-panel__folder-menu-toggle shrink-0 rounded p-1 text-[#5B6B82] hover:bg-slate-100"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Actions for ${name}`}
            onClick={() => {
              setMenuOpen(!menuOpen)
            }}
          >
            <IconDotsVertical size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {menuOpen ? (
        <div className="library-panel__folder-menu flex flex-col gap-0.5 border-t border-[#D1D9E4] px-2 py-1.5" role="menu">
          <MenuItem onClick={startRename}>Rename</MenuItem>
          <MenuItem
            onClick={() => {
              closeMenu()
              actions.createFile(folderId)
            }}
          >
            New file here
          </MenuItem>
          <MenuItem
            danger
            onClick={() => {
              closeMenu()
              if (folder !== null) actions.askDeleteFolder(folder)
            }}
          >
            Delete folder and contents
          </MenuItem>
        </div>
      ) : null}

      {folder === null ? (
        // The bucket needs a line of its own: it is reachable precisely because dossiers can
        // live where this one-level panel does not list them.
        <p className="library-panel__folder-hint px-2 pb-1 text-xs text-[#5B6B82]">
          {collapsed ? `${files.length} dossier${files.length === 1 ? '' : 's'} hidden — ` : ''}
          Dossiers that are not in a folder listed here.
        </p>
      ) : null}

      {collapsed ? null : (
        <div className="border-t border-[#EEF2F6] px-2 py-2">
          {folder === null ? (
            <FileList
              files={files}
              folderId={folderId}
              actions={actions}
              reorderable={false}
              emptyHint="Nothing here — every dossier is inside a folder you can see."
            />
          ) : (
            <FileList
              files={files}
              folderId={folderId}
              actions={actions}
              reorderable
              emptyHint={`No dossiers in ${name} yet.`}
            />
          )}
        </div>
      )}
    </section>
  )
}

/** One line of a `role="menu"` list. A plain button: a menu entry is an imperative action. */
function MenuItem({
  children,
  onClick,
  danger = false,
}: {
  children: ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`library-panel__menu-item rounded px-2 py-1.5 text-left text-xs font-medium tactile-btn hover:bg-slate-100 ${
        danger ? 'library-panel__menu-item--danger text-[#DC2626]' : 'text-[#0F172A]'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
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
      <button
        type="button"
        className="library-panel__new-file flex items-center gap-1 self-start rounded px-1 py-0.5 text-xs font-semibold text-[#1D4ED8] hover:bg-blue-50"
        onClick={() => {
          actions.createFile(folderId)
        }}
      >
        <IconPlus size={14} aria-hidden="true" />
        New file
      </button>

      {files.length === 0 ? (
        <p className="library-panel__empty library-panel__empty-folder px-1 py-2 text-xs text-[#5B6B82]">
          {emptyHint}
        </p>
      ) : reorderable ? (
        <ReorderableFileList files={files} folderId={folderId} actions={actions} />
      ) : (
        <ul className="library-panel__files m-0 flex list-none flex-col gap-1.5 p-0">
          {files.map((file) => (
            <FileRow key={file.id} file={file} actions={actions} handleProps={null} dragOffset={null} />
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
    <ul className="library-panel__files m-0 flex list-none flex-col gap-1.5 p-0">
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
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(file.name)

  const preview = getFirstBlockPreview(file)
  const encrypted = hasLockedBlocks(file)

  const closeMenu = (): void => {
    setMenuOpen(false)
  }

  const startRename = (): void => {
    setDraftName(file.name)
    setRenaming(true)
    closeMenu()
  }

  const commitRename = (): void => {
    const next = draftName.trim()
    if (next === '') return
    actions.renameFile(file, next)
    setRenaming(false)
  }

  return (
    <li
      className="library-panel__file rounded-md border border-[#D1D9E4] bg-white"
      // The marker `useReorderDrag` measures to find a row's pitch (see its module comment).
      data-reorder-item={handleProps === null ? undefined : ''}
      style={
        dragOffset === null
          ? undefined
          : { transform: `translateY(${dragOffset}px)`, position: 'relative', zIndex: 1 }
      }
    >
      <div className="flex items-center gap-1.5 py-1 pr-1">
        {handleProps === null ? null : (
          <button
            {...handleProps}
            className="library-panel__grip shrink-0 rounded p-1 text-[#94A3B8] hover:bg-slate-100 hover:text-[#0F172A]"
          >
            <IconGripVertical size={16} aria-hidden="true" />
          </button>
        )}

        {renaming ? (
          <form
            className="library-panel__file-rename flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              commitRename()
            }}
          >
            <input
              className="library-panel__file-rename-input desktop-sm min-w-0 flex-1 rounded border border-[#D1D9E4] px-2 py-1 text-sm"
              type="text"
              value={draftName}
              aria-label={`Rename ${file.name}`}
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
              className="library-panel__file-rename-save text-xs font-semibold text-[#1D4ED8]"
              disabled={draftName.trim() === ''}
            >
              Save
            </button>
            <button
              type="button"
              className="library-panel__file-rename-cancel text-xs text-[#5B6B82]"
              onClick={() => {
                setRenaming(false)
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          // The whole row (minus the grip and the menu) opens the editor.
          <button
            type="button"
            className="library-panel__file-open flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-slate-50"
            onClick={() => {
              actions.openFile(file)
            }}
          >
            <IconFileText size={16} className="shrink-0 text-[#1D4ED8]" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="library-panel__file-name truncate text-sm font-medium text-[#0F172A]">
                  {file.name}
                </span>
                {encrypted ? (
                  <Badge
                    className="library-panel__encrypted-badge"
                    size="xs"
                    variant="light"
                    color="shield"
                    leftSection={<IconLock size={10} aria-hidden="true" />}
                  >
                    Encrypted
                  </Badge>
                ) : null}
              </span>
              <span className="library-panel__file-preview block truncate text-xs text-[#5B6B82]">
                {preview}
              </span>
            </span>
          </button>
        )}

        <button
          type="button"
          className="library-panel__file-menu-toggle shrink-0 rounded p-1 text-[#5B6B82] hover:bg-slate-100"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Actions for ${file.name}`}
          onClick={() => {
            setMenuOpen(!menuOpen)
          }}
        >
          <IconDotsVertical size={16} aria-hidden="true" />
        </button>
      </div>

      {menuOpen ? (
        <div className="library-panel__file-menu flex flex-col gap-0.5 border-t border-[#EEF2F6] px-1 py-1.5" role="menu">
          <MenuItem onClick={startRename}>Rename</MenuItem>
          <MenuItem
            onClick={() => {
              closeMenu()
              actions.askMoveFile(file)
            }}
          >
            Move to…
          </MenuItem>
          <MenuItem
            danger
            onClick={() => {
              closeMenu()
              actions.askDeleteFile(file)
            }}
          >
            Delete
          </MenuItem>
        </div>
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Pure helpers — the arithmetic the prompts and the store calls depend on
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

/** What one folder delete costs, counted over the flat lists the store hands down. */
interface DeleteCost {
  folders: number
  files: number
  items: number
}

/**
 * Counts the subtree a folder delete takes with it.
 *
 * `deleteFolder` walks the same parent links in IndexedDB — "a folder tree dies whole"
 * (PLAN.md §6.3), because a dossier whose folder is gone would be unreachable — so the
 * warning can only be honest if it counts the same way. The folder itself is included:
 * it is destroyed too. Dossiers and legacy loose items are both counted, because both
 * really do go.
 */
function deleteCost(
  folders: LibraryFolder[],
  files: LibraryFile[],
  items: LibraryItem[],
  folderId: string,
): DeleteCost {
  /*
   * A Set's iterator visits values added during iteration, so widening `doomed` in place
   * walks the whole tree without a queue of its own. The `has` guard is what makes a
   * malformed cycle in the stored parent links terminate instead of looping forever.
   */
  const doomed = new Set<string>([folderId])
  for (const ancestor of doomed) {
    for (const folder of folders) {
      if (folder.parentId === ancestor && !doomed.has(folder.id)) doomed.add(folder.id)
    }
  }

  let fileCount = 0
  for (const file of files) {
    if (doomed.has(file.folderId)) fileCount += 1
  }
  let itemCount = 0
  for (const item of items) {
    if (doomed.has(item.folderId)) itemCount += 1
  }

  return { folders: doomed.size, files: fileCount, items: itemCount }
}

/** "2 folders", "1 dossier", "no items" — how the cascade warning is read. */
function countNouns(count: number, noun: string): string {
  if (count === 0) return `no ${noun}s`
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The prompt for a pending delete, read from the live store state.
 *
 * `null` means the target is gone, which drops the dialog rather than letting it quote
 * a dossier or a subtree that no longer exists.
 */
function describePendingDelete(
  request: PendingDelete,
  folders: LibraryFolder[],
  files: LibraryFile[],
  items: LibraryItem[],
): ConfirmPrompt | null {
  if (request.kind === 'file') {
    const file = files.find((candidate) => candidate.id === request.id)
    if (file === undefined) return null
    return {
      title: `Delete “${file.name}”?`,
      message:
        `“${file.name}” and its ${countNouns(file.blocks.length, 'block')} will be permanently ` +
        'deleted from this device. This cannot be undone.',
      confirmLabel: 'Delete dossier permanently',
    }
  }

  const folder = folders.find((candidate) => candidate.id === request.id)
  if (folder === undefined) return null

  const impact = deleteCost(folders, files, items, folder.id)
  return {
    title: `Delete “${folder.name}”?`,
    message:
      `This permanently deletes ${countNouns(impact.folders, 'folder')}, ` +
      `${countNouns(impact.files, 'dossier')} and ${countNouns(impact.items, 'item')} — ` +
      `“${folder.name}” and every folder inside it. This cannot be undone.`,
    confirmLabel: 'Delete folder and contents permanently',
  }
}

/**
 * The library store (PLAN.md §6, §16 Phase 5) — the UI's ONLY route to the local
 * library.
 *
 * A thin zustand wrapper around `lib/library.ts`: the components take folders, items
 * and callbacks as props and never import the IndexedDB layer themselves, so this
 * module is the one place where "the user asked for this" turns into a library write.
 * Two rules shape everything below:
 *
 *   - **IDB belongs to `lib/library.ts`.** Nothing here opens a connection, names an
 *     object store or hand-rolls a query. Reads go through `getFolders` and
 *     `getItemsInFolder` (the `folderId` index PLAN.md §6.3 declares); writes go
 *     through the layer's own calls, which validate the §6.1 shape on the way in and
 *     normalise it on the way out.
 *   - **The store is memory only.** It holds the library's own persistent rows and
 *     nothing else. Session artifacts — keys, the safety phrase, in-flight items,
 *     received items the user has not explicitly saved — are never put here and never
 *     reach IndexedDB (AGENTS.md, PLAN.md §1/§17). The one write path is an explicit
 *     user action: library CRUD, or `saveFromSession` from the ended screen.
 *
 * State is always taken from IndexedDB after a write rather than patched locally, so
 * a view can never show a copy that drifted from what is stored — which is what makes
 * a cascade delete (`deleteFolder`, PLAN.md §6.3) correct without re-implementing the
 * subtree walk here.
 *
 * Failures are recorded in `error` and rethrown. The rethrow is for the callers that
 * await a store action and report the problem themselves (`NewFolderModal`,
 * `SaveToLibraryModal`); a caller that cannot await (an event-handler wiring for a
 * `void` callback) catches and leaves the message to `error`, which the library
 * browser renders. Nothing is ever thrown into React's render path.
 */

import { create } from 'zustand'

import * as library from '../lib/library'
import { ROOT_FOLDER_ID } from '../lib/library'
import type { FileBlock, LibraryFile, LibraryFolder, LibraryItem } from '../lib/library'
import type { SessionItem } from './sessionStore'

export interface LibraryState {
  folders: LibraryFolder[]
  /** Every item in the library, whatever folder it is in (PLAN.md §6.4 needs them all). */
  items: LibraryItem[]
  /** Every file (dossier) in the library. */
  files: LibraryFile[]
  loading: boolean
  error: string | null

  /** Reloads folders, items, and files from IndexedDB. Never rejects: a failure shows in `error`. */
  refresh(): Promise<void>
  /** Seeds default folders & dossiers if library is completely empty. */
  seedInitialLibrary(): Promise<void>
  createFolder(name: string, parentId: string | null, color?: string): Promise<LibraryFolder>
  renameFolder(id: string, name: string): Promise<void>
  /**
   * Deletes the folder, its subfolders, and every item/file inside them.
   */
  deleteFolder(id: string): Promise<void>

  // Dossier File CRUD
  createFile(name: string, folderId: string, blocks?: FileBlock[]): Promise<LibraryFile>
  saveFile(file: LibraryFile): Promise<void>
  updateFile(id: string, patch: Partial<LibraryFile>): Promise<void>
  deleteFile(id: string): Promise<void>
  /** Moves a file to another folder, landing it at the END of that folder's order. */
  moveFile(id: string, targetFolderId: string): Promise<void>
  /**
   * Persists a reorder within the file's own folder (ORCHESTRATION D16.1/D16.3): the
   * `onMove(from, to)` of a drag or an arrow-key press both end here.
   *
   * `targetIndex` is the row's index in the list as it currently reads — the same
   * convention `moveIndex` and `useReorderDrag` use — and `folderId` is the folder the
   * caller was showing, checked against what is stored. See `lib/library.ts` `reorderFile`.
   */
  reorderFile(id: string, targetIndex: number, folderId?: string): Promise<void>
  /** The folder's files, in the order the library reads them (`sortOrder`, then age, then id). */
  filesIn(folderId: string): LibraryFile[]

  // Legacy/loose item CRUD
  renameItem(id: string, name: string): Promise<void>
  deleteItem(id: string): Promise<void>
  /** `null` is the tree's Root, which the library layer spells with its own sentinel id. */
  moveItem(id: string, targetFolderId: string | null): Promise<void>
  /** Create or overwrite by id (the library id IS the store's key). */
  saveItem(item: LibraryItem): Promise<void>
  /**
   * Converts a §9 session item and stores it.
   */
  saveFromSession(item: SessionItem, folderId: string | null): Promise<LibraryItem>
  /** The items directly in `folderId`; `ROOT_FOLDER_ID` is the root. */
  itemsIn(folderId: string): LibraryItem[]
}

/** The library as IndexedDB holds it, read through the §6.3 indexes. */
async function readLibrary(): Promise<{
  folders: LibraryFolder[]
  items: LibraryItem[]
  files: LibraryFile[]
}> {
  const folders = await library.getFolders()
  const [itemLists, files] = await Promise.all([
    Promise.all([
      library.getItemsInFolder(ROOT_FOLDER_ID),
      ...folders.map((folder) => library.getItemsInFolder(folder.id)),
    ]),
    library.getFiles(),
  ])
  return { folders, items: itemLists.flat(), files }
}

/** Anything the library layer throws, as a message safe to render. */
function describeLibraryError(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  if (typeof cause === 'string' && cause.trim() !== '') return cause
  return 'The library could not be updated.'
}

export const useLibraryStore = create<LibraryState>()((set, get) => {
  /** Re-reads folders, items, and files after a write, so the state is never a stale copy. */
  const syncFromIdb = async (): Promise<void> => {
    const { folders, items, files } = await readLibrary()
    set({ folders, items, files, error: null })
  }

  /**
   * Runs one library write and re-reads the library behind it.
   */
  const writeThenSync = async <T>(operation: () => Promise<T>): Promise<T> => {
    set({ error: null })
    try {
      const result = await operation()
      await syncFromIdb()
      return result
    } catch (cause: unknown) {
      set({ error: describeLibraryError(cause) })
      throw cause
    }
  }

  return {
    folders: [],
    items: [],
    files: [],
    loading: false,
    error: null,

    refresh: async () => {
      set({ loading: true, error: null })
      try {
        const { folders, items, files } = await readLibrary()
        set({ folders, items, files, loading: false })
      } catch (cause: unknown) {
        set({ loading: false, error: describeLibraryError(cause) })
      }
    },

    seedInitialLibrary: () =>
      writeThenSync(() => library.seedInitialLibrary()),

    createFolder: (name, parentId, color) =>
      writeThenSync(() => library.createFolder(name, parentId, color)),

    renameFolder: (id, name) =>
      writeThenSync(async () => {
        await library.renameFolder(id, name)
      }),

    deleteFolder: (id) =>
      writeThenSync(async () => {
        await library.deleteFolder(id)
      }),

    createFile: (name, folderId, blocks) =>
      writeThenSync(() => library.createFile(name, folderId, blocks)),

    saveFile: (file) =>
      writeThenSync(async () => {
        await library.saveFile(file)
      }),

    updateFile: (id, patch) =>
      writeThenSync(async () => {
        await library.updateFile(id, patch)
      }),

    deleteFile: (id) =>
      writeThenSync(async () => {
        await library.deleteFile(id)
      }),

    moveFile: (id, targetFolderId) =>
      writeThenSync(async () => {
        await library.moveFile(id, targetFolderId)
      }),

    reorderFile: (id, targetIndex, folderId) =>
      writeThenSync(async () => {
        await library.reorderFile(id, targetIndex, folderId)
      }),

    filesIn: (folderId) => get().files.filter((file) => file.folderId === folderId),

    renameItem: (id, name) =>
      writeThenSync(async () => {
        await library.updateItem(id, { name })
      }),

    deleteItem: (id) =>
      writeThenSync(async () => {
        await library.deleteItem(id)
      }),

    moveItem: (id, targetFolderId) =>
      writeThenSync(async () => {
        await library.moveItem(id, targetFolderId ?? ROOT_FOLDER_ID)
      }),

    saveItem: (item) =>
      writeThenSync(async () => {
        await library.saveItem(item)
      }),

    saveFromSession: (item, folderId) =>
      writeThenSync(() => library.saveFromSession(item, folderId ?? ROOT_FOLDER_ID)),

    itemsIn: (folderId) => get().items.filter((item) => item.folderId === folderId),
  }
})

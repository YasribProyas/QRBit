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
import type { LibraryFolder, LibraryItem } from '../lib/library'
import type { SessionItem } from './sessionStore'

export interface LibraryState {
  folders: LibraryFolder[]
  /** Every item in the library, whatever folder it is in (PLAN.md §6.4 needs them all). */
  items: LibraryItem[]
  loading: boolean
  error: string | null

  /** Reloads folders and items from IndexedDB. Never rejects: a failure shows in `error`. */
  refresh(): Promise<void>
  createFolder(name: string, parentId: string | null): Promise<LibraryFolder>
  renameFolder(id: string, name: string): Promise<void>
  /**
   * Deletes the folder, its subfolders and every item inside them (PLAN.md §6.3 —
   * a folder tree dies whole). The state is then re-read, so the cascade is whatever
   * IndexedDB actually did.
   */
  deleteFolder(id: string): Promise<void>
  renameItem(id: string, name: string): Promise<void>
  deleteItem(id: string): Promise<void>
  /** `null` is the tree's Root, which the library layer spells with its own sentinel id. */
  moveItem(id: string, targetFolderId: string | null): Promise<void>
  /** Create or overwrite by id (the library id IS the store's key). */
  saveItem(item: LibraryItem): Promise<void>
  /**
   * ADDITIVE to the Phase 5 store contract.
   *
   * Converts a §9 session item and stores it (PLAN.md §6.3's `saveFromSession`), which
   * is what PLAN.md §8 Phase 4's ended screen needs. It lives on the store because the
   * page must not import `lib/library.ts` — the store is the UI's single route to
   * IndexedDB — and because the saved row has to land in `items` for the library view
   * to be truthful without a manual refresh. Nothing is decrypted or re-encrypted on
   * the way in: a locked item's tuple is copied byte-for-byte (decision D9), and an
   * item whose transfer never completed throws rather than storing half a file.
   */
  saveFromSession(item: SessionItem, folderId: string | null): Promise<LibraryItem>
  /** The items directly in `folderId`; `ROOT_FOLDER_ID` is the root. */
  itemsIn(folderId: string): LibraryItem[]
}

/** The library as IndexedDB holds it, read through the §6.3 `folderId` index. */
async function readLibrary(): Promise<{ folders: LibraryFolder[]; items: LibraryItem[] }> {
  const folders = await library.getFolders()
  const lists = await Promise.all([
    library.getItemsInFolder(ROOT_FOLDER_ID),
    ...folders.map((folder) => library.getItemsInFolder(folder.id)),
  ])
  return { folders, items: lists.flat() }
}

/** Anything the library layer throws, as a message safe to render. */
function describeLibraryError(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  if (typeof cause === 'string' && cause.trim() !== '') return cause
  return 'The library could not be updated.'
}

export const useLibraryStore = create<LibraryState>()((set, get) => {
  /** Re-reads folders and items after a write, so the state is never a stale copy. */
  const syncFromIdb = async (): Promise<void> => {
    const { folders, items } = await readLibrary()
    set({ folders, items, error: null })
  }

  /**
   * Runs one library write and re-reads the library behind it.
   *
   * The failure is recorded in `error` for the UI and rethrown for whoever awaited
   * it, and a successful write clears a stale message.
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
    loading: false,
    error: null,

    refresh: async () => {
      set({ loading: true, error: null })
      try {
        const { folders, items } = await readLibrary()
        set({ folders, items, loading: false })
      } catch (cause: unknown) {
        set({ loading: false, error: describeLibraryError(cause) })
      }
    },

    createFolder: (name, parentId) =>
      writeThenSync(() => library.createFolder(name, parentId)),

    renameFolder: (id, name) =>
      writeThenSync(async () => {
        await library.renameFolder(id, name)
      }),

    deleteFolder: (id) =>
      writeThenSync(async () => {
        await library.deleteFolder(id)
      }),

    renameItem: (id, name) =>
      writeThenSync(async () => {
        // `updateItem` merges the patch onto the stored item and re-validates it, so the
        // type fields this rename does not name survive (PLAN.md §6.3).
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

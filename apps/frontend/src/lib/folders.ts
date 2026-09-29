/**
 * The pure folder-tree arithmetic the library UI shares (PLAN.md §6.1, §6.3, §6.4).
 *
 * These are the three helpers that used to sit in `components/library/LibraryBrowser.tsx`
 * and survive its deletion (ORCHESTRATION D16.4). They were never browser logic: they take
 * the flat `folders` / `items` lists the library layer hands out and answer a question
 * about the tree, with no store, no DOM and no IndexedDB read. Living in `lib/` is their
 * proper home, and it keeps the dependency direction right — a UI module used to own math
 * that other UI modules had to import from it.
 *
 * The types are `lib/library.ts`'s own (`LibraryFolder`, `LibraryItem`), not the
 * structural mirrors the old browser components declared. The mirrors were field-for-field
 * identical, so callers that still hold a mirror value pass it in by structure with no
 * cast; `library.ts` remains the only definition these functions have to agree with.
 *
 * `folderDeleteImpact` and `describeDelete` are the cascade gate: `deleteFolder` destroys
 * a folder, every folder inside it and everything they hold (PLAN.md §6.3, "a folder tree
 * dies whole"), permanently and with no other copy to restore from, so a confirmation that
 * quotes numbers has to count them the same way the deletion does.
 */

import type { LibraryFolder, LibraryItem } from './library'

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
 * destroyed too. The caller already has every folder and every item, so this is arithmetic
 * on those, not a second read of the database.
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

/** The delete the user asked for. `null` in state means no dialog is open. */
export type PendingDelete = { kind: 'folder'; id: string } | { kind: 'item'; id: string }

/** The words a delete confirmation shows for one pending delete. */
export interface DeletePrompt {
  title: string
  message: string
  confirmLabel: string
}

/**
 * The prompt for a pending delete, read from the live lists.
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

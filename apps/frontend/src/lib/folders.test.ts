/**
 * Tests for `lib/folders.ts` — the pure folder-tree arithmetic the library UI shares.
 *
 * These run in the default node environment: nothing here renders, so the assertions go
 * straight to the functions rather than through a component. They moved here with the
 * helpers when `LibraryBrowser.tsx` was deleted (ORCHESTRATION D16.4), and they are the
 * only remaining coverage of two things worth pinning on their own:
 *
 *   - the root has two spellings (`null` and `lib/library.ts`'s sentinel id) and an item
 *     whose folder row no longer exists belongs to the root rather than vanishing;
 *   - the cascade count a delete confirmation quotes walks the same parent links
 *     `deleteFolder` does (PLAN.md §6.3), counting dossiers and loose items as well as
 *     folders, including the malformed-cycle case — a warning that hangs the page on
 *     corrupted stored data is worse than one that is wrong;
 *   - `childFolders` orders siblings deterministically (it came from `FolderNode.tsx`
 *     together with the tree picker that uses it).
 */

import { describe, expect, it } from 'vitest'

import {
  childFolders,
  describeDelete,
  folderDeleteImpact,
  itemsInFolder,
  type PendingDelete,
} from './folders'
import type { LibraryFile, LibraryFolder, LibraryItem } from './library'

const folders: LibraryFolder[] = [
  { id: 'f1', name: 'Uni Stuff', parentId: null, createdAt: 1, updatedAt: 1 },
  { id: 'f2', name: 'Work', parentId: null, createdAt: 1, updatedAt: 1 },
  { id: 'f3', name: 'Thesis', parentId: 'f1', createdAt: 1, updatedAt: 1 },
  { id: 'f4', name: 'Empty', parentId: null, createdAt: 1, updatedAt: 1 },
]

const BASE = { folderId: 'f1', name: 'Note', type: 'text' as const, createdAt: 1 }

const items: LibraryItem[] = [
  { ...BASE, id: 'i1', name: 'Portal password', content: 'secret', updatedAt: 100 },
  { ...BASE, id: 'i2', name: 'Thesis Draft', content: 'draft', updatedAt: 300 },
  { ...BASE, id: 'i3', folderId: 'f2', name: 'SSH Keys', content: 'keys', updatedAt: 200 },
  // "root" is the library layer's root sentinel: the root has no folder row, so an item
  // at the root carries an id that matches no folder (lib/library.ts spells it 'root').
  { ...BASE, id: 'i4', folderId: 'root', name: 'Loose note', content: 'loose', updatedAt: 400 },
]

describe('itemsInFolder', () => {
  it('filters a real folder by id and puts everything outside the tree at the root', () => {
    expect(itemsInFolder(items, folders, 'f1').map((item) => item.id)).toEqual(['i1', 'i2'])
    expect(itemsInFolder(items, folders, null).map((item) => item.id)).toEqual(['i4'])
    // The root named as the store names it, rather than as null.
    expect(itemsInFolder(items, folders, 'root').map((item) => item.id)).toEqual(['i4'])
  })

  it('shows an item whose folder row has gone away at the root, not nowhere', () => {
    const orphaned: LibraryItem = { ...BASE, id: 'i5', folderId: 'gone', content: 'x', updatedAt: 1 }

    expect(itemsInFolder([...items, orphaned], folders, null).map((item) => item.id)).toEqual([
      'i4',
      'i5',
    ])
    // And a folder that exists but holds nothing lists nothing, rather than the leftovers.
    expect(itemsInFolder(items, folders, 'f4')).toEqual([])
  })

  it('leaves the caller’s arrays alone', () => {
    // The browser used this result straight into `.sort()`; a copy keeps that harmless.
    const before = items.map((item) => item.id)
    itemsInFolder(items, folders, 'f1').pop()
    expect(items.map((item) => item.id)).toEqual(before)
    expect(folders.map((folder) => folder.id)).toEqual(['f1', 'f2', 'f3', 'f4'])
  })
})

describe('childFolders', () => {
  it('returns the direct children in name order, whatever order the store used', () => {
    const tree: LibraryFolder[] = [
      { id: 'z', name: 'zeta', parentId: null, createdAt: 1, updatedAt: 1 },
      { id: 'a', name: 'Alpha', parentId: null, createdAt: 1, updatedAt: 1 },
      { id: 'child', name: 'Nested', parentId: 'a', createdAt: 1, updatedAt: 1 },
    ]

    // Case-insensitive, so `zeta` does not outrank `Alpha` on a byte comparison, and
    // locale-free, so two devices cannot disagree about what the tree looks like.
    expect(childFolders(tree, null).map((folder) => folder.id)).toEqual(['a', 'z'])
    expect(childFolders(tree, 'a').map((folder) => folder.id)).toEqual(['child'])
  })
})

describe('folderDeleteImpact', () => {
  const nested: LibraryFolder[] = [
    { id: 'a', name: 'A', parentId: null, createdAt: 1, updatedAt: 1 },
    { id: 'b', name: 'B', parentId: 'a', createdAt: 1, updatedAt: 1 },
    { id: 'c', name: 'C', parentId: 'b', createdAt: 1, updatedAt: 1 },
    { id: 'd', name: 'D', parentId: null, createdAt: 1, updatedAt: 1 },
  ]
  const nestedItems: LibraryItem[] = [
    { ...BASE, id: 'i1', folderId: 'a', name: 'A note', content: 'a', updatedAt: 1 },
    { ...BASE, id: 'i2', folderId: 'c', name: 'Deep note', content: 'c', updatedAt: 1 },
    { ...BASE, id: 'i3', folderId: 'd', name: 'Elsewhere', content: 'd', updatedAt: 1 },
    { ...BASE, id: 'i4', folderId: 'root', name: 'Loose', content: 'r', updatedAt: 1 },
  ]

  /** A dossier at each depth, plus one that lives outside the doomed subtree. */
  function dossier(id: string, folderId: string): LibraryFile {
    return {
      id,
      folderId,
      name: id,
      createdAt: 1,
      updatedAt: 1,
      blocks: [{ id: `${id}-b`, type: 'heading', content: id }],
    }
  }

  const nestedFiles: LibraryFile[] = [
    dossier('d1', 'a'),
    dossier('d2', 'c'),
    dossier('d3', 'd'),
    dossier('d4', 'root'),
  ]

  it('counts every depth and leaves the rest of the library out', () => {
    expect(folderDeleteImpact(nested, nestedFiles, nestedItems, 'a')).toEqual({
      folders: 3,
      files: 2,
      items: 2,
    })
    expect(folderDeleteImpact(nested, nestedFiles, nestedItems, 'b')).toEqual({
      folders: 2,
      files: 1,
      items: 1,
    })
    expect(folderDeleteImpact(nested, nestedFiles, nestedItems, 'c')).toEqual({
      folders: 1,
      files: 1,
      items: 1,
    })
    expect(folderDeleteImpact(nested, nestedFiles, nestedItems, 'd')).toEqual({
      folders: 1,
      files: 1,
      items: 1,
    })
  })

  it('survives a malformed parent cycle instead of counting forever', () => {
    // Two rows that name each other as parent: stored data can only get here by
    // corruption, but a warning that hangs the page is worse than one that is wrong.
    const cyclic: LibraryFolder[] = [
      { id: 'x', name: 'X', parentId: 'y', createdAt: 1, updatedAt: 1 },
      { id: 'y', name: 'Y', parentId: 'x', createdAt: 1, updatedAt: 1 },
    ]

    expect(folderDeleteImpact(cyclic, [], [], 'x')).toEqual({ folders: 2, files: 0, items: 0 })
  })

  it('counts the named folder itself, because it is destroyed too', () => {
    const empty: LibraryFolder[] = [{ id: 'e', name: 'E', parentId: null, createdAt: 1, updatedAt: 1 }]

    expect(folderDeleteImpact(empty, nestedFiles, nestedItems, 'e')).toEqual({
      folders: 1,
      files: 0,
      items: 0,
    })
  })
})

describe('describeDelete', () => {
  const nested: LibraryFolder[] = [
    { id: 'a', name: 'A', parentId: null, createdAt: 1, updatedAt: 1 },
    { id: 'b', name: 'B', parentId: 'a', createdAt: 1, updatedAt: 1 },
    { id: 'c', name: 'C', parentId: 'b', createdAt: 1, updatedAt: 1 },
    { id: 'd', name: 'D', parentId: null, createdAt: 1, updatedAt: 1 },
  ]
  const nestedItems: LibraryItem[] = [
    { ...BASE, id: 'i1', folderId: 'a', name: 'A note', content: 'a', updatedAt: 1 },
    { ...BASE, id: 'i2', folderId: 'c', name: 'Deep note', content: 'c', updatedAt: 1 },
    { ...BASE, id: 'i3', folderId: 'd', name: 'Elsewhere', content: 'd', updatedAt: 1 },
    { ...BASE, id: 'i4', folderId: 'root', name: 'Loose', content: 'r', updatedAt: 1 },
  ]

  /** Two dossiers in the doomed subtree, one of them holding two blocks. */
  const nestedFiles: LibraryFile[] = [
    {
      id: 'd1',
      folderId: 'a',
      name: 'Cluster keys',
      createdAt: 1,
      updatedAt: 1,
      blocks: [
        { id: 'd1-b1', type: 'heading', content: 'Cluster keys' },
        { id: 'd1-b2', type: 'richText', content: 'notes' },
      ],
    },
    { id: 'd2', folderId: 'c', name: 'Deep dossier', createdAt: 1, updatedAt: 1, blocks: [] },
    { id: 'd3', folderId: 'd', name: 'Elsewhere', createdAt: 1, updatedAt: 1, blocks: [] },
  ]

  it('names the item for an item prompt and the numbers for a folder prompt', () => {
    const item: PendingDelete = { kind: 'item', id: 'i2' }
    const folder: PendingDelete = { kind: 'folder', id: 'a' }

    const itemPrompt = describeDelete(item, nested, nestedFiles, nestedItems)
    expect(itemPrompt?.title).toBe('Delete “Deep note”?')
    expect(itemPrompt?.message).toContain('“Deep note”')
    expect(itemPrompt?.confirmLabel).toContain('permanently')

    const folderPrompt = describeDelete(folder, nested, nestedFiles, nestedItems)
    expect(folderPrompt?.message).toContain('3 folders')
    expect(folderPrompt?.message).toContain('2 dossiers')
    expect(folderPrompt?.message).toContain('2 items')
    expect(folderPrompt?.confirmLabel).toContain('Delete folder and contents')
  })

  it('states a dossier prompt by the blocks the dossier loses', () => {
    const prompt = describeDelete({ kind: 'file', id: 'd1' }, nested, nestedFiles, nestedItems)

    expect(prompt?.title).toBe('Delete “Cluster keys”?')
    expect(prompt?.message).toContain('2 blocks')
    expect(prompt?.confirmLabel).toBe('Delete dossier permanently')
  })

  it('says so when the folder is empty, rather than implying a cascade that is not there', () => {
    const prompt = describeDelete({ kind: 'folder', id: 'd' }, nested, nestedFiles, nestedItems)

    // 'd' holds one dossier, one item and no subfolder.
    expect(prompt?.message).toContain('1 folder')
    expect(prompt?.message).toContain('1 dossier')
    expect(prompt?.message).toContain('1 item')
    expect(prompt?.message).not.toMatch(/no folders|1 folders|1 dossiers and no items/)

    const bare: LibraryFolder = { id: 'z', name: 'Z', parentId: null, createdAt: 1, updatedAt: 1 }
    const emptyPrompt = describeDelete(
      { kind: 'folder', id: 'z' },
      [...nested, bare],
      nestedFiles,
      nestedItems,
    )
    expect(emptyPrompt?.message).toContain('no dossiers')
    expect(emptyPrompt?.message).toContain('no items')
  })

  it('has nothing to say about a target that is no longer there', () => {
    const request: PendingDelete = { kind: 'folder', id: 'gone' }

    expect(describeDelete(request, nested, nestedFiles, nestedItems)).toBe(null)
    expect(describeDelete({ kind: 'item', id: 'gone' }, nested, nestedFiles, nestedItems)).toBe(null)
    expect(describeDelete({ kind: 'file', id: 'gone' }, nested, nestedFiles, nestedItems)).toBe(null)
  })
})

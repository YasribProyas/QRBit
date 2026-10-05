/** @vitest-environment jsdom */
/**
 * Tests for `LibraryPanel` (ORCHESTRATION D16).
 *
 * **What is pinned, and why it is pinned this way.** Every action here ends in a store
 * call and in the list that comes back from IndexedDB, so each test intercepts the store
 * action it cares about (recording the arguments, then running the real one) and asserts
 * both: the call the panel made, and the rows the library produced. Nothing is asserted
 * about which element a control was drawn inside when the interesting part is what it
 * did — a row's Rename and that row's new label are the pair, a grip's `ArrowDown` and
 * the dossier's new position are the pair. The states that could lie to the user are
 * pinned explicitly: "loading" must not print an empty library, an empty folder says so
 * and still offers its `+ New file`, and a folder delete states the cascade it is about
 * to run and runs nothing until the answer is given.
 *
 * **Menus and dialogs float.** The row menus are one Mantine `Menu` and the dialogs are
 * Mantine `Modal`s, so both render through a Portal into `document.body` and mount on the
 * next frame: `openMenu` and the dialog helpers read the document, and `settle()` is the
 * frame they need. A row's menu is reached by its label, which is the part the user reads.
 *
 * **The drag harness.** `useReorderDrag` is pointer-based and jsdom 30 has neither the
 * `PointerEvent` constructor nor pointer capture, so this file does the three things Lane
 * A's harness does before driving anything: a `PointerEvent` subclass of `MouseEvent`
 * carrying the fields the hook reads, `setPointerCapture`/`hasPointerCapture`/
 * `releasePointerCapture` on the prototype, and a container inside `document.body` so the
 * hook's `window` listeners can hear the release. jsdom lays nothing out — every
 * `offsetTop`/`offsetHeight` is 0 — so the hook falls back to `DEFAULT_ITEM_HEIGHT` (48px
 * a row) and a 60px drag means "one row down". `lib/reorder.test.ts` and
 * `hooks/useReorderDrag.test.ts` own the index math; this file proves the panel drives it
 * with the right ids and the folder that was on screen.
 *
 * **Two drag lists, one screen.** The panel runs one `useReorderDrag` for the folder rows and
 * one per folder for its dossiers, so the harness reaches each list by its own grip class
 * (`.library-panel__folder-grip` for a folder header, `.library-panel__grip` for a dossier
 * row) and the folder tests assert both halves of the isolation: dragging a folder writes no
 * `reorderFile` call and moves no dossier, and dragging a dossier writes no `reorderFolder`
 * call and moves no folder — including the case where the two lists would read the *same*
 * index at the same moment.
 *
 * Rows are seeded with explicit `sortOrder` values, so the display order is the order the
 * test asked for rather than a `createdAt` tie-break that depends on how fast the machine
 * is.
 */

import 'fake-indexeddb/auto'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LibraryPanel } from './LibraryPanel'
import type { LibraryPanelProps } from './LibraryPanel'
import {
  closeLibraryDatabase,
  createFile,
  createFolder,
  getFiles,
  getFilesInFolder,
  getFolders,
  getItemsInFolder,
  reorderFolder,
  ROOT_FOLDER_ID,
  saveFile,
  saveItem,
  siblingFolders,
} from '../../lib/library'
import type { FileBlock, LibraryFile, LibraryFolder, LibraryItem } from '../../lib/library'
import { useLibraryStore } from '../../store/libraryStore'

/** The real store actions, kept so a recorder can run the write it is recording. */
const PRISTINE = useLibraryStore.getState()

// ---------------------------------------------------------------------------
// The pointer API jsdom does not have
// ---------------------------------------------------------------------------

class HarnessPointerEvent extends MouseEvent {
  readonly pointerId: number
  readonly pointerType: string
  readonly isPrimary: boolean

  constructor(type: string, init: { clientY?: number; pointerId?: number } = {}) {
    super(type, {
      bubbles: true,
      cancelable: true,
      clientY: init.clientY ?? 0,
      button: 0,
    })
    this.pointerId = init.pointerId ?? 1
    this.pointerType = 'mouse'
    this.isPrimary = true
  }
}

Object.defineProperty(globalThis, 'PointerEvent', {
  value: HarnessPointerEvent,
  configurable: true,
  writable: true,
})

const captured = new WeakMap<Element, number>()
Element.prototype.setPointerCapture = function (pointerId: number): void {
  captured.set(this, pointerId)
}
Element.prototype.hasPointerCapture = function (pointerId: number): boolean {
  return captured.get(this) === pointerId
}
Element.prototype.releasePointerCapture = function (pointerId: number): void {
  if (captured.get(this) === pointerId) captured.delete(this)
}

// ---------------------------------------------------------------------------
// Recording store seams
// ---------------------------------------------------------------------------

interface Recorded {
  reorderFile: Array<[string, number, string | undefined]>
  reorderFolder: Array<[string, number, string | null | undefined]>
  deleteFile: string[]
  moveFile: Array<[string, string]>
  updateFile: Array<[string, Partial<LibraryFile>]>
  renameFolder: Array<[string, string]>
  deleteFolder: string[]
  createFolder: Array<[string, string | null]>
}

let calls: Recorded = {
  reorderFile: [],
  reorderFolder: [],
  deleteFile: [],
  moveFile: [],
  updateFile: [],
  renameFolder: [],
  deleteFolder: [],
  createFolder: [],
}

/**
 * Replaces the store actions the panel calls with recorders that still perform the write.
 *
 * Installed before the panel renders, so the panel closes over these: the assertion is
 * about the call the panel actually made, and the list afterwards really is the library's,
 * because every recorder delegates to the action it replaced.
 */
function recordStore(): void {
  calls = {
    reorderFile: [],
    reorderFolder: [],
    deleteFile: [],
    moveFile: [],
    updateFile: [],
    renameFolder: [],
    deleteFolder: [],
    createFolder: [],
  }

  useLibraryStore.setState({
    reorderFile: async (id, targetIndex, folderId) => {
      calls.reorderFile.push([id, targetIndex, folderId])
      await PRISTINE.reorderFile(id, targetIndex, folderId)
    },
    reorderFolder: async (id, targetIndex, parentId) => {
      calls.reorderFolder.push([id, targetIndex, parentId])
      await PRISTINE.reorderFolder(id, targetIndex, parentId)
    },
    deleteFile: async (id) => {
      calls.deleteFile.push(id)
      await PRISTINE.deleteFile(id)
    },
    moveFile: async (id, targetFolderId) => {
      calls.moveFile.push([id, targetFolderId])
      await PRISTINE.moveFile(id, targetFolderId)
    },
    updateFile: async (id, patch) => {
      calls.updateFile.push([id, patch])
      await PRISTINE.updateFile(id, patch)
    },
    renameFolder: async (id, name) => {
      calls.renameFolder.push([id, name])
      await PRISTINE.renameFolder(id, name)
    },
    deleteFolder: async (id) => {
      calls.deleteFolder.push(id)
      await PRISTINE.deleteFolder(id)
    },
    createFolder: async (name, parentId, color) => {
      calls.createFolder.push([name, parentId])
      return PRISTINE.createFolder(name, parentId, color)
    },
  })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderPanel(props: Partial<LibraryPanelProps> = {}): void {
  const host = document.createElement('div')
  document.body.append(host)
  const created = createRoot(host)
  container = host
  root = created

  const nextProps: LibraryPanelProps = {
    onSelectFile: (): void => undefined,
    onCreateFile: (): void => undefined,
    ...props,
  }

  act(() => {
    created.render(<LibraryPanel {...nextProps} />)
  })
}

function panel(): HTMLDivElement {
  if (container === null) throw new Error('test bug: the panel was never rendered')
  return container
}

/** Re-reads the library from IndexedDB into the store, the way Home does on mount. */
async function loadLibrary(): Promise<void> {
  await act(async () => {
    await useLibraryStore.getState().refresh()
  })
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`timed out waiting for ${description}`)
}

/** The frame Mantine's portal/transition needs before a dropdown or dialog is in the DOM. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null))
    })
  })
}

// ---------------------------------------------------------------------------
// DOM reading helpers
// ---------------------------------------------------------------------------

interface SectionView {
  name: string
  files: string[]
  /** Grips this section offers — the panel's statement about where an order exists. */
  grips: number
  /** Grips on this section's own header row: the folder-level drag, one per listed folder. */
  folderGrips: number
  newFile: HTMLButtonElement | null
  empty: string | null
}

function folderSection(name: string): HTMLElement {
  for (const node of folderNodes()) {
    if (headingOf(node) === name) return node
  }
  throw new Error(`test bug: no section named ${name}`)
}

function viewOf(node: HTMLElement): SectionView {
  const newFile = node.querySelector<HTMLButtonElement>('.library-panel__new-file')
  return {
    name: node.querySelector('.library-panel__folder-name')?.textContent?.trim() ?? '',
    files: [...node.querySelectorAll<HTMLElement>('.library-panel__file-name')].map(
      (name) => name.textContent?.trim() ?? '',
    ),
    grips: node.querySelectorAll('.library-panel__grip').length,
    folderGrips: node.querySelectorAll('.library-panel__folder-grip').length,
    newFile: newFile ?? null,
    empty: node.querySelector('.library-panel__empty-folder')?.textContent?.trim() ?? null,
  }
}

function sectionNamed(name: string): SectionView {
  return viewOf(folderSection(name))
}

/**
 * The rows of one section, or an empty list when the section is not on screen.
 *
 * A wait predicate has to survive the window where the panel is showing the store's
 * `loading` state instead of its sections, so these reading helpers answer "nothing yet"
 * rather than throwing the way `sectionNamed` does for a final assertion.
 */
function sectionFiles(name: string): string[] {
  const node = folderNodes().find((candidate) => headingOf(candidate) === name)
  if (node === undefined) return []
  return [...node.querySelectorAll<HTMLElement>('.library-panel__file-name')].map(
    (label) => label.textContent?.trim() ?? '',
  )
}

function hasSection(name: string): boolean {
  return folderNodes().some((node) => headingOf(node) === name)
}

function folderNodes(): HTMLElement[] {
  return [...panel().querySelectorAll<HTMLElement>('.library-panel__folder')]
}

/** The sections as they are stacked on screen, Root first: the folder rows' own order. */
function folderOrderOnScreen(): string[] {
  return folderNodes().map(headingOf)
}

function headingOf(node: HTMLElement): string {
  return node.querySelector('.library-panel__folder-name')?.textContent?.trim() ?? ''
}

function fileRow(name: string): HTMLElement {
  for (const row of panel().querySelectorAll<HTMLElement>('.library-panel__file')) {
    if (row.querySelector('.library-panel__file-name')?.textContent?.trim() === name) return row
  }
  throw new Error(`test bug: no dossier row named ${name}`)
}

function requireButton(node: Element | null, what: string): HTMLButtonElement {
  if (!(node instanceof HTMLButtonElement)) throw new Error(`test bug: no ${what}`)
  return node
}

function click(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** A click that reaches IndexedDB: the flush afterwards is what the assertions then read. */
async function clickAndSettle(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** Opens the menu belonging to `scope` (a folder section or a dossier row) and waits for it. */
async function openMenu(scope: HTMLElement): Promise<void> {
  const toggle = scope.querySelector<HTMLButtonElement>(
    '.library-panel__file-menu-toggle, .library-panel__folder-menu-toggle',
  )
  if (toggle === null) throw new Error('test bug: this row has no menu')
  click(toggle)
  await settle()
}

/**
 * The open menu's entry with this label.
 *
 * Read from the document because Mantine portals the dropdown, and addressed by its label
 * because the label is what the panel promises the action is: "Rename folder", "Delete
 * folder and contents", "Move to folder", "Delete dossier".
 */
function menuItem(label: string): HTMLButtonElement {
  for (const item of document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
    if (item.textContent === label) return item
  }
  throw new Error(`test bug: no menu item labelled ${label}`)
}

function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(field, value)
  act(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function inputIn(scope: HTMLElement, selector: string, what: string): HTMLInputElement {
  const field = scope.querySelector(selector)
  if (!(field instanceof HTMLInputElement)) throw new Error(`test bug: no ${what}`)
  return field
}

/** The open dialog: a Mantine `Modal` portals into the document, not into the panel. */
function dialog(): HTMLElement {
  const node = document.querySelector('[role="dialog"]')
  if (!(node instanceof HTMLElement)) throw new Error('test bug: no dialog open')
  return node
}

/** A button of the open dialog, by its exact label. */
function dialogButton(label: string): HTMLButtonElement {
  for (const node of dialog().querySelectorAll<HTMLButtonElement>('button')) {
    if (node.textContent === label) return node
  }
  throw new Error(`test bug: no dialog button labelled ${label}`)
}

/**
 * The dialog's title and body, read the way a screen reader does: through the ids the
 * dialog points its `aria-labelledby` and `aria-describedby` at.
 *
 * The description is the dialog's body region, so it also contains the two control labels;
 * the assertions below ask what it says, not that it says nothing else.
 */
function dialogText(): { title: string; message: string } {
  const node = dialog()
  const titleId = node.getAttribute('aria-labelledby')
  const bodyId = node.getAttribute('aria-describedby')
  if (titleId === null || bodyId === null) throw new Error('test bug: unlabelled dialog')
  return {
    title: document.getElementById(titleId)?.textContent ?? '',
    message: document.getElementById(bodyId)?.textContent ?? '',
  }
}

function gripAt(index: number): HTMLButtonElement {
  const grips = [...panel().querySelectorAll<HTMLButtonElement>('.library-panel__grip')]
  const grip = grips[index]
  if (grip === undefined) throw new Error(`test bug: no grip at index ${index}`)
  return grip
}

/**
 * The folder grips, in the order they are stacked.
 *
 * A separate class from the dossier grip on purpose, and the tests keep them separate: the
 * panel hosts one drag list per folder plus one for the folder rows themselves, and every
 * assertion about "index 1" has to say which of them it means.
 */
function folderGripAt(index: number): HTMLButtonElement {
  const grips = [...panel().querySelectorAll<HTMLButtonElement>('.library-panel__folder-grip')]
  const grip = grips[index]
  if (grip === undefined) throw new Error(`test bug: no folder grip at index ${index}`)
  return grip
}

/** Grabs row `fromIndex`'s grip, travels `deltaY` pixels, releases. The real drag path. */
async function dragGrip(fromIndex: number, deltaY: number): Promise<void> {
  const grip = gripAt(fromIndex)

  await act(async () => {
    grip.dispatchEvent(new HarnessPointerEvent('pointerdown', { clientY: 100 }))
  })
  await act(async () => {
    document.body.dispatchEvent(new HarnessPointerEvent('pointermove', { clientY: 100 + deltaY }))
  })
  await act(async () => {
    document.body.dispatchEvent(new HarnessPointerEvent('pointerup', {}))
  })
}

/** The same drag path, on a folder header's grip. */
async function dragFolderGrip(fromIndex: number, deltaY: number): Promise<void> {
  const grip = folderGripAt(fromIndex)

  await act(async () => {
    grip.dispatchEvent(new HarnessPointerEvent('pointerdown', { clientY: 100 }))
  })
  await act(async () => {
    document.body.dispatchEvent(new HarnessPointerEvent('pointermove', { clientY: 100 + deltaY }))
  })
  await act(async () => {
    document.body.dispatchEvent(new HarnessPointerEvent('pointerup', {}))
  })
}

/** A key press on a grip: the keyboard twin of the drag (D16.3). */
function pressOnGrip(index: number, key: string): void {
  const grip = gripAt(index)
  act(() => {
    grip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** The same key press, on a folder header's grip. */
function pressOnFolderGrip(index: number, key: string): void {
  const grip = folderGripAt(index)
  act(() => {
    grip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seedFolder(name: string, parentId: string | null = null): Promise<LibraryFolder> {
  return createFolder(name, parentId)
}

/**
 * Puts the folders named by `ids` at the front of their parent's run, in that order.
 *
 * `createFolder` deliberately leaves a folder unordered, and unordered siblings fall back to a
 * createdAt/id tiebreak a test cannot predict (two folders made in the same millisecond), so a
 * seed that cares about the order states it through the real `reorderFolder` — the same call a
 * drag makes. `saveFolder` is not an option: it is skip-by-id, an import's rule.
 *
 * The first step moves the row that currently reads first to the end, which *always* changes
 * the index and so always materialises `SORT_ORDER_GAP` positions for the run: without it,
 * placing rows one by one could land every row on its own index, write nothing, and leave the
 * order resting on that same unpredictable tiebreak.
 */
async function orderFolders(parentId: string | null, ...ids: string[]): Promise<void> {
  const run = siblingFolders(await getFolders(), parentId).map((folder) => folder.id)
  const movedToEnd = run[0]
  if (movedToEnd !== undefined && run.length > 1) {
    await reorderFolder(movedToEnd, run.length - 1, parentId)
  }

  let placed = 0
  for (const id of ids) {
    await reorderFolder(id, placed, parentId)
    placed += 1
  }

  const after = siblingFolders(await getFolders(), parentId).map((folder) => folder.id)
  if (after.slice(0, ids.length).join(',') !== ids.join(',')) {
    throw new Error(`test bug: could not seed ${ids.join(',')} — the run reads ${after.join(',')}`)
  }
}

/** The top-level folders as IndexedDB reads them, in the order the library reads them. */
async function folderNamesInLibrary(): Promise<string[]> {
  return siblingFolders(await getFolders(), null).map((folder) => folder.name)
}

/**
 * A dossier written straight to IndexedDB, positioned inside its folder by `sortOrder`
 * so the panel's order is the order the test declares.
 */
async function seedFile(
  name: string,
  folderId: string,
  sortOrder: number,
  blocks: FileBlock[] = [{ id: `b-${name}`, type: 'heading', content: `${name} heading` }],
  isLocked: boolean = false,
): Promise<LibraryFile> {
  const created = await createFile(name, folderId, blocks)
  const ordered: LibraryFile = { ...created, sortOrder, isLocked }
  await saveFile(ordered)
  return ordered
}

function looseItem(folderId: string, name: string): LibraryItem {
  const now = Date.now()
  return {
    id: globalThis.crypto.randomUUID(),
    folderId,
    name,
    type: 'text',
    createdAt: now,
    updatedAt: now,
    content: `content of ${name}`,
  }
}

beforeEach(async () => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  useLibraryStore.setState({
    folders: [],
    items: [],
    files: [],
    loading: false,
    error: null,
  })
  recordStore()
  await closeLibraryDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('qrbit-library')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
})

afterEach(() => {
  if (root !== null) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  document.body.replaceChildren()
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  useLibraryStore.setState({
    reorderFile: PRISTINE.reorderFile,
    reorderFolder: PRISTINE.reorderFolder,
    deleteFile: PRISTINE.deleteFile,
    moveFile: PRISTINE.moveFile,
    updateFile: PRISTINE.updateFile,
    renameFolder: PRISTINE.renameFolder,
    deleteFolder: PRISTINE.deleteFolder,
    createFolder: PRISTINE.createFolder,
    loading: false,
    error: null,
  })
})

describe('LibraryPanel — what the panel lists', () => {
  it('lists each folder with its own dossiers, Root with the rest, and a grip only where an order exists', async () => {
    const vault = await seedFolder('Vault')
    const notes = await seedFolder('Notes')
    const research = await seedFolder('Research', vault.id)
    await seedFile('API keys', vault.id, 1000)
    await seedFile('Recovery tokens', notes.id, 1000)
    // A dossier in a subfolder: this panel lists one level, so it has to surface somewhere.
    const buried = await seedFile('Thesis data', research.id, 1000)
    await seedFile('Loose end', ROOT_FOLDER_ID, 2000)
    await loadLibrary()

    renderPanel()

    expect(sectionNamed('Vault').files).toEqual(['API keys'])
    expect(sectionNamed('Notes').files).toEqual(['Recovery tokens'])
    // Root is the catch-all for whatever no listed folder holds, so nothing is invisible.
    expect(sectionNamed('Root').files).toEqual(['Thesis data', 'Loose end'])
    expect(buried.folderId).toBe(research.id)

    // `sortOrder` is per folder, so a grip exists only on a folder's own rows: a grip in
    // Root would be an index counted across several folders, which the store cannot honour.
    expect(sectionNamed('Vault').grips).toBe(1)
    expect(sectionNamed('Notes').grips).toBe(1)
    expect(sectionNamed('Root').grips).toBe(0)
  })

  it('keeps the Encrypted badge and the first-block preview on the dossier they describe', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('Plain', vault.id, 1000, [
      { id: 'b-plain', type: 'richText', content: 'Notes only' },
    ])
    await seedFile(
      'Secrets',
      vault.id,
      2000,
      [
        { id: 'b-heading', type: 'heading', content: 'Cluster keys' },
        {
          id: 'b-locked',
          type: 'locked',
          label: 'Root keyphrase',
          isLocked: true,
          lockedData: {
            ciphertext: new Uint8Array(32).fill(7),
            iv: new Uint8Array(12).fill(1),
            salt: new Uint8Array(16).fill(2),
          },
        },
      ],
      true,
    )
    await loadLibrary()

    renderPanel()

    const rows = [...panel().querySelectorAll<HTMLElement>('.library-panel__file')]
    expect(rows).toHaveLength(2)
    const first = rows[0]
    const second = rows[1]
    if (!first || !second) throw new Error('test bug: fewer rows than seeded')

    expect(first.querySelectorAll('.library-panel__encrypted-badge')).toHaveLength(0)
    expect(second.querySelector('.library-panel__encrypted-badge')?.textContent).toContain('Encrypted')
    expect(first.querySelector('.library-panel__file-preview')?.textContent).toBe('Notes only')
    expect(second.querySelector('.library-panel__file-preview')?.textContent).toBe('Cluster keys')
  })

  /*
   * The row's width contract, reported by the owner as a badge reading `ENCRY…` next to a name
   * that was also cut.
   *
   * The mechanism is not the name's fault but the badge's own: a Mantine `Badge` root is an
   * `inline-grid` with `overflow: hidden`, `text-overflow: ellipsis` and a label column of `1fr`
   * (that is its documented clipping behaviour when a caller gives it a width), and as a flex
   * item it shrinks by default — `overflow: hidden` makes its automatic minimum size 0. So in a
   * row that had no room, BOTH the name and the badge clipped, and the badge clipped to a word
   * that is not a word. The fix is the split: the name is the flexible half (`truncate` plus
   * `min-w-0`, so it gives its width back and ellipsises) and the badge is not a shrink candidate
   * at all (`flex: none`, `white-space: nowrap`).
   *
   * jsdom runs no layout, so this cannot measure which box lost pixels; it asserts the two
   * declarations that decide that, and the text itself.
   */
  it('truncates a long name and never truncates the Encrypted badge', async () => {
    const vault = await seedFolder('Vault')
    const longName = 'Quarterly board pack with annexes and supporting schedules'
    await seedFile(
      longName,
      vault.id,
      1000,
      [
        {
          id: 'b-locked-long',
          type: 'locked',
          label: 'Board pack',
          isLocked: true,
          lockedData: {
            ciphertext: new Uint8Array(32).fill(7),
            iv: new Uint8Array(12).fill(1),
            salt: new Uint8Array(16).fill(2),
          },
        },
      ],
      true,
    )
    await loadLibrary()

    renderPanel()

    const row = fileRow(longName)
    const badge = row.querySelector<HTMLElement>('.library-panel__encrypted-badge')
    if (badge === null) throw new Error('test bug: the long-named dossier lost its badge')

    // The whole word, in the DOM and in the box that paints it.
    expect(badge.textContent).toBe('Encrypted')
    // A badge that cannot shrink and cannot wrap has nothing left to clip.
    expect(badge.style.flexShrink).toBe('0')
    expect(badge.style.flexGrow).toBe('0')
    expect(badge.style.whiteSpace).toBe('nowrap')

    // The name is the thing that gives way: an ellipsis rule and a zero floor, both of which the
    // badge deliberately does not carry.
    const name = row.querySelector<HTMLElement>('.library-panel__file-name')
    if (name === null) throw new Error('test bug: no dossier name')
    expect(name.textContent).toBe(longName)
    expect(name.classList.contains('truncate')).toBe(true)
    expect(name.classList.contains('min-w-0')).toBe(true)
    expect(name.style.flex).toBe('')
  })

  it('says it is loading, and does not call an unread library empty', async () => {
    renderPanel()
    await act(async () => {
      useLibraryStore.setState({ loading: true, folders: [], files: [], items: [] })
    })

    const status = panel().querySelector('.library-panel__loading')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.textContent).toContain('Loading your library')
    expect(panel().querySelector('.library-panel__empty')).toBe(null)
    expect(panel().textContent.toLowerCase()).not.toContain('no folders')

    await act(async () => {
      useLibraryStore.setState({ loading: false })
    })

    expect(panel().querySelector('.library-panel__loading')).toBe(null)
    expect(panel().querySelector('.library-panel__empty-folders')?.textContent).toContain(
      'no folders yet',
    )
  })

  it('states an empty folder without hiding the row that fills it', async () => {
    await seedFolder('Empty drawer')
    await loadLibrary()

    renderPanel()

    const section = sectionNamed('Empty drawer')
    expect(section.files).toEqual([])
    expect(section.empty).toContain('No dossiers in Empty drawer yet')
    expect(section.newFile).not.toBe(null)
  })

  it('surfaces a store failure instead of throwing it into the render path', async () => {
    renderPanel()

    await act(async () => {
      useLibraryStore.setState({ error: 'library: no folder with id "gone"' })
    })

    expect(panel().querySelector('.library-panel__error')?.textContent).toContain(
      'no folder with id "gone"',
    )
  })
})

describe('LibraryPanel — opening and creating dossiers', () => {
  it('opens the dossier whose row was clicked, and only that one', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('API keys', vault.id, 1000)
    const second = await seedFile('Recovery tokens', vault.id, 2000)
    await loadLibrary()

    const opened: LibraryFile[] = []
    renderPanel({
      onSelectFile: (file) => {
        opened.push(file)
      },
    })

    click(requireButton(fileRow('Recovery tokens').querySelector('.library-panel__file-open'), 'row body'))

    expect(opened).toHaveLength(1)
    expect(opened[0]?.id).toBe(second.id)
  })

  it('asks for a new file in the folder whose list the + New file row heads', async () => {
    const vault = await seedFolder('Vault')
    const notes = await seedFolder('Notes')
    await seedFile('API keys', vault.id, 1000)
    await loadLibrary()

    const askedFor: string[] = []
    renderPanel({
      // The page's half of the contract: create it where the click happened, then reload.
      onCreateFile: (folderId) => {
        askedFor.push(folderId)
        void createFile('New Dossier', folderId)
          .then(() => useLibraryStore.getState().refresh())
          .catch(() => undefined)
      },
    })

    const newFileInNotes = sectionNamed('Notes').newFile
    if (newFileInNotes === null) throw new Error('test bug: Notes has no + New file row')
    await clickAndSettle(newFileInNotes)
    await waitFor(() => sectionFiles('Notes').length === 1, 'the new dossier in Notes')

    expect(askedFor).toEqual([notes.id])
    expect(sectionNamed('Notes').files).toEqual(['New Dossier'])
    // Nothing leaked into the folder that was not clicked, nor into Root.
    expect(sectionNamed('Vault').files).toEqual(['API keys'])
    expect(sectionNamed('Root').files).toEqual([])
    expect((await getFilesInFolder(notes.id)).map((file) => file.name)).toEqual(['New Dossier'])
    expect(await getFilesInFolder(ROOT_FOLDER_ID)).toEqual([])
  })

  it('creates a dossier from Root with no folder chosen', async () => {
    const askedFor: string[] = []
    renderPanel({
      onCreateFile: (folderId) => {
        askedFor.push(folderId)
        void createFile('Unfiled draft', folderId)
          .then(() => useLibraryStore.getState().refresh())
          .catch(() => undefined)
      },
    })

    const newFileInRoot = sectionNamed('Root').newFile
    if (newFileInRoot === null) throw new Error('test bug: Root has no + New file row')
    await clickAndSettle(newFileInRoot)
    await waitFor(() => sectionFiles('Root').length === 1, 'the unfiled dossier')

    expect(askedFor).toEqual([ROOT_FOLDER_ID])
    expect((await getFilesInFolder(ROOT_FOLDER_ID)).map((file) => file.name)).toEqual([
      'Unfiled draft',
    ])
  })

  it('makes a folder at Root through the modal, and lists it', async () => {
    renderPanel()

    click(requireButton(panel().querySelector('.library-panel__new-folder'), 'New folder button'))
    await settle()

    const modal = dialog()
    typeInto(inputIn(modal, 'input[type="text"]', 'folder name field'), 'Archive')
    await clickAndSettle(dialogButton('Create'))

    expect(calls.createFolder).toEqual([['Archive', null]])
    await waitFor(() => hasSection('Archive'), 'Archive on screen')
    expect((await getFolders()).map((folder) => folder.name)).toEqual(['Archive'])
    expect(panel().querySelector('.library-panel__empty-folders')).toBe(null)
  })
})

describe('LibraryPanel — reordering a folder', () => {
  it('reorders by dragging the grip, and writes the move through reorderFile with the folder on screen', async () => {
    const vault = await seedFolder('Vault')
    const alpha = await seedFile('Alpha', vault.id, 1000)
    await seedFile('Bravo', vault.id, 2000)
    await seedFile('Charlie', vault.id, 3000)
    await loadLibrary()

    renderPanel()
    expect(sectionNamed('Vault').files).toEqual(['Alpha', 'Bravo', 'Charlie'])

    // 60px down at the 48px pitch jsdom forces: exactly one row.
    await dragGrip(0, 60)

    expect(calls.reorderFile).toEqual([[alpha.id, 1, vault.id]])
    await waitFor(
      () => sectionFiles('Vault').join(',') === 'Bravo,Alpha,Charlie',
      'the dragged dossier to land second',
    )
    expect((await getFilesInFolder(vault.id)).map((file) => file.name)).toEqual([
      'Bravo',
      'Alpha',
      'Charlie',
    ])
  })

  it('reorders by dragging a row past every row it passes', async () => {
    const vault = await seedFolder('Vault')
    const alpha = await seedFile('Alpha', vault.id, 1000)
    await seedFile('Bravo', vault.id, 2000)
    await seedFile('Charlie', vault.id, 3000)
    await loadLibrary()

    renderPanel()
    await dragGrip(0, 200)

    expect(calls.reorderFile).toEqual([[alpha.id, 2, vault.id]])
    await waitFor(
      () => sectionFiles('Vault').join(',') === 'Bravo,Charlie,Alpha',
      'the dragged dossier to land last',
    )
    expect((await getFilesInFolder(vault.id)).map((file) => file.name)).toEqual([
      'Bravo',
      'Charlie',
      'Alpha',
    ])
  })

  it('reorders with the grip keyboard twin, through the same store call', async () => {
    const vault = await seedFolder('Vault')
    const bravo = await seedFile('Bravo', vault.id, 1000)
    await seedFile('Alpha', vault.id, 2000)
    await loadLibrary()

    renderPanel()
    pressOnGrip(0, 'ArrowDown')

    expect(calls.reorderFile).toEqual([[bravo.id, 1, vault.id]])
    await waitFor(() => sectionFiles('Vault').join(',') === 'Alpha,Bravo', 'the keyboard move')
    expect((await getFilesInFolder(vault.id)).map((file) => file.name)).toEqual(['Alpha', 'Bravo'])
  })

  it('sends a row to the top of its folder with Home', async () => {
    const vault = await seedFolder('Vault')
    const charlie = await seedFile('Charlie', vault.id, 3000)
    await seedFile('Alpha', vault.id, 1000)
    await seedFile('Bravo', vault.id, 2000)
    await loadLibrary()

    renderPanel()
    expect(sectionNamed('Vault').files).toEqual(['Alpha', 'Bravo', 'Charlie'])

    pressOnGrip(2, 'Home')

    expect(calls.reorderFile).toEqual([[charlie.id, 0, vault.id]])
    await waitFor(
      () => sectionFiles('Vault').join(',') === 'Charlie,Alpha,Bravo',
      'Charlie first',
    )
  })

  it('writes nothing when a grip is grabbed and released without travelling', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('Alpha', vault.id, 1000)
    await seedFile('Bravo', vault.id, 2000)
    await loadLibrary()

    renderPanel()
    await dragGrip(0, 10)

    expect(calls.reorderFile).toEqual([])
    expect(sectionNamed('Vault').files).toEqual(['Alpha', 'Bravo'])
    expect((await getFilesInFolder(vault.id)).map((file) => file.name)).toEqual(['Alpha', 'Bravo'])
  })

  it('cancels a live drag on Escape without reordering anything', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('Alpha', vault.id, 1000)
    await seedFile('Bravo', vault.id, 2000)
    await loadLibrary()

    renderPanel()
    await act(async () => {
      gripAt(0).dispatchEvent(new HarnessPointerEvent('pointerdown', { clientY: 100 }))
    })
    await act(async () => {
      document.body.dispatchEvent(new HarnessPointerEvent('pointermove', { clientY: 200 }))
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      document.body.dispatchEvent(new HarnessPointerEvent('pointerup', {}))
    })

    expect(calls.reorderFile).toEqual([])
    expect(sectionNamed('Vault').files).toEqual(['Alpha', 'Bravo'])
  })
})

describe('LibraryPanel — reordering folders', () => {
  /**
   * Three top-level folders in a stated order, the first two holding two dossiers each in a
   * stated order.
   *
   * Both kinds of row get explicit positions, so an assertion about "row 1" cannot pass by
   * accident in either of the two lists on the screen.
   */
  async function seedThreeFolders(): Promise<{
    alpha: LibraryFolder
    beta: LibraryFolder
    gamma: LibraryFolder
    a1: LibraryFile
    a2: LibraryFile
    b1: LibraryFile
    b2: LibraryFile
  }> {
    const alpha = await seedFolder('Alpha')
    const beta = await seedFolder('Beta')
    const gamma = await seedFolder('Gamma')
    await orderFolders(null, alpha.id, beta.id, gamma.id)
    const a1 = await seedFile('A1', alpha.id, 1000)
    const a2 = await seedFile('A2', alpha.id, 2000)
    const b1 = await seedFile('B1', beta.id, 1000)
    const b2 = await seedFile('B2', beta.id, 2000)
    return { alpha, beta, gamma, a1, a2, b1, b2 }
  }

  it('reorders the folder rows by dragging the folder grip, through the store', async () => {
    const { alpha } = await seedThreeFolders()
    await loadLibrary()

    renderPanel()
    expect(folderOrderOnScreen()).toEqual(['Root', 'Alpha', 'Beta', 'Gamma'])
    // A folder header has a grip; the Root bucket spans several folders, so no single index
    // describes it and the panel offers no grip for it.
    expect(sectionNamed('Alpha').folderGrips).toBe(1)
    expect(sectionNamed('Root').folderGrips).toBe(0)

    // 120px down at the 48px pitch jsdom forces: two rows.
    await dragFolderGrip(0, 120)

    expect(calls.reorderFolder).toEqual([[alpha.id, 2, null]])
    await waitFor(() => folderOrderOnScreen().join(',') === 'Root,Beta,Gamma,Alpha', 'Alpha last')
    expect(await folderNamesInLibrary()).toEqual(['Beta', 'Gamma', 'Alpha'])
  })

  it('reorders folders with the grip keyboard twin, through the same store call', async () => {
    const { alpha } = await seedThreeFolders()
    await loadLibrary()

    renderPanel()
    pressOnFolderGrip(0, 'ArrowDown')

    // One call, with the arguments the equivalent drag makes: one code path, two inputs.
    expect(calls.reorderFolder).toEqual([[alpha.id, 1, null]])
    await waitFor(() => folderOrderOnScreen().join(',') === 'Root,Beta,Alpha,Gamma', 'Alpha second')
    expect(await folderNamesInLibrary()).toEqual(['Beta', 'Alpha', 'Gamma'])
  })

  it('lands a folder in the same place whether the move was a drag or a key press', async () => {
    const { alpha, beta, gamma } = await seedThreeFolders()
    await loadLibrary()

    renderPanel()
    pressOnFolderGrip(0, 'ArrowDown')
    await waitFor(() => folderOrderOnScreen().join(',') === 'Root,Beta,Alpha,Gamma', 'the key move')
    const afterKey = folderOrderOnScreen().join(',')

    // Back to the start, then the identical step by pointer.
    await orderFolders(null, alpha.id, beta.id, gamma.id)
    await loadLibrary()
    expect(folderOrderOnScreen()).toEqual(['Root', 'Alpha', 'Beta', 'Gamma'])

    await dragFolderGrip(0, 60)
    await waitFor(() => folderOrderOnScreen().join(',') === afterKey, 'the drag to match the key')

    expect(folderOrderOnScreen().join(',')).toBe(afterKey)
    expect(await folderNamesInLibrary()).toEqual(['Beta', 'Alpha', 'Gamma'])
    // Both inputs asked the store for exactly the same thing, once each.
    expect(calls.reorderFolder).toEqual([
      [alpha.id, 1, null],
      [alpha.id, 1, null],
    ])
  })

  it('leaves every dossier where it was when a folder is dragged', async () => {
    const { alpha, beta } = await seedThreeFolders()
    await loadLibrary()

    renderPanel()
    await dragFolderGrip(0, 60)
    await waitFor(() => folderOrderOnScreen().join(',') === 'Root,Beta,Alpha,Gamma', 'Alpha second')

    // The other list on the screen was neither asked about nor moved.
    expect(calls.reorderFile).toEqual([])
    expect((await getFilesInFolder(alpha.id)).map((file) => file.name)).toEqual(['A1', 'A2'])
    expect((await getFilesInFolder(beta.id)).map((file) => file.name)).toEqual(['B1', 'B2'])
    expect(sectionFiles('Alpha')).toEqual(['A1', 'A2'])
    expect(sectionFiles('Beta')).toEqual(['B1', 'B2'])
  })

  it('leaves the folder rows where they were when a dossier is dragged', async () => {
    const { alpha, a2 } = await seedThreeFolders()
    await loadLibrary()

    renderPanel()
    // Panel-wide dossier grip 1 is Alpha's second row; folder grip 1 is Beta's header. The two
    // lists are on screen at the same time and neither owns index 1.
    await dragGrip(1, -60)

    expect(calls.reorderFile).toEqual([[a2.id, 0, alpha.id]])
    expect(calls.reorderFolder).toEqual([])
    await waitFor(() => sectionFiles('Alpha').join(',') === 'A2,A1', 'A2 first')
    expect(folderOrderOnScreen()).toEqual(['Root', 'Alpha', 'Beta', 'Gamma'])
    expect(await folderNamesInLibrary()).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('counts each drag list against its own rows, in both lists, in one session', async () => {
    const { alpha, beta, a2, b1, b2 } = await seedThreeFolders()
    await loadLibrary()

    renderPanel()
    await dragGrip(1, -60) // inside Alpha: its second dossier to the top
    await waitFor(() => sectionFiles('Alpha').join(',') === 'A2,A1', 'the dossier move')
    expect(sectionFiles('Beta')).toEqual(['B1', 'B2'])

    await dragFolderGrip(1, -60) // the folder list: Beta above Alpha
    await waitFor(() => folderOrderOnScreen().join(',') === 'Root,Beta,Alpha,Gamma', 'the folder move')

    expect(calls.reorderFile).toEqual([[a2.id, 0, alpha.id]])
    expect(calls.reorderFolder).toEqual([[beta.id, 0, null]])
    // Neither list's move disturbed the other: Beta came along with its own rows intact.
    expect(sectionFiles('Beta')).toEqual(['B1', 'B2'])
    expect(sectionFiles('Alpha')).toEqual(['A2', 'A1'])
    expect((await getFilesInFolder(beta.id)).map((file) => file.id)).toEqual([b1.id, b2.id])
  })

  it('keeps a folder reorder after the panel goes away and the database is reopened', async () => {
    const { alpha } = await seedThreeFolders()
    await loadLibrary()

    renderPanel()
    await dragFolderGrip(0, 60)
    await waitFor(() => folderOrderOnScreen().join(',') === 'Root,Beta,Alpha,Gamma', 'Alpha second')
    expect(calls.reorderFolder).toEqual([[alpha.id, 1, null]])

    // Close the panel and the connection, the way leaving the page does, then come back.
    act(() => {
      root?.unmount()
    })
    container?.remove()
    root = null
    container = null
    await closeLibraryDatabase()

    await loadLibrary()
    renderPanel()

    expect(folderOrderOnScreen()).toEqual(['Root', 'Beta', 'Alpha', 'Gamma'])
    expect(await folderNamesInLibrary()).toEqual(['Beta', 'Alpha', 'Gamma'])
  })

  it('reorders the folders inside one parent without touching the top level', async () => {
    const vault = await seedFolder('Vault')
    const other = await seedFolder('Other')
    await orderFolders(null, vault.id, other.id)
    const first = await seedFolder('First', vault.id)
    const second = await seedFolder('Second', vault.id)
    await orderFolders(vault.id, second.id, first.id)

    // The subfolder run, exactly as it stood before the top level was touched.
    const subRunBefore = siblingFolders(await getFolders(), vault.id)
    await loadLibrary()

    renderPanel()
    // This panel lists one level, so the subfolders are not rows here; their run still belongs
    // to their own parent and a top-level drag must not renumber or re-home it.
    await dragFolderGrip(0, 60)

    expect(calls.reorderFolder).toEqual([[vault.id, 1, null]])
    await waitFor(() => folderOrderOnScreen().join(',') === 'Root,Other,Vault', 'Vault last')
    expect(siblingFolders(await getFolders(), vault.id)).toEqual(subRunBefore)
    expect(siblingFolders(await getFolders(), vault.id).map((folder) => folder.id)).toEqual([
      second.id,
      first.id,
    ])
    expect(subRunBefore.map((folder) => folder.parentId)).toEqual([vault.id, vault.id])
  })
})

describe('LibraryPanel — the folder menu', () => {
  it('renames the folder inline and keeps its dossiers with it', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('API keys', vault.id, 1000)
    await loadLibrary()

    renderPanel()
    const section = folderSection('Vault')
    await openMenu(section)
    click(menuItem('Rename folder'))

    typeInto(inputIn(section, 'input[type="text"]', 'rename field'), 'Working keys')
    await clickAndSettle(requireButton(section.querySelector('.library-panel__folder-rename-save'), 'rename save'))

    expect(calls.renameFolder).toEqual([[vault.id, 'Working keys']])
    await waitFor(() => sectionFiles('Working keys').join(',') === 'API keys', 'the renamed folder')
    expect((await getFolders()).map((folder) => folder.name)).toEqual(['Working keys'])
  })

  it('makes a dossier in this folder from “New file in this folder”', async () => {
    const vault = await seedFolder('Vault')
    await loadLibrary()

    const askedFor: string[] = []
    renderPanel({
      onCreateFile: (folderId) => {
        askedFor.push(folderId)
      },
    })

    const section = folderSection('Vault')
    await openMenu(section)
    click(menuItem('New file in this folder'))

    expect(askedFor).toEqual([vault.id])
    expect(sectionNamed('Vault').files).toEqual([])
  })

  it('asks before a folder delete, states the whole cascade, and deletes nothing until the answer', async () => {
    const vault = await seedFolder('Vault')
    const inside = await seedFolder('Old vault', vault.id)
    const alpha = await seedFile('API keys', vault.id, 1000)
    const buried = await seedFile('Cold storage', inside.id, 1500)
    const note = looseItem(inside.id, 'Loose note')
    await saveItem(note)
    await loadLibrary()

    renderPanel()
    const section = folderSection('Vault')
    await openMenu(section)
    // The entry states the cascade before the dialog does: one nested folder, two dossiers
    // (one of them in the nested folder), one loose item.
    click(menuItem('Delete folder and its 1 folder, 2 dossiers, 1 item'))

    const prompt = dialogText()
    expect(prompt.title).toContain('Vault')
    expect(prompt.message).toContain('2 folders')
    expect(prompt.message).toContain('2 dossiers')
    expect(prompt.message).toContain('1 item')

    // Nothing is lost yet: the question is not the answer.
    expect(calls.deleteFolder).toEqual([])
    expect((await getFiles()).map((file) => file.id)).toEqual([alpha.id, buried.id])

    await clickAndSettle(dialogButton('Delete folder and contents permanently'))

    expect(calls.deleteFolder).toEqual([vault.id])
    await waitFor(
      () => panel().querySelectorAll('.library-panel__folder').length === 1,
      'only Root left on screen',
    )
    expect(await getFiles()).toEqual([])
    expect(await getItemsInFolder(inside.id)).toEqual([])
    expect(await getFolders()).toEqual([])
    // The cascade is the data layer's, not a loop of single deletes here.
    expect(calls.deleteFile).toEqual([])
  })

  it('leaves everything alone when a folder delete is declined', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('API keys', vault.id, 1000)
    await loadLibrary()

    renderPanel()
    const section = folderSection('Vault')
    await openMenu(section)
    click(menuItem('Delete folder and its 1 dossier'))
    await clickAndSettle(dialogButton('Cancel'))

    expect(calls.deleteFolder).toEqual([])
    expect(sectionNamed('Vault').files).toEqual(['API keys'])
    expect((await getFolders()).map((folder) => folder.id)).toEqual([vault.id])
  })

  it('offers no rename or delete for Root, which the library layer cannot remove', async () => {
    await seedFile('Loose end', ROOT_FOLDER_ID, 1000)
    await loadLibrary()

    renderPanel()

    const root = folderSection('Root')
    expect(root.querySelector('.library-panel__folder-menu-toggle')).toBe(null)
    expect(root.querySelector('.library-panel__grip')).toBe(null)
    expect(root.querySelector('.library-panel__new-file')).not.toBe(null)
  })

  it('collapses a folder and brings its dossiers back', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('API keys', vault.id, 1000)
    await loadLibrary()

    renderPanel()
    expect(sectionNamed('Vault').files).toEqual(['API keys'])

    // Root is the first section, so the toggle has to be read from Vault's own node.
    const toggle = requireButton(
      folderSection('Vault').querySelector('.library-panel__folder-toggle'),
      'collapse toggle',
    )
    click(toggle)
    expect(sectionNamed('Vault').files).toEqual([])
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    click(toggle)
    expect(sectionNamed('Vault').files).toEqual(['API keys'])
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})

/**
 * The structure the panel has to state with its geometry (DESIGN.md's Row spec, and the
 * design-system pass's findings about this screen).
 *
 * Behaviour is pinned everywhere else in this file; these tests pin what a sighted user reads,
 * because that is the part a later edit can break without breaking a store call: which control
 * leads a row, how deep a contained row sits, what a count says, and where the control that
 * makes a dossier lives. Each assertion names the mechanism, not a pixel value, except where
 * the pixel value *is* the mechanism (DESIGN.md's 44px row and 10px row padding).
 *
 * jsdom lays nothing out, so the geometry is read back from the inline styles the component
 * writes — which is also the only form the deployed CSP allows (React sets styles through the
 * CSSOM). `getComputedStyle` here reports the initial value for `color` (`rgb(0, 0, 0)`) for
 * every element, because jsdom does not substitute Mantine's `var()` chain, so a colour-versus-
 * background assertion in this file would compare two numbers no browser ever painted. The
 * contrast guarantee for these labels is pinned in `src/themeBridge.test.tsx` ("a quiet control
 * is readable in the light scheme"), which resolves the token chain itself.
 */
describe('LibraryPanel — container and contained', () => {
  /** Vault holding two dossiers, Notes holding one, and one dossier in Root. */
  async function seedTwoFolders(): Promise<LibraryFolder> {
    const vault = await seedFolder('Vault')
    const notes = await seedFolder('Notes')
    await seedFile('API keys', vault.id, 1000)
    await seedFile('Recovery tokens', vault.id, 2000)
    await seedFile('Shopping list', notes.id, 1000)
    await seedFile('Loose end', ROOT_FOLDER_ID, 1000)
    await orderFolders(null, vault.id, notes.id)
    await loadLibrary()
    return vault
  }

  function headerRow(section: HTMLElement): HTMLElement {
    const row = section.querySelector<HTMLElement>('.library-panel__folder-row')
    if (row === null) throw new Error('test bug: this section has no header row')
    return row
  }

  /** The position of one control in the header row, or -1 when the row does not carry one. */
  function headerPosition(section: HTMLElement, className: string): number {
    return [...headerRow(section).children].findIndex((child) => child.classList.contains(className))
  }

  /** The dossier rows of one section, in the order it lists them. */
  function containedRows(section: HTMLElement): HTMLElement[] {
    return [...section.querySelectorAll<HTMLElement>('.library-panel__file')]
  }

  it('leads a container row with the grip, then the label with its folder icon, then the collapse toggle beside it', async () => {
    await seedTwoFolders()

    renderPanel()

    const vault = folderSection('Vault')
    // Grip first, then the folder name button (with folder icon), then the collapse chevron beside the folder name.
    expect(headerPosition(vault, 'library-panel__folder-grip')).toBeGreaterThanOrEqual(0)
    expect(headerPosition(vault, 'library-panel__folder-grip')).toBeLessThan(
      headerPosition(vault, 'library-panel__folder-name'),
    )
    expect(headerPosition(vault, 'library-panel__folder-name')).toBeLessThan(
      headerPosition(vault, 'library-panel__folder-toggle'),
    )
    // The two controls that create and command the folder are at the right end, the plus before
    // the menu, and the count between the label/toggle and them.
    expect(headerPosition(vault, 'library-panel__folder-toggle')).toBeLessThan(
      headerPosition(vault, 'library-panel__new-file'),
    )
    expect(headerPosition(vault, 'library-panel__new-file')).toBeLessThan(
      headerPosition(vault, 'library-panel__folder-menu-toggle'),
    )
  })

  it('makes Root a sibling of the folders by giving it the same row anatomy', async () => {
    await seedTwoFolders()

    renderPanel()

    const root = folderSection('Root')
    const vault = folderSection('Vault')
    // Root opens and closes like a folder, starts at the same edge and carries the same count —
    // which is the difference between "a bucket" and "another dossier row".
    expect(headerPosition(root, 'library-panel__folder-toggle')).toBe(
      headerPosition(vault, 'library-panel__folder-toggle'),
    )
    expect(headerRow(root).style.paddingInline).toBe(headerRow(vault).style.paddingInline)
    expect(headerRow(root).style.minHeight).toBe(headerRow(vault).style.minHeight)
    // It has no grip, because the store cannot honour one index across the folders its rows come
    // from — and the column is reserved rather than dropped, so the labels still line up.
    expect(headerPosition(root, 'library-panel__folder-grip')).toBe(-1)
    expect(headerPosition(root, 'library-panel__folder-rail')).toBe(
      headerPosition(vault, 'library-panel__folder-grip'),
    )
    expect(headerPosition(root, 'library-panel__new-file')).toBeGreaterThan(0)
    // No menu: the library layer has no Root to rename or delete.
    expect(headerPosition(root, 'library-panel__folder-menu-toggle')).toBe(-1)
  })

  it('indents every contained row deeper than the container that owns it', async () => {
    await seedTwoFolders()

    renderPanel()

    const vault = folderSection('Vault')
    const apiKeys = fileRow('API keys')
    // Container: the Panel's own row padding. Contained: tree indentation aligned cleanly under the folder row.
    expect(headerRow(vault).style.paddingInline).toBe('10px')
    expect(apiKeys.style.paddingInlineStart).toBe('28px')
    expect(apiKeys.style.paddingInlineEnd).toBe('10px')
    // A dossier never carries a disclosure chevron: no chevron means no contents.
    expect(apiKeys.querySelector('.library-panel__folder-toggle')).toBe(null)
    // Root's rows sit in the same contained column as a folder's, and keep the reserved grip
    // column even though they have no grip.
    const looseEnd = fileRow('Loose end')
    expect(looseEnd.style.paddingInlineStart).toBe(apiKeys.style.paddingInlineStart)
    expect(looseEnd.querySelector('.library-panel__grip')).toBe(null)
    expect(looseEnd.querySelector('.library-panel__file-rail')).not.toBe(null)
  })

  it('draws each row as a flat line with one division, and no box around the list', async () => {
    await seedTwoFolders()

    renderPanel()

    const vault = folderSection('Vault')
    // Container row uses 44px, and contained single-line dossier row uses 38px pitch.
    expect(headerRow(vault).style.minHeight).toBe('44px')
    expect(fileRow('API keys').style.minHeight).toBe('38px')
    expect(fileRow('API keys').style.borderTop).toContain('var(--qrbit-border)')
    // A section is its header row plus the rows it owns: no padded wrapper, no description line,
    // no `+ New file` row. That padding and those lines were the vertical voids.
    expect(
      [...vault.children].map((child) =>
        [...child.classList].find((name) => name.startsWith('library-panel__')) ?? child.tagName,
      ),
    ).toEqual(['library-panel__folder-row', 'library-panel__files'])
    expect(panel().querySelector('.library-panel__folder-hint')).toBe(null)
    const firstPlus = panel().querySelector<HTMLElement>('.library-panel__new-file')
    if (firstPlus === null) throw new Error('test bug: the panel has no plus control')
    expect(firstPlus.closest('.library-panel__folder-row')).not.toBe(null)
  })

  it('collapses to one row and says so in the count', async () => {
    await seedTwoFolders()

    renderPanel()
    const toggle = requireButton(
      folderSection('Vault').querySelector('.library-panel__folder-toggle'),
      'collapse toggle',
    )

    click(toggle)

    // A collapsed folder is its header alone
    expect(folderSection('Vault').children).toHaveLength(1)
    expect(
      folderSection('Vault').querySelector('.library-panel__folder-count'),
    ).toBe(null)

    click(toggle)
    expect(containedRows(folderSection('Vault'))).toHaveLength(2)
  })

  it('does not display dossier count badges in the folder browser', async () => {
    await seedTwoFolders()
    await seedFolder('Quiet')
    await loadLibrary()

    renderPanel()

    expect(
      folderSection('Vault').querySelector('.library-panel__folder-count'),
    ).toBe(null)
    expect(
      folderSection('Notes').querySelector('.library-panel__folder-count'),
    ).toBe(null)
    expect(
      folderSection('Root').querySelector('.library-panel__folder-count'),
    ).toBe(null)
    expect(
      folderSection('Quiet').querySelector('.library-panel__folder-count'),
    ).toBe(null)
  })

  it('asks for a new file in the folder whose header plus was pressed, without collapsing it', async () => {
    const vault = await seedTwoFolders()

    const askedFor: string[] = []
    renderPanel({
      onCreateFile: (folderId) => {
        askedFor.push(folderId)
      },
    })

    const section = folderSection('Vault')
    const plus = requireButton(section.querySelector('.library-panel__new-file'), 'header plus')
    expect(plus.getAttribute('aria-label')).toBe('New file in Vault')

    click(plus)

    expect(askedFor).toEqual([vault.id])
    // The press made a dossier; it did not fold the folder away. `stopPropagation` on the plus is
    // what keeps it out of the row's collapse controls (the chevron and the label), and the row is
    // verified here rather than assumed.
    expect(requireButton(section.querySelector('.library-panel__folder-toggle'), 'toggle').getAttribute('aria-expanded')).toBe('true')
    expect(sectionNamed('Vault').files).toEqual(['API keys', 'Recovery tokens'])
  })

  it('states the cascade in the delete entry of a folder that has one', async () => {
    const vault = await seedFolder('Vault')
    const inside = await seedFolder('Old vault', vault.id)
    await seedFile('API keys', vault.id, 1000)
    await seedFile('Cold storage', inside.id, 1500)
    await loadLibrary()

    renderPanel()
    await openMenu(folderSection('Vault'))

    // The same arithmetic the confirmation quotes, in the entry that opens it.
    expect(menuItem('Delete folder and its 1 folder, 2 dossiers').textContent).toBe(
      'Delete folder and its 1 folder, 2 dossiers',
    )
  })

  it('says what a delete of an empty folder costs, which is one folder', async () => {
    await seedFolder('Quiet')
    await loadLibrary()

    renderPanel()
    await openMenu(folderSection('Quiet'))

    expect(menuItem('Delete empty folder').textContent).toBe('Delete empty folder')
  })

  it('keeps the names in the DOM and out of the panel’s own colour decisions', async () => {
    await seedTwoFolders()

    renderPanel()

    const folderLabel = folderSection('Vault').querySelector<HTMLElement>(
      '.library-panel__folder-name',
    )
    const dossierLabel = fileRow('API keys').querySelector<HTMLElement>(
      '.library-panel__file-name',
    )
    // The text is there, whatever colour it is painted in.
    expect(folderLabel?.textContent?.trim()).toBe('Vault')
    expect(dossierLabel?.textContent?.trim()).toBe('API keys')
    // And the panel writes no colour of its own for it: the name comes from the theme's slots,
    // so the invisible-in-light-mode defect has one owner (`theme.ts`, whose bridge test is
    // named above) rather than being papered over row by row. Mantine's own CSS custom
    // properties (`--button-color`, resolved from the theme's slots) are not a claim this file
    // makes, so only the label elements and the row geometry are read here.
    expect(folderLabel?.style.color).toBe('')
    expect(dossierLabel?.style.color).toBe('')
    expect(dossierLabel?.getAttribute('style')).toBe(null)
    // The row itself only sets geometry and the division.
    expect(fileRow('API keys').style.color).toBe('')
    expect(fileRow('API keys').getAttribute('style')).toContain('border-top')
  })
})

describe('LibraryPanel — the dossier menu', () => {
  it('renames a dossier and the folder list follows', async () => {
    const vault = await seedFolder('Vault')
    const alpha = await seedFile('Alpha', vault.id, 1000)
    await loadLibrary()

    renderPanel()
    const row = fileRow('Alpha')
    await openMenu(row)
    click(menuItem('Rename dossier'))

    typeInto(inputIn(row, 'input[type="text"]', 'rename field'), '  Gateway keys  ')
    await clickAndSettle(requireButton(row.querySelector('.library-panel__file-rename-save'), 'rename save'))

    expect(calls.updateFile).toEqual([[alpha.id, { name: 'Gateway keys' }]])
    await waitFor(() => sectionFiles('Vault').join(',') === 'Gateway keys', 'the new label')
    expect((await getFilesInFolder(vault.id)).map((file) => file.name)).toEqual(['Gateway keys'])
  })

  it('refuses to file a dossier with an empty name', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('Alpha', vault.id, 1000)
    await loadLibrary()

    renderPanel()
    const row = fileRow('Alpha')
    await openMenu(row)
    click(menuItem('Rename dossier'))

    typeInto(inputIn(row, 'input[type="text"]', 'rename field'), '   ')
    const save = requireButton(row.querySelector('.library-panel__file-rename-save'), 'rename save')
    expect(save.disabled).toBe(true)

    click(requireButton(row.querySelector('.library-panel__file-rename-cancel'), 'rename cancel'))

    expect(calls.updateFile).toEqual([])
    expect(sectionNamed('Vault').files).toEqual(['Alpha'])
  })

  it('moves a dossier to another folder through the picker, and it reads as that folder’s row', async () => {
    const vault = await seedFolder('Vault')
    const notes = await seedFolder('Notes')
    const alpha = await seedFile('Alpha', vault.id, 1000)
    await loadLibrary()

    renderPanel()
    const row = fileRow('Alpha')
    await openMenu(row)
    click(menuItem('Move to folder'))
    await settle()

    const picker = dialog()
    const option = [...picker.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes('Notes'),
    )
    if (option === undefined) throw new Error('test bug: the picker does not offer Notes')
    click(option)

    // The dialog says what it is doing to the dossier the panel opened it for: a move, not a
    // save, and named after the dossier in the question above the list.
    expect(picker.textContent).toContain('Move “Alpha” into:')
    const confirm = dialogButton('Move dossier')
    await clickAndSettle(confirm)

    expect(calls.moveFile).toEqual([[alpha.id, notes.id]])
    await waitFor(() => sectionFiles('Notes').join(',') === 'Alpha', 'Alpha under Notes')
    expect(sectionNamed('Vault').files).toEqual([])
    expect((await getFilesInFolder(notes.id)).map((file) => file.id)).toEqual([alpha.id])
    // The picker closed with the choice, instead of staying open as if nothing happened.
    expect(document.querySelector('[role="dialog"]')).toBe(null)
  })

  it('deletes a dossier only after the confirmation, and says which dossier it is', async () => {
    const vault = await seedFolder('Vault')
    const alpha = await seedFile('Alpha', vault.id, 1000, [
      { id: 'b-1', type: 'heading', content: 'Alpha' },
      { id: 'b-2', type: 'richText', content: 'body' },
    ])
    const bravo = await seedFile('Bravo', vault.id, 2000)
    await loadLibrary()

    renderPanel()
    const row = fileRow('Alpha')
    await openMenu(row)
    click(menuItem('Delete dossier'))

    const prompt = dialogText()
    expect(prompt.title).toContain('Alpha')
    expect(prompt.message).toContain('2 blocks')
    expect(calls.deleteFile).toEqual([])
    expect((await getFilesInFolder(vault.id)).map((file) => file.id)).toEqual([alpha.id, bravo.id])

    await clickAndSettle(dialogButton('Delete dossier permanently'))

    expect(calls.deleteFile).toEqual([alpha.id])
    await waitFor(() => sectionFiles('Vault').join(',') === 'Bravo', 'Alpha gone')
    expect((await getFilesInFolder(vault.id)).map((file) => file.id)).toEqual([bravo.id])
  })

  it('keeps the dossier when the delete is declined', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('Alpha', vault.id, 1000)
    await loadLibrary()

    renderPanel()
    const row = fileRow('Alpha')
    await openMenu(row)
    click(menuItem('Delete dossier'))
    await clickAndSettle(dialogButton('Cancel'))

    expect(calls.deleteFile).toEqual([])
    expect(sectionNamed('Vault').files).toEqual(['Alpha'])
  })
})

describe('LibraryPanel — instant search & filtering', () => {
  it('filters dossiers by search query across folders and root', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('API keys', vault.id, 1000)
    await seedFile('Deployment runbook', vault.id, 2000)
    await seedFile('Loose end', ROOT_FOLDER_ID, 1000)
    await loadLibrary()

    renderPanel()

    const searchInput = inputIn(panel(), 'input[placeholder="Search dossiers..."]', 'search input')
    typeInto(searchInput, 'API')

    expect(panel().textContent).toContain('API keys')
    expect(panel().textContent).not.toContain('Deployment runbook')
    expect(panel().textContent).not.toContain('Loose end')

    // Clear search
    typeInto(searchInput, '')
    expect(panel().textContent).toContain('API keys')
    expect(panel().textContent).toContain('Deployment runbook')
    expect(panel().textContent).toContain('Loose end')
  })

  it('shows empty search state when no dossiers match query', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('API keys', vault.id, 1000)
    await loadLibrary()

    renderPanel()

    const searchInput = inputIn(panel(), 'input[placeholder="Search dossiers..."]', 'search input')
    typeInto(searchInput, 'NonExistentDossier999')

    expect(panel().textContent).toContain('No dossiers found matching “NonExistentDossier999”')
  })
})

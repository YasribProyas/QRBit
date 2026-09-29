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
  ROOT_FOLDER_ID,
  saveFile,
  saveItem,
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
  deleteFile: string[]
  moveFile: Array<[string, string]>
  updateFile: Array<[string, Partial<LibraryFile>]>
  renameFolder: Array<[string, string]>
  deleteFolder: string[]
  createFolder: Array<[string, string | null]>
}

let calls: Recorded = {
  reorderFile: [],
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

// ---------------------------------------------------------------------------
// DOM reading helpers
// ---------------------------------------------------------------------------

interface SectionView {
  name: string
  files: string[]
  /** Grips this section offers — the panel's statement about where an order exists. */
  grips: number
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

/** Opens the menu belonging to `scope` (a folder section or a dossier row) and reads it. */
function openMenu(scope: HTMLElement): void {
  const toggle = scope.querySelector<HTMLButtonElement>(
    '.library-panel__file-menu-toggle, .library-panel__folder-menu-toggle',
  )
  if (toggle === null) throw new Error('test bug: this row has no menu')
  click(toggle)
}

function menuItem(scope: HTMLElement, label: string): HTMLButtonElement {
  for (const item of scope.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
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

/** A button of the open confirmation dialog, by its exact label. */
function dialogButton(label: string): HTMLButtonElement {
  const dialog = panel().querySelector<HTMLElement>('.confirm-delete')
  if (dialog === null) throw new Error('test bug: no confirmation open')
  for (const node of dialog.querySelectorAll<HTMLButtonElement>('button')) {
    if (node.textContent === label) return node
  }
  throw new Error(`test bug: no dialog button labelled ${label}`)
}

function dialogText(): { title: string; message: string } {
  const dialog = panel().querySelector<HTMLElement>('.confirm-delete')
  if (dialog === null) throw new Error('test bug: no confirmation open')
  return {
    title: dialog.querySelector('.confirm-delete__title')?.textContent ?? '',
    message: dialog.querySelector('.confirm-delete__message')?.textContent ?? '',
  }
}

function gripAt(index: number): HTMLButtonElement {
  const grips = [...panel().querySelectorAll<HTMLButtonElement>('.library-panel__grip')]
  const grip = grips[index]
  if (grip === undefined) throw new Error(`test bug: no grip at index ${index}`)
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

/** A key press on a grip: the keyboard twin of the drag (D16.3). */
function pressOnGrip(index: number, key: string): void {
  const grip = gripAt(index)
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
 * A dossier written straight to IndexedDB, positioned inside its folder by `sortOrder`
 * so the panel's order is the order the test declares.
 */
async function seedFile(
  name: string,
  folderId: string,
  sortOrder: number,
  blocks: FileBlock[] = [{ id: `b-${name}`, type: 'heading', content: `${name} heading` }],
): Promise<LibraryFile> {
  const created = await createFile(name, folderId, blocks)
  const ordered: LibraryFile = { ...created, sortOrder }
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
    await seedFile('Secrets', vault.id, 2000, [
      { id: 'b-heading', type: 'heading', content: 'Cluster keys' },
      {
        id: 'b-locked',
        type: 'locked',
        label: 'Root keyphrase',
        content: 'sys_x94#kK99!Alpha2',
        isLocked: true,
      },
    ])
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

    click(requireButton(panel().querySelector('.library-panel__new-folder'), 'New Folder button'))
    const modal = panel().querySelector<HTMLElement>('.library-modal')
    if (modal === null) throw new Error('test bug: the new-folder dialog did not open')

    typeInto(inputIn(modal, '.library-modal__input', 'folder name field'), 'Archive')
    await clickAndSettle(requireButton(modal.querySelector('.library-modal__submit'), 'create button'))

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

describe('LibraryPanel — the folder menu', () => {
  it('renames the folder inline and keeps its dossiers with it', async () => {
    const vault = await seedFolder('Vault')
    await seedFile('API keys', vault.id, 1000)
    await loadLibrary()

    renderPanel()
    const section = folderSection('Vault')
    openMenu(section)
    click(menuItem(section, 'Rename'))

    typeInto(inputIn(section, '.library-panel__folder-rename-input', 'rename field'), 'Working keys')
    await clickAndSettle(requireButton(section.querySelector('.library-panel__folder-rename-save'), 'rename save'))

    expect(calls.renameFolder).toEqual([[vault.id, 'Working keys']])
    await waitFor(() => sectionFiles('Working keys').join(',') === 'API keys', 'the renamed folder')
    expect((await getFolders()).map((folder) => folder.name)).toEqual(['Working keys'])
  })

  it('makes a dossier in this folder from "New file here"', async () => {
    const vault = await seedFolder('Vault')
    await loadLibrary()

    const askedFor: string[] = []
    renderPanel({
      onCreateFile: (folderId) => {
        askedFor.push(folderId)
      },
    })

    const section = folderSection('Vault')
    openMenu(section)
    click(menuItem(section, 'New file here'))

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
    openMenu(section)
    click(menuItem(section, 'Delete folder and contents'))

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
    openMenu(section)
    click(menuItem(section, 'Delete folder and contents'))
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

describe('LibraryPanel — the dossier menu', () => {
  it('renames a dossier and the folder list follows', async () => {
    const vault = await seedFolder('Vault')
    const alpha = await seedFile('Alpha', vault.id, 1000)
    await loadLibrary()

    renderPanel()
    const row = fileRow('Alpha')
    openMenu(row)
    click(menuItem(row, 'Rename'))

    typeInto(inputIn(row, '.library-panel__file-rename-input', 'rename field'), '  Gateway keys  ')
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
    openMenu(row)
    click(menuItem(row, 'Rename'))

    typeInto(inputIn(row, '.library-panel__file-rename-input', 'rename field'), '   ')
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
    openMenu(row)
    click(menuItem(row, 'Move to…'))

    const modal = panel().querySelector<HTMLElement>('.fixed.inset-0')
    if (modal === null) throw new Error('test bug: the folder picker did not open')
    const option = [...modal.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes('Notes'),
    )
    if (option === undefined) throw new Error('test bug: the picker does not offer Notes')
    click(option)
    const confirm = [...modal.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === 'Save File',
    )
    if (confirm === undefined) throw new Error('test bug: the picker has no confirm button')
    await clickAndSettle(confirm)

    expect(calls.moveFile).toEqual([[alpha.id, notes.id]])
    await waitFor(() => sectionFiles('Notes').join(',') === 'Alpha', 'Alpha under Notes')
    expect(sectionNamed('Vault').files).toEqual([])
    expect((await getFilesInFolder(notes.id)).map((file) => file.id)).toEqual([alpha.id])
    // The picker closed with the choice, instead of staying open as if nothing happened.
    expect(panel().querySelector('.fixed.inset-0')).toBe(null)
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
    openMenu(row)
    click(menuItem(row, 'Delete'))

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
    openMenu(row)
    click(menuItem(row, 'Delete'))
    await clickAndSettle(dialogButton('Cancel'))

    expect(calls.deleteFile).toEqual([])
    expect(sectionNamed('Vault').files).toEqual(['Alpha'])
  })
})

/** @vitest-environment jsdom */
/**
 * Library browser tests (PLAN.md §6.4, §7, §16 Phase 5).
 *
 * The browser is the store's counterpart: it receives folders, items, the current
 * folder and action callbacks, and it owns only what is genuinely view state —
 * multi-select, the new-folder dialog, and the tree's current folder (which the page
 * owns through a prop and a setter). These tests pin the two-region layout, the empty /
 * loading / error states, the folder navigation, and PLAN.md §6.4's multi-select
 * contract (long press, checkbox fallback, Escape, the `···` menu taking over, and
 * "Send selected (N)" reporting the selected ids. Deletes are pinned too (Phase 5 review
 * P2): no store call happens until the confirmation is answered, and the cascade the
 * confirmation warns about is counted from the subtree the store would destroy.
 *
 * The offline creation row (`NewItemBar`) is pinned from two sides: here, that the browser
 * offers it, keeps it out of multi-select, points it at the folder actually on screen,
 * hands the §6.1 row to the save seam — and, in the store-backed case, that the row
 * reaches IndexedDB and appears in the list with nobody calling `refresh`; and in
 * `NewItemBar.test.tsx`, the compose dialogs, the pickers and the locked tuple.
 */

import 'fake-indexeddb/auto'

import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LibraryBrowser,
  describeDelete,
  folderDeleteImpact,
  itemsInFolder,
} from './LibraryBrowser'
import type { LibraryBrowserProps, PendingDelete } from './LibraryBrowser'
import type { LibraryFolder } from './FolderNode'
import type { LibraryItem } from './LibraryItemRow'
import { closeLibraryDatabase, getItemsInFolder, ROOT_FOLDER_ID } from '../../lib/library'
import { useLibraryStore } from '../../store/libraryStore'

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

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function click(element: HTMLElement, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(field, value)

  act(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * Submitting is asynchronous: the dialogs await the store's callback (IndexedDB) before
 * they close, so the test has to flush the microtask that follows the promise.
 */
async function submitForm(element: HTMLElement): Promise<void> {
  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function bySelector<T extends Element>(
  element: HTMLElement,
  selector: string,
  constructor: new () => T,
): T {
  const node = element.querySelector(selector)
  if (!(node instanceof constructor)) throw new Error(`test bug: nothing matching ${selector}`)
  return node
}

function button(element: HTMLElement, selector: string): HTMLButtonElement {
  return bySelector(element, selector, HTMLButtonElement)
}

function rows(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>('.library-item')]
}

function itemNames(element: HTMLElement): (string | undefined)[] {
  return rows(element).map((row) => row.querySelector('.library-item__name')?.textContent ?? undefined)
}

function folderNamed(element: HTMLElement, name: string): HTMLButtonElement {
  for (const candidate of element.querySelectorAll<HTMLButtonElement>('.folder-node__name')) {
    if (candidate.textContent?.includes(name) === true) return candidate
  }
  throw new Error(`test bug: no folder named ${name}`)
}

function menuItem(element: HTMLElement, label: string): HTMLButtonElement {
  for (const item of element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
    if (item.textContent === label) return item
  }
  throw new Error(`test bug: no menu item labelled ${label}`)
}

function longPress(element: HTMLElement): void {
  const row = element.querySelector('.library-item__row')
  if (row === null) throw new Error('test bug: no row to press')
  act(() => {
    row.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  act(() => {
    vi.advanceTimersByTime(600)
  })
}

/** The open confirmation, or `null` when nothing is asking.
 *  `.confirm-delete` is the dialog's own overlay class, added on top of the shared
 * `library-modal` shell, so it never matches the new-folder dialog by accident. */
function confirmDialog(element: HTMLElement): HTMLElement | null {
  return element.querySelector<HTMLElement>('.confirm-delete')
}

function dialogText(element: HTMLElement): { title: string; message: string } {
  const dialog = confirmDialog(element)
  if (dialog === null) throw new Error('test bug: no confirmation open')

  return {
    title: dialog.querySelector('.confirm-delete__title')?.textContent ?? '',
    message: dialog.querySelector('.confirm-delete__message')?.textContent ?? '',
  }
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

/** Opens the folder's `···` menu and picks its delete entry, stopping at the question. */
function askToDeleteFolder(element: HTMLElement, name: string): void {
  const menuToggle = folderNamed(element, name).parentElement?.querySelector(
    '.folder-node__menu-toggle',
  )
  if (!(menuToggle instanceof HTMLButtonElement)) throw new Error('test bug: no folder menu')

  click(menuToggle)
  click(menuItem(element, 'Delete folder and contents'))
}

/** The same for an item row: the first visible row's menu, then its Delete entry. */
function askToDeleteFirstItem(element: HTMLElement): void {
  click(button(element, '.library-item__menu-toggle'))
  click(menuItem(element, 'Delete'))
}

const IDB_NAME = 'qrdrop-library'

/**
 * Drops the library database.
 *
 * Only the store-backed cases need it: the library layer caches one connection, so
 * `closeLibraryDatabase` comes first or `deleteDatabase` blocks forever.
 */
async function emptyLibraryDatabase(): Promise<void> {
  await closeLibraryDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(IDB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'))
  })
}

function renderBrowser(overrides: Partial<LibraryBrowserProps> = {}) {
  const props: LibraryBrowserProps = {
    folders,
    items,
    currentFolderId: null,
    onSelectFolder: vi.fn(),
    onCreateFolder: vi.fn(),
    onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onRenameItem: vi.fn(),
    onMoveItem: vi.fn(),
    onDeleteItem: vi.fn(),
    // The offline creation row's save seam. Stubbed on every render so no layout test can
    // reach IndexedDB by accident; the row's own writes are pinned in NewItemBar.test.tsx
    // against a real `fake-indexeddb`.
    onSaveItem: vi.fn(),
    onSendItems: vi.fn(),
    onSelectionChange: vi.fn(),
    ...overrides,
  }

  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  act(() => {
    root.render(createElement(LibraryBrowser, props))
  })

  const harness: Harness = {
    element: host,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      host.remove()
    },
  }
  openHarnesses.push(harness)

  return {
    harness,
    props,
    update: (patch: Partial<LibraryBrowserProps>) => {
      Object.assign(props, patch)
      act(() => {
        root.render(createElement(LibraryBrowser, props))
      })
    },
  }
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  document.body.innerHTML = ''
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('itemsInFolder', () => {
  it('filters a real folder by id and puts everything outside the tree at the root', () => {
    expect(itemsInFolder(items, folders, 'f1').map((item) => item.id)).toEqual(['i1', 'i2'])
    expect(itemsInFolder(items, folders, null).map((item) => item.id)).toEqual(['i4'])
    // The root named as the store names it, rather than as null.
    expect(itemsInFolder(items, folders, 'root').map((item) => item.id)).toEqual(['i4'])
  })
})

describe('LibraryBrowser — layout (PLAN.md §6.4)', () => {
  it('renders the folder tree and the items of the current folder only', () => {
    const { harness } = renderBrowser({ currentFolderId: 'f1' })

    expect(harness.element.querySelector('.library-browser__folder-name')?.textContent).toContain(
      'Uni Stuff',
    )
    // The tree is navigation: Root plus the top-level folders, children on demand.
    const folderNames = [...harness.element.querySelectorAll('.folder-node__name')].map(
      (node) => node.textContent?.trim(),
    )
    expect(folderNames).toEqual(['📁 Root', '📁 Empty', '📁 Uni Stuff', '📁 Work'])

    expect(itemNames(harness.element)).toEqual(['Thesis Draft', 'Portal password'])
    expect(harness.element.querySelector('.folder-node__count')?.textContent).toBe('1')
  })

  it('expands a folder into its children', () => {
    const { harness } = renderBrowser({ currentFolderId: 'f1' })

    const uni = folderNamed(harness.element, 'Uni Stuff')
    const chevron = uni.parentElement?.querySelector('.folder-node__chevron')
    if (!(chevron instanceof HTMLButtonElement)) throw new Error('test bug: no chevron')

    click(chevron)

    expect(folderNamed(harness.element, 'Thesis')).not.toBe(null)
  })

  it('orders the current folder by most recently changed', () => {
    const { harness } = renderBrowser({ currentFolderId: 'f1' })

    expect(itemNames(harness.element)).toEqual(['Thesis Draft', 'Portal password'])
  })

  it('counts the root items and lists them when Root is selected', () => {
    const { harness } = renderBrowser({ currentFolderId: null })

    expect(harness.element.querySelector('.folder-node--root .folder-node__count')?.textContent).toBe(
      '1',
    )
    expect(itemNames(harness.element)).toEqual(['Loose note'])
    expect(harness.element.querySelector('.folder-node--root')?.getAttribute('data-current')).toBe(
      'true',
    )
  })

  it('treats the store\'s own root sentinel as the root', () => {
    const { harness } = renderBrowser({ currentFolderId: 'root' })

    expect(harness.element.querySelector('.library-browser__folder-name')?.textContent).toContain(
      'Root',
    )
    expect(itemNames(harness.element)).toEqual(['Loose note'])
    expect(harness.element.querySelector('.folder-node--root')?.getAttribute('data-current')).toBe(
      'true',
    )
  })

  it('has an empty state for an empty folder and one for an empty library', () => {
    const { harness, update } = renderBrowser({ currentFolderId: 'f4' })
    expect(harness.element.querySelector('.library-browser__empty')?.textContent).toBe(
      'This folder is empty.',
    )

    update({ folders: [], items: [], currentFolderId: null })

    expect(harness.element.querySelector('.library-browser__empty')?.textContent).toContain(
      'Your library is empty',
    )
    // The one action that makes sense on an empty library is still there.
    expect(button(harness.element, '.library-browser__new-folder')).not.toBe(null)
  })

  it('shows the store loading flag instead of claiming the library is empty', () => {
    const { harness } = renderBrowser({ folders: [], items: [], loading: true })

    expect(harness.element.querySelector('.library-browser__loading')?.textContent).toBe(
      'Loading your library…',
    )
    expect(harness.element.querySelector('.library-browser__empty')).toBe(null)
  })

  it('surfaces the store error above the tree', () => {
    const { harness } = renderBrowser({ error: 'IndexedDB is unavailable' })

    expect(harness.element.querySelector('.library-browser__error')?.textContent).toBe(
      'IndexedDB is unavailable',
    )
  })

  it('selects a folder, and Root as null', () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    click(folderNamed(harness.element, 'Work'))
    expect(props.onSelectFolder).toHaveBeenLastCalledWith('f2')

    click(folderNamed(harness.element, 'Root'))
    expect(props.onSelectFolder).toHaveBeenLastCalledWith(null)
  })
})

describe('LibraryBrowser — new folder (PLAN.md §6.4)', () => {
  it('creates a folder inside the current folder', async () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f2' })

    click(button(harness.element, '.library-browser__new-folder'))

    expect(harness.element.querySelector('.library-modal__title')?.textContent).toBe(
      'New folder in Work',
    )

    typeInto(bySelector(harness.element, '.library-modal__input', HTMLInputElement), 'Archive')
    await submitForm(harness.element)

    expect(props.onCreateFolder).toHaveBeenCalledWith('Archive', 'f2')
    expect(harness.element.querySelector('.library-modal')).toBe(null)
  })

  it('creates a folder at the root when the root is open', async () => {
    const { harness, props } = renderBrowser({ currentFolderId: null })

    click(button(harness.element, '.library-browser__new-folder'))
    typeInto(bySelector(harness.element, '.library-modal__input', HTMLInputElement), 'Archive')
    await submitForm(harness.element)

    expect(props.onCreateFolder).toHaveBeenCalledWith('Archive', null)
  })
})

describe('LibraryBrowser — offline creation row (PLAN.md §6.1, §6.4)', () => {
  /** The five actions of `NewItemBar`, in the order PLAN.md §9's add bar uses. */
  const CREATE_LABELS = [
    'Add text item',
    'Add rich text item',
    'Add images',
    'Add files',
    'Add locked item',
  ] as const

  function createButton(element: HTMLElement, label: string): HTMLButtonElement {
    return bySelector(element, `button[aria-label="${label}"]`, HTMLButtonElement)
  }

  it('offers a save row beside + New Folder, and says it saves rather than sends', () => {
    const { harness } = renderBrowser({ currentFolderId: 'f2' })

    expect(harness.element.querySelector('.new-item-bar')).not.toBe(null)
    for (const label of CREATE_LABELS) {
      expect(createButton(harness.element, label)).toBeInstanceOf(HTMLButtonElement)
    }
    // It is the same visual language as the in-session bar…
    expect(harness.element.querySelector('.new-item-bar')?.className).toContain('add-item-bar')
    // …but the promise is different, and it is written down.
    expect(harness.element.querySelector('.add-item-bar__hint')?.textContent).toContain(
      'nothing is sent',
    )
  })

  it('is there on an empty library, because creating something is the point', () => {
    const { harness, update } = renderBrowser({ folders: [], items: [], currentFolderId: null })

    update({ folders: [], items: [] })

    expect(harness.element.querySelector('.library-browser__empty')?.textContent).toContain(
      'Your library is empty',
    )
    for (const label of CREATE_LABELS) {
      expect(createButton(harness.element, label)).toBeInstanceOf(HTMLButtonElement)
    }
  })

  it('leaves the row out while multi-selecting, so the only action is send', () => {
    const { harness } = renderBrowser({ currentFolderId: 'f1' })

    click(button(harness.element, '.library-browser__select'))

    expect(harness.element.querySelector('.new-item-bar')).toBe(null)
  })

  it('saves a text note into the folder on screen, as a §6.1 row with no session involved', async () => {
    const saved: LibraryItem[] = []
    const { harness } = renderBrowser({
      currentFolderId: 'f2',
      onSaveItem: (item) => {
        saved.push(item)
      },
    })

    click(createButton(harness.element, 'Add text item'))
    typeInto(bySelector(harness.element, 'input[aria-label="Name"]', HTMLInputElement), 'Standup')
    typeInto(
      bySelector(harness.element, 'input[aria-label="Text item"]', HTMLInputElement),
      'Blocked on the relay',
    )
    await submitForm(harness.element)

    expect(saved).toHaveLength(1)
    const [item] = saved
    expect(item?.type).toBe('text')
    expect(item?.name).toBe('Standup')
    // The folder the browser is showing, not the root and not a parent of it.
    expect(item?.folderId).toBe('f2')
    // §6.1: a uuid the browser minted, and both timestamps set.
    expect(item?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(typeof item?.createdAt).toBe('number')
    expect(typeof item?.updatedAt).toBe('number')
    // The dialog is gone once the save landed.
    expect(harness.element.querySelector('.library-modal')).toBe(null)
  })

  it('writes a nested folder with its own id, and the root for a current id that names no folder', async () => {
    const saved: LibraryItem[] = []
    const { harness, update } = renderBrowser({
      currentFolderId: 'f3',
      onSaveItem: (item) => {
        saved.push(item)
      },
    })

    const composeNote = async (): Promise<void> => {
      click(createButton(harness.element, 'Add text item'))
      typeInto(bySelector(harness.element, 'input[aria-label="Name"]', HTMLInputElement), 'Note')
      await submitForm(harness.element)
    }

    await composeNote()
    expect(saved[0]?.folderId).toBe('f3')

    // A folder deleted while it was open: the list is the root, so the write goes there
    // rather than to a folder id that has no row (the library layer would refuse it).
    update({ currentFolderId: 'gone' })
    await composeNote()
    expect(saved[1]?.folderId).toBe('root')
  })
})

describe('LibraryBrowser — the row reaches IndexedDB through the store (PLAN.md §6.3)', () => {
  /** Home's shape and nothing else: the browser reads the library out of the store. */
  function StoreBackedBrowser(props: { currentFolderId: string | null }) {
    const storeFolders = useLibraryStore((state) => state.folders)
    const storeItems = useLibraryStore((state) => state.items)

    return (
      <LibraryBrowser
        folders={storeFolders}
        items={storeItems}
        currentFolderId={props.currentFolderId}
        onSelectFolder={() => {}}
        onCreateFolder={() => {}}
        onRenameFolder={() => {}}
        onDeleteFolder={() => {}}
        onRenameItem={() => {}}
        onMoveItem={() => {}}
        onDeleteItem={() => {}}
        onSendItems={() => {}}
      />
    )
  }

  /** Waits for a store write to come back around as a rendered row (no refresh call). */
  async function waitForRows(element: HTMLElement, expected: string[]): Promise<void> {
    const deadline = Date.now() + 20_000
    for (;;) {
      const names = itemNames(element).map((name) => name ?? '')
      if (names.join('\u0000') === expected.join('\u0000')) return
      if (Date.now() > deadline) {
        throw new Error(`test bug: rows stayed [${names.join(', ')}], wanted [${expected.join(', ')}]`)
      }
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10)
        })
      })
    }
  }

  beforeEach(async () => {
    useLibraryStore.setState({ folders: [], items: [], loading: false, error: null })
    await emptyLibraryDatabase()
  })

  afterEach(async () => {
    await closeLibraryDatabase()
  })

  it('lists a note the row created, with nobody calling refresh', async () => {
    const folder = await useLibraryStore.getState().createFolder('Kept', null)
    await useLibraryStore.getState().refresh()

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => {
      root.render(<StoreBackedBrowser currentFolderId={folder.id} />)
    })
    openHarnesses.push({
      element: host,
      unmount: () => {
        act(() => {
          root.unmount()
        })
      },
    })

    expect(itemNames(host)).toEqual([])

    click(bySelector(host, 'button[aria-label="Add text item"]', HTMLButtonElement))
    typeInto(bySelector(host, 'input[aria-label="Name"]', HTMLInputElement), 'Written offline')
    await submitForm(host)

    // The list grew by itself: `saveItem` re-reads IndexedDB and the view follows.
    await waitForRows(host, ['Written offline'])

    const stored = await getItemsInFolder(folder.id)
    expect(stored.map((row) => row.name)).toEqual(['Written offline'])
    expect(stored[0]?.type).toBe('text')
    // Nothing leaked to the root, and the store has no error to show.
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(0)
    expect(useLibraryStore.getState().error).toBe(null)
  })
})

describe('LibraryBrowser — multi-select (PLAN.md §6.4, §7)', () => {
  it('enters selection mode on a long press and sends the selected ids', () => {
    vi.useFakeTimers()
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    longPress(harness.element)

    expect(harness.element.querySelectorAll('.library-item__checkbox')).toHaveLength(2)
    expect(button(harness.element, '.library-browser__send-selected').textContent).toBe(
      'Send selected (1)',
    )

    // A plain tap now toggles selection instead of previewing.
    click(button(harness.element, '.library-item:nth-child(2) .library-item__name'))
    expect(button(harness.element, '.library-browser__send-selected').textContent).toBe(
      'Send selected (2)',
    )

    click(button(harness.element, '.library-browser__send-selected'))

    expect(props.onSendItems).toHaveBeenCalledWith(['i2', 'i1'])
    // Sending ends the selection; the header is back to its normal actions.
    expect(harness.element.querySelector('.library-item__checkbox')).toBe(null)
    expect(button(harness.element, '.library-browser__select').textContent).toBe('Select')
  })

  it('offers the checkbox route in as the fallback for a device without long press', () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    click(button(harness.element, '.library-browser__select'))

    expect(button(harness.element, '.library-browser__send-selected').disabled).toBe(true)

    const checkboxes = [...harness.element.querySelectorAll<HTMLInputElement>('.library-item__checkbox')]
    const first = checkboxes[0]
    const second = checkboxes[1]
    if (first === undefined || second === undefined) throw new Error('test bug: missing checkboxes')

    click(first)
    expect(button(harness.element, '.library-browser__send-selected').textContent).toBe(
      'Send selected (1)',
    )

    click(second)
    click(button(harness.element, '.library-browser__send-selected'))

    expect(props.onSendItems).toHaveBeenCalledWith(['i2', 'i1'])
  })

  it('leaves selection mode on Escape', () => {
    const { harness } = renderBrowser({ currentFolderId: 'f1' })

    click(button(harness.element, '.library-browser__select'))
    expect(harness.element.querySelector('.library-item__checkbox')).not.toBe(null)

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(harness.element.querySelector('.library-item__checkbox')).toBe(null)
    expect(harness.element.querySelector('.library-browser__send-selected')).toBe(null)
  })

  it('leaves selection mode when a row menu is opened', () => {
    const { harness } = renderBrowser({ currentFolderId: 'f1' })

    click(button(harness.element, '.library-browser__select'))
    click(button(harness.element, '.library-item__menu-toggle'))

    expect(harness.element.querySelector('.library-item__menu')).not.toBe(null)
    expect(harness.element.querySelector('.library-item__checkbox')).toBe(null)
  })

  it('cancels the selection without sending', () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    click(button(harness.element, '.library-browser__select'))
    click(bySelector(harness.element, '.library-item__checkbox', HTMLInputElement))
    click(button(harness.element, '.library-browser__selection-cancel'))

    expect(props.onSendItems).not.toHaveBeenCalled()
    expect(harness.element.querySelector('.library-item__checkbox')).toBe(null)
  })

  it('reports every selection change upward, including the clear (PLAN.md §7 Flow A)', () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    // Nothing is selected to begin with, so the page starts from a known empty selection.
    expect(props.onSelectionChange).toHaveBeenLastCalledWith([])

    click(button(harness.element, '.library-browser__select'))
    const checkboxes = [
      ...harness.element.querySelectorAll<HTMLInputElement>('.library-item__checkbox'),
    ]
    const first = checkboxes[0]
    if (first === undefined) throw new Error('test bug: missing checkbox')
    click(first)

    // Most recently updated first, so the first row is i2.
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(['i2'])

    // Cancelling clears it, and the page has to hear about that or its own "Scan & Send"
    // would queue an item the user just deselected.
    click(button(harness.element, '.library-browser__selection-cancel'))
    expect(props.onSelectionChange).toHaveBeenLastCalledWith([])
  })
})

describe('LibraryBrowser — item actions reach the store (PLAN.md §6.4)', () => {
  it('sends one item straight from its menu, without selection mode', () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    click(button(harness.element, '.library-item__menu-toggle'))
    click(menuItem(harness.element, 'Send'))

    expect(props.onSendItems).toHaveBeenCalledWith(['i2'])
  })

  it('wires rename and delete through to its own props, past the confirmation', async () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    click(button(harness.element, '.library-item__menu-toggle'))
    click(menuItem(harness.element, 'Rename'))
    typeInto(bySelector(harness.element, '.library-item__rename-input', HTMLInputElement), 'Renamed')
    await submitForm(harness.element)

    expect(props.onRenameItem).toHaveBeenCalledWith('i2', 'Renamed')

    click(button(harness.element, '.library-item__menu-toggle'))
    click(menuItem(harness.element, 'Delete'))

    // The row menu's Delete asks; it is the confirmation that answers it.
    expect(props.onDeleteItem).not.toHaveBeenCalled()
    click(button(harness.element, '.confirm-delete__confirm'))

    expect(props.onDeleteItem).toHaveBeenCalledWith('i2')
  })

  it('wires the folder rename and delete through to its own props, past the confirmation', async () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    const work = folderNamed(harness.element, 'Work')
    const row = work.parentElement
    const menuToggle = row?.querySelector('.folder-node__menu-toggle')
    if (!(menuToggle instanceof HTMLButtonElement)) throw new Error('test bug: no folder menu')

    click(menuToggle)
    click(menuItem(harness.element, 'Rename'))
    typeInto(bySelector(harness.element, '.folder-node__rename-input', HTMLInputElement), 'Job')
    await submitForm(harness.element)

    expect(props.onRenameFolder).toHaveBeenCalledWith('f2', 'Job')

    click(menuToggle)
    click(menuItem(harness.element, 'Delete folder and contents'))

    expect(props.onDeleteFolder).not.toHaveBeenCalled()
    click(button(harness.element, '.confirm-delete__confirm'))

    expect(props.onDeleteFolder).toHaveBeenCalledWith('f2')
  })
})

describe('LibraryBrowser — folder delete cascade (PLAN.md §6.3, §6.4)', () => {
  /**
   * A tree three levels deep under Uni Stuff, so the count has to recurse rather than
   * look at the folder's own rows:
   *
   *   Uni Stuff (f1)  i1, i2
   *     Thesis (f3)   i5
   *       Drafts (f5) i6
   */
  const deepFolders = [
    ...folders,
    { id: 'f5', name: 'Drafts', parentId: 'f3', createdAt: 1, updatedAt: 1 },
  ]
  const deepItems: LibraryItem[] = [
    ...items,
    { ...BASE, id: 'i5', folderId: 'f3', name: 'Chapter one', content: 'ch', updatedAt: 50 },
    { ...BASE, id: 'i6', folderId: 'f5', name: 'Cold scan', content: 'scan', updatedAt: 50 },
  ]

  it('counts the whole doomed subtree, folders and items alike, in the warning', () => {
    const { harness } = renderBrowser({
      folders: deepFolders,
      items: deepItems,
      currentFolderId: 'f1',
    })

    askToDeleteFolder(harness.element, 'Uni Stuff')

    const { title, message } = dialogText(harness.element)
    expect(title).toBe('Delete “Uni Stuff”?')
    expect(message).toContain('3 folders')
    expect(message).toContain('4 items')
    // Only the doomed tree is counted: Work's item and the root's note stay out of it.
    expect(message).not.toContain('SSH Keys')
    expect(message).not.toContain('Loose note')
    expect(message).toContain('cannot be undone')
  })

  it('says so when the folder is empty, rather than implying a cascade that is not there', () => {
    const { harness } = renderBrowser({ folders: deepFolders, items: deepItems })

    askToDeleteFolder(harness.element, 'Empty')

    expect(dialogText(harness.element).message).toContain('1 folder and no items')
  })

  it('re-reads the counts if the library changes while the question is open', () => {
    const { harness, update } = renderBrowser({
      folders: deepFolders,
      items: deepItems,
      currentFolderId: 'f1',
    })

    askToDeleteFolder(harness.element, 'Uni Stuff')
    expect(dialogText(harness.element).message).toContain('3 folders')

    // Drafts goes away elsewhere in the app; the warning must not keep quoting it.
    update({ folders: deepFolders.filter((folder) => folder.id !== 'f5') })

    const { message } = dialogText(harness.element)
    expect(message).toContain('2 folders')
    expect(message).toContain('3 items')
  })

  it('deletes nothing until the confirmation is answered, and then exactly the folder', () => {
    const { harness, props } = renderBrowser({
      folders: deepFolders,
      items: deepItems,
      currentFolderId: 'f1',
    })

    askToDeleteFolder(harness.element, 'Uni Stuff')

    expect(props.onDeleteFolder).not.toHaveBeenCalled()
    expect(props.onDeleteItem).not.toHaveBeenCalled()
    // The library on screen is untouched while the dialog is up.
    expect(itemNames(harness.element)).toEqual(['Thesis Draft', 'Portal password'])

    click(button(harness.element, '.confirm-delete__confirm'))

    // One call, one id — the same call the menu used to make on its own.
    expect(props.onDeleteFolder).toHaveBeenCalledTimes(1)
    expect(props.onDeleteFolder).toHaveBeenCalledWith('f1')
    expect(props.onDeleteItem).not.toHaveBeenCalled()
    expect(confirmDialog(harness.element)).toBe(null)
  })

  it('leaves the folder alone when the user cancels', () => {
    const { harness, props } = renderBrowser({
      folders: deepFolders,
      items: deepItems,
      currentFolderId: 'f1',
    })

    askToDeleteFolder(harness.element, 'Uni Stuff')
    click(button(harness.element, '.confirm-delete__cancel'))

    expect(props.onDeleteFolder).not.toHaveBeenCalled()
    expect(props.onDeleteItem).not.toHaveBeenCalled()
    expect(confirmDialog(harness.element)).toBe(null)
    // The tree is still there to act on afterwards.
    expect(folderNamed(harness.element, 'Uni Stuff')).not.toBe(null)
  })

  it('treats Escape as a cancel', () => {
    const { harness, props } = renderBrowser({
      folders: deepFolders,
      items: deepItems,
      currentFolderId: 'f1',
    })

    askToDeleteFolder(harness.element, 'Uni Stuff')
    pressEscape()

    expect(props.onDeleteFolder).not.toHaveBeenCalled()
    expect(confirmDialog(harness.element)).toBe(null)
  })

  it('never asks twice, and never answers for the user with a second request', () => {
    const { harness, props } = renderBrowser({
      folders: deepFolders,
      items: deepItems,
      currentFolderId: 'f1',
    })

    askToDeleteFolder(harness.element, 'Uni Stuff')
    // A different folder asked about while one is open replaces the question.
    askToDeleteFolder(harness.element, 'Work')

    expect(harness.element.querySelectorAll('.confirm-delete')).toHaveLength(1)
    expect(dialogText(harness.element).title).toBe('Delete “Work”?')

    click(button(harness.element, '.confirm-delete__confirm'))

    expect(props.onDeleteFolder).toHaveBeenCalledTimes(1)
    expect(props.onDeleteFolder).toHaveBeenCalledWith('f2')
  })
})

describe('LibraryBrowser — item delete confirmation', () => {
  it('asks for the item by name', () => {
    const { harness } = renderBrowser({ currentFolderId: 'f1' })

    askToDeleteFirstItem(harness.element)

    const { title, message } = dialogText(harness.element)
    // Rows are most recently changed first, so the first row is Thesis Draft (i2).
    expect(title).toBe('Delete “Thesis Draft”?')
    expect(message).toContain('“Thesis Draft”')
    expect(message).toContain('cannot be undone')
    // An item takes nothing with it, so no counts appear.
    expect(message).not.toMatch(/\d+ folders?/)
  })

  it('deletes nothing until the confirmation is answered, then exactly that item', () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    askToDeleteFirstItem(harness.element)
    expect(props.onDeleteItem).not.toHaveBeenCalled()

    click(button(harness.element, '.confirm-delete__confirm'))

    expect(props.onDeleteItem).toHaveBeenCalledTimes(1)
    expect(props.onDeleteItem).toHaveBeenCalledWith('i2')
    expect(props.onDeleteFolder).not.toHaveBeenCalled()
    expect(confirmDialog(harness.element)).toBe(null)
  })

  it('cancels on Escape and on Cancel', () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    askToDeleteFirstItem(harness.element)
    pressEscape()
    expect(props.onDeleteItem).not.toHaveBeenCalled()

    askToDeleteFirstItem(harness.element)
    click(button(harness.element, '.confirm-delete__cancel'))

    expect(props.onDeleteItem).not.toHaveBeenCalled()
    expect(confirmDialog(harness.element)).toBe(null)
  })

  it('drops the question if the item disappears while it is open', () => {
    const { harness, update } = renderBrowser({ currentFolderId: 'f1' })

    askToDeleteFirstItem(harness.element)
    expect(confirmDialog(harness.element)).not.toBe(null)

    update({ items: items.filter((item) => item.id !== 'i2') })

    // No dialog quoting an item that is already gone, and no deletion asked for.
    expect(confirmDialog(harness.element)).toBe(null)
  })
})

describe('LibraryBrowser — the gate is a dialog, not a browser prompt', () => {
  it('uses no window.confirm and keeps focus inside the dialog while it asks', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })
    askToDeleteFolder(harness.element, 'Uni Stuff')

    // window.confirm is blocked in a cross-origin iframe: a gate built on it would have
    // deleted the subtree without ever showing a question.
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
    expect(props.onDeleteFolder).not.toHaveBeenCalled()

    const focused = document.activeElement
    const dialog = confirmDialog(harness.element)
    if (dialog === null || !(focused instanceof HTMLElement)) throw new Error('test bug: no dialog')
    expect(dialog.contains(focused)).toBe(true)
  })

  it('does not strand focus on the menu entry that opened the question', () => {
    const { harness } = renderBrowser({ currentFolderId: 'f1' })

    askToDeleteFolder(harness.element, 'Uni Stuff')
    click(button(harness.element, '.confirm-delete__cancel'))

    // The folder's own menu closes on the way into the dialog, so the trigger that opened
    // it is gone and ConfirmDelete skips the hand-back. What must not happen is focus
    // staying inside a node that is no longer in the document.
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) throw new Error('test bug: nothing focused')
    expect(focused.isConnected).toBe(true)
    expect(confirmDialog(harness.element)).toBe(null)
  })

  it('leaves multi-select reporting alone while a delete is pending (PLAN.md §7 Flow A)', () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    askToDeleteFolder(harness.element, 'Uni Stuff')
    pressEscape()

    expect(props.onSelectionChange).toHaveBeenLastCalledWith([])
    expect(props.onDeleteFolder).not.toHaveBeenCalled()
  })
})

describe('folderDeleteImpact / describeDelete', () => {
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

  it('counts every depth and leaves the rest of the library out', () => {
    expect(folderDeleteImpact(nested, nestedItems, 'a')).toEqual({ folders: 3, items: 2 })
    expect(folderDeleteImpact(nested, nestedItems, 'b')).toEqual({ folders: 2, items: 1 })
    expect(folderDeleteImpact(nested, nestedItems, 'c')).toEqual({ folders: 1, items: 1 })
    expect(folderDeleteImpact(nested, nestedItems, 'd')).toEqual({ folders: 1, items: 1 })
  })

  it('survives a malformed parent cycle instead of counting forever', () => {
    // Two rows that name each other as parent: stored data can only get here by
    // corruption, but a warning that hangs the page is worse than one that is wrong.
    const cyclic = [
      { id: 'x', name: 'X', parentId: 'y', createdAt: 1, updatedAt: 1 },
      { id: 'y', name: 'Y', parentId: 'x', createdAt: 1, updatedAt: 1 },
    ]

    expect(folderDeleteImpact(cyclic, [], 'x')).toEqual({ folders: 2, items: 0 })
  })

  it('names the item for an item prompt and the numbers for a folder prompt', () => {
    const item: PendingDelete = { kind: 'item', id: 'i2' }
    const folder: PendingDelete = { kind: 'folder', id: 'a' }

    const itemPrompt = describeDelete(item, nested, nestedItems)
    expect(itemPrompt?.title).toBe('Delete “Deep note”?')
    expect(itemPrompt?.message).toContain('“Deep note”')
    expect(itemPrompt?.confirmLabel).toContain('permanently')

    const folderPrompt = describeDelete(folder, nested, nestedItems)
    expect(folderPrompt?.message).toContain('3 folders')
    expect(folderPrompt?.message).toContain('2 items')
    expect(folderPrompt?.confirmLabel).toContain('Delete folder and contents')
  })

  it('has nothing to say about a target that is no longer there', () => {
    const request: PendingDelete = { kind: 'folder', id: 'gone' }

    expect(describeDelete(request, nested, nestedItems)).toBe(null)
    expect(describeDelete({ kind: 'item', id: 'gone' }, nested, nestedItems)).toBe(null)
  })
})

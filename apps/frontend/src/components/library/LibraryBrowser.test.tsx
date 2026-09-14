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
 * "Send selected (N)" reporting the selected ids).
 */

import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LibraryBrowser, itemsInFolder } from './LibraryBrowser'
import type { LibraryBrowserProps } from './LibraryBrowser'
import type { LibraryFolder } from './FolderNode'
import type { LibraryItem } from './LibraryItemRow'

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

  it('wires rename and delete through to its own props', async () => {
    const { harness, props } = renderBrowser({ currentFolderId: 'f1' })

    click(button(harness.element, '.library-item__menu-toggle'))
    click(menuItem(harness.element, 'Rename'))
    typeInto(bySelector(harness.element, '.library-item__rename-input', HTMLInputElement), 'Renamed')
    await submitForm(harness.element)

    expect(props.onRenameItem).toHaveBeenCalledWith('i2', 'Renamed')

    click(button(harness.element, '.library-item__menu-toggle'))
    click(menuItem(harness.element, 'Delete'))

    expect(props.onDeleteItem).toHaveBeenCalledWith('i2')
  })

  it('wires the folder rename and delete through to its own props', async () => {
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

    expect(props.onDeleteFolder).toHaveBeenCalledWith('f2')
  })
})

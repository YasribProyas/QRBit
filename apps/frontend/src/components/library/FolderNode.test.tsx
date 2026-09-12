/** @vitest-environment jsdom */
/**
 * Folder tree node tests (PLAN.md §6.4, §16 Phase 5).
 *
 * The node renders one row of the tree and owns exactly two presentation details:
 * whether it is expanded, and whether its menu or inline rename is open. Everything
 * else leaves through a callback, which is what these tests check.
 *
 * `FolderPicker` (the same file) gets its own block: it is the folder domain's other
 * rendering of the tree, shared by the item row's Move picker and the save dialog.
 */

import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FolderNode, FolderPicker, childFolders } from './FolderNode'
import type { LibraryFolder } from './FolderNode'
import type { LibraryItem, LibraryTextItem } from './LibraryItemRow'

function folder(overrides: Partial<LibraryFolder> = {}): LibraryFolder {
  return {
    id: 'f1',
    name: 'Uni Stuff',
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function textItem(overrides: Partial<LibraryTextItem> = {}): LibraryTextItem {
  return {
    id: 'i1',
    folderId: 'f1',
    name: 'Note',
    type: 'text',
    createdAt: 1,
    updatedAt: 1,
    content: 'hello',
    ...overrides,
  }
}

interface Harness {
  element: HTMLDivElement
  rerender: () => void
  unmount: () => void
}

const openHarnesses: Harness[] = []

function mount(render: () => ReactElement): Harness {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  act(() => {
    root.render(render())
  })

  const harness: Harness = {
    element: host,
    rerender: () => {
      act(() => {
        root.render(render())
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      host.remove()
    },
  }

  openHarnesses.push(harness)
  return harness
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

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

function submitForm(element: HTMLElement): void {
  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

/** The menu items are buttons inside the row's menu; addressed by their label. */
function menuItem(element: HTMLElement, label: string): HTMLButtonElement {
  for (const item of element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
    if (item.textContent === label) return item
  }
  throw new Error(`test bug: no menu item labelled ${label}`)
}

const menuCallbacks = {
  onSelectFolder: vi.fn(),
  onRenameFolder: vi.fn(),
  onDeleteFolder: vi.fn(),
}

const noItems: LibraryItem[] = []

function renderNode(props: {
  folder?: LibraryFolder
  folders?: LibraryFolder[]
  items?: LibraryItem[]
  currentFolderId?: string | null
}): Harness {
  const folderToRender = props.folder ?? folder()
  const folders = props.folders ?? [folderToRender]
  const items = props.items ?? noItems
  const currentFolderId = props.currentFolderId ?? null

  return mount(() =>
    createElement(
      'ul',
      null,
      createElement(FolderNode, {
        folder: folderToRender,
        folders,
        items,
        currentFolderId,
        onSelectFolder: menuCallbacks.onSelectFolder,
        onRenameFolder: menuCallbacks.onRenameFolder,
        onDeleteFolder: menuCallbacks.onDeleteFolder,
      }),
    ),
  )
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
})

afterEach(() => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  document.body.innerHTML = ''
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('childFolders', () => {
  it('returns the direct children in name order, whatever order the store used', () => {
    const folders = [
      folder({ id: 'z', name: 'zeta' }),
      folder({ id: 'a', name: 'Alpha' }),
      folder({ id: 'child', name: 'Nested', parentId: 'a' }),
    ]

    expect(childFolders(folders, null).map((entry) => entry.id)).toEqual(['a', 'z'])
    expect(childFolders(folders, 'a').map((entry) => entry.id)).toEqual(['child'])
  })
})

describe('FolderNode', () => {
  it('shows the folder name and a badge counting the items directly inside', () => {
    const { element } = renderNode({
      items: [
        textItem({ id: 'i1', folderId: 'f1' }),
        textItem({ id: 'i2', folderId: 'f1' }),
        textItem({ id: 'i3', folderId: 'elsewhere' }),
      ],
    })

    expect(element.querySelector('.folder-node__name')?.textContent).toContain('Uni Stuff')
    expect(element.querySelector('.folder-node__count')?.textContent).toBe('2')
  })

  it('renders its children only while expanded', () => {
    const parent = folder({ id: 'f1', name: 'Uni Stuff' })
    const child = folder({ id: 'f2', name: 'Thesis', parentId: 'f1' })
    const { element } = renderNode({ folder: parent, folders: [parent, child] })

    expect(button(element, '.folder-node__chevron').getAttribute('aria-expanded')).toBe('false')
    expect(element.querySelector('.folder-node__children')).toBe(null)

    click(button(element, '.folder-node__chevron'))

    const children = bySelector(element, '.folder-node__children', HTMLUListElement)
    expect(children.querySelector('.folder-node__name')?.textContent).toContain('Thesis')
    expect(button(element, '.folder-node__chevron').getAttribute('aria-expanded')).toBe('true')

    click(button(element, '.folder-node__chevron'))
    expect(element.querySelector('.folder-node__children')).toBe(null)
  })

  it('selects the folder when its name is tapped, opening it so the tree is not blank', () => {
    const parent = folder({ id: 'f1' })
    const child = folder({ id: 'f2', name: 'Thesis', parentId: 'f1' })
    const { element } = renderNode({ folder: parent, folders: [parent, child], currentFolderId: 'f1' })

    expect(button(element, '.folder-node__name').getAttribute('aria-current')).toBe('true')

    click(button(element, '.folder-node__name'))

    expect(menuCallbacks.onSelectFolder).toHaveBeenCalledWith('f1')
    expect(element.querySelector('.folder-node__children')).not.toBe(null)
  })

  it('renames inline from the menu and reports the trimmed name', () => {
    const { element } = renderNode({})

    click(button(element, '.folder-node__menu-toggle'))
    click(menuItem(element, 'Rename'))

    const input = bySelector(element, '.folder-node__rename-input', HTMLInputElement)
    expect(input.value).toBe('Uni Stuff')

    typeInto(input, '  Study stuff  ')
    submitForm(element)

    expect(menuCallbacks.onRenameFolder).toHaveBeenCalledWith('f1', 'Study stuff')
    expect(element.querySelector('.folder-node__rename-input')).toBe(null)
  })

  it('refuses a blank rename and stays in the field', () => {
    const { element } = renderNode({})

    click(button(element, '.folder-node__menu-toggle'))
    click(menuItem(element, 'Rename'))

    const input = bySelector(element, '.folder-node__rename-input', HTMLInputElement)
    typeInto(input, '   ')

    expect(button(element, '.folder-node__rename-save').disabled).toBe(true)
    submitForm(element)

    expect(menuCallbacks.onRenameFolder).not.toHaveBeenCalled()
    expect(element.querySelector('.folder-node__rename-input')).not.toBe(null)
  })

  it('cancels a rename with Escape', () => {
    const { element } = renderNode({})

    click(button(element, '.folder-node__menu-toggle'))
    click(menuItem(element, 'Rename'))

    const input = bySelector(element, '.folder-node__rename-input', HTMLInputElement)
    typeInto(input, 'Nope')

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(element.querySelector('.folder-node__rename-input')).toBe(null)
    expect(menuCallbacks.onRenameFolder).not.toHaveBeenCalled()
  })

  it('deletes from the menu', () => {
    const { element } = renderNode({})

    click(button(element, '.folder-node__menu-toggle'))
    expect(element.querySelector('.folder-node__menu')).not.toBe(null)

    click(menuItem(element, 'Delete folder and contents'))

    expect(menuCallbacks.onDeleteFolder).toHaveBeenCalledWith('f1')
  })
})

describe('FolderPicker', () => {
  function renderPicker(
    value: string | null,
    onChange: (folderId: string | null) => void,
    folders: LibraryFolder[],
  ): Harness {
    return mount(() => createElement(FolderPicker, { folders, value, onChange, label: 'Move to folder' }))
  }

  it('offers Root plus the tree and marks the current choice', () => {
    const folders = [
      folder({ id: 'f1', name: 'Uni Stuff' }),
      folder({ id: 'f2', name: 'Thesis', parentId: 'f1' }),
    ]
    const { element } = renderPicker('f2', vi.fn(), folders)

    const options = [...element.querySelectorAll('.folder-picker__option')]
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      '📁 Root',
      '📁 Uni Stuff',
      '📁 Thesis',
    ])
    expect(options[2]?.getAttribute('aria-checked')).toBe('true')
    // The nested list is what carries the depth, not a computed indent.
    expect(element.querySelector('.folder-picker__list .folder-picker__list')).not.toBe(null)
  })

  it('reports the picked folder, and Root as null', () => {
    const folders = [folder({ id: 'f1', name: 'Uni Stuff' })]
    const onChange = vi.fn()
    const { element } = renderPicker(null, onChange, folders)

    const options = [...element.querySelectorAll<HTMLButtonElement>('.folder-picker__option')]
    const root = options[0]
    const uni = options[1]
    if (root === undefined || uni === undefined) throw new Error('test bug: missing options')

    click(uni)
    expect(onChange).toHaveBeenLastCalledWith('f1')

    click(root)
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('reads a value that names no folder as Root, the rule itemsInFolder states', () => {
    const folders = [folder({ id: 'f1', name: 'Uni Stuff' })]
    // 'root' is the library layer's sentinel for the root (lib/library.ts's
    // ROOT_FOLDER_ID), and it matches no folder row — an item in the root carries it.
    const { element } = renderPicker('root', vi.fn(), folders)

    const options = [...element.querySelectorAll('.folder-picker__option')]
    expect(options[0]?.getAttribute('aria-checked')).toBe('true')
    expect(options[1]?.getAttribute('aria-checked')).toBe('false')
  })
})

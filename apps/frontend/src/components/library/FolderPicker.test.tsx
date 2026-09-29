/** @vitest-environment jsdom */
/**
 * Folder tree picker tests (PLAN.md §6.4).
 *
 * These moved with `FolderPicker` when the `FolderNode` tree row around it was deleted —
 * nothing rendered the row any more, but the picker is what `AddItemBar.tsx`,
 * `SaveToLibraryModal.tsx` and the dossier row use to answer "which folder?".
 *
 * What is pinned is the choice, not the paint: the tree is offered with Root first, depth is
 * carried by nested lists rather than a computed indent, the chosen row is the one that reads
 * as chosen, and an id that names no folder means Root — the same rule `itemsInFolder`
 * states, because a root item's own `folderId` is the library layer's sentinel.
 *
 * `childFolders`, the ordering the picker depends on, is pinned in `lib/folders.test.ts`.
 */

import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FolderPicker } from './FolderPicker'
import type { LibraryFolder } from '../../lib/library'

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

interface Harness {
  element: HTMLDivElement
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

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function renderPicker(
  value: string | null,
  onChange: (folderId: string | null) => void,
  folders: LibraryFolder[],
): Harness {
  return mount(() =>
    createElement(FolderPicker, { folders, value, onChange, label: 'Move to folder' }),
  )
}

/** The rows of the picker, in the order they are on screen. */
function optionsOf(element: HTMLElement): HTMLButtonElement[] {
  return [...element.querySelectorAll<HTMLButtonElement>('.folder-picker__option')]
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})

afterEach(() => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  document.body.innerHTML = ''
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('FolderPicker', () => {
  it('is a radiogroup named by the question it answers', () => {
    const { element } = renderPicker(null, vi.fn(), [folder()])

    const group = element.querySelector('[role="radiogroup"]')
    expect(group?.getAttribute('aria-label')).toBe('Move to folder')
  })

  it('offers Root plus the tree and marks the current choice', () => {
    const folders = [
      folder({ id: 'f1', name: 'Uni Stuff' }),
      folder({ id: 'f2', name: 'Thesis', parentId: 'f1' }),
    ]
    const { element } = renderPicker('f2', vi.fn(), folders)

    const options = optionsOf(element)
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      'Root',
      'Uni Stuff',
      'Thesis',
    ])
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ])
    // The nested list is what carries the depth, not a computed indent.
    expect(element.querySelector('.folder-picker__list .folder-picker__list')).not.toBe(null)
  })

  it('reports the picked folder, and Root as null', () => {
    const folders = [folder({ id: 'f1', name: 'Uni Stuff' })]
    const onChange = vi.fn()
    const { element } = renderPicker(null, onChange, folders)

    const options = optionsOf(element)
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

    const options = optionsOf(element)
    expect(options[0]?.getAttribute('aria-checked')).toBe('true')
    expect(options[1]?.getAttribute('aria-checked')).toBe('false')
  })

  it('marks a selection with the selected fill and the 2px signal inset, not a coloured border', () => {
    const folders = [folder({ id: 'f1', name: 'Uni Stuff' })]
    const { element } = renderPicker('f1', vi.fn(), folders)

    const selected = optionsOf(element)[1]
    if (selected === undefined) throw new Error('test bug: no selected row')

    // DESIGN.md allows exactly one coloured edge, and it means selection. It is a box-shadow
    // inset so the row's box does not move, and no border colour is written here at all.
    expect(selected.style.backgroundColor).toBe('var(--qrbit-selected)')
    expect(selected.style.boxShadow).toContain('inset 2px 0 0 var(--qrbit-signal)')
    expect(selected.style.borderTopColor).toBe('')
  })
})

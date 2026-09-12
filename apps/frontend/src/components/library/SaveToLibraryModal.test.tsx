/** @vitest-environment jsdom */
/**
 * Save-to-library dialog tests (PLAN.md §8 Phase 4's "Save to Library →", §16 Phase 5).
 *
 * The dialog is presentational: it reports `(itemId, folderId)` per item and a
 * folder for "save all", and the page does the saving. These tests pin the folder
 * picker (Root as `null`, the tree below it), both save shapes, the two states a row
 * cannot be saved from (unfinished transfer, already saved), and the rejection path —
 * a save that failed must not look like a save that worked.
 */

import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SaveToLibraryModal } from './SaveToLibraryModal'
import type { SaveToLibraryModalProps, SaveableSessionItem } from './SaveToLibraryModal'
import type { LibraryFolder } from './FolderNode'

const folders: LibraryFolder[] = [
  { id: 'f1', name: 'Uni Stuff', parentId: null, createdAt: 1, updatedAt: 1 },
  { id: 'f2', name: 'Work', parentId: 'f1', createdAt: 1, updatedAt: 1 },
]

const sessionItems: SaveableSessionItem[] = [
  { id: 's1', name: 'Text note', type: 'text', complete: true },
  { id: 's2', name: 'holiday.png', type: 'image', complete: true },
  { id: 's3', name: 'Server root key', type: 'locked', complete: true },
  { id: 's4', name: 'half-sent.pdf', type: 'file', complete: false },
]

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function mount(element: ReactElement): Harness {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  act(() => {
    root.render(element)
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

function renderModal(overrides: Partial<SaveToLibraryModalProps> = {}): Harness {
  return mount(
    createElement(SaveToLibraryModal, {
      items: sessionItems,
      folders,
      onSaveItem: vi.fn(),
      onSaveAll: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    }),
  )
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
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function itemRow(element: HTMLElement, name: string): HTMLElement {
  for (const row of element.querySelectorAll<HTMLElement>('.library-modal__item')) {
    if (row.querySelector('.library-modal__item-name')?.textContent === name) return row
  }
  throw new Error(`test bug: no row for ${name}`)
}

function saveButton(element: HTMLElement, name: string): HTMLButtonElement {
  return button(itemRow(element, name), '.library-modal__save')
}

function pickFolder(element: HTMLElement, name: string): void {
  for (const option of element.querySelectorAll<HTMLButtonElement>('.folder-picker__option')) {
    if (option.textContent?.includes(name) === true) {
      click(option)
      return
    }
  }
  throw new Error(`test bug: no folder option ${name}`)
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

describe('SaveToLibraryModal', () => {
  it('lists the items with their type icons and starts on Root', () => {
    const harness = renderModal()

    const names = [...harness.element.querySelectorAll('.library-modal__item-name')].map(
      (node) => node.textContent,
    )
    expect(names).toEqual(['Text note', 'holiday.png', 'Server root key', 'half-sent.pdf'])

    const icons = [...harness.element.querySelectorAll('.library-modal__item .library-item__icon')].map(
      (node) => node.textContent,
    )
    expect(icons).toEqual(['¶', '🖼', '🔒', '📎'])

    const rootOption = harness.element.querySelector('.folder-picker__option')
    expect(rootOption?.getAttribute('aria-checked')).toBe('true')
    expect(button(harness.element, '.library-modal__save-all').textContent).toBe('Save all (3)')
  })

  it('saves one item into the picked folder', async () => {
    const onSaveItem = vi.fn()
    const harness = renderModal({ onSaveItem })

    pickFolder(harness.element, 'Work')

    await act(async () => {
      click(saveButton(harness.element, 'Server root key'))
    })

    expect(onSaveItem).toHaveBeenCalledWith('s3', 'f2')
  })

  it('saves into the root when Root is picked', () => {
    const onSaveItem = vi.fn()
    const harness = renderModal({ onSaveItem })

    click(saveButton(harness.element, 'Text note'))

    expect(onSaveItem).toHaveBeenCalledWith('s1', null)
  })

  it('saves everything into the picked folder', () => {
    const onSaveAll = vi.fn()
    const harness = renderModal({ onSaveAll })

    pickFolder(harness.element, 'Uni Stuff')
    click(button(harness.element, '.library-modal__save-all'))

    expect(onSaveAll).toHaveBeenCalledWith('f1')
  })

  it('refuses to save a transfer that never finished, and says why', () => {
    const harness = renderModal()

    expect(saveButton(harness.element, 'half-sent.pdf').disabled).toBe(true)
    expect(saveButton(harness.element, 'half-sent.pdf').getAttribute('title')).toBe(
      'The transfer did not finish',
    )
    expect(itemRow(harness.element, 'half-sent.pdf').textContent).toContain(
      'Transfer did not finish',
    )
    expect(saveButton(harness.element, 'Text note').disabled).toBe(false)
  })

  it('shows already-saved items as saved and leaves them out of the batch', () => {
    const harness = renderModal({ savedIds: ['s1'] })

    expect(itemRow(harness.element, 'Text note').querySelector('.library-modal__saved')?.textContent).toBe(
      'Saved',
    )
    expect(itemRow(harness.element, 'Text note').querySelector('.library-modal__save')).toBe(null)
    expect(button(harness.element, '.library-modal__save-all').textContent).toBe('Save all (2)')
  })

  it('cannot save when there is nothing receivable', () => {
    const harness = renderModal({ items: [] })

    expect(button(harness.element, '.library-modal__save-all').disabled).toBe(true)
    expect(harness.element.querySelector('.library-modal__empty')?.textContent).toBe(
      'No received items to save.',
    )
  })

  it('reports a failed save instead of pretending the item was kept', async () => {
    const onSaveItem = vi.fn(async () => {
      throw new Error('quota exceeded')
    })
    const harness = renderModal({ onSaveItem })

    await act(async () => {
      click(saveButton(harness.element, 'Text note'))
    })

    expect(harness.element.querySelector('.library-modal__error')?.textContent).toBe(
      'Could not save to the library (quota exceeded).',
    )
    expect(button(harness.element, '.library-modal__save-all').disabled).toBe(false)
  })

  it('closes on Done', () => {
    const onClose = vi.fn()
    const harness = renderModal({ onClose })

    click(button(harness.element, '.library-modal__done'))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

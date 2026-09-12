/** @vitest-environment jsdom */
/**
 * New folder dialog tests (PLAN.md §6.4's "+ New Folder", §16 Phase 5).
 *
 * What is pinned: the parent is fixed by the browser and stated in the title, a blank
 * name cannot be submitted and is trimmed when it is, the store's asynchronous create
 * keeps the dialog busy until it settles, and a rejection is reported instead of the
 * dialog closing as if the folder existed.
 */

import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NewFolderModal } from './NewFolderModal'
import type { NewFolderModalProps } from './NewFolderModal'

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

function renderModal(overrides: Partial<NewFolderModalProps> = {}): Harness {
  return mount(
    createElement(NewFolderModal, {
      parentId: 'f1',
      parentName: 'Uni Stuff',
      onCreate: vi.fn(),
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

function nameInput(element: HTMLElement): HTMLInputElement {
  return bySelector(element, '.library-modal__input', HTMLInputElement)
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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

/** Submitting awaits `onCreate`, so the microtask after it has to be flushed too. */
async function submitForm(element: HTMLElement): Promise<void> {
  dispatchSubmit(element)
  await act(async () => {})
}

function dispatchSubmit(element: HTMLElement): void {
  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
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

describe('NewFolderModal', () => {
  it('names the parent folder and starts with an empty, focused field', () => {
    const harness = renderModal({ parentName: 'Root' })

    expect(harness.element.querySelector('.library-modal__title')?.textContent).toBe(
      'New folder in Root',
    )
    expect(nameInput(harness.element).value).toBe('')
    expect(document.activeElement).toBe(nameInput(harness.element))
    expect(button(harness.element, '.library-modal__submit').disabled).toBe(true)
  })

  it('refuses a blank name', async () => {
    const onCreate = vi.fn()
    const harness = renderModal({ onCreate })

    typeInto(nameInput(harness.element), '   ')

    expect(button(harness.element, '.library-modal__submit').disabled).toBe(true)

    await submitForm(harness.element)

    expect(onCreate).not.toHaveBeenCalled()
    expect(harness.element.querySelector('.library-modal')).not.toBe(null)
  })

  it('creates in the current folder with a trimmed name and closes', async () => {
    const onCreate = vi.fn()
    const onClose = vi.fn()
    const harness = renderModal({ onCreate, onClose, parentId: 'f1' })

    typeInto(nameInput(harness.element), '  Thesis  ')
    await submitForm(harness.element)

    expect(onCreate).toHaveBeenCalledWith('Thesis', 'f1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('creates at the root when the browser is at the root', async () => {
    const onCreate = vi.fn()
    const harness = renderModal({ onCreate, parentId: null, parentName: 'Root' })

    typeInto(nameInput(harness.element), 'Archive')
    await submitForm(harness.element)

    expect(onCreate).toHaveBeenCalledWith('Archive', null)
  })

  it('stays busy until the store answers, then closes', async () => {
    let release: (() => void) | null = null
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const onClose = vi.fn()
    const harness = renderModal({ onCreate, onClose })

    typeInto(nameInput(harness.element), 'Archive')
    // Dispatch on its own so the pending `onCreate` can be observed before it settles:
    // overlapping `act` scopes (awaiting the submit and releasing it at once) break the
    // environment for every later test in the file.
    dispatchSubmit(harness.element)
    await act(async () => {})

    expect(button(harness.element, '.library-modal__submit').textContent).toBe('Creating…')
    expect(button(harness.element, '.library-modal__cancel').disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      release?.()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reports a failed create and keeps the name for another try', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('quota exceeded')
    })
    const onClose = vi.fn()
    const harness = renderModal({ onCreate, onClose })

    typeInto(nameInput(harness.element), 'Archive')
    await submitForm(harness.element)

    expect(harness.element.querySelector('.library-modal__error')?.textContent).toBe(
      'Could not create the folder (quota exceeded).',
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(nameInput(harness.element).value).toBe('Archive')
    expect(button(harness.element, '.library-modal__submit').disabled).toBe(false)
  })

  it('cancels without creating anything', () => {
    const onCreate = vi.fn()
    const onClose = vi.fn()
    const harness = renderModal({ onCreate, onClose })

    click(button(harness.element, '.library-modal__cancel'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCreate).not.toHaveBeenCalled()
  })
})

/** @vitest-environment jsdom */
/**
 * New folder dialog tests (PLAN.md §6.4's "+ New Folder", §16 Phase 5).
 *
 * What is pinned: the parent is fixed by the browser and stated in the title, a blank
 * name cannot be submitted and is trimmed when it is, the store's asynchronous create
 * keeps the dialog busy until it settles, a rejection is reported instead of the dialog
 * closing as if the folder existed, and a busy dialog cannot be dismissed — because a
 * folder that turns up after the dialog has gone looks like one that was never asked for.
 *
 * The dialog is a Mantine `Modal`, which portals into `document.body`, so the helpers read
 * it from the document. The field is named by its visible label (Mantine wires `label` to
 * the input through ids), which is what `field()` resolves.
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

function dialog(): HTMLElement {
  const node = document.querySelector('[role="dialog"]')
  if (!(node instanceof HTMLElement)) throw new Error('test bug: no dialog')
  return node
}

function field(): HTMLInputElement {
  const input = dialog().querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error('test bug: no folder name field')
  return input
}

function action(label: string): HTMLButtonElement {
  for (const candidate of dialog().querySelectorAll<HTMLButtonElement>('button')) {
    if (candidate.textContent === label) return candidate
  }
  throw new Error(`test bug: no button labelled ${label}`)
}

/** Lets Mantine's portal, transition and focus trap commit before an assertion reads them. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null))
    })
  })
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function pressEscape(): void {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(input, value)

  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Submitting awaits `onCreate`, so the microtask after it has to be flushed too. */
async function submitForm(): Promise<void> {
  dispatchSubmit()
  await act(async () => {})
}

function dispatchSubmit(): void {
  const form = dialog().querySelector('form')
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
  it('names the parent folder and starts with an empty, focused field', async () => {
    renderModal({ parentName: 'Root' })
    await settle()

    const title = document.getElementById(dialog().getAttribute('aria-labelledby') ?? '')
    expect(title?.textContent).toBe('New folder in Root')
    expect(field().value).toBe('')
    expect(document.activeElement).toBe(field())
    expect(action('Create').disabled).toBe(true)
  })

  it('refuses a blank name', async () => {
    const onCreate = vi.fn()
    renderModal({ onCreate })

    typeInto(field(), '   ')

    expect(action('Create').disabled).toBe(true)

    await submitForm()

    expect(onCreate).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).not.toBe(null)
  })

  it('creates in the current folder with a trimmed name and closes', async () => {
    const onCreate = vi.fn()
    const onClose = vi.fn()
    renderModal({ onCreate, onClose, parentId: 'f1' })

    typeInto(field(), '  Thesis  ')
    await submitForm()

    expect(onCreate).toHaveBeenCalledWith('Thesis', 'f1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('creates at the root when the browser is at the root', async () => {
    const onCreate = vi.fn()
    renderModal({ onCreate, parentId: null, parentName: 'Root' })

    typeInto(field(), 'Archive')
    await submitForm()

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
    renderModal({ onCreate, onClose })

    typeInto(field(), 'Archive')
    // Dispatch on its own so the pending `onCreate` can be observed before it settles:
    // overlapping `act` scopes (awaiting the submit and releasing it at once) break the
    // environment for every later test in the file.
    dispatchSubmit()
    await act(async () => {})

    expect(action('Creating…').disabled).toBe(true)
    expect(action('Cancel').disabled).toBe(true)
    expect(field().disabled).toBe(true)

    // A busy dialog is not dismissible: Escape and Cancel both have to wait for the write.
    pressEscape()
    click(action('Cancel'))
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
    renderModal({ onCreate, onClose })

    typeInto(field(), 'Archive')
    await submitForm()

    expect(dialog().textContent).toContain('Could not create the folder (quota exceeded).')
    // The message is wired to the field it describes, so it is read with the field.
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(onClose).not.toHaveBeenCalled()
    expect(field().value).toBe('Archive')
    expect(action('Create').disabled).toBe(false)
  })

  it('cancels without creating anything', () => {
    const onCreate = vi.fn()
    const onClose = vi.fn()
    renderModal({ onCreate, onClose })

    click(action('Cancel'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCreate).not.toHaveBeenCalled()
  })
})

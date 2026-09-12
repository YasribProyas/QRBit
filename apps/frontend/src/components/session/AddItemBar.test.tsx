/** @vitest-environment jsdom */
/**
 * AddItemBar tests (PLAN.md §9 — "Add item bar (sender only)", §16 Phases 3 and 4).
 *
 * The bar is a thin adapter: each control calls one items-API method and nothing
 * else, so these tests use a stand-in for the API (plain mock functions) and assert
 * the calls. The stand-in is the same shape `useSession` implements, which keeps the
 * test honest about the contract without needing a session.
 *
 * Two scope rules are pinned here as well, because "not built yet" is easy to
 * regress in the other direction: 🔒 must open the Phase 4 compose modal (and call
 * `addLockedItem`, never the other add methods directly), and 📚 (library picker)
 * must not be rendered at all until Phase 5.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AddItemBar } from './AddItemBar'
import type { AddItemBarProps } from './AddItemBar'
import type { LockedItemInput } from './LockedItemComposeModal'

function makeApi(): AddItemBarProps['api'] {
  return {
    addTextItem: vi.fn((): string => 'text-id'),
    addRichTextItem: vi.fn((): string => 'rich-id'),
    addFileItem: vi.fn((): string => 'file-id'),
    addLockedItem: vi.fn(async (_input: LockedItemInput): Promise<string> => 'locked-id'),
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderBar(api: AddItemBarProps['api'], maxLockedFileBytes?: number): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(createElement(AddItemBar, { api, maxLockedFileBytes }))
  })

  container = element
  root = created
  return element
}

function button(element: HTMLElement, label: string): HTMLButtonElement {
  for (const candidate of element.querySelectorAll('button')) {
    if (candidate.getAttribute('aria-label') === label) return candidate
  }
  throw new Error(`test bug: no button labelled ${label}`)
}

function input(element: HTMLElement, selector: string): HTMLInputElement {
  const node = element.querySelector(selector)
  if (!(node instanceof HTMLInputElement)) throw new Error(`test bug: no input matching ${selector}`)
  return node
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** jsdom has no real file picker, so the selection is injected as a FileList-shaped value. */
function pick(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/**
 * Types into a controlled React field.
 *
 * The value goes in through the prototype's setter because React keeps its own
 * `value` tracker on the element: assigning `value` directly updates that tracker,
 * and React then treats the resulting event as a no-op.
 */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(field, value)

  act(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function field(element: HTMLElement, selector: string): HTMLInputElement {
  const node = element.querySelector(selector)
  if (!(node instanceof HTMLInputElement)) throw new Error(`test bug: nothing matching ${selector}`)
  return node
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
})

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('AddItemBar — text and rich text (PLAN.md §9)', () => {
  it('adds an empty text item from T', () => {
    const api = makeApi()
    const element = renderBar(api)

    click(button(element, 'Add text item'))

    expect(api.addTextItem).toHaveBeenCalledTimes(1)
    expect(api.addTextItem).toHaveBeenCalledWith()
    expect(api.addRichTextItem).not.toHaveBeenCalled()
    expect(api.addFileItem).not.toHaveBeenCalled()
  })

  it('adds an empty rich-text item from ¶', () => {
    const api = makeApi()
    const element = renderBar(api)

    click(button(element, 'Add rich text item'))

    expect(api.addRichTextItem).toHaveBeenCalledTimes(1)
    expect(api.addTextItem).not.toHaveBeenCalled()
  })
})

describe('AddItemBar — images and files (PLAN.md §9, §16 Phase 3)', () => {
  it('opens the image picker rather than sending anything itself', () => {
    const api = makeApi()
    const element = renderBar(api)
    const imageInput = input(element, '.add-item-bar__image-input')
    const clicked = vi.spyOn(imageInput, 'click')

    click(button(element, 'Add images'))

    expect(clicked).toHaveBeenCalledTimes(1)
    expect(api.addFileItem).not.toHaveBeenCalled()
  })

  it('offers multi-select image choosing, and one item per selected file', () => {
    const api = makeApi()
    const element = renderBar(api)
    const imageInput = input(element, '.add-item-bar__image-input')

    expect(imageInput.accept).toBe('image/*')
    expect(imageInput.multiple).toBe(true)

    const files = [
      new File(['a'], 'one.png', { type: 'image/png' }),
      new File(['b'], 'two.png', { type: 'image/png' }),
      new File(['c'], 'three.jpg', { type: 'image/jpeg' }),
    ]
    pick(imageInput, files)

    expect(api.addFileItem).toHaveBeenCalledTimes(3)
    expect(api.addFileItem).toHaveBeenNthCalledWith(1, files[0])
    expect(api.addFileItem).toHaveBeenNthCalledWith(3, files[2])
  })

  it('sends every file chosen through 📎 as its own item', () => {
    const api = makeApi()
    const element = renderBar(api)
    const fileInput = input(element, '.add-item-bar__file-input')

    expect(fileInput.multiple).toBe(true)

    const files = [new File(['a'], 'notes.txt'), new File(['b'], 'archive.zip')]
    pick(fileInput, files)

    expect(api.addFileItem).toHaveBeenCalledTimes(2)
    expect(api.addFileItem).toHaveBeenNthCalledWith(2, files[1])
  })

  it('ignores an empty selection', () => {
    const api = makeApi()
    const element = renderBar(api)

    pick(input(element, '.add-item-bar__file-input'), [])

    expect(api.addFileItem).not.toHaveBeenCalled()
  })
})

describe('AddItemBar — locked items (PLAN.md §16 Phase 4)', () => {
  it('opens the locked compose modal instead of sending anything itself', () => {
    const api = makeApi()
    const element = renderBar(api)
    const locked = button(element, 'Add locked item')

    expect(locked.disabled).toBe(false)
    expect(element.textContent).not.toContain('Phase 4')
    expect(element.querySelector('.locked-compose')).toBe(null)

    click(locked)

    expect(element.querySelector('.locked-compose')).not.toBe(null)
    expect(api.addTextItem).not.toHaveBeenCalled()
    expect(api.addRichTextItem).not.toHaveBeenCalled()
    expect(api.addFileItem).not.toHaveBeenCalled()
    expect(api.addLockedItem).not.toHaveBeenCalled()
  })

  it('forwards what the modal collected to addLockedItem, then closes it', async () => {
    const api = makeApi()
    const element = renderBar(api)

    click(button(element, 'Add locked item'))
    typeInto(field(element, '.locked-compose__label-input'), 'Uni portal password')
    typeInto(field(element, '.locked-compose__password'), 'hunter2')
    typeInto(field(element, '.locked-compose__confirm-password'), 'hunter2')

    const form = element.querySelector('form')
    if (form === null) throw new Error('test bug: no form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(api.addLockedItem).toHaveBeenCalledWith({
      label: 'Uni portal password',
      innerType: 'text',
      content: '',
      password: 'hunter2',
    })
    expect(element.querySelector('.locked-compose')).toBe(null)
  })

  it('closes the modal again when it is cancelled', () => {
    const element = renderBar(makeApi())

    click(button(element, 'Add locked item'))
    const cancel = element.querySelector('.locked-compose__cancel')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('test bug: no cancel button')
    click(cancel)

    expect(element.querySelector('.locked-compose')).toBe(null)
  })

  it('hands the caller’s D6 cap to the compose modal instead of its own default', () => {
    // The page passes `LOCKED_ITEM_MAX_PLAINTEXT_BYTES` from `lib/crypto.ts`; the bar
    // must forward whatever it is given, or the one owner of that number is bypassed.
    const element = renderBar(makeApi(), 1024)

    click(button(element, 'Add locked item'))
    click(field(element, '.locked-compose__type-radio[value="file"]'))
    pick(field(element, '.locked-compose__file'), [
      new File(['x'.repeat(2048)], 'two-kib.bin'),
    ])

    // Two KiB is well under the modal's own 3 MiB default, so this message can only
    // come from the forwarded cap.
    expect(element.querySelector('.locked-compose__error')?.textContent).toContain(
      'at most 1024 bytes',
    )
  })

  it('does not render the Phase 5 library picker', () => {
    const element = renderBar(makeApi())

    expect(element.textContent).not.toContain('📚')
    expect(element.querySelectorAll('button')).toHaveLength(5)
  })
})

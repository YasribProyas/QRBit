/** @vitest-environment jsdom */
/**
 * LockedItem row tests (PLAN.md §9's `locked` row, §16 Phase 4).
 *
 * The row is the whole receive experience: label + 🔒, an Unlock button that opens the
 * password modal, and the inline reveal once the item is unlocked — one rendering
 * path per inner type. `onUnlock` / `onLockAgain` are stand-ins for the items API
 * methods (the Phase 4 contract), so no crypto appears in this file: the row renders
 * the state the store holds and nothing more.
 *
 * What is pinned here:
 *
 *   - the sender's view states the inner type it chose; the receiver's does not,
 *   - unlocking is the same flow on both sides (the sender verifies with the password
 *     it set, PLAN.md §9),
 *   - a wrong password never reaches the row as a crash — the modal owns that, and
 *     the row stays locked,
 *   - the reveal for each inner type, including the file's object URL being revoked
 *     when the item is locked again and when the row unmounts (the only resource the
 *     row owns; the plaintext itself never leaves memory),
 *   - an item whose locked payload has not arrived offers no unlock at all.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LockedItem } from './LockedItem'
import type { LockedItemViewProps } from './LockedItem'
import type { LockedItem as LockedItemModel } from '../../../store/sessionStore'

function makeItem(overrides: Partial<LockedItemModel> = {}): LockedItemModel {
  return {
    id: 'l1',
    type: 'locked',
    status: 'complete',
    createdAt: 1,
    label: 'Uni portal password',
    innerType: 'text',
    ciphertext: new Uint8Array([1, 2, 3]),
    iv: new Uint8Array([4, 5, 6]),
    salt: new Uint8Array([7, 8, 9]),
    ...overrides,
  }
}

/** A minimal Tiptap document containing exactly `text`. */
function docWith(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
}

let urlCounter = 0
const createObjectURL = vi.fn((_source: Blob | MediaSource): string => {
  urlCounter += 1
  return `blob:qrdrop/${urlCounter}`
})
const revokeObjectURL = vi.fn()
const previousCreateObjectURL = URL.createObjectURL
const previousRevokeObjectURL = URL.revokeObjectURL

interface Harness {
  element: HTMLDivElement
  /** Re-render with new props — how the store hands the row its next state. */
  update: (next: Partial<LockedItemViewProps>) => void
  unmount: () => void
}

const openHarnesses: Harness[] = []
const onLockAgain = vi.fn()

function renderRow(overrides: Partial<LockedItemViewProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const created: Root = createRoot(element)

  let props: LockedItemViewProps = {
    item: makeItem(),
    sender: true,
    onUnlock: vi.fn(async (_id: string, _password: string) => true),
    onLockAgain,
    ...overrides,
  }

  act(() => {
    created.render(createElement(LockedItem, props))
  })

  const harness: Harness = {
    element,
    update: (next) => {
      props = { ...props, ...next }
      act(() => {
        created.render(createElement(LockedItem, props))
      })
    },
    unmount: () => {
      act(() => {
        created.unmount()
      })
      element.remove()
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

function passwordInput(element: HTMLElement): HTMLInputElement {
  return bySelector(element, 'input[type="password"]', HTMLInputElement)
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

/** Opens the unlock modal, types a password and submits it. */
async function attemptUnlock(element: HTMLElement, password: string): Promise<void> {
  click(button(element, '.locked-item__unlock'))
  typeInto(passwordInput(element), password)

  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')

  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function editorOf(element: HTMLElement): Editor {
  const dom = element.querySelector('.ProseMirror')
  const editor = (dom as (HTMLElement & { editor?: Editor }) | null)?.editor
  if (!(editor instanceof Editor)) throw new Error('test bug: Tiptap did not mount an editor')
  return editor
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  urlCounter = 0
  vi.clearAllMocks()
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
})

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  // Tiptap destroys an unmounted editor on a timer; letting it fire here keeps each
  // test's destruction out of the next test's assertions.
  await new Promise((resolve) => setTimeout(resolve, 5))

  URL.createObjectURL = previousCreateObjectURL
  URL.revokeObjectURL = previousRevokeObjectURL
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('LockedItem — sender view (PLAN.md §9)', () => {
  it('shows the label, the badge and the inner type it chose, and no password field yet', () => {
    const { element } = renderRow({
      item: makeItem({ innerType: 'file', label: 'Server root key' }),
    })

    expect(element.querySelector('.locked-item__label')?.textContent).toBe('Server root key')
    expect(element.querySelector('.locked-item__badge')?.textContent).toContain('🔒')
    expect(element.querySelector('.locked-item__inner-type')?.textContent).toBe('File')
    expect(button(element, '.locked-item__unlock')).not.toBe(null)
    expect(element.querySelector('input[type="password"]')).toBe(null)
  })

  it('opens the password modal and unlocks with the password it set', async () => {
    const onUnlock = vi.fn(async (_id: string, _password: string) => true)
    const { element } = renderRow({ onUnlock })

    await attemptUnlock(element, 'hunter2')

    expect(onUnlock).toHaveBeenCalledTimes(1)
    expect(onUnlock).toHaveBeenCalledWith('l1', 'hunter2')
    // Success closes the modal; the store's `unlocked` state owns the reveal.
    expect(element.querySelector('input[type="password"]')).toBe(null)
  })
})

describe('LockedItem — receiver view (PLAN.md §9)', () => {
  it('shows the label and the badge only, plus the same unlock affordance', () => {
    const { element } = renderRow({ item: makeItem({ innerType: 'file' }), sender: false })

    expect(element.querySelector('.locked-item__label')?.textContent).toBe('Uni portal password')
    expect(element.querySelector('.locked-item__badge')?.textContent).toContain('🔒')
    // The type is the sender's choice; the receiver's row never claims it.
    expect(element.querySelector('.locked-item__inner-type')).toBe(null)
    expect(button(element, '.locked-item__unlock').textContent).toBe('Unlock')
  })
})

describe('LockedItem — wrong password (PLAN.md §17)', () => {
  it('keeps the item locked, shows the error and lets the next attempt through', async () => {
    const onUnlock = vi.fn(async (_id: string, _password: string) => false)
    const { element } = renderRow({ item: makeItem({ innerType: 'text' }), onUnlock })

    await attemptUnlock(element, 'typo')

    const error = element.querySelector('.unlock-modal__error')
    expect(error?.getAttribute('data-error-kind')).toBe('wrong-password')
    expect(passwordInput(element).value).toBe('')
    // Still locked and still open for a retry.
    expect(element.querySelector('.locked-item__reveal')).toBe(null)
    expect(element.querySelector('.locked-item__unlock')).not.toBe(null)

    onUnlock.mockImplementation(async () => true)
    typeInto(passwordInput(element), 'the real one')

    const form = element.querySelector('form')
    if (form === null) throw new Error('test bug: no form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onUnlock).toHaveBeenLastCalledWith('l1', 'the real one')
    expect(element.querySelector('input[type="password"]')).toBe(null)
  })

  it('surfaces an infrastructure failure without crashing the row', async () => {
    const onUnlock = vi.fn(async (_id: string, _password: string) => {
      throw new Error('no such item')
    })
    const { element } = renderRow({ onUnlock })

    await expect(attemptUnlock(element, 'whatever')).resolves.toBeUndefined()

    const error = element.querySelector('.unlock-modal__error')
    expect(error?.getAttribute('data-error-kind')).toBe('failed')
    expect(element.querySelector('.locked-item__label')?.textContent).toBe('Uni portal password')
  })
})

describe('LockedItem — the inline reveal (PLAN.md §9)', () => {
  it('renders unlocked text as read-only content', () => {
    const { element } = renderRow({
      item: makeItem({ unlocked: true, plaintextContent: 'hunter2\nbackup: hunter3' }),
    })

    expect(element.querySelector('.locked-item__reveal')?.textContent).toBe(
      'hunter2\nbackup: hunter3',
    )
    expect(button(element, '.locked-item__lock-again')).not.toBe(null)
    expect(element.querySelector('.locked-item__unlock')).toBe(null)
  })

  it('renders unlocked rich text in a read-only editor', () => {
    const { element } = renderRow({
      item: makeItem({
        innerType: 'richtext',
        unlocked: true,
        plaintextContent: docWith('the secret document'),
      }),
    })

    expect(element.textContent).toContain('the secret document')
    expect(editorOf(element).isEditable).toBe(false)
  })

  it('renders an unlocked file as a download built from the plaintext', () => {
    const { element } = renderRow({
      item: makeItem({
        innerType: 'file',
        unlocked: true,
        plaintextContent: new File(['one time codes'], 'codes.txt', { type: 'text/plain' }),
      }),
    })

    const link = bySelector(element, '.locked-item__download', HTMLAnchorElement)
    expect(link.getAttribute('download')).toBe('codes.txt')
    expect(link.getAttribute('href')).toBe('blob:qrdrop/1')
  })

  it('falls back to the label when the plaintext has no file name', () => {
    const { element } = renderRow({
      item: makeItem({
        innerType: 'file',
        label: 'Recovery codes',
        unlocked: true,
        plaintextContent: new Blob(['one time codes']),
      }),
    })

    expect(
      bySelector(element, '.locked-item__download', HTMLAnchorElement).getAttribute('download'),
    ).toBe('Recovery codes')
  })

  it('revokes the download URL when the item is locked again', () => {
    const { element, update } = renderRow({
      item: makeItem({
        innerType: 'file',
        unlocked: true,
        plaintextContent: new File(['codes'], 'codes.txt'),
      }),
    })

    expect(element.querySelector('.locked-item__download')?.getAttribute('href')).toBe(
      'blob:qrdrop/1',
    )
    expect(revokeObjectURL).not.toHaveBeenCalled()

    update({ item: makeItem({ innerType: 'file', unlocked: false }) })

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrdrop/1')
    expect(element.querySelector('.locked-item__download')).toBe(null)
    expect(element.querySelector('.locked-item__reveal')).toBe(null)
  })

  it('revokes the download URL when the row unmounts', () => {
    const { unmount } = renderRow({
      item: makeItem({
        innerType: 'file',
        unlocked: true,
        plaintextContent: new File(['codes'], 'codes.txt'),
      }),
    })

    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrdrop/1')
  })

  it('reports an unlocked item whose plaintext is missing instead of rendering nothing', () => {
    const { element } = renderRow({ item: makeItem({ unlocked: true }) })

    expect(element.querySelector('.locked-item__error')?.textContent).toContain(
      'The unlocked contents are missing',
    )
  })
})

describe('LockedItem — locking again', () => {
  it('calls the API and never re-runs an unlock', () => {
    const onUnlock = vi.fn(async (_id: string, _password: string) => true)
    const { element } = renderRow({
      item: makeItem({ unlocked: true, plaintextContent: 'secret' }),
      onUnlock,
    })

    click(button(element, '.locked-item__lock-again'))

    expect(onLockAgain).toHaveBeenCalledWith('l1')
    expect(onUnlock).not.toHaveBeenCalled()
  })
})

describe('LockedItem — before the payload arrives (§16 Phase 4 contract)', () => {
  it('offers no unlock while the locked payload is still in flight', () => {
    const { element } = renderRow({ item: makeItem({ status: 'transferring' }) })

    expect(element.querySelector('.locked-item__unlock')).toBe(null)
    expect(element.textContent).toContain('Waiting for the encrypted payload…')
  })

  it('says so when the payload never arrived', () => {
    const { element } = renderRow({ item: makeItem({ status: 'error' }) })

    expect(element.querySelector('.locked-item__unlock')).toBe(null)
    expect(element.textContent).toContain('The locked payload did not arrive.')
  })

  it('offers the unlock once the item is complete', () => {
    const { element } = renderRow({ item: makeItem({ status: 'complete' }) })

    expect(element.querySelector('.locked-item__unlock')).not.toBe(null)
  })
})

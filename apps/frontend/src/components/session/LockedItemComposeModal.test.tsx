/** @vitest-environment jsdom */
/**
 * LockedItemComposeModal tests (PLAN.md §16 Phase 4, with decisions D6 and D7).
 *
 * The modal is pure form: it collects the four values and hands them to
 * `addLockedItem`. `onAdd` is a stand-in for that method (the Phase 4 contract), so
 * nothing here needs Web Crypto — the encryption is the API's job.
 *
 * Four behaviours carry the risk and are pinned here:
 *
 *   1. D7 — the password is asked for twice and a mismatch blocks the send. There is
 *      no recovery path, so a typo must not be able to lock the user out.
 *   2. D6 — an oversized file is refused with a message that names the alternative
 *      (a regular file item, which is still end-to-end encrypted), and it can never
 *      reach the wire.
 *   3. the spinner covers the ~300ms PBKDF2 derivation (PLAN.md §19 decision 9), and
 *      a double submission cannot send the item twice.
 *   4. a failure is inline, never a crash, and the composed values stay put for a retry.
 *
 * jsdom ships no renderer and this repo has no rendering library, so React's own
 * `act` + `createRoot` are used, as in `items/TextItem.test.tsx`.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LOCKED_ITEM_DEFAULT_MAX_FILE_BYTES,
  LockedItemComposeModal,
} from './LockedItemComposeModal'
import type { LockedItemComposeModalProps, LockedItemInput } from './LockedItemComposeModal'

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function renderModal(overrides: Partial<LockedItemComposeModalProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const created: Root = createRoot(element)

  const props: LockedItemComposeModalProps = {
    onAdd: vi.fn(async (_input: LockedItemInput) => 'locked-1'),
    onClose: vi.fn(),
    ...overrides,
  }

  act(() => {
    created.render(createElement(LockedItemComposeModal, props))
  })

  const harness: Harness = {
    element,
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

function input(element: HTMLElement, selector: string): HTMLInputElement {
  return bySelector(element, selector, HTMLInputElement)
}

function textarea(element: HTMLElement): HTMLTextAreaElement {
  return bySelector(element, '.locked-compose__text', HTMLTextAreaElement)
}

function submitButton(element: HTMLElement): HTMLButtonElement {
  return bySelector(element, '.locked-compose__submit', HTMLButtonElement)
}

function errorOf(element: HTMLElement): HTMLElement | null {
  const node = element.querySelector('.locked-compose__error')
  return node instanceof HTMLElement ? node : null
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

/** jsdom has no real file picker, so the selection is injected as a FileList-shaped value. */
function pickFile(element: HTMLElement, file: File): void {
  const picker = input(element, '.locked-compose__file')
  Object.defineProperty(picker, 'files', { value: [file], configurable: true })

  act(() => {
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Selects an inner type the way tapping its radio does. */
function chooseType(element: HTMLElement, innerType: string): void {
  const radio = input(element, `.locked-compose__type-radio[value="${innerType}"]`)

  act(() => {
    radio.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function submit(element: HTMLElement): Promise<void> {
  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')

  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

/** Fills the three fields a text item needs, in the order a user would. */
function fillTextDraft(element: HTMLElement, label: string, password: string, secret: string): void {
  typeInto(input(element, '.locked-compose__label-input'), label)
  typeInto(textarea(element), secret)
  typeInto(input(element, '.locked-compose__password'), password)
  typeInto(input(element, '.locked-compose__confirm-password'), password)
}

function editorOf(element: HTMLElement): Editor {
  const dom = element.querySelector('.ProseMirror')
  const editor = (dom as (HTMLElement & { editor?: Editor }) | null)?.editor
  if (!(editor instanceof Editor)) throw new Error('test bug: Tiptap did not mount an editor')
  return editor
}

/** A stand-in for the ~300ms PBKDF2 derivation the real `addLockedItem` performs. */
function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let settle: (value: string) => void = () => {}
  const promise = new Promise<string>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle }
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
})

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  // Tiptap destroys an unmounted editor on a timer; letting it fire here keeps each
  // test's destruction out of the next test's assertions.
  await new Promise((resolve) => setTimeout(resolve, 5))
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('LockedItemComposeModal — the label (PLAN.md §9)', () => {
  it('is required, and stays plaintext', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd })

    fillTextDraft(element, '', 'hunter2', 'secret')
    expect(submitButton(element).disabled).toBe(true)

    // A label that is only whitespace is no label.
    typeInto(input(element, '.locked-compose__label-input'), '   ')
    expect(submitButton(element).disabled).toBe(true)

    // The label is never masked or encrypted: it is the item's public name.
    expect(input(element, '.locked-compose__label-input').type).toBe('text')
    expect(element.textContent).toContain('visible without the password')

    await submit(element)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('sends the trimmed label with the text content and the password', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const onClose = vi.fn()
    const { element } = renderModal({ onAdd, onClose })

    fillTextDraft(element, '  Uni portal password  ', 'hunter2', 'correct horse')
    expect(submitButton(element).disabled).toBe(false)

    await submit(element)

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith({
      label: 'Uni portal password',
      innerType: 'text',
      content: 'correct horse',
      password: 'hunter2',
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('LockedItemComposeModal — the password twice (decision D7)', () => {
  it('blocks the send while the two passwords differ', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd })

    fillTextDraft(element, 'Server key', 'hunter2', 'secret')
    typeInto(input(element, '.locked-compose__confirm-password'), 'hunter3')

    expect(submitButton(element).disabled).toBe(true)
    expect(element.querySelector('[data-mismatch="true"]')).not.toBe(null)

    await submit(element)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('stays disabled until a password is typed at all', () => {
    const { element } = renderModal()

    fillTextDraft(element, 'Server key', '', '')
    expect(submitButton(element).disabled).toBe(true)

    typeInto(input(element, '.locked-compose__password'), 'hunter2')
    typeInto(input(element, '.locked-compose__confirm-password'), 'hunter2')

    expect(submitButton(element).disabled).toBe(false)
    expect(element.querySelector('[data-mismatch="true"]')).toBe(null)
  })

  it('says there is no recovery, because there is none', () => {
    const { element } = renderModal()

    expect(element.textContent).toContain('There is no recovery')
  })
})

describe('LockedItemComposeModal — content follows the inner type (§16 Phase 4)', () => {
  it('starts on plain text, with a textarea and no editor or file picker', () => {
    const { element } = renderModal()

    expect(input(element, '.locked-compose__type-radio[value="text"]').checked).toBe(true)
    expect(textarea(element)).not.toBe(null)
    expect(element.querySelector('.ProseMirror')).toBe(null)
    expect(element.querySelector('.locked-compose__file')).toBe(null)
  })

  it('swaps the textarea for a Tiptap editor for rich text, and sends JSON', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd })

    chooseType(element, 'richtext')

    expect(element.querySelector('.locked-compose__text')).toBeNull()
    const editor = editorOf(element)
    expect(editor.isEditable).toBe(true)

    act(() => {
      editor.commands.insertContent('typed secret')
    })

    typeInto(input(element, '.locked-compose__label-input'), 'Draft')
    typeInto(input(element, '.locked-compose__password'), 'hunter2')
    typeInto(input(element, '.locked-compose__confirm-password'), 'hunter2')
    await submit(element)

    expect(onAdd).toHaveBeenCalledTimes(1)
    const sent = onAdd.mock.calls[0]?.[0]
    expect(sent?.innerType).toBe('richtext')
    expect(JSON.parse(String(sent?.content))).toMatchObject({ type: 'doc' })
    expect(String(sent?.content)).toContain('typed secret')
  })

  it('needs a chosen file before a file item can be sent', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd })

    chooseType(element, 'file')
    typeInto(input(element, '.locked-compose__label-input'), 'Recovery codes')
    typeInto(input(element, '.locked-compose__password'), 'hunter2')
    typeInto(input(element, '.locked-compose__confirm-password'), 'hunter2')

    expect(submitButton(element).disabled).toBe(true)
    await submit(element)
    expect(onAdd).not.toHaveBeenCalled()

    const file = new File(['one time codes'], 'codes.txt', { type: 'text/plain' })
    pickFile(element, file)

    expect(submitButton(element).disabled).toBe(false)
    await submit(element)

    expect(onAdd.mock.calls[0]?.[0]).toEqual({
      label: 'Recovery codes',
      innerType: 'file',
      content: file,
      password: 'hunter2',
    })
  })
})

describe('LockedItemComposeModal — the 3 MiB cap (decision D6)', () => {
  it('refuses a file over the default cap and names the regular-file alternative', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd })

    chooseType(element, 'file')
    const oversized = new File(['x'.repeat(LOCKED_ITEM_DEFAULT_MAX_FILE_BYTES + 1)], 'huge.bin')

    pickFile(element, oversized)

    const error = errorOf(element)
    expect(error?.textContent).toContain('at most 3 MiB')
    expect(error?.textContent).toContain('regular file item')
    expect(error?.textContent).toContain('end-to-end encrypted')
    // Dropped, not kept: an oversized item must not be sendable at all.
    expect(submitButton(element).disabled).toBe(true)

    await submit(element)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('uses a caller-supplied cap instead of the default', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd, maxFileBytes: 8 })

    chooseType(element, 'file')
    pickFile(element, new File(['123456789'], 'nine.txt'))

    expect(errorOf(element)?.textContent).toContain('at most 8 bytes')
    expect(submitButton(element).disabled).toBe(true)

    await submit(element)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('accepts a file exactly at the cap', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd, maxFileBytes: 8 })

    chooseType(element, 'file')
    const file = new File(['12345678'], 'eight.txt')
    pickFile(element, file)

    typeInto(input(element, '.locked-compose__label-input'), 'At the cap')
    typeInto(input(element, '.locked-compose__password'), 'hunter2')
    typeInto(input(element, '.locked-compose__confirm-password'), 'hunter2')
    await submit(element)

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0]?.[0]?.content).toBe(file)
  })
})

describe('LockedItemComposeModal — the cap on text and rich text (decision D6)', () => {
  it('refuses text over the cap on submit, naming the regular text item', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd, maxFileBytes: 8 })

    // The textarea has no maxlength, so the check happens where the UTF-8 bytes are
    // known: on submit, and before anything can reach `addLockedItem`.
    fillTextDraft(element, 'Server key', 'hunter2', '123456789')
    expect(submitButton(element).disabled).toBe(false)

    await submit(element)

    expect(onAdd).not.toHaveBeenCalled()
    expect(errorOf(element)?.textContent).toContain('at most 8 bytes')
    expect(errorOf(element)?.textContent).toContain('regular text item')
  })

  it('refuses rich text over the cap on submit, naming the regular rich text item', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd, maxFileBytes: 16 })

    chooseType(element, 'richtext')
    act(() => {
      editorOf(element).commands.insertContent('a secret')
    })
    typeInto(input(element, '.locked-compose__label-input'), 'Draft')
    typeInto(input(element, '.locked-compose__password'), 'hunter2')
    typeInto(input(element, '.locked-compose__confirm-password'), 'hunter2')

    await submit(element)

    expect(onAdd).not.toHaveBeenCalled()
    expect(errorOf(element)?.textContent).toContain('regular rich text item')
  })

  it('accepts text exactly at the cap', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd, maxFileBytes: 8 })

    fillTextDraft(element, 'Server key', 'hunter2', '12345678')
    await submit(element)

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0]?.[0]?.content).toBe('12345678')
  })
})

describe('LockedItemComposeModal — switching the inner type (§16 Phase 4)', () => {
  it('clears a picked file and blocks the send until a new file is picked', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd })

    chooseType(element, 'file')
    pickFile(element, new File(['family secrets'], 'secrets.txt'))
    typeInto(input(element, '.locked-compose__label-input'), 'Recovery codes')
    typeInto(input(element, '.locked-compose__password'), 'hunter2')
    typeInto(input(element, '.locked-compose__confirm-password'), 'hunter2')
    expect(submitButton(element).disabled).toBe(false)

    chooseType(element, 'text')
    chooseType(element, 'file')

    // The picker remounted empty, so the file the draft held is nowhere on screen — and
    // it must not be sendable either: locked content has no recovery path, so the sender
    // may not transmit bytes they cannot look at.
    expect(submitButton(element).disabled).toBe(true)
    await submit(element)
    expect(onAdd).not.toHaveBeenCalled()

    const replacement = new File(['new secrets'], 'new.txt')
    pickFile(element, replacement)
    expect(submitButton(element).disabled).toBe(false)
    await submit(element)

    expect(onAdd.mock.calls[0]?.[0]?.content).toBe(replacement)
  })

  it('clears rich text typed before the switch because the editor remounts empty', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => 'locked-1')
    const { element } = renderModal({ onAdd })

    chooseType(element, 'richtext')
    act(() => {
      editorOf(element).commands.insertContent('first secret')
    })
    typeInto(input(element, '.locked-compose__label-input'), 'Draft')
    typeInto(input(element, '.locked-compose__password'), 'hunter2')
    typeInto(input(element, '.locked-compose__confirm-password'), 'hunter2')
    expect(submitButton(element).disabled).toBe(false)

    chooseType(element, 'text')
    chooseType(element, 'richtext')

    // A fresh editor: the retained draft must not be able to send text the composer can
    // no longer see.
    expect(editorOf(element).getText()).toBe('')
    expect(submitButton(element).disabled).toBe(true)
    await submit(element)
    expect(onAdd).not.toHaveBeenCalled()

    act(() => {
      editorOf(element).commands.insertContent('second secret')
    })
    expect(submitButton(element).disabled).toBe(false)
    await submit(element)

    const sent = onAdd.mock.calls[0]?.[0]
    expect(sent?.innerType).toBe('richtext')
    expect(String(sent?.content)).toContain('second secret')
    expect(String(sent?.content)).not.toContain('first secret')
  })
})

describe('LockedItemComposeModal — the PBKDF2 wait (PLAN.md §19 decision 9)', () => {
  it('shows a spinner while the item is encrypted and closes on success', async () => {
    const gate = deferred()
    const onAdd = vi.fn((_input: LockedItemInput) => gate.promise)
    const onClose = vi.fn()
    const { element } = renderModal({ onAdd, onClose })

    fillTextDraft(element, 'Server key', 'hunter2', 'secret')

    const form = element.querySelector('form')
    if (form === null) throw new Error('test bug: no form')
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(element.querySelector('.spinner')).not.toBe(null)
    expect(element.textContent).toContain('Encrypting…')
    expect(submitButton(element).disabled).toBe(true)

    await act(async () => {
      gate.resolve('locked-1')
    })

    expect(element.querySelector('.spinner')).toBe(null)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cannot send the same item twice from a double submit', async () => {
    const gate = deferred()
    const onAdd = vi.fn((_input: LockedItemInput) => gate.promise)
    const { element } = renderModal({ onAdd })

    fillTextDraft(element, 'Server key', 'hunter2', 'secret')

    const form = element.querySelector('form')
    if (form === null) throw new Error('test bug: no form')
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onAdd).toHaveBeenCalledTimes(1)

    await act(async () => {
      gate.resolve('locked-1')
    })
  })

  it('shows a failed send inline and keeps the draft for a retry', async () => {
    const onAdd = vi.fn(async (_input: LockedItemInput) => {
      throw new Error('item-add requires an active session')
    })
    const onClose = vi.fn()
    const { element } = renderModal({ onAdd, onClose })

    fillTextDraft(element, 'Server key', 'hunter2', 'secret')

    await expect(submit(element)).resolves.toBeUndefined()

    expect(errorOf(element)?.textContent).toContain('Could not send the locked item')
    expect(errorOf(element)?.textContent).toContain('requires an active session')
    expect(onClose).not.toHaveBeenCalled()
    // Still open, still filled in — the send can simply be retried.
    expect(input(element, '.locked-compose__label-input').value).toBe('Server key')
    expect(input(element, '.locked-compose__password').value).toBe('hunter2')
    expect(element.querySelector('.spinner')).toBe(null)
    expect(submitButton(element).disabled).toBe(false)
  })
})

describe('LockedItemComposeModal — shape', () => {
  it('is a modal dialog that can be cancelled', () => {
    const onClose = vi.fn()
    const { element } = renderModal({ onClose })

    expect(element.querySelector('.locked-compose')?.getAttribute('role')).toBe('dialog')
    expect(element.querySelector('.locked-compose')?.getAttribute('aria-modal')).toBe('true')

    const cancel = bySelector(element, '.locked-compose__cancel', HTMLButtonElement)
    act(() => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

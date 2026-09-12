/** @vitest-environment jsdom */
/**
 * UnlockModal tests (PLAN.md §9's receiver flow, §16 Phase 4, §17).
 *
 * The contract has three outcomes, and confusing them is the failure this component
 * exists to prevent:
 *
 *   - unlocked — close, and let the row reveal the plaintext,
 *   - wrong password — PLAN.md §17: show an error, CLEAR the input, stay open, never
 *     crash (the user must be able to retry),
 *   - an infrastructure failure — a distinct message, because "wrong password" would
 *     send the user hunting for a password that was never the problem.
 *
 * The wrong-password path is pinned hardest, and it is pinned through a stand-in for
 * the items API's `unlockItem`: this component owns no crypto, so no crypto is needed
 * to test it (the Phase 4 contract).
 *
 * jsdom ships no renderer and this repo has no rendering library, so React's own
 * `act` + `createRoot` are used, as in `items/TextItem.test.tsx`.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UnlockModal } from './UnlockModal'
import type { UnlockModalProps } from './UnlockModal'

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function renderModal(overrides: Partial<UnlockModalProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const created: Root = createRoot(element)

  const props: UnlockModalProps = {
    label: 'Uni portal password',
    onSubmit: vi.fn(async () => true),
    onClose: vi.fn(),
    ...overrides,
  }

  act(() => {
    created.render(createElement(UnlockModal, props))
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

function passwordInput(element: HTMLElement): HTMLInputElement {
  const input = element.querySelector('input[type="password"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('test bug: no password input')
  return input
}

function submitButton(element: HTMLElement): HTMLButtonElement {
  const button = element.querySelector('.unlock-modal__submit')
  if (!(button instanceof HTMLButtonElement)) throw new Error('test bug: no submit button')
  return button
}

function errorOf(element: HTMLElement): HTMLElement | null {
  const node = element.querySelector('.unlock-modal__error')
  return node instanceof HTMLElement ? node : null
}

/**
 * Types into a controlled React input.
 *
 * The value goes in through the prototype's setter because React keeps its own
 * `value` tracker on the element: assigning `input.value` directly updates that
 * tracker, and React then treats the resulting event as a no-op.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: HTMLInputElement.value has no setter')
  setter.call(input, value)

  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Submits the form the way pressing Enter in the password field does. */
async function submit(element: HTMLElement): Promise<void> {
  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')

  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

/** A stand-in for the ~300ms PBKDF2 derivation the real `unlockItem` performs. */
function deferred(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let settle: (value: boolean) => void = () => {}
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle }
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
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('UnlockModal — the item it is unlocking (PLAN.md §9)', () => {
  it('names the item and keeps the password masked and out of form history', () => {
    const { element } = renderModal({ label: 'Server root key' })

    expect(element.textContent).toContain('Server root key')
    expect(passwordInput(element).type).toBe('password')
    expect(passwordInput(element).autocomplete).toBe('off')
    expect(element.querySelector('.unlock-modal')?.getAttribute('role')).toBe('dialog')
  })

  it('cannot be submitted with an empty password', async () => {
    const onSubmit = vi.fn(async () => true)
    const { element } = renderModal({ onSubmit })

    expect(submitButton(element).disabled).toBe(true)

    await submit(element)

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('closes without unlocking when the user cancels', () => {
    const onClose = vi.fn()
    const { element } = renderModal({ onClose })
    const cancel = element.querySelector('.unlock-modal__cancel')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('test bug: no cancel button')

    act(() => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('UnlockModal — success (PLAN.md §16 Phase 4)', () => {
  it('hands the typed password to the API and closes', async () => {
    const onSubmit = vi.fn(async (_password: string) => true)
    const onClose = vi.fn()
    const { element } = renderModal({ onSubmit, onClose })

    typeInto(passwordInput(element), 'correct horse')
    await submit(element)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('correct horse')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(errorOf(element)).toBe(null)
  })
})

describe('UnlockModal — wrong password (PLAN.md §17, §16 Phase 4)', () => {
  it('shows the error, clears the input and stays open for a retry', async () => {
    const onSubmit = vi.fn(async (_password: string) => false)
    const onClose = vi.fn()
    const { element } = renderModal({ onSubmit, onClose })

    typeInto(passwordInput(element), 'typo')
    await submit(element)

    const error = errorOf(element)
    expect(error?.getAttribute('data-error-kind')).toBe('wrong-password')
    expect(error?.textContent).toContain('That password is not correct.')
    expect(passwordInput(element).value).toBe('')
    expect(onClose).not.toHaveBeenCalled()
    expect(element.querySelector('.unlock-modal')).not.toBe(null)
  })

  it('lets the next attempt succeed, and sends only the new password', async () => {
    const onSubmit = vi.fn(async (_password: string) => false)
    const onClose = vi.fn()
    const { element } = renderModal({ onSubmit, onClose })

    typeInto(passwordInput(element), 'typo')
    await submit(element)

    onSubmit.mockImplementation(async () => true)
    typeInto(passwordInput(element), 'the real one')
    await submit(element)

    expect(onSubmit).toHaveBeenNthCalledWith(2, 'the real one')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(errorOf(element)).toBe(null)
  })

  it('never throws when the API rejects with a wrong-password-shaped failure', async () => {
    const onSubmit = vi.fn(async (_password: string) => {
      throw new DOMException('operation failed', 'OperationError')
    })
    const onClose = vi.fn()
    const { element } = renderModal({ onSubmit, onClose })

    typeInto(passwordInput(element), 'x')

    await expect(submit(element)).resolves.toBeUndefined()

    expect(errorOf(element)).not.toBe(null)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('UnlockModal — infrastructure failure (Phase 4 contract)', () => {
  it('shows its own message instead of blaming the password', async () => {
    const onSubmit = vi.fn(async (_password: string) => {
      throw new Error('the session is not active')
    })
    const { element } = renderModal({ onSubmit })

    typeInto(passwordInput(element), 'whatever')
    await submit(element)

    const error = errorOf(element)
    expect(error?.getAttribute('data-error-kind')).toBe('failed')
    expect(error?.textContent).toContain('Could not unlock this item')
    expect(error?.textContent).toContain('the session is not active')
    expect(error?.textContent).not.toContain('not correct')
    expect(element.querySelector('.unlock-modal')).not.toBe(null)
  })

  it('keeps a rejection without a message readable', async () => {
    const onSubmit = vi.fn(async (_password: string) => {
      throw 'gone'
    })
    const { element } = renderModal({ onSubmit })

    typeInto(passwordInput(element), 'whatever')
    await submit(element)

    expect(errorOf(element)?.textContent).toBe('Could not unlock this item.')
  })
})

describe('UnlockModal — the PBKDF2 wait (PLAN.md §19 decision 9)', () => {
  it('shows a spinner and blocks re-submission while the key is derived', async () => {
    const gate = deferred()
    const onSubmit = vi.fn((_password: string) => gate.promise)
    const onClose = vi.fn()
    const { element } = renderModal({ onSubmit, onClose })

    typeInto(passwordInput(element), 'slow one')

    const form = element.querySelector('form')
    if (form === null) throw new Error('test bug: no form')
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(element.querySelector('.spinner')).not.toBe(null)
    expect(element.textContent).toContain('Unlocking…')
    expect(submitButton(element).disabled).toBe(true)

    await act(async () => {
      gate.resolve(true)
    })

    expect(element.querySelector('.spinner')).toBe(null)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not submit twice while the first attempt is in flight', async () => {
    const gate = deferred()
    const onSubmit = vi.fn((_password: string) => gate.promise)
    const { element } = renderModal({ onSubmit })

    typeInto(passwordInput(element), 'slow one')

    const form = element.querySelector('form')
    if (form === null) throw new Error('test bug: no form')
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)

    await act(async () => {
      gate.resolve(false)
    })
  })
})

/** @vitest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TextComposeModal } from './TextComposeModal'
import type { TextComposeModalProps } from './TextComposeModal'

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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

async function submitForm(element: HTMLElement): Promise<void> {
  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function renderModal(props: Partial<TextComposeModalProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const root: Root = createRoot(element)

  const fullProps: TextComposeModalProps = {
    onSave: vi.fn(),
    onClose: vi.fn(),
    folderName: 'Notes',
    ...props,
  }

  act(() => {
    root.render(<TextComposeModal {...fullProps} />)
  })

  const harness: Harness = {
    element,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      element.remove()
    },
  }

  openHarnesses.push(harness)
  return harness
}

describe('TextComposeModal', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    for (const harness of openHarnesses) {
      harness.unmount()
    }
    openHarnesses.length = 0
  })

  it('renders title with folder name and fields', () => {
    const { element } = renderModal({ folderName: 'Project' })

    expect(element.querySelector('#text-compose-title')?.textContent).toBe('New text note in Project')
    expect(element.querySelector('input[aria-label="Name"]')).not.toBe(null)
    expect(element.querySelector('input[aria-label="Text item"]')).not.toBe(null)
  })

  it('submits composed name and content to onSave and closes', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const { element } = renderModal({ onSave, onClose })

    const nameInput = element.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    const textInput = element.querySelector<HTMLInputElement>('input[aria-label="Text item"]')!

    typeInto(nameInput, 'Grocery List')
    typeInto(textInput, 'Milk, Eggs, Bread')

    await submitForm(element)

    expect(onSave).toHaveBeenCalledWith('Grocery List', 'Milk, Eggs, Bread')
    expect(onClose).toHaveBeenCalled()
  })

  it('defaults name to "Text note" when name is omitted', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const { element } = renderModal({ onSave, onClose })

    const textInput = element.querySelector<HTMLInputElement>('input[aria-label="Text item"]')!
    typeInto(textInput, 'Some quick thought')

    await submitForm(element)

    expect(onSave).toHaveBeenCalledWith('Text note', 'Some quick thought')
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces an error message when onSave rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Quota exceeded'))
    const onClose = vi.fn()
    const { element } = renderModal({ onSave, onClose })

    const nameInput = element.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    typeInto(nameInput, 'Notes')

    await submitForm(element)

    expect(onClose).not.toHaveBeenCalled()
    expect(element.querySelector('.library-modal__error')?.textContent).toContain('Quota exceeded')
  })

  it('stores one row per compose, however many times Save is pressed before the write lands', async () => {
    let releaseSave: () => void = () => {}
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        }),
    )
    const { element } = renderModal({ onSave })

    typeInto(element.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, 'Twice is one too many')
    const form = element.querySelector('form')
    if (form === null) throw new Error('test bug: no form')

    // Both submits in one tick: `busy` is batched, so the latch is what stops the second.
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      releaseSave()
      await Promise.resolve()
    })

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('cancels compose without calling onSave', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    const { element } = renderModal({ onSave, onClose })

    const cancelBtn = element.querySelector<HTMLButtonElement>('.library-modal__cancel')!
    click(cancelBtn)

    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
})

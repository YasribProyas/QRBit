/** @vitest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RichTextComposeModal } from './RichTextComposeModal'
import type { RichTextComposeModalProps } from './RichTextComposeModal'
import { parseRichTextContent } from '../session/items/RichTextItem'

function bySelector(element: HTMLElement, selector: string): HTMLInputElement {
  const node = element.querySelector<HTMLInputElement>(selector)
  if (node === null) throw new Error(`test bug: nothing matches ${selector}`)
  return node
}

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

function editorOf(element: HTMLElement): Editor {
  const dom = element.querySelector('.ProseMirror')
  const editor = (dom as (HTMLElement & { editor?: Editor }) | null)?.editor
  if (!(editor instanceof Editor)) throw new Error('test bug: Tiptap did not mount an editor')
  return editor
}

function renderModal(props: Partial<RichTextComposeModalProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const root: Root = createRoot(element)

  const fullProps: RichTextComposeModalProps = {
    onSave: vi.fn(),
    onClose: vi.fn(),
    folderName: 'Docs',
    ...props,
  }

  act(() => {
    root.render(<RichTextComposeModal {...fullProps} />)
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

describe('RichTextComposeModal', () => {
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
    const { element } = renderModal({ folderName: 'Specs' })

    expect(element.querySelector('#richtext-compose-title')?.textContent).toBe('New rich text note in Specs')
    expect(element.querySelector('input[aria-label="Name"]')).not.toBe(null)
    expect(element.querySelector('.richtext-item')).not.toBe(null)
  })

  it('submits composed rich text note with valid Tiptap JSON content', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const { element } = renderModal({ onSave, onClose })

    const nameInput = element.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    typeInto(nameInput, 'Architecture Plan')

    const editor = editorOf(element)
    act(() => {
      editor.commands.insertContent('Phase 1 details')
    })

    await submitForm(element)

    expect(onSave).toHaveBeenCalledTimes(1)
    const [savedName, savedContent] = onSave.mock.calls[0] as [string, string]
    expect(savedName).toBe('Architecture Plan')

    // Verifies it serializes to the same Tiptap JSON string shape that parseRichTextContent expects
    const parsed = parseRichTextContent(savedContent)
    expect(parsed).toBeDefined()
    expect(parsed?.type).toBe('doc')
    expect(savedContent).toContain('Phase 1 details')
    expect(onClose).toHaveBeenCalled()
  })

  it('defaults name to "Rich text note" when name is omitted', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const { element } = renderModal({ onSave, onClose })

    const editor = editorOf(element)
    act(() => {
      editor.commands.insertContent('Some rich content')
    })

    await submitForm(element)

    expect(onSave).toHaveBeenCalledWith(
      'Rich text note',
      expect.stringContaining('Some rich content'),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces an error message when onSave rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Storage failure'))
    const onClose = vi.fn()
    const { element } = renderModal({ onSave, onClose })

    const nameInput = element.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    typeInto(nameInput, 'Plan')

    await submitForm(element)

    expect(onClose).not.toHaveBeenCalled()
    expect(element.querySelector('.library-modal__error')?.textContent).toContain('Storage failure')
  })

  it('files a named-but-empty note as the document an untouched session editor produces', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { element } = renderModal({ onSave })

    typeInto(bySelector(element, 'input[aria-label="Name"]'), 'Nothing typed yet')
    await submitForm(element)

    const [, savedContent] = onSave.mock.calls[0] as [string, string]
    // The point of the comparison: this app's one and only Tiptap configuration, started
    // empty, is what `RichTextItem` would emit — so a locally authored empty note and a
    // received one are the same string and preview the same way (§6.1).
    const reference = new Editor({ extensions: [StarterKit] })
    try {
      expect(savedContent).toBe(JSON.stringify(reference.getJSON()))
    } finally {
      reference.destroy()
    }
    expect(parseRichTextContent(savedContent)?.type).toBe('doc')
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

/** @vitest-environment jsdom */
/**
 * Tests for `AttachmentPicker` — the only thing in the dossier editor that can put bytes on a
 * block (ORCHESTRATION D16, attachments).
 *
 * It is tested on its refusals rather than its successes, because a picker that accepts the
 * wrong thing is the failure this component exists to replace: an `image` block holding a CSV, or
 * a draft left holding a filename whose bytes never arrived. Every refusal asserts that
 * `onSelect` was NOT called as well as the message being shown, since "said no" and "wrote half a
 * block" are separate failures — and the second one is what would have re-opened the old bug.
 *
 * jsdom has no file dialog, so a choice is injected as a `FileList`-shaped value and `change` is
 * dispatched the way `LockedItemComposeModal.test.tsx` does it.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AttachmentPicker, LIBRARY_ATTACHMENT_MAX_BYTES } from './AttachmentPicker'
import type { AttachmentSelection } from './AttachmentPicker'

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(props: {
  blockType: 'image' | 'fileAttachment'
  maxBytes?: number
}): { onSelect: ReturnType<typeof vi.fn>; onReject: ReturnType<typeof vi.fn> } {
  const onSelect = vi.fn()
  const onReject = vi.fn()

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <AttachmentPicker
        blockType={props.blockType}
        label={props.blockType === 'image' ? 'Choose image' : 'Choose file'}
        maxBytes={props.maxBytes}
        onSelect={(attachment: AttachmentSelection) => {
          onSelect(attachment)
        }}
        onReject={(message: string) => {
          onReject(message)
        }}
      />,
    )
  })

  return { onSelect, onReject }
}

function element(): HTMLDivElement {
  if (container === null) throw new Error('test bug: nothing is mounted')
  return container
}

function picker(): HTMLInputElement {
  const input = element().querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) throw new Error('test bug: the picker rendered no file input')
  return input
}

/** Injects a choice the way the OS would, then fires the change React listens for. */
function choose(file: File | null): void {
  const input = picker()
  Object.defineProperty(input, 'files', {
    value: file === null ? [] : [file],
    configurable: true,
  })

  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function firstRejectMessage(onReject: ReturnType<typeof vi.fn>): string {
  const message = vi.mocked(onReject).mock.calls[0]?.[0]
  if (typeof message !== 'string') throw new Error('test bug: nothing was rejected')
  return message
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
})

describe('AttachmentPicker — a real choice', () => {
  it('hands over the chosen image with its bytes, its name and the measured size', () => {
    const { onSelect, onReject } = mount({ blockType: 'image' })
    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'rig.png', { type: 'image/png' })

    choose(file)

    expect(onSelect).toHaveBeenCalledTimes(1)
    const selection = vi.mocked(onSelect).mock.calls[0]?.[0]
    if (selection === undefined) throw new Error('test bug: no selection was reported')
    expect(selection.blob).toBe(file)
    expect(selection.fileName).toBe('rig.png')
    expect(selection.mimeType).toBe('image/png')
    // The size is measured off the Blob at the moment of choosing — never announced by a label.
    expect(selection.sizeInBytes).toBe(file.size)
    expect(selection.sizeInBytes).toBe(5)
    expect(onReject).not.toHaveBeenCalled()
  })

  it('scopes accept to the block type, and takes any file for an attachment block', () => {
    const { onSelect } = mount({ blockType: 'image' })
    expect(picker().accept).toBe('image/*')

    const csv = new File(['a,b,c'], 'export.csv', { type: 'text/csv' })
    choose(csv)
    // Refused on an image block, because the type check is real and `accept` is only a hint.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('accepts a file with no announced type on an attachment block', () => {
    const { onSelect } = mount({ blockType: 'fileAttachment' })
    expect(picker().accept).toBe('')

    const blobby = new File(['data'], 'weights.dat')
    choose(blobby)

    const selection = vi.mocked(onSelect).mock.calls[0]?.[0]
    if (selection === undefined) throw new Error('test bug: the picker refused a plain file')
    expect(selection.mimeType).toBe('')
    expect(selection.sizeInBytes).toBe(4)
  })

  it('clears the input after a choice, so picking the same file twice still fires a change', () => {
    const { onSelect } = mount({ blockType: 'fileAttachment' })
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })

    choose(file)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(picker().value).toBe('')

    choose(file)
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('says nothing when the dialog closed without a choice', () => {
    const { onSelect, onReject } = mount({ blockType: 'image' })

    choose(null)

    expect(onSelect).not.toHaveBeenCalled()
    expect(onReject).not.toHaveBeenCalled()
  })
})

describe('AttachmentPicker — refusals leave the block alone', () => {
  it('refuses a non-image on an image block, names it, and selects nothing', () => {
    const { onSelect, onReject } = mount({ blockType: 'image' })

    choose(new File(['not a picture'], 'payload.csv', { type: 'text/csv' }))

    expect(onSelect).not.toHaveBeenCalled()
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(firstRejectMessage(onReject)).toContain('payload.csv')
    expect(firstRejectMessage(onReject)).toContain('image/')
  })

  it('refuses a file above the cap, quotes the cap in bytes, and selects nothing', () => {
    // A 10-byte cap is stated by the test rather than allocating 64 MiB; the enforcement is the
    // same comparison, and the default is pinned separately below.
    const { onSelect, onReject } = mount({ blockType: 'fileAttachment', maxBytes: 10 })

    choose(new File(['0123456789A'], 'over.txt', { type: 'text/plain' }))

    expect(onSelect).not.toHaveBeenCalled()
    expect(firstRejectMessage(onReject)).toContain('10 B')
  })

  it('takes a file that is exactly the cap', () => {
    const { onSelect } = mount({ blockType: 'fileAttachment', maxBytes: 10 })

    choose(new File(['0123456789'], 'exact.txt', { type: 'text/plain' }))

    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('documents the library cap as 64 MiB', () => {
    expect(LIBRARY_ATTACHMENT_MAX_BYTES).toBe(64 * 1024 * 1024)
  })
})

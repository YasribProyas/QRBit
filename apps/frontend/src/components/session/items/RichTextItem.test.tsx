/** @vitest-environment jsdom */
/**
 * RichTextItem tests (PLAN.md §9, §16 Phase 3 "RichTextItem: Tiptap integration,
 * JSON delta sync").
 *
 * Three behaviours carry the risk here, so all three are pinned against the real
 * Tiptap editor rather than a fake:
 *
 *   1. a local edit reaches the items API as the document's JSON (the sender's
 *      half of the sync),
 *   2. incoming content is applied *without* emitting an update — the feedback
 *      loop that would otherwise bounce the receiver's document back at the
 *      sender forever,
 *   3. the editor is destroyed when the component unmounts. Tiptap's own
 *      `useEditor` owns that and schedules the destruction on the next tick, so
 *      the test waits for it.
 *
 * The editor instance is reached through the DOM: Tiptap attaches it to the
 * ProseMirror element (`dom.editor`). A local edit is then a real editor command,
 * which exercises the same `update` event a keystroke produces.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RichTextItem, parseRichTextContent } from './RichTextItem'
import type { RichTextItemViewProps } from './RichTextItem'
import type { RichTextItem as RichTextItemModel } from '../../../store/sessionStore'

/** A minimal Tiptap document containing exactly `text`. */
function docWith(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
}

function makeItem(overrides: Partial<RichTextItemModel> = {}): RichTextItemModel {
  return {
    id: 'rt-1',
    type: 'richtext',
    status: 'complete',
    createdAt: 1,
    content: docWith('start'),
    ...overrides,
  }
}

function editorOf(element: HTMLElement): Editor {
  const dom = element.querySelector('.ProseMirror')
  const editor = (dom as (HTMLElement & { editor?: Editor }) | null)?.editor
  if (!(editor instanceof Editor)) throw new Error('test bug: Tiptap did not mount an editor')
  return editor
}

interface Harness {
  element: HTMLDivElement
  update: (next: Partial<RichTextItemViewProps>) => void
  unmount: () => void
}

const openHarnesses: Harness[] = []
const onChange = vi.fn()

function renderItem(overrides: Partial<RichTextItemViewProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const created: Root = createRoot(element)

  let props: RichTextItemViewProps = {
    item: makeItem(),
    editable: true,
    onChange,
    ...overrides,
  }

  act(() => {
    created.render(createElement(RichTextItem, props))
  })

  const harness: Harness = {
    element,
    update: (next) => {
      props = { ...props, ...next }
      act(() => {
        created.render(createElement(RichTextItem, props))
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

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
})

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  // Tiptap destroys an unmounted editor on a timer; letting it fire here keeps
  // each test's destruction out of the next test's assertions.
  await new Promise((resolve) => setTimeout(resolve, 5))
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('RichTextItem — sender (PLAN.md §9)', () => {
  it('mounts an editable editor holding the item content', () => {
    const { element } = renderItem({ item: makeItem({ content: docWith('already here') }) })

    expect(element.textContent).toContain('already here')
    expect(editorOf(element).isEditable).toBe(true)
  })

  it('sends every edit to the items API as document JSON', () => {
    const { element } = renderItem({ item: makeItem({ id: 'rt-9' }) })
    const editor = editorOf(element)

    act(() => {
      editor.commands.insertContent('typed')
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    const [id, json] = onChange.mock.calls[0] as [string, string]
    expect(id).toBe('rt-9')
    expect(JSON.parse(json)).toMatchObject({ type: 'doc' })
    expect(json).toContain('typed')
  })

  it('never lets the store overwrite what the sender is typing', () => {
    const { element, update } = renderItem({ item: makeItem({ content: docWith('start') }) })
    const editor = editorOf(element)

    act(() => {
      editor.commands.insertContent('typed here')
    })
    // The sender's own update is still in the API's debounce window, so the store
    // still carries the older document.
    update({ item: makeItem({ content: docWith('start') }) })

    expect(element.textContent).toContain('typed here')
  })
})

describe('RichTextItem — receiver (PLAN.md §9)', () => {
  it('renders read-only and applies the peer content as it arrives', () => {
    const { element, update } = renderItem({ item: makeItem({ content: docWith('one') }), editable: false })

    expect(editorOf(element).isEditable).toBe(false)
    expect(element.textContent).toContain('one')

    update({ item: makeItem({ content: docWith('one two') }) })

    expect(element.textContent).toContain('one two')
  })

  it('does not emit updates when it applies incoming content (no feedback loop)', () => {
    const { element, update } = renderItem({ item: makeItem({ content: docWith('one') }), editable: false })

    update({ item: makeItem({ content: docWith('two') }) })
    update({ item: makeItem({ content: docWith('three') }) })

    expect(element.textContent).toContain('three')
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('RichTextItem lifecycle', () => {
  it('destroys the editor when the item leaves the board', async () => {
    const destroy = vi.spyOn(Editor.prototype, 'destroy')
    const { element, unmount } = renderItem()

    const editor = editorOf(element)
    expect(editor.isDestroyed).toBe(false)

    unmount()
    // Tiptap schedules the destruction a tick after unmount so that React 19's
    // StrictMode remount does not lose the instance.
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(editor.isDestroyed).toBe(true)
    destroy.mockRestore()
  })
})

describe('parseRichTextContent', () => {
  it('reads a document out of the item JSON and rejects anything else', () => {
    expect(parseRichTextContent(docWith('x'))).toMatchObject({ type: 'doc' })
    expect(parseRichTextContent('')).toBeUndefined()
    expect(parseRichTextContent('not json')).toBeUndefined()
    expect(parseRichTextContent('[1,2,3]')).toBeUndefined()
    expect(parseRichTextContent('{"content":[]}')).toBeUndefined()
    expect(parseRichTextContent('"a string"')).toBeUndefined()
  })
})

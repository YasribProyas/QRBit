/** @vitest-environment jsdom */
/**
 * TextItem tests (PLAN.md §9, §16 Phase 3 "TextItem: real-time sync").
 *
 * The component has exactly two behaviours to protect: the sender's keystrokes reach
 * the items API without a second debounce (the 100ms one belongs to the API —
 * PLAN.md §19 decision 8), and the receiver renders the store's content read-only,
 * with no input of its own. Both are props-driven here; the store → view path is
 * covered by SessionBoard.test.tsx.
 *
 * jsdom ships no renderer and this repo has no rendering library, so React's own
 * `act` + `createRoot` are used, as in `hooks/useWebRTC.test.tsx`.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TextItem } from './TextItem'
import type { TextItemViewProps } from './TextItem'
import type { TextItem as TextItemModel } from '../../../store/sessionStore'

function makeItem(overrides: Partial<TextItemModel> = {}): TextItemModel {
  return { id: 'item-1', type: 'text', status: 'complete', createdAt: 1, content: '', ...overrides }
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

interface Harness {
  element: HTMLDivElement
  /** Re-render with new props — how the store hands a receiver its next content. */
  update: (next: Partial<TextItemViewProps>) => void
  unmount: () => void
}

const openHarnesses: Harness[] = []
const onChange = vi.fn()

function renderItem(overrides: Partial<TextItemViewProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const created: Root = createRoot(element)

  let props: TextItemViewProps = {
    item: makeItem(),
    editable: true,
    onChange,
    ...overrides,
  }

  act(() => {
    created.render(createElement(TextItem, props))
  })

  const harness: Harness = {
    element,
    update: (next) => {
      props = { ...props, ...next }
      act(() => {
        created.render(createElement(TextItem, props))
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

function inputOf(element: HTMLElement): HTMLInputElement {
  const input = element.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error('test bug: no input rendered')
  return input
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

describe('TextItem — sender (PLAN.md §9)', () => {
  it('initialises the input from content the item already carries', () => {
    const { element } = renderItem({ item: makeItem({ content: 'already here' }) })

    expect(inputOf(element).value).toBe('already here')
  })

  it('forwards every keystroke to the items API, with no debounce of its own', () => {
    const { element } = renderItem({ item: makeItem({ id: 'abc' }) })
    const input = inputOf(element)

    typeInto(input, 'h')
    typeInto(input, 'hi')
    typeInto(input, 'hi!')

    expect(onChange).toHaveBeenCalledTimes(3)
    expect(onChange).toHaveBeenNthCalledWith(1, 'abc', 'h')
    expect(onChange).toHaveBeenNthCalledWith(3, 'abc', 'hi!')
  })

  it('shows what was typed even before the store catches up', () => {
    const { element } = renderItem()
    const input = inputOf(element)

    typeInto(input, 'draft')

    expect(inputOf(element).value).toBe('draft')
  })
})

describe('TextItem — receiver (PLAN.md §9)', () => {
  it('renders the content read-only, with no input', () => {
    const { element } = renderItem({
      item: makeItem({ content: 'hello from the other side' }),
      editable: false,
    })

    expect(element.querySelector('input')).toBe(null)
    expect(element.textContent).toContain('hello from the other side')
  })

  it('follows the store as deltas land, without ever calling the API', () => {
    const { element, update } = renderItem({ item: makeItem({ content: 'one' }), editable: false })
    expect(element.textContent).toContain('one')

    update({ item: makeItem({ content: 'one two' }) })

    expect(element.textContent).toContain('one two')
    expect(onChange).not.toHaveBeenCalled()
  })
})

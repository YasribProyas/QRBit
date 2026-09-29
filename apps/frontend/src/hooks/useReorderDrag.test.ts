/** @vitest-environment jsdom */
/**
 * Tests for `useReorderDrag` (ORCHESTRATION D16.2/D16.3).
 *
 * **The harness, and why it looks like this.** jsdom 30 implements neither the
 * `PointerEvent` constructor nor `Element.setPointerCapture`, and React 19 needs the
 * container to be in the document for an event to reach it — while the hook's own
 * `pointermove`/`pointerup` listeners are on `window`, which a detached tree can never
 * reach. So the file does three things a browser would do for it, before driving anything:
 *
 *   1. a `PointerEvent` subclass of `MouseEvent` carrying the three fields the hook reads
 *      (`pointerId`, `pointerType`, `isPrimary`). Dispatching a bare `MouseEvent` under the
 *      name `pointerdown` would have left `pointerId` undefined, and the hook's per-pointer
 *      matching would then never be exercised — so the fake carries real values rather than
 *      being a type lie;
 *   2. `setPointerCapture`/`hasPointerCapture`/`releasePointerCapture` recording calls, so
 *      "the capture is released" is an assertion instead of an aspiration;
 *   3. the container is appended to `document.body`, and every event is dispatched on a real
 *      element with `bubbles: true`, so it travels the path a browser takes.
 *
 * jsdom has no layout engine: every `offsetTop`/`offsetHeight` is 0. Tests therefore pass
 * `getItemHeight` explicitly for the drag math (which is what the hook delegates to
 * `lib/reorder.ts` for), and two tests stub `offsetTop` on the row elements themselves to
 * prove the DOM-measurement path and its `DEFAULT_ITEM_HEIGHT` fallback. `lib/reorder.test.ts`
 * owns the index math itself; this file only checks the hook drives it correctly.
 *
 * No JSX: the task assigns this file a `.ts` name, so rows are built with `createElement`
 * and the `data-reorder-item` marker is set through the DOM.
 */

import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useReorderDrag } from './useReorderDrag'
import { REORDER_ITEM_ATTRIBUTE } from './useReorderDrag'
import type { UseReorderDragResult } from './useReorderDrag'

// ---------------------------------------------------------------------------
// The three things a browser would provide
// ---------------------------------------------------------------------------

interface PointerInit {
  pointerId?: number
  pointerType?: string
  isPrimary?: boolean
  clientY?: number
  button?: number
}

class HarnessPointerEvent extends MouseEvent {
  readonly pointerId: number
  readonly pointerType: string
  readonly isPrimary: boolean

  constructor(type: string, init: PointerInit = {}) {
    super(type, {
      bubbles: true,
      cancelable: true,
      clientY: init.clientY ?? 0,
      button: init.button ?? 0,
    })
    this.pointerId = init.pointerId ?? 1
    this.pointerType = init.pointerType ?? 'mouse'
    this.isPrimary = init.isPrimary ?? true
  }
}

const captureLog: string[] = []
const captured = new WeakMap<Element, number>()

function installPointerApi(): void {
  Object.defineProperty(globalThis, 'PointerEvent', {
    value: HarnessPointerEvent,
    configurable: true,
    writable: true,
  })

  Element.prototype.setPointerCapture = function (pointerId: number): void {
    captureLog.push(`set ${pointerId}`)
    captured.set(this, pointerId)
  }
  Element.prototype.hasPointerCapture = function (pointerId: number): boolean {
    return captured.get(this) === pointerId
  }
  Element.prototype.releasePointerCapture = function (pointerId: number): void {
    captureLog.push(`release ${pointerId}`)
    if (captured.get(this) === pointerId) captured.delete(this)
  }
}

installPointerApi()

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

interface ProbeProps {
  length: number
  onMove(from: number, to: number): void
  getItemHeight?(index: number): number
}

let rendered: UseReorderDragResult | null = null

function Probe(props: ProbeProps): ReactNode {
  const api = useReorderDrag({
    length: props.length,
    onMove: props.onMove,
    getItemHeight: props.getItemHeight,
  })
  rendered = api

  const rows: ReactNode[] = []
  for (let index = 0; index < props.length; index += 1) {
    rows.push(
      createElement('li', { key: `row-${index}` }, createElement('span', null, createElement('button', api.getHandleProps(index)))),
    )
  }
  return createElement('ul', null, rows)
}

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

function renderProbe(props: ProbeProps): void {
  rendered = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(createElement(Probe, props))
  })
}

function rerenderProbe(props: ProbeProps): void {
  rendered = null
  act(() => {
    root?.render(createElement(Probe, props))
  })
}

function unmountProbe(): void {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
}

function api(): UseReorderDragResult {
  if (rendered === null) throw new Error('test bug: the probe never rendered')
  return rendered
}

function handleAt(index: number): HTMLButtonElement {
  const handle = container?.querySelectorAll('button')[index]
  if (handle === undefined) throw new Error(`test bug: no handle at index ${index}`)
  return handle
}

/** The `<li>` that owns a handle — the row the hook measures. */
function rowAt(index: number): HTMLLIElement {
  const row = container?.querySelectorAll('li')[index]
  if (row === undefined) throw new Error(`test bug: no row at index ${index}`)
  return row
}

function pointerDown(handle: HTMLElement, clientY: number, init: PointerInit = {}): void {
  act(() => {
    handle.dispatchEvent(new HarnessPointerEvent('pointerdown', { clientY, ...init }))
  })
}

function pointerMove(clientY: number, init: PointerInit = {}): void {
  act(() => {
    // On the body, not the handle: a pointer outside the grip still has to drive the drag.
    document.body.dispatchEvent(new HarnessPointerEvent('pointermove', { clientY, ...init }))
  })
}

function pointerEnd(type: 'pointerup' | 'pointercancel', target: Element = document.body): void {
  act(() => {
    target.dispatchEvent(new HarnessPointerEvent(type, {}))
  })
}

function pressKey(key: string, target: Element, init: { ctrlKey?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

/** A 40px list: the pitch every drag test translates into indices. */
const ROW = 40

// ---------------------------------------------------------------------------

beforeEach(() => {
  captureLog.length = 0
})

afterEach(() => {
  unmountProbe()
  document.body.replaceChildren()
})

describe('useReorderDrag pointer path', () => {
  it('starts a drag on pointerdown and reports the live position', () => {
    renderProbe({ length: 4, onMove: () => {}, getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)

    expect(api().drag).toEqual({ from: 0, to: 0, offset: 0 })
    // The pointer capture the hook takes is the one it must hand back.
    expect(captureLog).toEqual(['set 1'])
  })

  it('announces onMove exactly once, on release, and never during the drag', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 4, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)
    pointerMove(140)
    expect(api().drag).toEqual({ from: 0, to: 1, offset: 40 })
    pointerMove(190)
    expect(api().drag).toEqual({ from: 0, to: 2, offset: 90 })
    expect(moves).toEqual([])

    pointerEnd('pointerup', handleAt(0))

    expect(moves).toEqual([[0, 2]])
    expect(api().drag).toBeNull()
    expect(captureLog).toEqual(['set 1', 'release 1'])
  })

  it('counts a row by its own pitch when the rows differ in height', () => {
    const moves: Array<[number, number]> = []
    const heights = [10, 100, 10]
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]), getItemHeight: (index) => heights[index] ?? 10 })

    pointerDown(handleAt(0), 5)
    // 60px down is row 1 of [10, 100, 10]. A single averaged pitch would call it row 2,
    // which is the bug the per-row form of `resolveTargetIndex` exists to avoid.
    pointerMove(65)
    expect(api().drag).toEqual({ from: 0, to: 1, offset: 60 })

    pointerEnd('pointerup')
    expect(moves).toEqual([[0, 1]])
  })

  it('announces nothing when the row is released where it started', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(1), 100)
    pointerMove(110)
    expect(api().drag).toEqual({ from: 1, to: 1, offset: 10 })
    pointerEnd('pointerup')

    expect(moves).toEqual([])
    expect(api().drag).toBeNull()
  })

  it('ends on a pointerup outside the handle', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)
    pointerEnd('pointerup', document.body)

    // Released before it moved anywhere: the drag is over, nothing was reordered.
    expect(moves).toEqual([])
    expect(api().drag).toBeNull()
    expect(captureLog).toEqual(['set 1', 'release 1'])
  })

  it('commits a completed drag that is released over another element', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)
    pointerMove(180)
    pointerEnd('pointerup', rowAt(2))

    expect(moves).toEqual([[0, 2]])
  })

  it('cancels on Escape without announcing', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 4, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)
    pointerMove(220)
    expect(api().drag).toEqual({ from: 0, to: 3, offset: 120 })

    pressKey('Escape', document.body)

    expect(moves).toEqual([])
    expect(api().drag).toBeNull()
    expect(captureLog).toEqual(['set 1', 'release 1'])
  })

  it('cancels on pointercancel without announcing', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 4, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)
    pointerMove(220)
    pointerEnd('pointercancel')

    expect(moves).toEqual([])
    expect(api().drag).toBeNull()
  })

  it('ignores a pointermove from a different pointer', () => {
    renderProbe({ length: 4, onMove: () => {}, getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100, { pointerId: 7 })
    pointerMove(220, { pointerId: 8 })
    expect(api().drag).toEqual({ from: 0, to: 0, offset: 0 })

    pointerMove(220, { pointerId: 7 })
    expect(api().drag).toEqual({ from: 0, to: 3, offset: 120 })
  })

  it('ignores a secondary button and a second finger', () => {
    renderProbe({ length: 3, onMove: () => {}, getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100, { button: 2 })
    expect(api().drag).toBeNull()

    pointerDown(handleAt(0), 100, { isPrimary: false })
    expect(api().drag).toBeNull()

    // A real grab still works afterwards, and only one drag is live at a time.
    pointerDown(handleAt(0), 100)
    pointerDown(handleAt(1), 140)
    expect(api().drag).toEqual({ from: 0, to: 0, offset: 0 })
  })

  it('serves touch through the same path as mouse', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(2), 200, { pointerType: 'touch', pointerId: 11 })
    pointerMove(120, { pointerType: 'touch', pointerId: 11 })
    expect(api().drag).toEqual({ from: 2, to: 0, offset: -80 })
    pointerEnd('pointerup')

    expect(moves).toEqual([[2, 0]])
  })

  it('clamps a drop dragged past either end of the list', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)
    pointerMove(9_000)
    expect(api().drag?.to).toBe(2)
    pointerEnd('pointerup')

    pointerDown(handleAt(2), 400)
    pointerMove(-9_000)
    expect(api().drag?.to).toBe(0)
    pointerEnd('pointerup')

    expect(moves).toEqual([
      [0, 2],
      [2, 0],
    ])
  })

  it('removes its window listeners when the drag ends', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)
    pointerMove(140)
    pointerEnd('pointerup')
    expect(moves).toEqual([[0, 1]])

    // A stray move and a stray release afterwards change nothing and announce nothing.
    pointerMove(900)
    pointerEnd('pointerup')
    expect(moves).toEqual([[0, 1]])
    expect(api().drag).toBeNull()
  })

  it('ends the drag on unmount without announcing into a tree that is gone', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 4, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)
    pointerMove(220)
    expect(api().drag).toEqual({ from: 0, to: 3, offset: 120 })

    unmountProbe()
    expect(moves).toEqual([])

    // The listeners are gone: a release after the unmount is not heard at all.
    document.body.dispatchEvent(new HarnessPointerEvent('pointerup', {}))
    expect(moves).toEqual([])
  })

  it('announces nothing when the grabbed row leaves the list mid-drag', () => {
    const moves: Array<[number, number]> = []
    const onMove = (from: number, to: number): void => {
      moves.push([from, to])
    }

    renderProbe({ length: 3, onMove, getItemHeight: () => ROW })
    pointerDown(handleAt(2), 200)
    pointerMove(120)
    expect(api().drag).toEqual({ from: 2, to: 0, offset: -80 })

    // Two rows deleted: index 2 no longer exists, so the release must not move row 0.
    rerenderProbe({ length: 1, onMove, getItemHeight: () => ROW })
    pointerEnd('pointerup')

    expect(moves).toEqual([])
    expect(api().drag).toBeNull()
  })

  it('clamps the announced index to a list that shrank around it', () => {
    const moves: Array<[number, number]> = []
    const onMove = (from: number, to: number): void => {
      moves.push([from, to])
    }

    renderProbe({ length: 4, onMove, getItemHeight: () => ROW })
    pointerDown(handleAt(0), 100)
    pointerMove(220)
    expect(api().drag).toEqual({ from: 0, to: 3, offset: 120 })

    // One row deleted from the end: the drop lands on the row that is still there.
    rerenderProbe({ length: 3, onMove, getItemHeight: () => ROW })
    pointerEnd('pointerup')

    expect(moves).toEqual([[0, 2]])
  })

  it('keeps dragging against the current length after a rerender', () => {
    renderProbe({ length: 2, onMove: () => {}, getItemHeight: () => ROW })
    pointerDown(handleAt(0), 100)
    pointerMove(220)
    expect(api().drag?.to).toBe(1)

    rerenderProbe({ length: 5, onMove: () => {}, getItemHeight: () => ROW })
    pointerMove(220)
    expect(api().drag?.to).toBe(3)
  })

  it('still drags on a browser that has no pointer capture', () => {
    const setCapture = Element.prototype.setPointerCapture
    const hasCapture = Element.prototype.hasPointerCapture
    const releaseCapture = Element.prototype.releasePointerCapture
    Reflect.deleteProperty(Element.prototype, 'setPointerCapture')
    Reflect.deleteProperty(Element.prototype, 'hasPointerCapture')
    Reflect.deleteProperty(Element.prototype, 'releasePointerCapture')

    try {
      const moves: Array<[number, number]> = []
      renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

      pointerDown(handleAt(0), 100)
      pointerMove(180)
      pointerEnd('pointerup')

      expect(moves).toEqual([[0, 2]])
      expect(captureLog).toEqual([])
    } finally {
      Element.prototype.setPointerCapture = setCapture
      Element.prototype.hasPointerCapture = hasCapture
      Element.prototype.releasePointerCapture = releaseCapture
    }
  })

  it('drags a touch list with no getItemHeight, at the default pitch', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 4, onMove: (from, to) => moves.push([from, to]) })

    pointerDown(handleAt(0), 100)
    // jsdom lays nothing out, so every measurement comes back 0 and the hook falls back to
    // DEFAULT_ITEM_HEIGHT (48px) rather than treating every row as one pixel tall.
    pointerMove(100)
    expect(api().drag).toEqual({ from: 0, to: 0, offset: 0 })
    pointerMove(148)
    expect(api().drag).toEqual({ from: 0, to: 1, offset: 48 })
    pointerEnd('pointerup')

    expect(moves).toEqual([[0, 1]])
  })

  it('measures the row marked data-reorder-item, not the button inside it', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 4, onMove: (from, to) => moves.push([from, to]) })

    // Rows 120px apart. The button is nested in a span, so only the `data-reorder-item`
    // ancestor can be the row: measuring the handle's own parent would give a 0px pitch and
    // the fallback 48px, and a 100px drag would then read as two rows instead of one.
    rowAt(0).setAttribute(REORDER_ITEM_ATTRIBUTE, '')
    rowAt(1).setAttribute(REORDER_ITEM_ATTRIBUTE, '')
    rowAt(2).setAttribute(REORDER_ITEM_ATTRIBUTE, '')
    rowAt(3).setAttribute(REORDER_ITEM_ATTRIBUTE, '')
    for (const [index, row] of [rowAt(0), rowAt(1), rowAt(2), rowAt(3)].entries()) {
      Object.defineProperty(row, 'offsetTop', { configurable: true, get: () => index * 120 })
      Object.defineProperty(row, 'offsetHeight', { configurable: true, get: () => 100 })
    }

    pointerDown(handleAt(0), 1_000)
    pointerMove(1_100)
    expect(api().drag).toEqual({ from: 0, to: 1, offset: 100 })

    pointerEnd('pointerup')
    expect(moves).toEqual([[0, 1]])
  })
})

describe('useReorderDrag handle props (the keyboard twin, D16.3)', () => {
  it('describes itself as a button grip with the label and touch-action a row needs', () => {
    renderProbe({ length: 3, onMove: () => {} })

    const props = api().getHandleProps(1)
    expect(props.type).toBe('button')
    expect(props['aria-label']).toBe('Reorder item 2 of 3')
    expect(props.style.touchAction).toBe('none')

    // The rendered button really is what the props say.
    expect(handleAt(1).getAttribute('type')).toBe('button')
    expect(handleAt(1).getAttribute('aria-label')).toBe('Reorder item 2 of 3')
    expect(handleAt(1).style.touchAction).toBe('none')
  })

  it('moves a row with the arrow keys, announcing each press', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 4, onMove: (from, to) => moves.push([from, to]) })

    pressKey('ArrowDown', handleAt(1))
    pressKey('ArrowUp', handleAt(1))
    expect(moves).toEqual([
      [1, 2],
      [1, 0],
    ])
  })

  it('moves a row to the ends of the list with Home and End', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 4, onMove: (from, to) => moves.push([from, to]) })

    expect(pressKey('End', handleAt(1)).defaultPrevented).toBe(true)
    pressKey('Home', handleAt(2))
    expect(moves).toEqual([
      [1, 3],
      [2, 0],
    ])
  })

  it('leaves an edge press to the browser instead of scrolling or wrapping', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]) })

    expect(pressKey('ArrowUp', handleAt(0)).defaultPrevented).toBe(false)
    expect(pressKey('Home', handleAt(0)).defaultPrevented).toBe(false)
    expect(pressKey('ArrowDown', handleAt(2)).defaultPrevented).toBe(false)
    expect(pressKey('End', handleAt(2)).defaultPrevented).toBe(false)
    expect(moves).toEqual([])
  })

  it('does not swallow browser shortcuts or other keys', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]) })

    expect(pressKey('ArrowDown', handleAt(0), { ctrlKey: true }).defaultPrevented).toBe(false)
    pressKey('Enter', handleAt(0))
    pressKey('a', handleAt(0))
    expect(moves).toEqual([])
  })

  it('ignores the keyboard while a pointer drag is live', () => {
    const moves: Array<[number, number]> = []
    renderProbe({ length: 3, onMove: (from, to) => moves.push([from, to]), getItemHeight: () => ROW })

    pointerDown(handleAt(0), 100)
    pressKey('ArrowDown', handleAt(0))
    expect(moves).toEqual([])

    pointerEnd('pointerup')
    pressKey('ArrowDown', handleAt(0))
    expect(moves).toEqual([[0, 1]])
  })

  it('counts the keyboard against the current list length', () => {
    const moves: Array<[number, number]> = []
    const onMove = (from: number, to: number): void => {
      moves.push([from, to])
    }

    renderProbe({ length: 5, onMove })
    rerenderProbe({ length: 2, onMove })

    // Three rows vanished. The last row of the list is now index 1, so `ArrowDown` on it
    // does nothing and `End` means index 1 — not the 4 the render before remembered.
    expect(pressKey('ArrowDown', handleAt(1)).defaultPrevented).toBe(false)
    expect(pressKey('End', handleAt(0)).defaultPrevented).toBe(true)
    expect(moves).toEqual([[0, 1]])
  })
})

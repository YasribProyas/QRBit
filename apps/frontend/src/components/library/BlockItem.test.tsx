/** @vitest-environment jsdom */
/**
 * Behaviour tests for a single dossier row (ORCHESTRATION D16.2/D16.3, spec row 6).
 *
 * The row used to render a `GripVertical` that did nothing — an affordance and a lie. These
 * tests pin the row contract that makes it true:
 *
 *   - the grip is a real `<button>` carrying the props `useReorderDrag` hands out (its
 *     `aria-label`, its `touch-action: none`), so a pointer can grab it and a keyboard can
 *     focus it;
 *   - the row itself carries `data-reorder-item`, one per row and in list order, dividers
 *     included — the hook counts those markers to measure pitch, and a row that hides from the
 *     count shifts every index under a drag;
 *   - the grabbed row is translated by the offset the hook reports, `onMove` fires once and
 *     only on release, and a cancelled drag leaves neither a translation nor an announcement;
 *   - ArrowUp/ArrowDown/Home/End on the grip announce the same moves the pointer would
 *     (the keyboard twin, D16.3);
 *   - the visible up/down buttons still fire `onMoveUp`/`onMoveDown` with their own row index
 *     and disable themselves at the ends of the list;
 *   - typing in a block calls `onUpdate` with that block's id and only the changed fields, and
 *     does not touch the order — the row has no save path, because D16.1 moved saving into
 *     the editor.
 *
 * `Harness` wires the rows through the real hook and the real `moveIndex`, exactly the way
 * `FileEditView` does, because testing the grip against a stubbed handle would prove nothing
 * about the grip.
 *
 * jsdom 30 has no `PointerEvent`, so the fake extends `MouseEvent` and carries the three fields
 * the hook actually reads; dispatching a bare `MouseEvent` named `pointerdown` would leave
 * `pointerId` undefined and the hook's per-pointer matching would silently never fire. jsdom
 * also has no layout: rows measure 0 and the hook falls back to `DEFAULT_ITEM_HEIGHT` (48px),
 * so drags are stated in pitches of 48.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BlockItem } from './BlockItem'
import { useReorderDrag } from '../../hooks/useReorderDrag'
import { DEFAULT_ITEM_HEIGHT, moveIndex } from '../../lib/reorder'
import type { FileBlock } from '../../lib/library'

// ---------------------------------------------------------------------------
// The pointer API jsdom does not have
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function heading(id: string, content: string): FileBlock {
  return { id, type: 'heading', content }
}

const BLOCKS: FileBlock[] = [
  heading('b-1', 'Alpha'),
  heading('b-2', 'Bravo'),
  heading('b-3', 'Charlie'),
]

/** A divider renders a different root element, so it is the row that could fall out of the count. */
const WITH_DIVIDER: FileBlock[] = [
  heading('b-1', 'Alpha'),
  { id: 'd-1', type: 'divider' },
  heading('b-3', 'Charlie'),
]

// ---------------------------------------------------------------------------
// The harness: the same wiring FileEditView uses
// ---------------------------------------------------------------------------

interface HarnessProps {
  blocks: FileBlock[]
  mode?: 'edit' | 'sender' | 'receiver'
  onMove?(from: number, to: number): void
  onUpdate?(id: string, changes: Partial<FileBlock>): void
  onMoveUp?(index: number): void
  onMoveDown?(index: number): void
}

function Harness(props: HarnessProps): ReactNode {
  const [rows, setRows] = useState(props.blocks)
  const { drag, getHandleProps } = useReorderDrag({
    length: rows.length,
    onMove: (from, to) => {
      props.onMove?.(from, to)
      setRows((current) => moveIndex(current, from, to))
    },
  })

  return (
    <div className="space-y-3">
      {rows.map((block, index) => (
        <BlockItem
          key={block.id}
          block={block}
          index={index}
          totalBlocks={rows.length}
          mode={props.mode ?? 'edit'}
          onUpdate={(id, changes) => {
            // The same reducer the editor runs: the row is controlled, so what it announces
            // is what comes back down as props.
            props.onUpdate?.(id, changes)
            setRows((current) =>
              current.map((row) => (row.id === id ? { ...row, ...changes } : row)),
            )
          }}
          onMoveUp={props.onMoveUp}
          onMoveDown={props.onMoveDown}
          reorderHandleProps={getHandleProps(index)}
          isReorderDragging={drag?.from === index}
          reorderOffset={drag !== null && drag.from === index ? drag.offset : 0}
        />
      ))}
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(props: HarnessProps): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<Harness {...props} />)
  })
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
})

function element(): HTMLDivElement {
  if (container === null) throw new Error('test bug: nothing is mounted')
  return container
}

/** The rows the hook can see, in list order. */
function markedRows(): HTMLElement[] {
  return Array.from(element().querySelectorAll('[data-reorder-item]')) as HTMLElement[]
}

function grips(): HTMLButtonElement[] {
  return Array.from(element().querySelectorAll('button')).filter((button) =>
    (button.getAttribute('aria-label') ?? '').startsWith('Reorder item'),
  ) as HTMLButtonElement[]
}

function gripAt(index: number): HTMLButtonElement {
  const grip = grips()[index]
  if (grip === undefined) throw new Error('test bug: no grip at index ' + index)
  return grip
}

function arrowIn(rowIndex: number, direction: 'up' | 'down'): HTMLButtonElement {
  const row = markedRows()[rowIndex]
  if (row === undefined) throw new Error('test bug: no row at index ' + rowIndex)
  const wanted = direction === 'up' ? ' block up' : ' block down'
  const button = Array.from(row.querySelectorAll('button')).find((candidate) =>
    (candidate.getAttribute('aria-label') ?? '').endsWith(wanted),
  )
  if (button === undefined) throw new Error(`test bug: no "${direction}" arrow in row ${rowIndex}`)
  return button as HTMLButtonElement
}

function headingInputs(): HTMLInputElement[] {
  return Array.from(
    element().querySelectorAll<HTMLInputElement>('input[placeholder="Enter section heading..."]'),
  )
}

function headingInput(index: number): HTMLInputElement {
  const input = headingInputs()[index]
  if (input === undefined) throw new Error('test bug: no heading input at index ' + index)
  return input
}

/** The rendered heading texts, in document order — what the user sees the list as. */
function headingOrder(): string[] {
  return headingInputs().map((input) => input.value)
}

function click(button: HTMLElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: input value has no setter')
  setter.call(input, value)
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pointerDown(handle: HTMLElement, clientY: number): void {
  act(() => {
    handle.dispatchEvent(new HarnessPointerEvent('pointerdown', { clientY }))
  })
}

function pointerMove(clientY: number): void {
  act(() => {
    // On the window, not the grip: a pointer that strays off the handle still drives the drag.
    window.dispatchEvent(new HarnessPointerEvent('pointermove', { clientY }))
  })
}

function pointerUp(): void {
  act(() => {
    window.dispatchEvent(new HarnessPointerEvent('pointerup', { clientY: 0 }))
  })
}

function pressOn(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** Grabs row `from` and travels it to row `to`, one pitch at a time. */
function drag(from: number, to: number): void {
  const startY = 100
  pointerDown(gripAt(from), startY)
  pointerMove(startY + (to - from) * DEFAULT_ITEM_HEIGHT)
  pointerUp()
}

// ---------------------------------------------------------------------------
// The grip is a real handle (D16.2)
// ---------------------------------------------------------------------------

describe('BlockItem — the drag grip', () => {
  it('renders the hook handle as a focusable button, and marks every row for measurement', () => {
    mount({ blocks: BLOCKS })

    expect(markedRows()).toHaveLength(3)
    expect(grips()).toHaveLength(3)

    const grip = gripAt(1)
    expect(grip.tagName).toBe('BUTTON')
    expect(grip.getAttribute('aria-label')).toBe('Reorder item 2 of 3')
    // `touch-action: none` is what lets a touch drag move the row instead of scrolling the page.
    expect(grip.style.touchAction).toBe('none')
  })

  it('marks a divider row too, so grip indices still match list indices', () => {
    mount({ blocks: WITH_DIVIDER })

    expect(markedRows()).toHaveLength(3)
    expect(grips()).toHaveLength(3)
    const dividerRow = markedRows()[1]
    expect(dividerRow?.querySelector('button[aria-label^="Reorder item"]')).not.toBeNull()
  })

  it('renders no grip and no row marker outside the editor', () => {
    mount({ blocks: [heading('b-1', 'Alpha')], mode: 'receiver' })

    expect(grips()).toHaveLength(0)
    expect(markedRows()).toHaveLength(0)
  })

  it('moves a row with the pointer, announcing once and only on release', () => {
    const onMove = vi.fn()
    mount({ blocks: BLOCKS, onMove })

    const startY = 100
    pointerDown(gripAt(0), startY)
    pointerMove(startY + DEFAULT_ITEM_HEIGHT)

    // Mid-drag: nothing has been announced, nothing has been reordered, the row is only moved.
    expect(onMove).not.toHaveBeenCalled()
    expect(headingOrder()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(markedRows()[0]?.style.transform).toContain('48px')

    pointerUp()

    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith(0, 1)
    expect(headingOrder()).toEqual(['Bravo', 'Alpha', 'Charlie'])
    // The translation belongs to the drag, and the drag is over.
    expect(markedRows()[0]?.style.transform).toBe('')
    expect(markedRows()[1]?.style.transform).toBe('')
  })

  it('cancels on Escape: no move, no announcement, no leftover offset', () => {
    const onMove = vi.fn()
    mount({ blocks: BLOCKS, onMove })

    pointerDown(gripAt(2), 200)
    pointerMove(200 - 2 * DEFAULT_ITEM_HEIGHT)
    expect(markedRows()[2]?.style.transform).toContain('-96px')

    pressOn(document.body, 'Escape')
    pointerUp()

    expect(onMove).not.toHaveBeenCalled()
    expect(headingOrder()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(markedRows()[2]?.style.transform).toBe('')
  })

  it('moves the same row from the keyboard on that grip (D16.3)', () => {
    const onMove = vi.fn()
    mount({ blocks: BLOCKS, onMove })

    pressOn(gripAt(0), 'ArrowDown')
    expect(onMove).toHaveBeenLastCalledWith(0, 1)

    drag(0, 2) // put row 0 at the bottom, so the next key has a fresh list to act on
    const before = headingOrder()

    pressOn(gripAt(0), 'End')
    expect(onMove).toHaveBeenLastCalledWith(0, 2)
    expect(headingOrder()).not.toEqual(before)

    // A key the grip does not own is left to the browser, so Tab and page scrolling work.
    const calls = onMove.mock.calls.length
    pressOn(gripAt(0), 'Tab')
    expect(onMove).toHaveBeenCalledTimes(calls)
  })
})

// ---------------------------------------------------------------------------
// The arrow buttons stay the accessible twin
// ---------------------------------------------------------------------------

describe('BlockItem — the arrow controls', () => {
  it('labels both arrows and reports which row was pressed', () => {
    const onMoveUp = vi.fn()
    const onMoveDown = vi.fn()
    mount({ blocks: BLOCKS, onMoveUp, onMoveDown })

    click(arrowIn(1, 'down'))
    expect(onMoveDown).toHaveBeenCalledWith(1)

    click(arrowIn(1, 'up'))
    expect(onMoveUp).toHaveBeenCalledWith(1)
  })

  it('disables the arrows that would move a row off the list', () => {
    mount({ blocks: BLOCKS })

    expect(arrowIn(0, 'up').disabled).toBe(true)
    expect(arrowIn(0, 'down').disabled).toBe(false)
    expect(arrowIn(2, 'down').disabled).toBe(true)
    expect(arrowIn(2, 'up').disabled).toBe(false)
  })

  it('takes a divider out of the way with the grip, the same way as any other row', () => {
    const onMove = vi.fn()
    mount({ blocks: WITH_DIVIDER, onMove })

    drag(1, 2)

    expect(onMove).toHaveBeenCalledWith(1, 2)
    // The divider is not a heading input, so the two headings simply swap places behind it.
    expect(headingOrder()).toEqual(['Alpha', 'Charlie'])
    expect(markedRows()[2]?.textContent ?? '').toContain('DIVIDER')
  })
})

// ---------------------------------------------------------------------------
// Editing a block stays local (D16.1)
// ---------------------------------------------------------------------------

describe('BlockItem — editing a block', () => {
  it('announces the changed field for that block id, and never reorders or persists', () => {
    const onUpdate = vi.fn()
    const onMove = vi.fn()
    const onMoveUp = vi.fn()
    mount({ blocks: BLOCKS, onUpdate, onMove, onMoveUp })

    typeInto(headingInput(0), 'Alpha rewritten')
    expect(onUpdate).toHaveBeenLastCalledWith('b-1', { content: 'Alpha rewritten' })

    typeInto(headingInput(1), 'Bravo rewritten')
    expect(onUpdate).toHaveBeenLastCalledWith('b-2', { content: 'Bravo rewritten' })

    // Typing is not a reorder, and the row has no save path of its own.
    expect(onMove).not.toHaveBeenCalled()
    expect(onMoveUp).not.toHaveBeenCalled()
    expect(headingOrder()).toEqual(['Alpha rewritten', 'Bravo rewritten', 'Charlie'])
  })

  it('keeps the grip and the block actions out of the sender screen', () => {
    mount({ blocks: [heading('b-1', 'Alpha')], mode: 'sender' })

    expect(grips()).toHaveLength(0)
    expect(headingInputs()).toHaveLength(0)
    expect(element().textContent ?? '').toContain('Alpha')
  })
})

/**
 * `useReorderDrag` — vertical list reordering with pointer events, plus a keyboard twin
 * (ORCHESTRATION D16.2: HTML5 drag-and-drop never fires on touch, so it cannot serve both
 * desktop and mobile; D16.3: every drag needs an accessible equivalent).
 *
 * One code path for mouse, pen and touch. The grip is a real `<button>`: arrows and
 * Home/End move the row without any pointer, and `onMove` is the only way anything leaves
 * the hook, so a drag and a key press persist through exactly the same store call.
 *
 * `onMove(from, to)` is called **once, on release**, never during the drag, and both
 * numbers are indices into the list as it currently renders — the same convention
 * `lib/reorder.ts` `moveIndex` uses. `drag` is what to paint with: the grabbed row is the
 * one whose index equals `drag.from`, and it should sit `drag.offset` pixels below where
 * it normally is.
 *
 * ```tsx
 * import { moveIndex } from '../lib/reorder'
 * import { useReorderDrag } from '../hooks/useReorderDrag'
 * import { useLibraryStore } from '../store/libraryStore'
 *
 * function FileList({ files, folderId }: { files: LibraryFile[]; folderId: string }) {
 *   const reorderFile = useLibraryStore((state) => state.reorderFile)
 *   const { drag, getHandleProps } = useReorderDrag({
 *     length: files.length,
 *     // One call per completed reorder: an arrow key or a released drag.
 *     onMove: (from, to) => {
 *       const moved = files[from]
 *       if (moved !== undefined) void reorderFile(moved.id, to, folderId)
 *     },
 *   })
 *
 *   return (
 *     <ul>
 *       {files.map((file, index) => (
 *         <li
 *           key={file.id}
 *           // `data-reorder-item` is how the hook finds the row to measure. Without it
 *           // (and without `getItemHeight`) the pitch falls back to DEFAULT_ITEM_HEIGHT.
 *           data-reorder-item=""
 *           style={
 *             drag && drag.from === index
 *               ? { transform: `translateY(${drag.offset}px)`, position: 'relative', zIndex: 1 }
 *               : undefined
 *           }
 *         >
 *           <button {...getHandleProps(index)}>
 *             <GripVertical size={16} aria-hidden="true" />
 *           </button>
 *           {file.name}
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * Rows of differing height (the block editor) should measure themselves instead of
 * relying on the grabbed row's pitch: `useReorderDrag({ length, onMove, getItemHeight:
 * (index) => rows[index].getBoundingClientRect().height + gap })`.
 *
 * The grip's own `pointerdown` is consumed (`preventDefault`), so it never starts a text
 * selection and never fires a compatibility `click`: put row actions on the row, not on
 * the grip. Touch scrolling is blocked by `touch-action: none` on the handle.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

import { DEFAULT_ITEM_HEIGHT, resolveTargetIndex } from '../lib/reorder'

/**
 * Marks the element a row renders, so a grab can measure the row that owns the handle and
 * not the handle itself. Spread onto the row element (`<li data-reorder-item="">`).
 */
export const REORDER_ITEM_ATTRIBUTE = 'data-reorder-item'

export interface UseReorderDragOptions {
  /** Rows in the list right now. Read on every event, so a list that changes mid-drag is never indexed against its old length. */
  length: number
  /**
   * Called once per completed reorder, with indices into the list as it was at grab time
   * (`from`) and the index the row should end up at (`to`). Never called while dragging,
   * never called for a drop back in place, a cancelled drag or an unmount.
   */
  onMove(from: number, to: number): void
  /** Pitch (height plus gap) of row `index` in pixels. Omit to measure the grabbed row. */
  getItemHeight?(index: number): number
}

/** The live drag, or `null` when nothing is grabbed. */
export interface ReorderDragState {
  /** Index of the grabbed row, in the list as it renders. */
  from: number
  /** Index the grabbed row is currently over, clamped to the list. */
  to: number
  /** Signed pixels the pointer has travelled since the grab — what to translate by. */
  offset: number
}

/** Props to spread onto the grip `<button>`. */
export interface ReorderHandleProps {
  type: 'button'
  'aria-label': string
  style: CSSProperties
  onPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void
}

export interface UseReorderDragResult {
  drag: ReorderDragState | null
  getHandleProps(index: number): ReorderHandleProps
}

/** Everything a grab needs that is not React state. */
interface ActiveGrab {
  pointerId: number
  from: number
  to: number
  offset: number
  startY: number
  /** Row pitch, sampled once at grab. */
  heights: number[]
  element: HTMLButtonElement
  /** Removes the window listeners; set when they are attached. */
  detach: (() => void) | null
  captureSet: boolean
}

/** A pointer that reports 0 (nothing laid out, e.g. jsdom or a hidden row) is no use for index math. */
function usableHeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ITEM_HEIGHT
}

/** The row that owns a handle: the nearest `data-reorder-item` ancestor, else the handle's parent. */
function findRow(handle: HTMLElement): HTMLElement | null {
  const marked = handle.closest(`[${REORDER_ITEM_ATTRIBUTE}]`)
  if (marked instanceof HTMLElement) return marked
  return handle.parentElement instanceof HTMLElement ? handle.parentElement : null
}

/**
 * The grabbed row's pitch in pixels: the distance to the row after it (which includes any
 * gap between them), then the distance to the row before it, then the row's own height.
 */
function measurePitch(row: HTMLElement): number {
  const following = row.nextElementSibling
  if (following instanceof HTMLElement) {
    const distance = following.offsetTop - row.offsetTop
    if (distance > 0) return distance
  }
  const preceding = row.previousElementSibling
  if (preceding instanceof HTMLElement) {
    const distance = row.offsetTop - preceding.offsetTop
    if (distance > 0) return distance
  }
  return usableHeight(row.offsetHeight)
}

/** Per-row pitches for the whole list, from `getItemHeight` or from one DOM measurement. */
function rowHeights(
  handle: HTMLElement,
  length: number,
  getItemHeight: ((index: number) => number) | undefined,
): number[] {
  if (getItemHeight !== undefined) {
    const heights: number[] = []
    for (let index = 0; index < length; index += 1) {
      heights.push(usableHeight(getItemHeight(index)))
    }
    return heights
  }
  const row = findRow(handle)
  const pitch = row === null ? DEFAULT_ITEM_HEIGHT : measurePitch(row)
  return new Array<number>(length).fill(pitch)
}

/**
 * Sets the pointer capture when the browser offers it, and remembers that it did, so the
 * release matches. Browsers that implement pointer events implement all three methods;
 * the guard is for the ones that do not (and for jsdom, which has no PointerEvent at all —
 * see `useReorderDrag.test.ts` for what the test harness polyfills and why).
 */
function capturePointer(element: HTMLButtonElement, pointerId: number): boolean {
  if (typeof element.setPointerCapture !== 'function') return false
  try {
    element.setPointerCapture(pointerId)
    return true
  } catch {
    // The pointer already went away between `pointerdown` and here.
    return false
  }
}

function releasePointer(element: HTMLButtonElement, pointerId: number, captured: boolean): void {
  if (!captured || typeof element.releasePointerCapture !== 'function') return
  try {
    if (typeof element.hasPointerCapture !== 'function' || element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId)
    }
  } catch {
    // Nothing to hand back: the capture is already gone.
  }
}

export function useReorderDrag(options: UseReorderDragOptions): UseReorderDragResult {
  const { length, onMove, getItemHeight } = options

  const [drag, setDrag] = useState<ReorderDragState | null>(null)
  const grabRef = useRef<ActiveGrab | null>(null)
  const lengthRef = useRef(length)
  const onMoveRef = useRef(onMove)
  const getItemHeightRef = useRef(getItemHeight)

  // The window listeners live outside React's event flow, so they read the current props
  // through refs. This runs after every commit, which is before any pointer or key event a
  // user can produce.
  useEffect(() => {
    lengthRef.current = length
    onMoveRef.current = onMove
    getItemHeightRef.current = getItemHeight
  })

  /** Drops the grab and its listeners without announcing anything. */
  const abandonGrab = useCallback((): void => {
    const grab = grabRef.current
    if (grab === null) return
    grabRef.current = null
    if (grab.detach !== null) {
      const detach = grab.detach
      grab.detach = null
      detach()
    }
    releasePointer(grab.element, grab.pointerId, grab.captureSet)
  }, [])

  /**
   * Ends the drag. `commit` announces `onMove(from, to)` — once, and only for a move that
   * is still meaningful: a row that left the list while the pointer was down, or one that
   * finished where it started, announces nothing.
   */
  const endGrab = useCallback(
    (commit: boolean): void => {
      const grab = grabRef.current
      if (grab === null) return
      const lastIndex = lengthRef.current - 1
      const from = grab.from
      const to = Math.min(Math.max(grab.to, 0), Math.max(lastIndex, 0))
      abandonGrab()
      setDrag(null)
      if (!commit || from > lastIndex || from === to) return
      onMoveRef.current(from, to)
    },
    [abandonGrab],
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent): void => {
      const grab = grabRef.current
      if (grab === null || event.pointerId !== grab.pointerId) return
      // The grabbed row is gone (a delete landed mid-drag) and the index it had no longer
      // exists: end quietly rather than invent a position for it.
      if (lengthRef.current <= grab.from) {
        endGrab(false)
        return
      }
      // Not passive, so this can stop the page scrolling under a touch drag.
      event.preventDefault()
      const offset = event.clientY - grab.startY
      const to = resolveTargetIndex({
        length: lengthRef.current,
        from: grab.from,
        delta: offset,
        itemHeight: grab.heights,
      })
      grab.offset = offset
      grab.to = to
      setDrag({ from: grab.from, to, offset })
    },
    [endGrab],
  )

  const handlePointerEnd = useCallback((): void => {
    endGrab(true)
  }, [endGrab])

  const handlePointerCancel = useCallback((): void => {
    endGrab(false)
  }, [endGrab])

  const handleWindowKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (event.key === 'Escape') endGrab(false)
    },
    [endGrab],
  )

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, index: number): void => {
      // Only a primary, left-button (or touch/pen) press grabs: a right click or a second
      // finger must not steal the drag.
      if (event.button !== 0 || event.isPrimary === false) return
      if (grabRef.current !== null) return
      if (index < 0 || index >= lengthRef.current) return

      const element = event.currentTarget
      // No compatibility `mousedown`/`click`, and no text selection under the pointer.
      event.preventDefault()

      const grab: ActiveGrab = {
        pointerId: event.pointerId,
        from: index,
        to: index,
        offset: 0,
        startY: event.clientY,
        heights: rowHeights(element, lengthRef.current, getItemHeightRef.current),
        element,
        detach: null,
        captureSet: capturePointer(element, event.pointerId),
      }
      grabRef.current = grab

      // Window, not the handle: a pointer released over another element, or one the browser
      // never captured, still has to end the drag. `passive: false` is what lets
      // `pointermove` prevent the touch scroll.
      const listenerOptions: AddEventListenerOptions = { capture: false, passive: false }
      const toggle = (on: boolean): void => {
        if (on) {
          window.addEventListener('pointermove', handlePointerMove, listenerOptions)
          window.addEventListener('pointerup', handlePointerEnd, listenerOptions)
          window.addEventListener('pointercancel', handlePointerCancel, listenerOptions)
          window.addEventListener('keydown', handleWindowKeyDown, listenerOptions)
        } else {
          window.removeEventListener('pointermove', handlePointerMove, listenerOptions)
          window.removeEventListener('pointerup', handlePointerEnd, listenerOptions)
          window.removeEventListener('pointercancel', handlePointerCancel, listenerOptions)
          window.removeEventListener('keydown', handleWindowKeyDown, listenerOptions)
        }
      }
      toggle(true)
      grab.detach = () => {
        toggle(false)
      }

      setDrag({ from: index, to: index, offset: 0 })
    },
    [handlePointerCancel, handlePointerEnd, handlePointerMove, handleWindowKeyDown],
  )

  /**
   * The keyboard twin of the drag (D16.3). Arrow keys move this row one slot, Home and End
   * move it to the ends; each real move announces `onMove` immediately, because a key press
   * has no "during" to wait for. Keys at the edge of the list, and keys with a modifier, are
   * left to the browser so page scrolling and shortcuts still work.
   */
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
      if (grabRef.current !== null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

      let to = index
      if (event.key === 'ArrowUp') to = index - 1
      else if (event.key === 'ArrowDown') to = index + 1
      else if (event.key === 'Home') to = 0
      else if (event.key === 'End') to = lengthRef.current - 1
      else return

      if (to === index || to < 0 || to > lengthRef.current - 1) return
      event.preventDefault()
      onMoveRef.current(index, to)
    },
    [],
  )

  // A drag that outlives its component must not announce into a tree that is gone, and its
  // window listeners must not survive either.
  useEffect(() => abandonGrab, [abandonGrab])

  const getHandleProps = useCallback(
    (index: number): ReorderHandleProps => ({
      type: 'button',
      'aria-label': `Reorder item ${index + 1} of ${length}`,
      style: { touchAction: 'none', cursor: 'grab' },
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        handlePointerDown(event, index)
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        handleKeyDown(event, index)
      },
    }),
    [handleKeyDown, handlePointerDown, length],
  )

  return { drag, getHandleProps }
}

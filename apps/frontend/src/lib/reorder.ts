/**
 * The index math behind drag-reordering — pure, DOM-free, and the single source of
 * truth for it (ORCHESTRATION D16.2/D16.3).
 *
 * Two consumers, one implementation:
 *
 *   - `hooks/useReorderDrag.ts` asks {@link resolveTargetIndex} "the pointer grabbed
 *     row `from` and has travelled `delta` pixels; which row is it over now?", and
 *     hands that index to the caller's `onMove`.
 *   - `lib/library.ts` asks {@link nextSortOrder} "row `targetIndex` of this folder
 *     is now this record; what `sortOrder` does that need?" and renumbers the whole
 *     run when the answer is {@link RENUMBER_REQUIRED}.
 *
 * The index convention is shared by both, and it is the one `moveIndex` implements:
 * `from` and `to` are both indices into the list *as it is currently displayed*, and
 * the move is remove-then-insert. So `moveIndex([a, b, c, d], 0, 2)` is `[b, c, a, d]`
 * — `a` lands at index 2, exactly where the user dropped it. A component that renders
 * the list and a store that persists it therefore agree on `to` without either having
 * to compensate for the hole the moved row leaves behind (the classic off-by-one when
 * dragging down).
 *
 * Nothing here touches the DOM, IndexedDB or React, so every branch is testable as a
 * plain function call.
 */

/**
 * The distance between two neighbouring `sortOrder` values.
 *
 * Gap-based rather than dense (1000, 2000, 3000 …) so the common reorder rewrites one
 * record — the midpoint of its two new neighbours — instead of the whole sibling run.
 * Roughly ten halvings of the same gap are available before {@link RENUMBER_REQUIRED}
 * is returned, and renumbering then restores the full gap.
 */
export const SORT_ORDER_GAP = 1000

/**
 * The value {@link nextSortOrder} returns when the gap around the target index cannot
 * hold another position, meaning the caller must rewrite the whole sibling run.
 *
 * `NaN` is used deliberately: it is not a number any record may hold
 * (`lib/library.ts` rejects a non-integer `sortOrder` on read and on write), so a
 * forgotten check cannot persist it. Test it with {@link needsRenumber}.
 */
export const RENUMBER_REQUIRED: number = Number.NaN

/** True when `nextSortOrder` gave up and the caller has to renumber the sibling run. */
export function needsRenumber(value: number): boolean {
  return Number.isNaN(value)
}

/**
 * The row pitch {@link resolveTargetIndex} assumes when a caller has no measurement.
 *
 * A grip row in this app is a single line plus padding; 48px is the pitch the panels
 * render. Callers that know better pass `itemHeight` — the hook measures real rows and
 * falls back to this when a measurement comes out as 0 (which is what a hidden or
 * not-yet-laid-out element reports, and what every element reports under jsdom).
 */
export const DEFAULT_ITEM_HEIGHT = 48

// ---------------------------------------------------------------------------
// Validation — a bad index is a caller bug, so it says so loudly
// ---------------------------------------------------------------------------

function describeNumber(value: number): string {
  return String(value)
}

function requireIndex(value: number, what: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RangeError(`reorder: ${what} must be an integer (got ${describeNumber(value)})`)
  }
  if (value < 0 || value > max) {
    throw new RangeError(`reorder: ${what} must be between 0 and ${max} (got ${value})`)
  }
  return value
}

function requireRowCount(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`reorder: ${what} must be a non-negative integer (got ${describeNumber(value)})`)
  }
  return value
}

function requirePitch(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`reorder: ${what} must be a finite number greater than 0 (got ${describeNumber(value)})`)
  }
  return value
}

function requirePosition(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RangeError(`reorder: ${what} must be a safe integer (got ${describeNumber(value)})`)
  }
  return value
}

// ---------------------------------------------------------------------------
// moveIndex
// ---------------------------------------------------------------------------

/**
 * Returns a new list with the item at `from` removed and re-inserted at `to`.
 *
 * `from === to` is a no-op that still returns a fresh array, so a caller can never hold
 * a reference aliasing the input. Both indices are into the input list, and `to` is
 * where the item ends up (see the module comment). Out-of-range or non-integer indices
 * and an empty list throw a `RangeError`; nothing is clamped, because a component that
 * lost track of its own list length should not silently reorder a different row.
 */
export function moveIndex<T>(list: readonly T[], from: number, to: number): T[] {
  if (list.length === 0) {
    throw new RangeError('reorder: moveIndex needs a list with at least one item')
  }
  const source = requireIndex(from, 'moveIndex "from"', list.length - 1)
  const target = requireIndex(to, 'moveIndex "to"', list.length - 1)

  // Slices rather than `splice`: reading one index out of a `readonly T[]` is
  // `T | undefined` under `noUncheckedIndexedAccess`, and this shape never has to assert
  // it away. `moved` is a one-item slice, so it can be spread without an index read.
  if (source === target) return [...list]
  const moved = list.slice(source, source + 1)
  if (source < target) {
    return [
      ...list.slice(0, source),
      ...list.slice(source + 1, target + 1),
      ...moved,
      ...list.slice(target + 1),
    ]
  }
  return [...list.slice(0, target), ...moved, ...list.slice(target, source), ...list.slice(source + 1)]
}

// ---------------------------------------------------------------------------
// resolveTargetIndex
// ---------------------------------------------------------------------------

export interface ResolveTargetIndexOptions {
  /** Rows in the list, including the grabbed one. Must be at least 1. */
  length: number
  /** Index of the grabbed row: `0 <= from < length`. */
  from: number
  /** Signed pixels the pointer has travelled since the grab (down is positive). */
  delta: number
  /**
   * Row pitch in pixels: one number for a uniform list, or one entry per row when rows
   * differ in height (a short array is padded with its own last entry). Omit it for
   * {@link DEFAULT_ITEM_HEIGHT}.
   */
  itemHeight?: number | readonly number[]
}

/**
 * Which row the grabbed row is now hovering, given how far the pointer moved.
 *
 * The layout is treated as unmoved (the dragged row still occupies its own slot, which
 * is what the DOM looks like mid-drag), so the answer is the row whose band contains
 * the dragged row's centre after the travel — for a uniform pitch that is exactly
 * `from + round(delta / pitch)`, and the per-row form generalises it. The result is
 * clamped to `[0, length - 1]`: a pointer dragged past the end of the list means
 * "first" or "last", not "nowhere".
 *
 * Pure index math on numbers so the hook has nothing to get wrong: bad `length`, `from`,
 * `delta` or a non-positive pitch throw.
 */
export function resolveTargetIndex(options: ResolveTargetIndexOptions): number {
  const length = requireRowCount(options.length, 'resolveTargetIndex "length"')
  if (length === 0) {
    throw new RangeError('reorder: resolveTargetIndex needs a list with at least one row')
  }
  const from = requireIndex(options.from, 'resolveTargetIndex "from"', length - 1)
  if (typeof options.delta !== 'number' || !Number.isFinite(options.delta)) {
    throw new RangeError(
      `reorder: resolveTargetIndex needs a finite "delta" in pixels (got ${describeNumber(options.delta)})`,
    )
  }

  const heights = pitchPerRow(options.itemHeight, length)

  // The dragged row's centre in the layout as it stands (its own row still in place).
  let centre = options.delta
  let seen = 0
  for (const height of heights) {
    if (seen === from) {
      centre += height / 2
      break
    }
    centre += height
    seen += 1
  }

  let top = 0
  let index = 0
  for (const height of heights) {
    const bottom = top + height
    if (centre < bottom) return index
    top = bottom
    index += 1
  }
  return length - 1
}

/** One positive pitch per row, from a constant, a per-row array, or the default. */
function pitchPerRow(
  itemHeight: number | readonly number[] | undefined,
  length: number,
): number[] {
  const heights: number[] = []
  if (typeof itemHeight === 'number') {
    const pitch = requirePitch(itemHeight, 'resolveTargetIndex "itemHeight"')
    for (let index = 0; index < length; index += 1) heights.push(pitch)
    return heights
  }
  if (Array.isArray(itemHeight)) {
    const last = itemHeight[itemHeight.length - 1]
    for (let index = 0; index < length; index += 1) {
      const value = itemHeight[index] ?? last ?? DEFAULT_ITEM_HEIGHT
      heights.push(requirePitch(value, `resolveTargetIndex "itemHeight[${index}]"`))
    }
    return heights
  }
  for (let index = 0; index < length; index += 1) {
    heights.push(requirePitch(DEFAULT_ITEM_HEIGHT, 'resolveTargetIndex "itemHeight"'))
  }
  return heights
}

// ---------------------------------------------------------------------------
// nextSortOrder
// ---------------------------------------------------------------------------

/**
 * The `sortOrder` a moved record needs to land at `targetIndex` among its siblings.
 *
 * `siblings` are the other rows' positions **in display order** (so the array is short
 * by one — it excludes the moved record), `targetIndex` is the insertion point inside
 * it (`0` is before all of them, `siblings.length` is after all of them), and
 * `existing` is the moved record's current position or `undefined` if it never had one.
 *
 * The gap rule: land halfway between the new neighbours, `+ GAP` after the last row, or
 * `- GAP` before the first. `existing` is reused when it already sits strictly between
 * the two neighbours, which makes "grabbed it, dropped it back where it was" return the
 * same number so the caller can skip the write entirely. When the two neighbours are
 * adjacent integers there is no midpoint, and when the run would run off the end of the
 * safe integer range there is no `+ GAP` / `- GAP` either: both answer
 * {@link RENUMBER_REQUIRED}, and `lib/library.ts` rewrites the sibling run at
 * {@link SORT_ORDER_GAP} spacing. Positions may be negative — a row dragged above a
 * folder that starts at 0 pushes the range down until it, too, has to be renumbered.
 */
export function nextSortOrder(
  siblings: readonly number[],
  targetIndex: number,
  existing: number | undefined,
): number {
  const index = requireIndex(targetIndex, 'nextSortOrder "targetIndex"', siblings.length)
  for (const position of siblings) {
    requirePosition(position, 'nextSortOrder "siblings"')
  }
  if (existing !== undefined) {
    requirePosition(existing, 'nextSortOrder "existing"')
  }

  const previous = index > 0 ? siblings[index - 1] : undefined
  const following = index < siblings.length ? siblings[index] : undefined

  if (previous === undefined) {
    // Nothing above it: either the run is empty, or it is being dropped first.
    return following === undefined
      ? (existing ?? SORT_ORDER_GAP)
      : withinSafeRange(following - SORT_ORDER_GAP)
  }
  if (following === undefined) {
    return withinSafeRange(previous + SORT_ORDER_GAP)
  }
  if (existing !== undefined && existing > previous && existing < following) {
    return existing
  }
  const midpoint = withinSafeRange(previous + Math.floor((following - previous) / 2))
  // Also the branch for a run that is not ascending (a hand-edited or half-migrated
  // folder): `following - previous` is then <= 0, so no integer can sit between them.
  return midpoint > previous && midpoint < following ? midpoint : RENUMBER_REQUIRED
}

function withinSafeRange(value: number): number {
  return Number.isSafeInteger(value) ? value : RENUMBER_REQUIRED
}

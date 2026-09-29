/**
 * Tests for `lib/reorder.ts` — the index math every reorderable list shares.
 *
 * The pure module runs in the default node environment (no DOM docblock needed). What
 * gets pinned here is the pair of bugs the module exists to prevent: the off-by-one when
 * a row moves DOWN (the hole it leaves behind must not shift the target), and the moment
 * the gap between two `sortOrder` values collapses and the caller has to renumber. Both
 * are asserted by exact number, not by "it round-trips".
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ITEM_HEIGHT,
  moveIndex,
  needsRenumber,
  nextSortOrder,
  RENUMBER_REQUIRED,
  resolveTargetIndex,
  SORT_ORDER_GAP,
} from './reorder'

describe('moveIndex', () => {
  it('returns a new list with the item landing at `to`', () => {
    expect(moveIndex(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves up without leaving the gap the down-move would need', () => {
    // Remove-then-insert: `d` leaves index 3 and lands at index 1, so `a`, `b`, `c` shift down.
    expect(moveIndex(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(moveIndex(['a', 'b', 'c', 'd'], 2, 0)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('is the same convention for neighbours in both directions', () => {
    expect(moveIndex(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveIndex(['a', 'b', 'c'], 1, 0)).toEqual(['b', 'a', 'c'])
    expect(moveIndex(['a', 'b', 'c'], 1, 2)).toEqual(['a', 'c', 'b'])
    expect(moveIndex(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b'])
  })

  it('ends at the first and last index without wrapping', () => {
    const list = ['a', 'b', 'c', 'd', 'e']
    expect(moveIndex(list, 4, 0)).toEqual(['e', 'a', 'b', 'c', 'd'])
    expect(moveIndex(list, 0, 4)).toEqual(['b', 'c', 'd', 'e', 'a'])
  })

  it('is a no-op that still returns a fresh array when from === to', () => {
    const list = ['a', 'b', 'c']
    const result = moveIndex(list, 1, 1)
    expect(result).toEqual(['a', 'b', 'c'])
    expect(result).not.toBe(list)
  })

  it('handles a single-item list', () => {
    expect(moveIndex(['only'], 0, 0)).toEqual(['only'])
  })

  it('keeps duplicate values as separate entries', () => {
    expect(moveIndex(['x', 'y', 'x', 'x'], 0, 2)).toEqual(['y', 'x', 'x', 'x'])
    expect(moveIndex(['x', 'y', 'x', 'x'], 3, 0)).toEqual(['x', 'x', 'y', 'x'])
  })

  it('moves object entries by reference and leaves the input untouched', () => {
    const first = { id: 1 }
    const second = { id: 2 }
    const third = { id: 3 }
    const input = [first, second, third]
    const result = moveIndex(input, 2, 0)

    expect(result).toEqual([third, first, second])
    expect(result[0]).toBe(third)
    expect(input).toEqual([first, second, third])
  })

  it('refuses an empty list', () => {
    expect(() => moveIndex([], 0, 0)).toThrow(RangeError)
    expect(() => moveIndex<number>([], 0, 0)).toThrow(/at least one item/)
  })

  it('refuses out-of-range indices rather than clamping them', () => {
    const list = ['a', 'b', 'c']
    expect(() => moveIndex(list, -1, 1)).toThrow(/"from" must be between 0 and 2/)
    expect(() => moveIndex(list, 0, 3)).toThrow(/"to" must be between 0 and 2/)
    expect(() => moveIndex(list, 3, 0)).toThrow(RangeError)
    expect(() => moveIndex(['a'], 0, 1)).toThrow(RangeError)
  })

  it('refuses negative, fractional and non-finite indices', () => {
    const list = ['a', 'b', 'c']
    expect(() => moveIndex(list, Number.NaN, 1)).toThrow(RangeError)
    expect(() => moveIndex(list, 1, Number.NaN)).toThrow(RangeError)
    expect(() => moveIndex(list, Number.POSITIVE_INFINITY, 0)).toThrow(RangeError)
    expect(() => moveIndex(list, 0.5, 1)).toThrow(/must be an integer/)
    expect(() => moveIndex(list, 0, -2)).toThrow(RangeError)
  })
})

describe('resolveTargetIndex', () => {
  it('answers "which row is the grabbed one over" for a uniform list', () => {
    // 40px rows: a full row of travel is a full row of index.
    expect(resolveTargetIndex({ length: 4, from: 0, delta: 0, itemHeight: 40 })).toBe(0)
    expect(resolveTargetIndex({ length: 4, from: 0, delta: 19, itemHeight: 40 })).toBe(0)
    expect(resolveTargetIndex({ length: 4, from: 0, delta: 20, itemHeight: 40 })).toBe(1)
    expect(resolveTargetIndex({ length: 4, from: 0, delta: 39, itemHeight: 40 })).toBe(1)
    expect(resolveTargetIndex({ length: 4, from: 0, delta: 40, itemHeight: 40 })).toBe(1)
    expect(resolveTargetIndex({ length: 4, from: 0, delta: 120, itemHeight: 40 })).toBe(3)
    expect(resolveTargetIndex({ length: 4, from: 3, delta: -80, itemHeight: 40 })).toBe(1)
    expect(resolveTargetIndex({ length: 4, from: 3, delta: -120, itemHeight: 40 })).toBe(0)
  })

  it('swaps with the row below at half a pitch and needs more to swap upward', () => {
    // The boundary is `from + round(delta / pitch)` (rounding half up), which is what makes
    // a down-drag feel eager and an up-drag feel deliberate — pinned so it cannot drift.
    expect(resolveTargetIndex({ length: 5, from: 2, delta: 19, itemHeight: 40 })).toBe(2)
    expect(resolveTargetIndex({ length: 5, from: 2, delta: 20, itemHeight: 40 })).toBe(3)
    expect(resolveTargetIndex({ length: 5, from: 2, delta: -20, itemHeight: 40 })).toBe(2)
    expect(resolveTargetIndex({ length: 5, from: 2, delta: -21, itemHeight: 40 })).toBe(1)
  })

  it('clamps travel beyond either end of the list to the first and last row', () => {
    expect(resolveTargetIndex({ length: 3, from: 1, delta: 10_000, itemHeight: 40 })).toBe(2)
    expect(resolveTargetIndex({ length: 3, from: 1, delta: -10_000, itemHeight: 40 })).toBe(0)
    expect(resolveTargetIndex({ length: 1, from: 0, delta: 500, itemHeight: 40 })).toBe(0)
  })

  it('uses a per-row pitch when the rows differ in height', () => {
    // Rows of 10, 100 and 10: row 0's centre is at 5, so 60px down puts it at 65 — inside
    // the tall middle row, not six rows down a uniform 10px list.
    const heights = [10, 100, 10]
    expect(resolveTargetIndex({ length: 3, from: 0, delta: 60, itemHeight: heights })).toBe(1)
    expect(resolveTargetIndex({ length: 3, from: 0, delta: 4, itemHeight: heights })).toBe(0)
    // Row 0 is 10px tall, so its centre is reached 5px in — the same half-pitch rule as a
    // uniform list, just with each row's own height.
    expect(resolveTargetIndex({ length: 3, from: 0, delta: 5, itemHeight: heights })).toBe(1)
    expect(resolveTargetIndex({ length: 3, from: 0, delta: 106, itemHeight: heights })).toBe(2)
    // From the tall row, its own half-height is what counts.
    expect(resolveTargetIndex({ length: 3, from: 1, delta: -60, itemHeight: heights })).toBe(0)
  })

  it('pads a short per-row array with its own last entry', () => {
    expect(resolveTargetIndex({ length: 4, from: 3, delta: -80, itemHeight: [40, 40] })).toBe(1)
    expect(resolveTargetIndex({ length: 4, from: 3, delta: -160, itemHeight: [40, 40] })).toBe(0)
  })

  it('falls back to DEFAULT_ITEM_HEIGHT when no pitch is given', () => {
    const defaultPitch = DEFAULT_ITEM_HEIGHT
    expect(resolveTargetIndex({ length: 5, from: 0, delta: defaultPitch * 2 })).toBe(2)
    expect(resolveTargetIndex({ length: 5, from: 0, delta: defaultPitch / 2 })).toBe(1)
    // An empty per-row array has nothing to measure with, so it is the same fallback.
    expect(resolveTargetIndex({ length: 5, from: 0, delta: defaultPitch * 2, itemHeight: [] })).toBe(2)
  })

  it('refuses a list it cannot index', () => {
    expect(() => resolveTargetIndex({ length: 0, from: 0, delta: 10 })).toThrow(RangeError)
    expect(() => resolveTargetIndex({ length: 3, from: 3, delta: 10 })).toThrow(/"from"/)
    expect(() => resolveTargetIndex({ length: 3, from: -1, delta: 10 })).toThrow(/"from"/)
    expect(() => resolveTargetIndex({ length: 3.5, from: 0, delta: 10 })).toThrow(/"length"/)
    expect(() => resolveTargetIndex({ length: -1, from: 0, delta: 10 })).toThrow(/"length"/)
  })

  it('refuses a delta or pitch that is not a usable distance', () => {
    expect(() => resolveTargetIndex({ length: 3, from: 0, delta: Number.NaN })).toThrow(/"delta"/)
    expect(() => resolveTargetIndex({ length: 3, from: 0, delta: Number.POSITIVE_INFINITY })).toThrow(/"delta"/)
    expect(() => resolveTargetIndex({ length: 3, from: 0, delta: 10, itemHeight: 0 })).toThrow(/"itemHeight"/)
    expect(() => resolveTargetIndex({ length: 3, from: 0, delta: 10, itemHeight: -40 })).toThrow(/"itemHeight"/)
    expect(() => resolveTargetIndex({ length: 3, from: 0, delta: 10, itemHeight: Number.NaN })).toThrow(/"itemHeight"/)
    expect(() =>
      resolveTargetIndex({ length: 3, from: 0, delta: 10, itemHeight: [40, 0, 40] }),
    ).toThrow(/itemHeight\[1\]/)
  })

  it('always returns an index inside the list', () => {
    for (let delta = -500; delta <= 500; delta += 7) {
      const to = resolveTargetIndex({ length: 4, from: 1, delta, itemHeight: 33 })
      expect(Number.isInteger(to)).toBe(true)
      expect(to).toBeGreaterThanOrEqual(0)
      expect(to).toBeLessThanOrEqual(3)
    }
  })
})

describe('nextSortOrder', () => {
  it('puts a record in a folder of its own at the first gap', () => {
    expect(nextSortOrder([], 0, undefined)).toBe(SORT_ORDER_GAP)
    // An existing position is kept: nothing else is around it, so there is nothing to move.
    expect(nextSortOrder([], 0, 4242)).toBe(4242)
  })

  it('lands between two neighbours', () => {
    expect(nextSortOrder([1000, 3000], 1, 2000)).toBe(2000)
    expect(nextSortOrder([1000, 2000, 3000], 2, 100)).toBe(2500)
  })

  it('appends and prepends by the gap, so one record is written', () => {
    expect(nextSortOrder([1000, 2000, 3000], 3, 500)).toBe(4000)
    expect(nextSortOrder([1000, 2000, 3000], 0, 5000)).toBe(0)
    // Dropping below a run that already starts at 0 goes negative: still one write.
    expect(nextSortOrder([0, 1000, 2000], 0, 5000)).toBe(-1000)
  })

  it('keeps the current position when the record is dropped back between the same pair', () => {
    // The caller compares against what it read and skips the write.
    expect(nextSortOrder([1000, 3000], 1, 2000)).toBe(2000)
  })

  it('reports a collapsed gap as a renumber', () => {
    expect(nextSortOrder([1000, 1001], 1, 5000)).toBe(RENUMBER_REQUIRED)
    expect(needsRenumber(nextSortOrder([1000, 1001], 1, 5000))).toBe(true)
    // A gap of 2 has exactly one integer left in it.
    expect(nextSortOrder([1000, 1002], 1, 5000)).toBe(1001)
  })

  it('reports a run that does not ascend as a renumber', () => {
    // Duplicates and inverted pairs cannot be split by a midpoint; the caller rewrites the
    // run in display order, which is the only order the reads use.
    expect(nextSortOrder([1000, 1000], 1, 5000)).toBe(RENUMBER_REQUIRED)
    expect(nextSortOrder([2000, 1000], 1, 5000)).toBe(RENUMBER_REQUIRED)
    expect(nextSortOrder([1000, 2000, 2000, 3000], 2, 500)).toBe(RENUMBER_REQUIRED)
  })

  it('reports a gap that would leave the safe integer range as a renumber', () => {
    expect(nextSortOrder([Number.MAX_SAFE_INTEGER], 1, 1000)).toBe(RENUMBER_REQUIRED)
    expect(nextSortOrder([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER], 1, 1000)).toBe(
      RENUMBER_REQUIRED,
    )
    expect(nextSortOrder([Number.MIN_SAFE_INTEGER], 0, 1000)).toBe(RENUMBER_REQUIRED)
  })

  it('is stable across repeated inserts into the same slot', () => {
    // Each insert halves the gap, so a folder dragged on the same spot over and over
    // eventually asks for a renumber instead of inventing fractional positions.
    let previous = 0
    let following = SORT_ORDER_GAP
    let renumbered = false
    for (let round = 0; round < 40; round += 1) {
      const value = nextSortOrder([previous, following], 1, undefined)
      if (needsRenumber(value)) {
        renumbered = true
        break
      }
      expect(value).toBeGreaterThan(previous)
      expect(value).toBeLessThan(following)
      following = value
    }
    expect(renumbered).toBe(true)
  })

  it('refuses indices and positions it cannot use', () => {
    expect(() => nextSortOrder([1000, 2000], 3, undefined)).toThrow(/"targetIndex"/)
    expect(() => nextSortOrder([1000, 2000], -1, undefined)).toThrow(/"targetIndex"/)
    expect(() => nextSortOrder([1000, 2000], 1.5, undefined)).toThrow(/integer/)
    expect(() => nextSortOrder([Number.NaN], 0, undefined)).toThrow(/"siblings"/)
    expect(() => nextSortOrder([1000.5], 0, undefined)).toThrow(/"siblings"/)
    expect(() => nextSortOrder([1000], 0, Number.POSITIVE_INFINITY)).toThrow(/"existing"/)
    expect(() => nextSortOrder([Number.MAX_SAFE_INTEGER + 10], 0, undefined)).toThrow(/"siblings"/)
  })

  it('accepts a negative existing position', () => {
    expect(nextSortOrder([-2000, -1000], 1, -3000)).toBe(-1500)
    expect(nextSortOrder([-2000, -1000], 2, -3000)).toBe(0)
  })
})

describe('the shared constants', () => {
  it('spreads a fresh run one gap apart', () => {
    expect(SORT_ORDER_GAP).toBe(1000)
    // Dense enough to stay inside the safe range for any realistic folder, wide enough to
    // survive ten halvings before `RENUMBER_REQUIRED`.
    expect(nextSortOrder([SORT_ORDER_GAP, 2 * SORT_ORDER_GAP], 1, undefined)).toBe(1500)
    expect(DEFAULT_ITEM_HEIGHT).toBeGreaterThan(0)
  })

  it('only ever means "renumber" for NaN', () => {
    expect(needsRenumber(RENUMBER_REQUIRED)).toBe(true)
    expect(needsRenumber(0)).toBe(false)
    expect(needsRenumber(-1000)).toBe(false)
  })
})

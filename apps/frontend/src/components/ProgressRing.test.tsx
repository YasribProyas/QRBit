/** @vitest-environment jsdom */
/**
 * ProgressRing tests (PLAN.md §9).
 *
 * The ring is pure props, so these tests render it directly and check the two
 * things that matter to a caller: the value assistive technology reads, and the
 * clamped value the SVG draws. jsdom ships no renderer and this repo has no
 * rendering library, so React's own `act` + `createRoot` are used, as in
 * `hooks/useWebRTC.test.tsx`.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProgressRing } from './ProgressRing'
import type { ProgressRingProps } from './ProgressRing'

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderRing(overrides: Partial<ProgressRingProps> = {}): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)
  const props: ProgressRingProps = { progress: 0, label: 'Transfer progress', ...overrides }

  act(() => {
    created.render(createElement(ProgressRing, props))
  })

  container = element
  root = created
  return element
}

function ring(element: HTMLElement): HTMLElement {
  const node = element.querySelector('.progress-ring')
  if (!(node instanceof HTMLElement)) throw new Error('test bug: the ring did not render')
  return node
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('ProgressRing (PLAN.md §9)', () => {
  it('exposes the rounded percentage to assistive technology', () => {
    const element = renderRing({ progress: 42.6, label: 'holiday.jpg transfer progress' })

    expect(ring(element).getAttribute('role')).toBe('progressbar')
    expect(ring(element).getAttribute('aria-valuenow')).toBe('43')
    expect(ring(element).getAttribute('aria-valuemin')).toBe('0')
    expect(ring(element).getAttribute('aria-valuemax')).toBe('100')
    expect(ring(element).getAttribute('aria-label')).toBe('holiday.jpg transfer progress')
  })

  it('clamps values outside 0–100 instead of drawing an impossible ring', () => {
    expect(ring(renderRing({ progress: -20 })).getAttribute('aria-valuenow')).toBe('0')

    act(() => {
      root?.render(createElement(ProgressRing, { progress: 140, label: 'Transfer progress' }))
    })
    expect(ring(container as HTMLDivElement).getAttribute('aria-valuenow')).toBe('100')
  })

  it('treats a non-finite progress as empty rather than rendering NaN', () => {
    const element = renderRing({ progress: Number.NaN })

    expect(ring(element).getAttribute('aria-valuenow')).toBe('0')
    expect(element.querySelector('.progress-ring__value')?.getAttribute('stroke-dasharray')).toBe('0 100')
  })

  it('draws the arc proportionally', () => {
    const element = renderRing({ progress: 25 })

    expect(element.querySelector('.progress-ring__value')?.getAttribute('stroke-dasharray')).toBe('25 75')
    expect(element.querySelector('.progress-ring__track')).not.toBe(null)
  })

  it('sizes the ring from the size prop', () => {
    const element = renderRing({ progress: 10, size: 24 })

    expect(ring(element).style.width).toBe('24px')
    expect(ring(element).style.height).toBe('24px')
  })
})

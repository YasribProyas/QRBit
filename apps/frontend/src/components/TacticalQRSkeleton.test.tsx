/** @vitest-environment jsdom */
/**
 * Tests for `TacticalQRSkeleton.tsx`.
 *
 * Verifies geometry, accessible roles, finder-pattern layout, code line placeholders,
 * link row structure, dark-mode-safe tokens, and prop overrides.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TacticalQRSkeleton } from './TacticalQRSkeleton'
import type { TacticalQRSkeletonProps } from './TacticalQRSkeleton'

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderSkeleton(props: Partial<TacticalQRSkeletonProps> = {}): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(createElement(TacticalQRSkeleton, props))
  })

  container = element
  root = created
  return element
}

function one(element: HTMLElement, selector: string, what: string): HTMLElement {
  const node = element.querySelector(selector)
  if (!(node instanceof HTMLElement)) throw new Error(`test bug: no ${what} (${selector})`)
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

describe('TacticalQRSkeleton — default geometry and structure', () => {
  it('renders full pairing skeleton with status bar, well, code line, and link row', () => {
    const element = renderSkeleton()

    // Root wrapper
    const rootEl = one(element, '.tactical-qr-skeleton', 'root skeleton element')
    expect(rootEl).not.toBeNull()

    // 1. Status bar skeleton
    const status = one(element, '.tactical-qr-skeleton__status', 'status bar skeleton')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toContain('Connecting host session…')
    const dot = one(status, '.tactical-qr-skeleton__status-dot', 'beacon dot placeholder')
    expect(dot.className).toContain('animate-beacon-ping')

    // 2. Well skeleton
    const well = one(element, '.tactical-qr-skeleton__well', 'code well plate')
    expect(well.style.background).toContain('var(--qrbit-signal-subtle)')

    const frame = one(well, '.tactical-qr-skeleton__frame', 'aspect-ratio frame')
    expect(frame.style.width).toBe('220px')
    expect(frame.style.aspectRatio).toBe('1 / 1')

    // 4 Corner viewfinder reticles
    const reticles = well.querySelectorAll('.tactical-qr-skeleton__reticle')
    expect(reticles).toHaveLength(4)
    expect(well.querySelector('.tactical-qr-skeleton__reticle--tl')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__reticle--tr')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__reticle--bl')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__reticle--br')).not.toBeNull()

    // 3 Finder patterns: top-left, top-right, bottom-left (none in bottom-right)
    const finders = well.querySelectorAll('.tactical-qr-skeleton__finder')
    expect(finders).toHaveLength(3)
    expect(well.querySelector('.tactical-qr-skeleton__finder--tl')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__finder--tr')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__finder--bl')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__finder--br')).toBeNull()

    // Timing and alignment patterns
    expect(well.querySelector('.tactical-qr-skeleton__timing-h')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__timing-v')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__alignment')).not.toBeNull()

    // Module grid and optical scan sweep
    expect(well.querySelector('.tactical-qr-skeleton__grid')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__sweep')).not.toBeNull()
    expect(well.querySelector('.tactical-qr-skeleton__shimmer')).not.toBeNull()

    // 3. Code line skeleton
    const codePill = one(element, '.tactical-qr-skeleton__code', 'code placeholder pill')
    expect(codePill.style.background).toContain('var(--qrbit-sunken)')
    const chars = codePill.querySelectorAll('.tactical-qr-skeleton__code-char')
    expect(chars).toHaveLength(8)

    // 4. Link row skeleton
    const linkRow = one(element, '.tactical-qr-skeleton__link-row', 'link row skeleton')
    expect(linkRow.style.background).toContain('var(--qrbit-sunken)')
    expect(linkRow.querySelector('.tactical-qr-skeleton__link-bar')).not.toBeNull()
    expect(linkRow.querySelector('.tactical-qr-skeleton__copy-btn')).not.toBeNull()
  })

  it('does not render active session class hooks that would falsify test assertions', () => {
    const element = renderSkeleton()

    // Must not have .session-qr, .tactical-qr__code, .tactical-qr__link, or .tactical-qr__copy
    expect(element.querySelector('.session-qr')).toBeNull()
    expect(element.querySelector('.tactical-qr__code')).toBeNull()
    expect(element.querySelector('.tactical-qr__link')).toBeNull()
    expect(element.querySelector('.tactical-qr__copy')).toBeNull()
  })
})

describe('TacticalQRSkeleton — props and overrides', () => {
  it('supports custom size for the well plate', () => {
    const element = renderSkeleton({ size: 280 })
    const frame = one(element, '.tactical-qr-skeleton__frame', 'custom size frame')
    expect(frame.style.width).toBe('280px')
  })

  it('supports custom statusText', () => {
    const element = renderSkeleton({ statusText: 'Generating secure QR…' })
    const status = one(element, '.tactical-qr-skeleton__status', 'status bar')
    expect(status.textContent).toContain('Generating secure QR…')
  })

  it('supports variant="well-only" by hiding status, code line, and link row', () => {
    const element = renderSkeleton({ variant: 'well-only' })

    expect(element.querySelector('.tactical-qr-skeleton__well')).not.toBeNull()
    expect(element.querySelector('.tactical-qr-skeleton__status')).toBeNull()
    expect(element.querySelector('.tactical-qr-skeleton__code')).toBeNull()
    expect(element.querySelector('.tactical-qr-skeleton__link-row')).toBeNull()
  })

  it('supports individual visibility flags to toggle subcomponents', () => {
    const element = renderSkeleton({
      showStatusBar: false,
      showCodeLine: false,
      showLinkRow: true,
    })

    expect(element.querySelector('.tactical-qr-skeleton__status')).toBeNull()
    expect(element.querySelector('.tactical-qr-skeleton__well')).not.toBeNull()
    expect(element.querySelector('.tactical-qr-skeleton__code')).toBeNull()
    expect(element.querySelector('.tactical-qr-skeleton__link-row')).not.toBeNull()
  })

  it('supports disabling animations via animate={false}', () => {
    const element = renderSkeleton({ animate: false })

    const dot = one(element, '.tactical-qr-skeleton__status-dot', 'beacon dot')
    expect(dot.className).not.toContain('animate-beacon-ping')

    expect(element.querySelector('.animate-scan-sweep')).toBeNull()
    expect(element.querySelector('.tactical-qr-skeleton__shimmer')).toBeNull()

    const finder = one(element, '.tactical-qr-skeleton__finder--tl', 'finder pattern')
    expect(finder.className).not.toContain('tactical-qr-skeleton__pulse')
  })

  it('forwards custom className and inline style to the root element', () => {
    const element = renderSkeleton({
      className: 'my-custom-skeleton',
      style: { opacity: '0.8' },
    })

    const rootEl = one(element, '.tactical-qr-skeleton', 'root container')
    expect(rootEl.className).toContain('my-custom-skeleton')
    expect(rootEl.style.opacity).toBe('0.8')
  })
})

describe('TacticalQRSkeleton — accessibility and design tokens', () => {
  it('marks decorative and non-interactive skeleton elements aria-hidden', () => {
    const element = renderSkeleton()

    expect(one(element, '.tactical-qr-skeleton__code', 'code').getAttribute('aria-hidden')).toBe(
      'true',
    )
    expect(
      one(element, '.tactical-qr-skeleton__link-container', 'link container').getAttribute(
        'aria-hidden',
      ),
    ).toBe('true')

    const finders = element.querySelectorAll('.tactical-qr-skeleton__finder')
    finders.forEach((finder) => {
      expect(finder.getAttribute('aria-hidden')).toBe('true')
    })

    const reticles = element.querySelectorAll('.tactical-qr-skeleton__reticle')
    reticles.forEach((reticle) => {
      expect(reticle.getAttribute('aria-hidden')).toBe('true')
    })
  })

  it('uses luminance-stable and semantic design tokens', () => {
    const element = renderSkeleton()

    const well = one(element, '.tactical-qr-skeleton__well', 'well plate')
    expect(well.style.background).toBe('var(--qrbit-signal-subtle)')
    expect(well.style.borderRadius).toBe('var(--qrbit-radius-md)')

    const reticle = one(element, '.tactical-qr-skeleton__reticle--tl', 'reticle')
    expect(reticle.style.borderColor).toBe('var(--qrbit-signal)')

    const codePill = one(element, '.tactical-qr-skeleton__code', 'code pill')
    expect(codePill.style.background).toBe('var(--qrbit-sunken)')
    expect(codePill.style.borderRadius).toBe('var(--qrbit-radius-sm)')
  })
})

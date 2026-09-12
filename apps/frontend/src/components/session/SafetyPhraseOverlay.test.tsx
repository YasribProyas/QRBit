/** @vitest-environment jsdom */
/**
 * SafetyPhraseOverlay tests (PLAN.md §8 Phase 2).
 *
 * The overlay is deliberately dumb: props in, `onConfirm` / `onAbort` out. These
 * tests therefore render it standalone with a fixed phrase — no crypto, no store
 * and no session flow is involved, which is the point of keeping it
 * presentational.
 *
 * jsdom ships no renderer, and this repo does not depend on a rendering library,
 * so React's own `act` + `createRoot` are used, as in `hooks/useWebRTC.test.tsx`.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SafetyPhraseOverlay } from './SafetyPhraseOverlay'
import type { SafetyPhraseOverlayProps } from './SafetyPhraseOverlay'

const PHRASE = ['river', 'copper', 'eight'] as const

interface Harness {
  container: HTMLDivElement
  onConfirm: () => void
  onAbort: () => void
  update: (next: Partial<SafetyPhraseOverlayProps>) => void
  text: () => string
  isDisabled: (selector: string) => boolean
  state: (selector: string) => string | null
  click: (selector: string) => void
  unmount: () => void
}

function requireButton(container: HTMLElement, selector: string): HTMLButtonElement {
  const node = container.querySelector(selector)
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`test bug: no button matched ${selector}`)
  }
  return node
}

function renderOverlay(overrides: Partial<SafetyPhraseOverlayProps> = {}): Harness {
  const onConfirm = vi.fn()
  const onAbort = vi.fn()

  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)

  let props: SafetyPhraseOverlayProps = {
    phrase: PHRASE,
    confirmed: false,
    peerConfirmed: false,
    onConfirm,
    onAbort,
    ...overrides,
  }

  const render = (next: SafetyPhraseOverlayProps): void => {
    props = next
    act(() => {
      root.render(createElement(SafetyPhraseOverlay, props))
    })
  }

  render(props)

  return {
    container,
    onConfirm,
    onAbort,
    update: (next) => {
      render({ ...props, ...next })
    },
    text: () => container.textContent ?? '',
    isDisabled: (selector) => requireButton(container, selector).disabled,
    state: (selector) => container.querySelector(selector)?.getAttribute('data-state') ?? null,
    click: (selector) => {
      act(() => {
        requireButton(container, selector).click()
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

let harness: Harness | null = null

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})

afterEach(() => {
  harness?.unmount()
  harness = null
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('SafetyPhraseOverlay phrase rendering (PLAN.md §8)', () => {
  it('renders the three words as three separate readable elements', () => {
    harness = renderOverlay()

    const words = Array.from(harness.container.querySelectorAll('.safety-phrase__word'))
    expect(words.map((word) => word.textContent)).toEqual(['river', 'copper', 'eight'])
    // One element per word, so a screen reader reads words rather than a run-on.
    expect(words).toHaveLength(3)
  })

  it('renders the phrase verbatim, leaving casing to CSS', () => {
    harness = renderOverlay({ phrase: ['River', 'COPPER', 'eight'] })

    const words = Array.from(harness.container.querySelectorAll('.safety-phrase__word'))
    expect(words.map((word) => word.textContent)).toEqual(['River', 'COPPER', 'eight'])
  })

  it('asks the user to compare both devices and announces itself as a modal', () => {
    harness = renderOverlay()

    const dialog = harness.container.querySelector('.safety-phrase')
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-labelledby')).toBe('safety-phrase-instruction')
    expect(harness.container.querySelector('#safety-phrase-instruction')?.textContent).toContain(
      'Confirm these match on both devices:',
    )
  })
})

describe('SafetyPhraseOverlay confirmation state (PLAN.md §8)', () => {
  it('fires onConfirm when Confirmed is tapped', () => {
    harness = renderOverlay()

    harness.click('.safety-phrase__confirm')

    expect(harness.onConfirm).toHaveBeenCalledTimes(1)
    expect(harness.onAbort).not.toHaveBeenCalled()
  })

  it('shows this device as confirmed and the peer as pending', () => {
    harness = renderOverlay()
    expect(harness.state('.safety-phrase__check[data-state="pending"]')).toBe('pending')

    harness.update({ confirmed: true })

    const checks = Array.from(harness.container.querySelectorAll('.safety-phrase__check'))
    expect(checks).toHaveLength(2)
    expect(checks[0]?.getAttribute('data-state')).toBe('confirmed')
    expect(checks[0]?.textContent).toContain('This device')
    expect(checks[0]?.textContent).toContain('confirmed ✓')
    expect(checks[1]?.getAttribute('data-state')).toBe('pending')
    expect(checks[1]?.textContent).toContain('Other device')
    expect(checks[1]?.textContent).toContain('not confirmed yet')
  })

  it('does not claim the session can start until both devices confirmed', () => {
    harness = renderOverlay({ confirmed: true })

    expect(harness.text()).toContain('The session starts only after both devices confirm.')
    expect(harness.text()).not.toContain('Both devices confirmed')

    harness.update({ peerConfirmed: true })

    expect(harness.text()).toContain('Both devices confirmed')
    expect(harness.state('.safety-phrase__check[data-state="pending"]')).toBe(null)
  })

  it('flips the peer indication when peerConfirmed changes', () => {
    harness = renderOverlay({ peerConfirmed: false })
    expect(harness.container.textContent).toContain('Other device')

    harness.update({ peerConfirmed: true })

    const peer = harness.container.querySelectorAll('.safety-phrase__check')[1]
    expect(peer?.getAttribute('data-state')).toBe('confirmed')
    expect(peer?.textContent).toContain('confirmed ✓')
  })

  it('fires onAbort, including after this device confirmed', () => {
    harness = renderOverlay({ confirmed: true })

    harness.click('.safety-phrase__abort')

    expect(harness.onAbort).toHaveBeenCalledTimes(1)
    expect(harness.onConfirm).not.toHaveBeenCalled()
  })
})

describe('SafetyPhraseOverlay busy and confirmed buttons (PLAN.md §8)', () => {
  it('disables both buttons while busy and swallows the clicks', () => {
    harness = renderOverlay({ busy: true })

    expect(harness.isDisabled('.safety-phrase__confirm')).toBe(true)
    expect(harness.isDisabled('.safety-phrase__abort')).toBe(true)

    harness.click('.safety-phrase__confirm')
    harness.click('.safety-phrase__abort')

    expect(harness.onConfirm).not.toHaveBeenCalled()
    expect(harness.onAbort).not.toHaveBeenCalled()
  })

  it('stops re-confirming once this device has confirmed', () => {
    harness = renderOverlay({ confirmed: true })

    expect(harness.isDisabled('.safety-phrase__confirm')).toBe(true)
    expect(harness.isDisabled('.safety-phrase__abort')).toBe(false)

    harness.click('.safety-phrase__confirm')

    expect(harness.onConfirm).not.toHaveBeenCalled()
    expect(harness.onAbort).not.toHaveBeenCalled()
  })

  it('leaves both buttons enabled while idle', () => {
    harness = renderOverlay()

    expect(harness.isDisabled('.safety-phrase__confirm')).toBe(false)
    expect(harness.isDisabled('.safety-phrase__abort')).toBe(false)
  })
})

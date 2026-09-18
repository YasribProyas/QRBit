/** @vitest-environment jsdom */
/**
 * SafetyPhraseOverlay tests (PLAN.md §8 Phase 2, decision D14).
 *
 * Under decision D14:
 * - Only the sender (role 'guest') sees the confirm control and gates the session.
 * - The receiver (role 'host') sees the three words prominently without a confirm control.
 * - Both roles have the Abort control.
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
  queryButton: (selector: string) => HTMLButtonElement | null
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
    queryButton: (selector) => {
      const node = container.querySelector(selector)
      return node instanceof HTMLButtonElement ? node : null
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

describe('SafetyPhraseOverlay sender confirmation state (decision D14)', () => {
  it('sender sees the overlay with a confirm control and an abort control', () => {
    harness = renderOverlay({ isSender: true })

    expect(harness.queryButton('.safety-phrase__confirm')).not.toBe(null)
    expect(harness.queryButton('.safety-phrase__abort')).not.toBe(null)
  })

  it('fires onConfirm when Confirmed is tapped', () => {
    harness = renderOverlay({ isSender: true })

    harness.click('.safety-phrase__confirm')

    expect(harness.onConfirm).toHaveBeenCalledTimes(1)
    expect(harness.onAbort).not.toHaveBeenCalled()
  })

  it('shows this device as confirmed and indicates status', () => {
    harness = renderOverlay({ isSender: true })
    expect(harness.state('.safety-phrase__check[data-state="pending"]')).toBe('pending')

    harness.update({ confirmed: true })

    const check = harness.container.querySelector('.safety-phrase__check')
    expect(check?.getAttribute('data-state')).toBe('confirmed')
    expect(check?.textContent).toContain('This device')
    expect(check?.textContent).toContain('confirmed ✓')
  })

  it('indicates the session starts once the sender confirms (decision D14)', () => {
    harness = renderOverlay({ isSender: true, confirmed: false })
    expect(harness.text()).toContain('The session starts once you confirm the words match.')

    harness.update({ confirmed: true })
    expect(harness.text()).toContain('Confirmed — starting the session…')
  })

  it('fires onAbort, including after this device confirmed', () => {
    harness = renderOverlay({ isSender: true, confirmed: true })

    harness.click('.safety-phrase__abort')

    expect(harness.onAbort).toHaveBeenCalledTimes(1)
    expect(harness.onConfirm).not.toHaveBeenCalled()
  })

  it('disables both buttons while busy and swallows the clicks', () => {
    harness = renderOverlay({ isSender: true, busy: true })

    expect(harness.isDisabled('.safety-phrase__confirm')).toBe(true)
    expect(harness.isDisabled('.safety-phrase__abort')).toBe(true)

    harness.click('.safety-phrase__confirm')
    harness.click('.safety-phrase__abort')

    expect(harness.onConfirm).not.toHaveBeenCalled()
    expect(harness.onAbort).not.toHaveBeenCalled()
  })

  it('stops re-confirming once this device has confirmed', () => {
    harness = renderOverlay({ isSender: true, confirmed: true })

    expect(harness.isDisabled('.safety-phrase__confirm')).toBe(true)
    expect(harness.isDisabled('.safety-phrase__abort')).toBe(false)

    harness.click('.safety-phrase__confirm')

    expect(harness.onConfirm).not.toHaveBeenCalled()
    expect(harness.onAbort).not.toHaveBeenCalled()
  })

  it('leaves both buttons enabled while idle', () => {
    harness = renderOverlay({ isSender: true })

    expect(harness.isDisabled('.safety-phrase__confirm')).toBe(false)
    expect(harness.isDisabled('.safety-phrase__abort')).toBe(false)
  })
})

describe('SafetyPhraseOverlay receiver view (decision D14)', () => {
  it('receiver sees the words prominently but has no confirm control', () => {
    harness = renderOverlay({ isSender: false })

    // Words are prominently visible
    const words = Array.from(harness.container.querySelectorAll('.safety-phrase__word'))
    expect(words.map((w) => w.textContent)).toEqual(['river', 'copper', 'eight'])

    // Receiver has NO gating confirm button
    expect(harness.queryButton('.safety-phrase__confirm')).toBe(null)

    // Receiver DOES have an abort button
    expect(harness.queryButton('.safety-phrase__abort')).not.toBe(null)
  })

  it('shows receiver waiting for sender confirmation', () => {
    harness = renderOverlay({ isSender: false, peerConfirmed: false })

    const check = harness.container.querySelector('.safety-phrase__check')
    expect(check?.getAttribute('data-state')).toBe('pending')
    expect(check?.textContent).toContain('Sender')
    expect(check?.textContent).toContain('waiting for confirmation…')
    expect(harness.text()).toContain('Waiting for the sender to confirm the safety phrase.')
  })

  it('updates receiver status when sender confirms', () => {
    harness = renderOverlay({ isSender: false, peerConfirmed: false })

    harness.update({ peerConfirmed: true })

    const check = harness.container.querySelector('.safety-phrase__check')
    expect(check?.getAttribute('data-state')).toBe('confirmed')
    expect(check?.textContent).toContain('Sender')
    expect(check?.textContent).toContain('confirmed ✓')
    expect(harness.text()).toContain('Sender confirmed — starting the session…')
  })

  it('allows receiver to abort the session', () => {
    harness = renderOverlay({ isSender: false })

    harness.click('.safety-phrase__abort')
    expect(harness.onAbort).toHaveBeenCalledTimes(1)
  })

  it('disables receiver abort button while busy', () => {
    harness = renderOverlay({ isSender: false, busy: true })

    expect(harness.isDisabled('.safety-phrase__abort')).toBe(true)
    harness.click('.safety-phrase__abort')
    expect(harness.onAbort).not.toHaveBeenCalled()
  })
})

/** @vitest-environment jsdom */
/**
 * Page-level tests for `pages/Session.tsx` (PLAN.md §8).
 *
 * `useSession` is mocked so the page can be rendered in each phase directly; the
 * hook's real behaviour is covered by useSession.test.tsx. What matters here is the
 * gating contract: the safety-phrase overlay is mounted only while the store is in
 * 'pairing', it carries both confirmation flags, and Abort is wired through.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UseSessionResult } from '../hooks/useSession'

const mocked = vi.hoisted(() => ({
  current: null as UseSessionResult | null,
  confirmPhrase: vi.fn(),
  abort: vi.fn(),
  restart: vi.fn(),
}))

vi.mock('../hooks/useSession', () => ({
  useSession: () => mocked.current,
}))

const { Session } = await import('./Session')

const PHRASE: [string, string, string] = ['RIVER', 'COPPER', 'EIGHT']

function makeResult(overrides: Partial<UseSessionResult> = {}): UseSessionResult {
  return {
    role: 'guest',
    phase: 'connecting',
    sessionCode: 'A7X3K9P2',
    connectionState: 'new',
    errorMessage: null,
    status: { label: 'Connecting…', tone: 'warn' },
    roleLabel: 'Guest — you opened the other device’s session',
    localHello: null,
    peerHello: null,
    safetyPhrase: null,
    phraseConfirmed: false,
    peerConfirmed: false,
    confirmPhrase: () => {
      mocked.confirmPhrase()
    },
    abort: () => {
      mocked.abort()
    },
    restart: () => {
      mocked.restart()
    },
    ...overrides,
  }
}

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

function renderSession(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)
  act(() => {
    created.render(
      <MemoryRouter initialEntries={['/session?code=A7X3K9P2']}>
        <Session />
      </MemoryRouter>,
    )
  })
  container = element
  root = created
  return element
}

function queryButton(element: HTMLElement, label: string): HTMLButtonElement | null {
  for (const button of element.querySelectorAll('button')) {
    if (button.textContent?.includes(label)) return button
  }
  return null
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
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

describe('Session page phase gating (PLAN.md §8)', () => {
  it('mounts the safety-phrase overlay while pairing', () => {
    mocked.current = makeResult({ phase: 'pairing', safetyPhrase: PHRASE, connectionState: 'connected' })

    const element = renderSession()

    const overlay = element.querySelector('.safety-phrase')
    expect(overlay).not.toBe(null)
    expect(overlay?.getAttribute('aria-modal')).toBe('true')
    expect(element.textContent).toContain('Confirm these match on both devices:')
    for (const word of PHRASE) {
      expect(element.textContent).toContain(word)
    }
    expect(queryButton(element, 'Confirmed')).not.toBe(null)
    expect(queryButton(element, 'Abort session')).not.toBe(null)
  })

  it('does not mount the overlay before the phrase exists', () => {
    mocked.current = makeResult({ phase: 'connecting', safetyPhrase: null })

    const element = renderSession()

    expect(element.querySelector('.safety-phrase')).toBe(null)
    expect(element.textContent).toContain('Connecting…')
  })

  it('unmounts the overlay once the session is active', () => {
    mocked.current = makeResult({
      phase: 'active',
      safetyPhrase: PHRASE,
      phraseConfirmed: true,
      peerConfirmed: true,
      status: { label: 'Connected', tone: 'ok' },
    })

    const element = renderSession()

    expect(element.querySelector('.safety-phrase')).toBe(null)
    expect(element.textContent).toContain('Connected')
  })

  it('shows this device confirmed while the peer is still pending', () => {
    mocked.current = makeResult({ phase: 'pairing', safetyPhrase: PHRASE, phraseConfirmed: true })

    const element = renderSession()

    expect(element.textContent).toContain('confirmed ✓')
    expect(element.textContent).toContain('not confirmed yet')
    // The confirm button is a one-way action.
    expect(queryButton(element, 'Confirmed')?.disabled).toBe(true)
    // Abort must stay available while waiting for the peer.
    expect(queryButton(element, 'Abort session')?.disabled).toBe(false)
  })

  it('reports the peer confirmation as soon as it arrives', () => {
    mocked.current = makeResult({ phase: 'pairing', safetyPhrase: PHRASE, peerConfirmed: true })

    const element = renderSession()

    const peerState = element.querySelector('.safety-phrase__status p:last-child')
    expect(peerState?.getAttribute('data-state')).toBe('confirmed')
  })

  it('wires Confirmed and Abort to the session hook', () => {
    mocked.current = makeResult({ phase: 'pairing', safetyPhrase: PHRASE })
    const element = renderSession()

    const confirm = queryButton(element, 'Confirmed')
    const abort = queryButton(element, 'Abort session')
    if (!confirm || !abort) throw new Error('test bug: the overlay buttons are missing')

    act(() => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      abort.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocked.confirmPhrase).toHaveBeenCalledTimes(1)
    expect(mocked.abort).toHaveBeenCalledTimes(1)
  })
})

describe('Session page recovery paths (PLAN.md §8 Phase 4)', () => {
  it('offers a retry on error', () => {
    mocked.current = makeResult({
      phase: 'ended',
      errorMessage: 'the signaling connection closed before pairing (code 1006)',
      status: { label: 'Error', tone: 'error' },
    })

    const element = renderSession()
    const retry = queryButton(element, 'Try again')
    if (!retry) throw new Error('test bug: the retry button is missing')

    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocked.restart).toHaveBeenCalledTimes(1)
    expect(element.querySelector('.safety-phrase')).toBe(null)
  })

  it('offers a fresh session after a clean end', () => {
    mocked.current = makeResult({
      phase: 'ended',
      errorMessage: null,
      status: { label: 'Session ended', tone: 'idle' },
    })

    const element = renderSession()
    expect(element.textContent).toContain('Session ended')

    const start = queryButton(element, 'Start a new session')
    if (!start) throw new Error('test bug: the new-session button is missing')
    act(() => {
      start.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocked.restart).toHaveBeenCalledTimes(1)
  })
})

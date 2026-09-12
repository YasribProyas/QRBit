/** @vitest-environment jsdom */
/**
 * Page-level tests for `pages/Session.tsx` (PLAN.md §8).
 *
 * `useSession` is mocked so the page can be rendered in each phase directly; the
 * hook's real behaviour is covered by useSession.test.tsx. What matters here is the
 * gating contract: the safety-phrase overlay is mounted only while the store is in
 * 'pairing', it carries both confirmation flags, Abort is wired through, and the
 * session board (PLAN.md §8 Phase 3) is the active view — with the add bar on the
 * sender only, and the Phase 1/2 channel-check panel gone for good.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UseSessionResult } from '../hooks/useSession'
import type { ItemsApi } from '../components/session/SessionBoard'
import { useSessionStore } from '../store/sessionStore'

/**
 * The items API is part of what `useSession` returns, so the stand-in result carries
 * it too — the page hands it straight to the board and the add bar.
 */
type MockedSession = UseSessionResult & ItemsApi

const mocked = vi.hoisted(() => ({
  current: null as MockedSession | null,
  confirmPhrase: vi.fn(),
  abort: vi.fn(),
  restart: vi.fn(),
}))

vi.mock('../hooks/useSession', () => ({
  useSession: () => mocked.current,
}))

const { Session } = await import('./Session')

const PHRASE: [string, string, string] = ['RIVER', 'COPPER', 'EIGHT']

function makeResult(overrides: Partial<MockedSession> = {}): MockedSession {
  return {
    role: 'guest',
    phase: 'connecting',
    sessionCode: 'A7X3K9P2',
    connectionState: 'new',
    errorMessage: null,
    status: { label: 'Connecting…', tone: 'warn' },
    roleLabel: 'Guest — you opened the other device’s session',
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
    addTextItem: () => 'text-id',
    addRichTextItem: () => 'rich-id',
    addFileItem: () => 'file-id',
    addLockedItem: async () => 'locked-id',
    unlockItem: async () => true,
    lockItemAgain: vi.fn(),
    updateTextItem: vi.fn(),
    updateRichTextItem: vi.fn(),
    deleteItem: vi.fn(),
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
  useSessionStore.getState().reset()
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

describe('Session page in the active phase (PLAN.md §8 Phase 3)', () => {
  it('renders the board for the sender, with the add bar and no channel check', () => {
    mocked.current = makeResult({
      role: 'guest',
      phase: 'active',
      connectionState: 'connected',
      status: { label: 'Connected', tone: 'ok' },
    })

    const element = renderSession()

    expect(element.querySelector('.session-board')).not.toBe(null)
    expect(element.querySelector('.add-item-bar')).not.toBe(null)
    // The Phase 1/2 greeting panel has been retired by Phase 3.
    expect(element.textContent).not.toContain('Channel check')
    expect(element.textContent).not.toContain('Waiting for the data channel')
  })

  it('renders the board for the receiver but no add bar (PLAN.md §9: sender only)', () => {
    mocked.current = makeResult({
      role: 'host',
      phase: 'active',
      connectionState: 'connected',
      status: { label: 'Connected', tone: 'ok' },
    })

    const element = renderSession()

    expect(element.querySelector('.session-board')).not.toBe(null)
    expect(element.querySelector('.add-item-bar')).toBe(null)
  })

  it('shows no board before the session is active', () => {
    mocked.current = makeResult({ phase: 'connecting' })

    const element = renderSession()

    expect(element.querySelector('.session-board')).toBe(null)
    expect(element.querySelector('.add-item-bar')).toBe(null)
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

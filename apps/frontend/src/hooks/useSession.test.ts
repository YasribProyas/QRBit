/**
 * Unit tests for the pure helpers exported by useSession (PLAN.md §8).
 *
 * Only the pure functions are exercised: the hook itself is integration behaviour,
 * and a React/DOM harness would test the framework rather than this logic.
 */

import {
  PEER_REJOINED_REASON,
  describeError,
  describeSessionStatus,
  parseNewSessionResponse,
} from './useSession'
import { useSessionStore } from '../store/sessionStore'

describe('parseNewSessionResponse', () => {
  it('accepts a session code without TURN credentials', () => {
    expect(parseNewSessionResponse({ code: 'A7X3K9P2' })).toEqual({ code: 'A7X3K9P2' })
  })

  it('keeps TURN credentials when both fields are present', () => {
    const parsed = parseNewSessionResponse({
      code: 'A7X3K9P2',
      turnCredentials: { username: 'user', credential: 'cred' },
    })

    expect(parsed).toEqual({
      code: 'A7X3K9P2',
      turnCredentials: { username: 'user', credential: 'cred' },
    })
  })

  it('drops a malformed TURN payload instead of failing the whole session', () => {
    expect(parseNewSessionResponse({ code: 'A7X3K9P2', turnCredentials: { username: 'user' } })).toEqual(
      { code: 'A7X3K9P2' },
    )
    expect(parseNewSessionResponse({ code: 'A7X3K9P2', turnCredentials: 'nope' })).toEqual({
      code: 'A7X3K9P2',
    })
  })

  it('rejects a payload that carries no usable code', () => {
    expect(() => parseNewSessionResponse(null)).toThrow(/unexpected payload/)
    expect(() => parseNewSessionResponse({ code: '' })).toThrow(/without a code/)
    expect(() => parseNewSessionResponse({ code: 42 })).toThrow(/without a code/)
  })
})

describe('describeError', () => {
  it('uses the Error message when there is one', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('falls back to a non-blank string and then to a generic message', () => {
    expect(describeError('plain text')).toBe('plain text')
    expect(describeError('   ')).toBe('Something went wrong starting the session')
    expect(describeError(new Error(''))).toBe('Something went wrong starting the session')
    expect(describeError(null)).toBe('Something went wrong starting the session')
  })
})

describe('describeSessionStatus', () => {
  it('reports an error above every other state', () => {
    expect(describeSessionStatus('idle', 'new', 'nope')).toEqual({ label: 'Error', tone: 'error' })
  })

  it('reports connected once the session is active or the peer connects', () => {
    expect(describeSessionStatus('active', 'new', null)).toEqual({ label: 'Connected', tone: 'ok' })
    expect(describeSessionStatus('connecting', 'connected', null)).toEqual({
      label: 'Connected',
      tone: 'ok',
    })
  })

  it('reports the ended session as idle', () => {
    expect(describeSessionStatus('ended', 'closed', null)).toEqual({
      label: 'Session ended',
      tone: 'idle',
    })
  })

  it('maps a failed or lost connection to an error or a warning', () => {
    expect(describeSessionStatus('connecting', 'failed', null)).toEqual({
      label: 'Connection failed',
      tone: 'error',
    })
    expect(describeSessionStatus('connecting', 'disconnected', null)).toEqual({
      label: 'Connection lost',
      tone: 'warn',
    })
  })

  it('is still connecting otherwise', () => {
    expect(describeSessionStatus('connecting', 'new', null)).toEqual({
      label: 'Connecting…',
      tone: 'warn',
    })
  })
})

/**
 * ORCHESTRATION.md D4: the host ends the session when the other device re-joins.
 *
 * The hook's `pubkey` branch has no React harness here (see the file header), so the
 * path under test is the one it uses: the exported reason ends up in the store's
 * `errorMessage` via `endSession`, which Session.tsx renders as the Error panel.
 */
describe('a peer that re-joined after the offer (D4)', () => {
  afterEach(() => {
    useSessionStore.getState().reset()
  })

  it('ends the session and tells the user the other device reconnected', () => {
    useSessionStore.getState().startConnecting('host', 'A7X3K9P2')
    useSessionStore.getState().endSession(PEER_REJOINED_REASON)

    const state = useSessionStore.getState()
    expect(state.phase).toBe('ended')
    expect(state.errorMessage).toBe(PEER_REJOINED_REASON)
    expect(state.connectionState).toBe('new')
    expect(PEER_REJOINED_REASON).toMatch(/reconnected/i)
    expect(PEER_REJOINED_REASON).toMatch(/new session/i)
  })

  it('surfaces as an Error status rather than a silent "Connecting…"', () => {
    useSessionStore.getState().startConnecting('host', 'A7X3K9P2')
    useSessionStore.getState().endSession(PEER_REJOINED_REASON)

    const { phase, connectionState, errorMessage } = useSessionStore.getState()

    expect(describeSessionStatus(phase, connectionState, errorMessage)).toEqual({
      label: 'Error',
      tone: 'error',
    })
  })
})

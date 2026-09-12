/** @vitest-environment jsdom */
/**
 * Session store tests for the Phase 2 phrase-confirm additions (PLAN.md §8/§9).
 *
 * PLAN.md §8 blocks the session until *both* devices have confirmed, so the
 * store keeps the two flags apart (`phraseConfirmed` = this device,
 * `peerConfirmed` = the peer) and derives `bothConfirmed()` from them. Most tests
 * here call the actions directly; the last group renders a probe that consumes
 * `bothConfirmed()` the way a component will, because that derived selector is
 * only useful if it actually re-renders its subscriber.
 *
 * jsdom is opted into file-wide for that probe (vitest 5 has no
 * environmentMatchGlobs equivalent). The assertions themselves need no DOM.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { INITIAL_SESSION_STATE, useSessionStore } from './sessionStore'

const PHRASE: [string, string, string] = ['river', 'copper', 'eight']

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  useSessionStore.getState().reset()
})

afterEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  useSessionStore.getState().reset()
})

describe('session store Phase 2 state (PLAN.md §9)', () => {
  it('starts unconfirmed on both sides', () => {
    const state = useSessionStore.getState()

    expect(state.phraseConfirmed).toBe(false)
    expect(state.peerConfirmed).toBe(false)
    expect(state.bothConfirmed()).toBe(false)
    // Phase 1 fields must survive the addition untouched.
    expect(state.safetyPhrase).toBe(null)
    expect(state.phase).toBe('idle')
    expect(state.errorMessage).toBe(null)
  })

  it('confirms only this device via confirmPhrase', () => {
    useSessionStore.getState().confirmPhrase()

    expect(useSessionStore.getState().phraseConfirmed).toBe(true)
    expect(useSessionStore.getState().peerConfirmed).toBe(false)
    expect(useSessionStore.getState().bothConfirmed()).toBe(false)
  })

  it('needs both flags before bothConfirmed is true', () => {
    const store = useSessionStore.getState()

    store.setPeerConfirmed(true)
    expect(useSessionStore.getState().bothConfirmed()).toBe(false)

    store.confirmPhrase()
    expect(useSessionStore.getState().bothConfirmed()).toBe(true)
  })

  it('withdraws confirmation when a flag is set back to false', () => {
    const store = useSessionStore.getState()
    store.confirmPhrase()
    store.setPeerConfirmed(true)
    expect(useSessionStore.getState().bothConfirmed()).toBe(true)

    useSessionStore.getState().setPeerConfirmed(false)
    expect(useSessionStore.getState().bothConfirmed()).toBe(false)

    useSessionStore.getState().setPeerConfirmed(true)
    useSessionStore.getState().setPhraseConfirmed(false)
    expect(useSessionStore.getState().bothConfirmed()).toBe(false)
  })

  it('stores and clears the safety phrase', () => {
    useSessionStore.getState().setSafetyPhrase(PHRASE)
    expect(useSessionStore.getState().safetyPhrase).toEqual(['river', 'copper', 'eight'])

    useSessionStore.getState().setSafetyPhrase(null)
    expect(useSessionStore.getState().safetyPhrase).toBe(null)
  })
})

describe('session store Phase 2 resets (PLAN.md §8)', () => {
  it('reset clears both confirmation flags', () => {
    const store = useSessionStore.getState()
    store.setSafetyPhrase(PHRASE)
    store.confirmPhrase()
    store.setPeerConfirmed(true)

    useSessionStore.getState().reset()

    const state = useSessionStore.getState()
    expect(state.phraseConfirmed).toBe(false)
    expect(state.peerConfirmed).toBe(false)
    expect(state.safetyPhrase).toBe(null)
    expect(state.bothConfirmed()).toBe(false)
    expect(state).toMatchObject(INITIAL_SESSION_STATE)
  })

  it('endSession drops the peer confirmation with the session', () => {
    const store = useSessionStore.getState()
    store.confirmPhrase()
    store.setPeerConfirmed(true)

    useSessionStore.getState().endSession('the other device disconnected')

    const state = useSessionStore.getState()
    expect(state.phase).toBe('ended')
    expect(state.errorMessage).toBe('the other device disconnected')
    expect(state.peerConfirmed).toBe(false)
    expect(state.bothConfirmed()).toBe(false)
  })

  it('startConnecting clears a stale confirmation from the last session', () => {
    const store = useSessionStore.getState()
    store.confirmPhrase()
    store.setPeerConfirmed(true)

    useSessionStore.getState().startConnecting('host', 'A7X3K9P2')

    const state = useSessionStore.getState()
    expect(state.role).toBe('host')
    expect(state.sessionCode).toBe('A7X3K9P2')
    expect(state.phase).toBe('connecting')
    expect(state.phraseConfirmed).toBe(false)
    expect(state.peerConfirmed).toBe(false)
    expect(state.bothConfirmed()).toBe(false)
  })
})

describe('bothConfirmed() as a live selector (PLAN.md §8)', () => {
  function mountProbe(): { text: () => string; unmount: () => void } {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    function Probe() {
      const both = useSessionStore((state) => state.bothConfirmed())
      return createElement('span', null, both ? 'both' : 'waiting')
    }

    act(() => {
      root.render(createElement(Probe))
    })

    return {
      text: () => container.textContent ?? '',
      unmount: () => {
        act(() => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  it('re-renders its subscriber as each flag flips', () => {
    const probe = mountProbe()
    expect(probe.text()).toBe('waiting')

    act(() => {
      useSessionStore.getState().confirmPhrase()
    })
    expect(probe.text()).toBe('waiting')

    act(() => {
      useSessionStore.getState().setPeerConfirmed(true)
    })
    expect(probe.text()).toBe('both')

    act(() => {
      useSessionStore.getState().reset()
    })
    expect(probe.text()).toBe('waiting')

    probe.unmount()
  })
})

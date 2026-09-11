/** @vitest-environment jsdom */
/**
 * Tests that the peer's connection state reaches the session store (PLAN.md §9).
 *
 * `useSession` — and every Phase 3 component — reads `connectionState` from
 * `useSessionStore`, so the hook's peer subscription has to write there too. A
 * hook-local `useState` alone leaves the store at `'new'` for the whole session.
 *
 * node/jsdom ship no `RTCPeerConnection`, so the global is replaced with the fake
 * below before the hook constructs its peer. React's own `act` is used directly
 * rather than pulling in a rendering library.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useSessionStore } from '../store/sessionStore'
import { useWebRTC } from './useWebRTC'
import type { UseWebRTCResult } from './useWebRTC'

class FakeRTCPeerConnection {
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null
  onconnectionstatechange: ((event: Event) => void) | null = null

  connectionState: RTCPeerConnectionState = 'new'
  closed = false

  constructor() {
    fakes.push(this)
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }
}

let fakes: FakeRTCPeerConnection[] = []
let originalRtcPeerConnection: unknown

function latestFake(): FakeRTCPeerConnection {
  const fake = fakes[fakes.length - 1]
  if (!fake) throw new Error('test bug: no fake RTCPeerConnection was constructed')
  return fake
}

/** Renders the hook and exposes its latest result, so tests can drive it directly. */
function renderHookProbe(): { result: () => UseWebRTCResult; unmount: () => void } {
  let current: UseWebRTCResult | null = null

  function Probe() {
    current = useWebRTC({ onIceCandidate: () => {}, onMessage: () => {}, onOpen: () => {} })
    return null
  }

  const root = createRoot(document.createElement('div'))
  act(() => {
    root.render(<Probe />)
  })

  return {
    result: () => {
      if (!current) throw new Error('test bug: the probe did not render')
      return current
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
    },
  }
}

beforeEach(() => {
  fakes = []
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  originalRtcPeerConnection = (globalThis as unknown as Record<string, unknown>)['RTCPeerConnection']
  ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = FakeRTCPeerConnection
  useSessionStore.getState().reset()
})

afterEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = originalRtcPeerConnection
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  useSessionStore.getState().reset()
})

describe('useWebRTC connection state (PLAN.md §9)', () => {
  it('mirrors every peer state change into the session store', () => {
    const probe = renderHookProbe()
    act(() => {
      probe.result().createPeer()
    })
    const fake = latestFake()
    expect(useSessionStore.getState().connectionState).toBe('new')

    act(() => {
      fake.connectionState = 'connecting'
      fake.onconnectionstatechange?.(new Event('connectionstatechange'))
    })
    expect(probe.result().connectionState).toBe('connecting')
    expect(useSessionStore.getState().connectionState).toBe('connecting')

    act(() => {
      fake.connectionState = 'connected'
      fake.onconnectionstatechange?.(new Event('connectionstatechange'))
    })
    expect(probe.result().connectionState).toBe('connected')
    expect(useSessionStore.getState().connectionState).toBe('connected')

    probe.unmount()
  })

  it('marks the store closed when the peer is torn down', () => {
    const probe = renderHookProbe()
    act(() => {
      probe.result().createPeer()
    })

    act(() => {
      probe.result().close()
    })

    expect(latestFake().closed).toBe(true)
    expect(useSessionStore.getState().connectionState).toBe('closed')

    probe.unmount()
  })
})

/** @vitest-environment jsdom */
/**
 * Tests for the `useWebRTC` wrapper (PLAN.md §9, §12).
 *
 * `useSession` — and every Phase 3 component — reads `connectionState` from
 * `useSessionStore`, so the hook's peer subscription has to write there too. A
 * hook-local `useState` alone leaves the store at `'new'` for the whole session.
 *
 * The second group covers the Phase 2 async send channel: because AES-GCM is
 * asynchronous the `send()` signature stays `void` (ORCHESTRATION.md D3), so a
 * failed send has to reach the session through `onSendError` rather than by
 * throwing at the call site.
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
import type { UseWebRTCHandlers, UseWebRTCResult } from './useWebRTC'

class FakeDataChannel {
  readonly sent: unknown[] = []
  readyState: RTCDataChannelState = 'connecting'
  binaryType: BinaryType = 'blob'
  closed = false

  /** The pump threshold the wrapper's peer armed, and the queue it reads. */
  bufferedAmountLowThreshold = 0
  bufferedAmount = 0

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onbufferedamountlow: ((event: Event) => void) | null = null

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 'closed'
  }

  open(): void {
    this.readyState = 'open'
    this.onopen?.(new Event('open'))
  }
}

class FakeRTCPeerConnection {
  readonly createdChannels: FakeDataChannel[] = []

  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null
  onconnectionstatechange: ((event: Event) => void) | null = null

  connectionState: RTCPeerConnectionState = 'new'
  closed = false

  constructor() {
    fakes.push(this)
  }

  createDataChannel(): RTCDataChannel {
    const channel = new FakeDataChannel()
    this.createdChannels.push(channel)
    return channel as unknown as RTCDataChannel
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'fake-offer-sdp' }
  }

  async setLocalDescription(): Promise<void> {
    // Nothing to record: this fake only needs to satisfy the host path.
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
function renderHookProbe(
  overrides: Partial<UseWebRTCHandlers> = {},
): { result: () => UseWebRTCResult; unmount: () => void } {
  let current: UseWebRTCResult | null = null

  function Probe() {
    current = useWebRTC({
      onIceCandidate: () => {},
      onMessage: () => {},
      onOpen: () => {},
      onSendError: () => {},
      ...overrides,
    })
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

/** A stand-in for the ECDH-derived session key; the derivation is tested elsewhere. */
async function makeSessionKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** Brings the probe's peer up to the point where a frame can be sent. */
async function openChannel(
  probe: { result: () => UseWebRTCResult },
): Promise<FakeDataChannel> {
  act(() => {
    probe.result().createPeer()
  })
  await act(async () => {
    await probe.result().initAsHost()
  })

  const channel = latestFake().createdChannels[0]
  if (!channel) throw new Error('test bug: initAsHost created no data channel')
  act(() => {
    channel.open()
  })
  return channel
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

describe('useWebRTC encrypted send channel (ORCHESTRATION.md D3)', () => {
  it('refuses to send until the session key has been installed', async () => {
    const probe = renderHookProbe()
    await openChannel(probe)

    expect(() => {
      probe.result().send({ t: 'phrase-confirm' })
    }).toThrow(/session key is not ready/)

    probe.unmount()
  })

  it('installs the session key on the peer so a frame can be encrypted and sent', async () => {
    const probe = renderHookProbe()
    const channel = await openChannel(probe)

    const key = await makeSessionKey()
    act(() => {
      probe.result().setSessionKey(key)
    })
    act(() => {
      probe.result().send({ t: 'session-end' })
    })
    await act(async () => {
      await probe.result().drain()
    })

    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]).toBeInstanceOf(ArrayBuffer)

    probe.unmount()
  })

  it('routes an asynchronous send failure to onSendError instead of dropping it', async () => {
    const errors: unknown[] = []
    const probe = renderHookProbe({ onSendError: (error) => errors.push(error) })
    const channel = await openChannel(probe)
    const key = await makeSessionKey()
    act(() => {
      probe.result().setSessionKey(key)
    })

    act(() => {
      probe.result().send({ t: 'session-end' })
    })
    // The peer is gone by the time the queued write runs.
    channel.readyState = 'closed'

    await act(async () => {
      await probe.result().drain()
    })

    expect(errors).toHaveLength(1)
    expect(channel.sent).toEqual([])

    probe.unmount()
  })

  it('resolves drain() for a probe whose peer was never created', async () => {
    const probe = renderHookProbe()

    await expect(probe.result().drain()).resolves.toBeUndefined()

    probe.unmount()
  })

  it('refuses item frames until markActive() is called, and carries them afterwards', async () => {
    const probe = renderHookProbe()
    const channel = await openChannel(probe)
    const key = await makeSessionKey()
    act(() => {
      probe.result().setSessionKey(key)
    })

    expect(() => {
      probe.result().send({ t: 'text-delta', id: 'a', content: 'too early' })
    }).toThrow(/marked active/)
    // The control frames that gate the session itself are always allowed.
    act(() => {
      probe.result().send({ t: 'phrase-confirm' })
    })
    await act(async () => {
      await probe.result().drain()
    })
    expect(channel.sent).toHaveLength(1)

    act(() => {
      probe.result().markActive()
    })
    act(() => {
      void probe.result().sendAwaitable({ t: 'text-delta', id: 'a', content: 'now' })
    })
    await act(async () => {
      await probe.result().drain()
    })
    expect(channel.sent).toHaveLength(2)

    probe.unmount()
  })

  it('applies markActive() to a peer that is created afterwards', async () => {
    const probe = renderHookProbe()

    // The host builds its peer only once the worker issues TURN credentials, so the
    // gate can be opened before there is anything to open it on.
    act(() => {
      probe.result().markActive()
    })
    await openChannel(probe)
    const key = await makeSessionKey()
    act(() => {
      probe.result().setSessionKey(key)
    })

    expect(() => {
      probe.result().send({ t: 'item-delete', id: 'a' })
    }).not.toThrow()

    probe.unmount()
  })

  it('resolves sendAwaitable() once the frame has been written', async () => {
    const probe = renderHookProbe()
    const channel = await openChannel(probe)
    const key = await makeSessionKey()
    act(() => {
      probe.result().markActive()
      probe.result().setSessionKey(key)
    })

    await act(async () => {
      await probe.result().sendAwaitable({ t: 'file-done', id: 'a' })
    })

    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]).toBeInstanceOf(ArrayBuffer)

    probe.unmount()
  })

  it('reports the channel backpressure to the pumps and waits for it to clear', async () => {
    const probe = renderHookProbe()
    const channel = await openChannel(probe)

    // Below the threshold: nothing to wait for.
    await expect(probe.result().waitForBackpressure()).resolves.toBeUndefined()

    channel.bufferedAmount = channel.bufferedAmountLowThreshold + 1
    let resumed = false
    const waiting = probe.result().waitForBackpressure().then(() => {
      resumed = true
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(resumed).toBe(false)

    channel.bufferedAmount = 0
    act(() => {
      channel.onbufferedamountlow?.(new Event('bufferedamountlow'))
    })
    await act(async () => {
      await waiting
    })
    expect(resumed).toBe(true)

    probe.unmount()
  })

  it('wakes a pump waiting on backpressure when the peer is torn down', async () => {
    const probe = renderHookProbe()
    const channel = await openChannel(probe)
    channel.bufferedAmount = channel.bufferedAmountLowThreshold + 1

    const waiting = probe.result().waitForBackpressure()
    act(() => {
      probe.result().close()
    })

    await act(async () => {
      await expect(waiting).resolves.toBeUndefined()
    })

    probe.unmount()
  })

  it('wakes a pump waiting on backpressure when the item work is stopped instead', async () => {
    const probe = renderHookProbe()
    const channel = await openChannel(probe)
    channel.bufferedAmount = channel.bufferedAmountLowThreshold + 1

    const waiting = probe.result().waitForBackpressure()
    act(() => {
      probe.result().releaseBackpressure()
    })

    await act(async () => {
      await expect(waiting).resolves.toBeUndefined()
    })
    // The peer survives: this is what the peer's clean `session-end` path needs, where
    // no close() runs.
    expect(probe.result().connectionState).not.toBe('closed')

    probe.unmount()
  })
})

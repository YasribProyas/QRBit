/**
 * Unit tests for the signaling client.
 *
 * Node has no real signaling server, so a fake WebSocket is injected through
 * `SignalingClientOptions.socketFactory`. That is the only reason the injection
 * seam exists; production callers never pass it.
 */

import {
  SignalingClient,
  isPeerJoinedCue,
  isPeerRejoinedCue,
  isSignalingMessage,
  shouldHostSendOffer,
} from './signaling'
import type { SignalingMessage, SessionRole } from './signaling'

class FakeWebSocket {
  readonly url: string
  readonly sent: string[] = []

  readyState = 0
  closed = false

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  fireOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  deliver(payload: string): void {
    this.onmessage?.({ data: payload } as unknown as MessageEvent)
  }

  deliverNonString(): void {
    this.onmessage?.({ data: new ArrayBuffer(4) } as unknown as MessageEvent)
  }

  fireError(): void {
    this.onerror?.(new Event('error'))
  }

  fireClose(code = 1006, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason } as unknown as CloseEvent)
  }
}

class FakeSocketRegistry {
  readonly sockets: FakeWebSocket[] = []

  readonly factory = (url: string): WebSocket => {
    const socket = new FakeWebSocket(url)
    this.sockets.push(socket)
    return socket as unknown as WebSocket
  }

  get latest(): FakeWebSocket {
    const socket = this.sockets[this.sockets.length - 1]
    if (!socket) throw new Error('test bug: no socket has been created yet')
    return socket
  }
}

const BASE_URL = 'ws://localhost:8787'
const CODE = 'A7X3K9P2'

function makeClient(url: string = BASE_URL): { client: SignalingClient; registry: FakeSocketRegistry } {
  const registry = new FakeSocketRegistry()
  const client = new SignalingClient(url, { socketFactory: registry.factory })
  return { client, registry }
}

/**
 * Starts a connect without awaiting it, for tests that only assert on how the
 * socket was constructed. The eventual rejection is irrelevant there, but it
 * must be observed so it never surfaces as an unhandled rejection.
 */
function beginConnect(client: SignalingClient, role: SessionRole = 'host'): void {
  client.connect(CODE, role, '').catch(() => undefined)
}

async function makeConnectedClient(
  role: SessionRole = 'host',
): Promise<{ client: SignalingClient; registry: FakeSocketRegistry; socket: FakeWebSocket }> {
  const { client, registry } = makeClient()
  const connecting = client.connect(CODE, role, '')
  const socket = registry.latest
  socket.fireOpen()
  await connecting
  return { client, registry, socket }
}

describe('SignalingClient URL construction', () => {
  it('builds /session/<code>/ws against the base URL', () => {
    const { client, registry } = makeClient()
    beginConnect(client)
    expect(registry.latest.url).toBe(`${BASE_URL}/session/${CODE}/ws`)
  })

  it('normalises a trailing slash on the base URL', () => {
    const { client, registry } = makeClient(`${BASE_URL}/`)
    beginConnect(client, 'guest')
    expect(registry.latest.url).toBe(`${BASE_URL}/session/${CODE}/ws`)
  })

  it('normalises repeated trailing slashes', () => {
    const { client, registry } = makeClient(`${BASE_URL}///`)
    beginConnect(client, 'guest')
    expect(registry.latest.url).toBe(`${BASE_URL}/session/${CODE}/ws`)
  })
})

describe('SignalingClient join handshake', () => {
  it('sends a join frame carrying the role and public key on open', async () => {
    const { client, registry } = makeClient()
    const connecting = client.connect(CODE, 'guest', 'PUBKEY')
    registry.latest.fireOpen()
    await connecting

    expect(JSON.parse(registry.latest.sent[0] ?? 'null')).toEqual({
      type: 'join',
      role: 'guest',
      publicKey: 'PUBKEY',
    })
  })

  it('sends an empty public key in Phase 1 without dropping the field', async () => {
    const { registry } = await makeConnectedClient('host')
    const frame = JSON.parse(registry.latest.sent[0] ?? 'null') as Record<string, unknown>
    expect(frame['publicKey']).toBe('')
    expect('publicKey' in frame).toBe(true)
  })

  it('rejects when the socket errors before the join is accepted', async () => {
    const { client, registry } = makeClient()
    const connecting = client.connect(CODE, 'host', '')
    registry.latest.fireError()
    await expect(connecting).rejects.toThrow(/socket error/)
  })

  it('rejects when the socket closes before the join is accepted', async () => {
    const { client, registry } = makeClient()
    const connecting = client.connect(CODE, 'host', '')
    registry.latest.fireClose(1006, 'abnormal')
    await expect(connecting).rejects.toThrow(/closed before the join/)
  })

  it('is single-use, per PLAN.md §19.10 (no session reconnect)', async () => {
    const { client } = await makeConnectedClient()
    await expect(client.connect(CODE, 'host', '')).rejects.toThrow(/single-use/)
  })
})

describe('SignalingClient message dispatch', () => {
  it('dispatches a valid message to subscribers', async () => {
    const { client, socket } = await makeConnectedClient()
    const received: SignalingMessage[] = []
    client.onMessage((message) => received.push(message))

    socket.deliver(JSON.stringify({ type: 'offer', sdp: 'v=0' }))

    expect(received).toEqual([{ type: 'offer', sdp: 'v=0' }])
  })

  it('flags isPaired when the worker reports pairing', async () => {
    const { client, socket } = await makeConnectedClient()
    expect(client.isPaired).toBe(false)
    socket.deliver(JSON.stringify({ type: 'paired' }))
    expect(client.isPaired).toBe(true)
  })

  it('routes malformed JSON to onError and dispatches nothing', async () => {
    const { client, socket } = await makeConnectedClient()
    const errors: unknown[] = []
    const received: SignalingMessage[] = []
    client.onError((error) => errors.push(error))
    client.onMessage((message) => received.push(message))

    socket.deliver('{not json')

    expect(received).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('routes an unrecognised message shape to onError', async () => {
    const { client, socket } = await makeConnectedClient()
    const errors: unknown[] = []
    client.onError((error) => errors.push(error))

    socket.deliver(JSON.stringify({ type: 'bogus' }))

    expect(errors).toHaveLength(1)
  })

  it('routes a non-string frame to onError without throwing', async () => {
    const { client, socket } = await makeConnectedClient()
    const errors: unknown[] = []
    client.onError((error) => errors.push(error))

    expect(() => {
      socket.deliverNonString()
    }).not.toThrow()
    expect(errors).toHaveLength(1)
  })

  it('stops delivery after unsubscribe', async () => {
    const { client, socket } = await makeConnectedClient()
    const received: SignalingMessage[] = []
    const unsubscribe = client.onMessage((message) => received.push(message))

    socket.deliver(JSON.stringify({ type: 'paired' }))
    unsubscribe()
    socket.deliver(JSON.stringify({ type: 'paired' }))

    expect(received).toHaveLength(1)
  })

  it('survives a throwing subscriber and still delivers to the others', async () => {
    const { client, socket } = await makeConnectedClient()
    const errors: unknown[] = []
    const received: SignalingMessage[] = []
    client.onError((error) => errors.push(error))
    client.onMessage(() => {
      throw new Error('subscriber blew up')
    })
    client.onMessage((message) => received.push(message))

    socket.deliver(JSON.stringify({ type: 'paired' }))

    expect(received).toEqual([{ type: 'paired' }])
    expect(errors).toHaveLength(1)
  })
})

describe('SignalingClient send', () => {
  it('throws before connect', () => {
    const { client } = makeClient()
    expect(() => {
      client.send({ type: 'paired' })
    }).toThrow(/not connected/)
  })

  it('throws when the socket is no longer open', async () => {
    const { client, socket } = await makeConnectedClient()
    socket.readyState = 2

    expect(() => {
      client.send({ type: 'paired' })
    }).toThrow(/not open/)
  })

  it('serialises the message as JSON', async () => {
    const { client, socket } = await makeConnectedClient()
    socket.sent.length = 0

    client.send({ type: 'ice', candidate: { candidate: 'candidate:1' } })

    expect(JSON.parse(socket.sent[0] ?? 'null')).toEqual({
      type: 'ice',
      candidate: { candidate: 'candidate:1' },
    })
  })
})

describe('SignalingClient close', () => {
  it('closes the underlying socket and is idempotent', async () => {
    const { client, socket } = await makeConnectedClient()
    client.close()
    client.close()

    expect(socket.closed).toBe(true)
  })

  it('detaches socket listeners so later events are ignored', async () => {
    const { client, socket } = await makeConnectedClient()
    const events: string[] = []
    client.onClose(() => events.push('close'))
    client.onMessage(() => events.push('message'))

    client.close()
    socket.fireClose(1000, 'done')
    socket.deliver(JSON.stringify({ type: 'paired' }))

    expect(events).toEqual([])
  })

  it('rejects a pending connect instead of leaving the caller hanging', async () => {
    const { client } = makeClient()
    const connecting = client.connect(CODE, 'host', '')

    client.close()

    await expect(connecting).rejects.toThrow(/closed before the join was accepted/)
  })
})

describe('isSignalingMessage', () => {
  it('accepts every message shape in PLAN.md §13', () => {
    const valid: SignalingMessage[] = [
      { type: 'join', role: 'host', publicKey: 'k' },
      { type: 'pubkey', publicKey: 'k' },
      { type: 'offer', sdp: 'v=0' },
      { type: 'answer', sdp: 'v=0' },
      { type: 'ice', candidate: { candidate: 'candidate:1' } },
      { type: 'paired' },
      { type: 'error', message: 'nope' },
    ]

    for (const message of valid) {
      expect(isSignalingMessage(message)).toBe(true)
    }
  })

  it('rejects non-objects and unknown types', () => {
    expect(isSignalingMessage(null)).toBe(false)
    expect(isSignalingMessage('paired')).toBe(false)
    expect(isSignalingMessage(42)).toBe(false)
    expect(isSignalingMessage([])).toBe(false)
    expect(isSignalingMessage({})).toBe(false)
    expect(isSignalingMessage({ type: 'nope' })).toBe(false)
  })

  it('rejects shapes with missing or mistyped payload fields', () => {
    expect(isSignalingMessage({ type: 'join', role: 'host' })).toBe(false)
    expect(isSignalingMessage({ type: 'join', role: 'peer', publicKey: 'k' })).toBe(false)
    expect(isSignalingMessage({ type: 'join', role: 'host', publicKey: 1 })).toBe(false)
    expect(isSignalingMessage({ type: 'offer' })).toBe(false)
    expect(isSignalingMessage({ type: 'ice', candidate: null })).toBe(false)
    expect(isSignalingMessage({ type: 'error' })).toBe(false)
    expect(isSignalingMessage({ type: 'pubkey', publicKey: null })).toBe(false)
  })
})

/**
 * The host's "peer joined" cue is implicit in the wire protocol: PLAN.md §13 has no
 * explicit peer-joined frame, so `pubkey` doubles as it. These tests pin that
 * contract, because an offer sent before the cue is rejected by the Durable Object as
 * `peer-not-connected` and ends the session.
 */
describe('peer-joined cue', () => {
  const ALL_MESSAGE_TYPES: SignalingMessage[] = [
    { type: 'join', role: 'host', publicKey: 'k' },
    { type: 'pubkey', publicKey: 'k' },
    { type: 'offer', sdp: 'v=0' },
    { type: 'answer', sdp: 'v=0' },
    { type: 'ice', candidate: { candidate: 'candidate:1' } },
    { type: 'paired' },
    { type: 'error', message: 'nope' },
  ]

  it('treats pubkey as the only peer-joined cue', () => {
    for (const message of ALL_MESSAGE_TYPES) {
      expect(isPeerJoinedCue(message)).toBe(message.type === 'pubkey')
    }
  })

  it('sends the host offer once the pubkey cue arrives', () => {
    expect(shouldHostSendOffer({ type: 'pubkey', publicKey: '' }, 'host', false)).toBe(true)
  })

  it('never sends the host offer before the cue', () => {
    for (const message of ALL_MESSAGE_TYPES) {
      if (message.type === 'pubkey') continue
      expect(shouldHostSendOffer(message, 'host', false)).toBe(false)
    }
  })

  it('never sends an offer from the guest role, even on the cue', () => {
    expect(shouldHostSendOffer({ type: 'pubkey', publicKey: '' }, 'guest', false)).toBe(false)
    expect(shouldHostSendOffer({ type: 'pubkey', publicKey: '' }, null, false)).toBe(false)
  })

  it('sends at most one offer per host attempt', () => {
    expect(shouldHostSendOffer({ type: 'pubkey', publicKey: '' }, 'host', true)).toBe(false)
  })

  /**
   * ORCHESTRATION.md D4. A pre-pairing disconnect releases the role's slot but leaves
   * the code joinable (D1), so a guest that drops out and re-joins the same code makes
   * the Durable Object send the host a second cue. The host has already latched its one
   * offer, so the session ends rather than hanging on "Connecting…" until the TTL.
   */
  describe('isPeerRejoinedCue', () => {
    const CUE: SignalingMessage = { type: 'pubkey', publicKey: '' }

    it('is true only when a host that has already offered sees the cue', () => {
      expect(isPeerRejoinedCue(CUE, 'host', true)).toBe(true)
      expect(isPeerRejoinedCue(CUE, 'host', false)).toBe(false)
      expect(isPeerRejoinedCue(CUE, 'guest', true)).toBe(false)
      expect(isPeerRejoinedCue(CUE, null, true)).toBe(false)
    })

    it('is false for every message that is not the peer-joined cue', () => {
      for (const message of ALL_MESSAGE_TYPES) {
        if (message.type === 'pubkey') continue
        expect(isPeerRejoinedCue(message, 'host', true)).toBe(false)
      }
    })

    it('leaves the first cue to shouldHostSendOffer', () => {
      // The two predicates are exact complements on the cue: only the latch separates
      // "a peer joined" from "the peer re-joined", which is why the first cue still
      // produces the offer instead of ending the session.
      expect(isPeerRejoinedCue(CUE, 'host', false)).toBe(false)
      expect(shouldHostSendOffer(CUE, 'host', false)).toBe(true)
    })
  })
})

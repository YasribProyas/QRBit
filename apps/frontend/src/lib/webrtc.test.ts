/**
 * Unit tests for the WebRTC module.
 *
 * `RTCPeerConnection` does not exist in node or jsdom, so `PeerConnection`
 * itself is not instantiated here. Instead the logic it delegates to — ICE
 * server construction, the Phase 2 encode/decode seam, and the pending
 * candidate buffer — is extracted as pure, directly testable units.
 */

import {
  DATA_CHANNEL_LABEL,
  PeerConnection,
  PendingIceCandidates,
  buildIceServers,
  decodeFrame,
  encodeFrame,
  isHelloMessage,
} from './webrtc'
import type { HelloMessage } from './webrtc'

// ---------------------------------------------------------------------------
// Test doubles.
//
// node/jsdom provide no RTCPeerConnection, so the global is replaced with the
// fake below for the duration of the PeerConnection suite. This is what lets
// the real class -- not a re-implementation of it -- be exercised end to end.
// ---------------------------------------------------------------------------

let fakePeers: FakeRTCPeerConnection[] = []

class FakeDataChannel {
  readonly label: string
  readonly options: RTCDataChannelInit | undefined
  readonly sent: unknown[] = []

  readyState: RTCDataChannelState = 'connecting'
  binaryType: BinaryType = 'blob'
  closed = false

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null

  constructor(label: string, options?: RTCDataChannelInit) {
    this.label = label
    this.options = options
  }

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

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload } as unknown as MessageEvent)
  }
}

class FakeRTCPeerConnection {
  readonly config: RTCConfiguration
  readonly createdChannels: FakeDataChannel[] = []
  readonly addedCandidates: RTCIceCandidateInit[] = []

  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  closed = false

  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null
  onconnectionstatechange: ((event: Event) => void) | null = null

  constructor(config: RTCConfiguration) {
    this.config = config
    fakePeers.push(this)
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
    const channel = new FakeDataChannel(label, options)
    this.createdChannels.push(channel)
    return channel as unknown as RTCDataChannel
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'fake-offer-sdp' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'fake-answer-sdp' }
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate)
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }
}

function installFakeRtcPeerConnection(): void {
  fakePeers = []
  ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = FakeRTCPeerConnection
}

const STUN_URL = 'stun:stun.cloudflare.com:3478'
const TURN_URLS = [
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turns:turn.cloudflare.com:5349',
]

describe('DATA_CHANNEL_LABEL', () => {
  it('is the label both peers agree on', () => {
    expect(DATA_CHANNEL_LABEL).toBe('qrdrop-main')
  })
})

describe('buildIceServers (PLAN.md §12)', () => {
  it('uses STUN only when no TURN credentials were issued', () => {
    expect(buildIceServers()).toEqual([{ urls: STUN_URL }])
    expect(buildIceServers({})).toEqual([{ urls: STUN_URL }])
  })

  it('adds TURN when both username and credential are present', () => {
    const servers = buildIceServers({ turnUsername: 'user', turnCredential: 'cred' })

    expect(servers).toHaveLength(2)
    expect(servers[0]?.urls).toBe(STUN_URL)
    expect(servers[1]?.urls).toEqual(TURN_URLS)
    expect(servers[1]?.username).toBe('user')
    expect(servers[1]?.credential).toBe('cred')
  })

  it('omits TURN rather than advertising empty credentials', () => {
    // A TURN entry without credentials makes some browsers reject the whole
    // configuration, which would break NAT traversal instead of just losing
    // the relay fallback.
    expect(buildIceServers({ turnUsername: 'user' })).toEqual([{ urls: STUN_URL }])
    expect(buildIceServers({ turnCredential: 'cred' })).toEqual([{ urls: STUN_URL }])
    expect(buildIceServers({ turnUsername: '', turnCredential: 'cred' })).toEqual([{ urls: STUN_URL }])
  })

  it('covers UDP, TCP and TLS transports for hostile networks (PLAN.md §17)', () => {
    const servers = buildIceServers({ turnUsername: 'user', turnCredential: 'cred' })
    expect(servers[1]?.urls).toEqual(TURN_URLS)
  })

  it('returns a fresh array each call so callers cannot corrupt shared state', () => {
    const first = buildIceServers()
    first.push({ urls: 'stun:example.invalid:3478' })
    first[0]!.urls = 'stun:mutated.invalid:3478'

    expect(buildIceServers()).toEqual([{ urls: STUN_URL }])
  })
})

describe('encodeFrame / decodeFrame (the Phase 2 encryption seam)', () => {
  it('round-trips a HelloMessage', () => {
    const message: HelloMessage = { t: 'hello', from: 'host', text: 'hello there' }
    expect(decodeFrame(encodeFrame(message))).toEqual(message)
  })

  it('round-trips an empty text field', () => {
    const message: HelloMessage = { t: 'hello', from: 'guest', text: '' }
    expect(decodeFrame(encodeFrame(message))).toEqual(message)
  })

  it('rejects a non-string frame', () => {
    expect(() => decodeFrame(new ArrayBuffer(8))).toThrow(/expected a text frame/)
    expect(() => decodeFrame(null)).toThrow(/expected a text frame/)
  })

  it('rejects malformed JSON', () => {
    expect(() => decodeFrame('{not json')).toThrow()
  })

  it('rejects well-formed JSON of the wrong shape', () => {
    expect(() => decodeFrame(JSON.stringify({ t: 'goodbye', from: 'host', text: 'x' }))).toThrow(
      /not a HelloMessage/,
    )
    expect(() => decodeFrame(JSON.stringify({ t: 'hello', from: 'host' }))).toThrow(/not a HelloMessage/)
    expect(() => decodeFrame(JSON.stringify(['hello']))).toThrow(/not a HelloMessage/)
  })
})

describe('isHelloMessage', () => {
  it('accepts both roles', () => {
    expect(isHelloMessage({ t: 'hello', from: 'host', text: 'a' })).toBe(true)
    expect(isHelloMessage({ t: 'hello', from: 'guest', text: 'a' })).toBe(true)
  })

  it('rejects wrong tags, roles, field types and non-objects', () => {
    expect(isHelloMessage({ t: 'hi', from: 'host', text: 'a' })).toBe(false)
    expect(isHelloMessage({ t: 'hello', from: 'peer', text: 'a' })).toBe(false)
    expect(isHelloMessage({ t: 'hello', from: 'host', text: 1 })).toBe(false)
    expect(isHelloMessage({ t: 'hello', from: 'host' })).toBe(false)
    expect(isHelloMessage(null)).toBe(false)
    expect(isHelloMessage('hello')).toBe(false)
  })
})

describe('PendingIceCandidates', () => {
  const candidate = (value: string): RTCIceCandidateInit => ({ candidate: value })

  it('starts empty', () => {
    expect(new PendingIceCandidates().size).toBe(0)
  })

  it('tracks how many candidates are buffered', () => {
    const pending = new PendingIceCandidates()
    pending.push(candidate('a'))
    pending.push(candidate('b'))
    expect(pending.size).toBe(2)
  })

  it('drains in arrival order and empties the buffer', () => {
    const pending = new PendingIceCandidates()
    pending.push(candidate('a'))
    pending.push(candidate('b'))

    expect(pending.drain()).toEqual([candidate('a'), candidate('b')])
    expect(pending.size).toBe(0)
  })

  it('drains only what was buffered since the last drain', () => {
    const pending = new PendingIceCandidates()
    pending.push(candidate('a'))
    pending.drain()
    pending.push(candidate('b'))

    expect(pending.drain()).toEqual([candidate('b')])
  })

  it('returns an empty array when drained while empty', () => {
    expect(new PendingIceCandidates().drain()).toEqual([])
  })

  it('clears the buffer', () => {
    const pending = new PendingIceCandidates()
    pending.push(candidate('a'))
    pending.clear()
    expect(pending.size).toBe(0)
    expect(pending.drain()).toEqual([])
  })
})

describe('PeerConnection (against a fake RTCPeerConnection)', () => {
  const originalRtcPeerConnection = (globalThis as unknown as Record<string, unknown>)['RTCPeerConnection']

  beforeEach(() => {
    installFakeRtcPeerConnection()
  })

  afterAll(() => {
    ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = originalRtcPeerConnection
  })

  function latestPeer(): FakeRTCPeerConnection {
    const peer = fakePeers[fakePeers.length - 1]
    if (!peer) throw new Error('test bug: no fake RTCPeerConnection was constructed')
    return peer
  }

  async function hostWithChannel(): Promise<{
    connection: PeerConnection
    fake: FakeRTCPeerConnection
    channel: FakeDataChannel
  }> {
    const connection = new PeerConnection()
    await connection.initAsHost()
    const fake = latestPeer()
    const channel = fake.createdChannels[0]
    if (!channel) throw new Error('test bug: initAsHost did not create a data channel')
    return { connection, fake, channel }
  }

  it('configures ICE for a direct-first, TURN-fallback path (PLAN.md §17)', () => {
    new PeerConnection({ turnUsername: 'user', turnCredential: 'cred' })
    const fake = latestPeer()

    expect(fake.config.iceTransportPolicy).toBe('all')
    expect(fake.config.iceServers).toEqual(
      buildIceServers({ turnUsername: 'user', turnCredential: 'cred' }),
    )
  })

  it('creates the correctly-labelled ordered channel and an offer as host', async () => {
    const { fake, channel } = await hostWithChannel()

    expect(channel.label).toBe(DATA_CHANNEL_LABEL)
    expect(channel.options).toEqual({ ordered: true })
    expect(fake.localDescription).toEqual({ type: 'offer', sdp: 'fake-offer-sdp' })
  })

  it('applies the remote offer and returns an answer as guest', async () => {
    const connection = new PeerConnection()
    const answer = await connection.receiveOffer({ type: 'offer', sdp: 'incoming' })
    const fake = latestPeer()

    expect(fake.remoteDescription).toEqual({ type: 'offer', sdp: 'incoming' })
    expect(answer).toEqual({ type: 'answer', sdp: 'fake-answer-sdp' })
    expect(fake.localDescription).toEqual(answer)
  })

  it('attaches the guest channel when it arrives via ondatachannel', async () => {
    const connection = new PeerConnection()
    await connection.receiveOffer({ type: 'offer', sdp: 'incoming' })
    const fake = latestPeer()
    const channel = new FakeDataChannel(DATA_CHANNEL_LABEL)

    fake.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent)
    const opened: string[] = []
    connection.onDataChannelOpen(() => opened.push('open'))
    channel.open()

    expect(opened).toEqual(['open'])
  })

  it('passes ICE candidates straight through once the remote description is set', async () => {
    const connection = new PeerConnection()
    await connection.receiveAnswer({ type: 'answer', sdp: 'ok' })
    const fake = latestPeer()

    await connection.addIceCandidate({ candidate: 'candidate:1' })

    expect(fake.addedCandidates).toEqual([{ candidate: 'candidate:1' }])
  })

  it('buffers ICE candidates that arrive before the remote description', async () => {
    const connection = new PeerConnection()
    const fake = latestPeer()

    await connection.addIceCandidate({ candidate: 'candidate:1' })
    await connection.addIceCandidate({ candidate: 'candidate:2' })

    // Must NOT have been handed to the peer yet: addIceCandidate would reject
    // with InvalidStateError in the browser.
    expect(fake.addedCandidates).toEqual([])
  })

  it('flushes buffered candidates in arrival order after the remote description lands', async () => {
    const connection = new PeerConnection()
    const fake = latestPeer()

    await connection.addIceCandidate({ candidate: 'candidate:1' })
    await connection.addIceCandidate({ candidate: 'candidate:2' })
    await connection.receiveAnswer({ type: 'answer', sdp: 'ok' })

    expect(fake.addedCandidates).toEqual([{ candidate: 'candidate:1' }, { candidate: 'candidate:2' }])
  })

  it('keeps the usable candidates when one buffered candidate fails', async () => {
    const connection = new PeerConnection()
    const fake = latestPeer()

    await connection.addIceCandidate({ candidate: 'candidate:1' })
    await connection.addIceCandidate({ candidate: 'candidate:2' })

    let calls = 0
    fake.addIceCandidate = async (candidate: RTCIceCandidateInit): Promise<void> => {
      calls += 1
      if (calls === 1) throw new Error('this candidate is unusable')
      fake.addedCandidates.push(candidate)
    }

    await expect(connection.receiveAnswer({ type: 'answer', sdp: 'ok' })).resolves.toBeUndefined()
    expect(fake.addedCandidates).toEqual([{ candidate: 'candidate:2' }])
  })

  it('reports ICE candidates as plain init objects and ignores the end-of-candidates null', async () => {
    const { connection, fake } = await hostWithChannel()
    const seen: RTCIceCandidateInit[] = []
    connection.onIceCandidate((candidate) => seen.push(candidate))

    const candidate = { toJSON: (): RTCIceCandidateInit => ({ candidate: 'candidate:9' }) }
    fake.onicecandidate?.({ candidate } as unknown as RTCPeerConnectionIceEvent)
    fake.onicecandidate?.({ candidate: null } as unknown as RTCPeerConnectionIceEvent)

    expect(seen).toEqual([{ candidate: 'candidate:9' }])
  })

  it('reports connection state changes for the status bar (PLAN.md §8)', async () => {
    const { connection, fake } = await hostWithChannel()
    const states: RTCPeerConnectionState[] = []
    connection.onStateChange((state) => states.push(state))

    fake.connectionState = 'connecting'
    fake.onconnectionstatechange?.(new Event('connectionstatechange'))
    fake.connectionState = 'connected'
    fake.onconnectionstatechange?.(new Event('connectionstatechange'))

    expect(states).toEqual(['connecting', 'connected'])
  })

  it('notifies onDataChannelOpen when the channel opens after subscribing', async () => {
    const { connection, channel } = await hostWithChannel()
    const opened: string[] = []
    connection.onDataChannelOpen(() => opened.push('open'))

    channel.open()

    expect(opened).toEqual(['open'])
  })

  it('replays onDataChannelOpen if the channel opened before subscribing', async () => {
    // The guest learns about the channel via ondatachannel and React registers
    // its effect afterwards, so the open edge can land first. Losing it would
    // mean the session never starts.
    const { connection, channel } = await hostWithChannel()
    channel.open()

    const opened: string[] = []
    connection.onDataChannelOpen(() => opened.push('open'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(opened).toEqual(['open'])
  })

  it('keeps a throwing replay subscriber from escaping as an uncaught error', async () => {
    // Every live emit path routes through invokeSafely. If the pre-subscription
    // replay does not, the throw surfaces as an uncaught microtask exception, which
    // vitest reports as an unhandled error and fails this file.
    const { connection, channel } = await hostWithChannel()
    channel.open()

    let replayed = false
    connection.onDataChannelOpen(() => {
      replayed = true
      throw new Error('replay subscriber blew up')
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The replay really ran, so this cannot pass merely because nothing happened.
    expect(replayed).toBe(true)
  })

  it('stops delivering onDataChannelOpen after unsubscribe', async () => {
    const { connection, channel } = await hostWithChannel()
    const opened: string[] = []
    const unsubscribe = connection.onDataChannelOpen(() => opened.push('open'))

    unsubscribe()
    channel.open()

    expect(opened).toEqual([])
  })

  it('refuses to send before the channel is open', async () => {
    const { connection } = await hostWithChannel()

    expect(() => {
      connection.send({ t: 'hello', from: 'host', text: 'hi' })
    }).toThrow(/data channel is not open/)
  })

  it('sends through the Phase 2 encode seam once the channel is open', async () => {
    const { connection, channel } = await hostWithChannel()
    channel.open()
    const message: HelloMessage = { t: 'hello', from: 'host', text: 'hi' }

    connection.send(message)

    expect(channel.sent).toEqual([encodeFrame(message)])
  })

  it('decodes inbound frames and drops the ones it cannot decode', async () => {
    const { connection, channel } = await hostWithChannel()
    const received: HelloMessage[] = []
    connection.onMessage((message) => received.push(message))

    channel.receive(encodeFrame({ t: 'hello', from: 'guest', text: 'hello back' }))
    channel.receive('{ not json')
    channel.receive(JSON.stringify({ t: 'unexpected' }))
    channel.receive(new ArrayBuffer(4))

    expect(received).toEqual([{ t: 'hello', from: 'guest', text: 'hello back' }])
  })

  it('keeps delivering after a subscriber throws', async () => {
    const { connection, channel } = await hostWithChannel()
    const received: HelloMessage[] = []
    connection.onMessage(() => {
      throw new Error('subscriber blew up')
    })
    connection.onMessage((message) => received.push(message))

    expect(() => {
      channel.receive(encodeFrame({ t: 'hello', from: 'guest', text: 'still fine' }))
    }).not.toThrow()
    expect(received).toEqual([{ t: 'hello', from: 'guest', text: 'still fine' }])
  })

  it('stops delivering messages after unsubscribe', async () => {
    const { connection, channel } = await hostWithChannel()
    const received: HelloMessage[] = []
    const unsubscribe = connection.onMessage((message) => received.push(message))

    unsubscribe()
    channel.receive(encodeFrame({ t: 'hello', from: 'guest', text: 'ignored' }))

    expect(received).toEqual([])
  })

  it('closes the peer and channel, detaches listeners, and is idempotent', async () => {
    const { connection, fake, channel } = await hostWithChannel()

    connection.close()
    connection.close()

    expect(fake.closed).toBe(true)
    expect(channel.closed).toBe(true)
    expect(fake.onicecandidate).toBeNull()
    expect(fake.ondatachannel).toBeNull()
    expect(fake.onconnectionstatechange).toBeNull()
    expect(channel.onmessage).toBeNull()
  })

  it('delivers nothing after close', async () => {
    const { connection, channel } = await hostWithChannel()
    const received: HelloMessage[] = []
    connection.onMessage((message) => received.push(message))

    connection.close()
    channel.receive(encodeFrame({ t: 'hello', from: 'guest', text: 'too late' }))

    expect(received).toEqual([])
  })

  it('never throws when close happens before the channel is open', () => {
    const connection = new PeerConnection()
    expect(() => {
      connection.close()
    }).not.toThrow()
  })

  it('drops buffered candidates on close', async () => {
    const connection = new PeerConnection()
    const fake = latestPeer()
    await connection.addIceCandidate({ candidate: 'candidate:1' })

    connection.close()
    await connection.receiveAnswer({ type: 'answer', sdp: 'late' })

    expect(fake.addedCandidates).toEqual([])
  })
})

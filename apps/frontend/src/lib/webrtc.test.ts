/**
 * Unit tests for the WebRTC module and the Phase 2 encrypted seam (PLAN.md §10,
 * §11.3, §16 Phase 2).
 *
 * `RTCPeerConnection` does not exist in node or jsdom, so the global is replaced
 * with the fake below. The fake links two peers together, which is what lets the
 * real `PeerConnection` — not a re-implementation of it — carry frames in both
 * directions through a real AES-GCM envelope, with two real P-256 keypairs and the
 * real `deriveSessionMaterial()` key-derivation path.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { exportPublicKey, generateKeypair, toBase64 } from './crypto'
import {
  DATA_CHANNEL_LABEL,
  PeerConnection,
  PendingIceCandidates,
  buildIceServers,
  decodeFrame,
  encodeFrame,
  isFrame,
} from './webrtc'
import type { Frame, HelloMessage } from './webrtc'
import { deriveSessionMaterial } from '../hooks/useSession'

const SESSION_CODE = 'A7X3K9P2'

// ---------------------------------------------------------------------------
// Test doubles.
//
// node/jsdom provide no RTCPeerConnection, so the global is replaced with the
// fake below for the duration of the PeerConnection suites.
// ---------------------------------------------------------------------------

let fakePeers: FakeRTCPeerConnection[] = []

class FakeDataChannel {
  readonly label: string
  readonly options: RTCDataChannelInit | undefined
  readonly sent: unknown[] = []

  /** The other end of this channel, when two fake peers are linked together. */
  remote: FakeDataChannel | null = null

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
    // A real DataChannel delivers to the peer without echoing back to the sender.
    this.remote?.receive(data)
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
  readonly receivedChannels: FakeDataChannel[] = []
  readonly addedCandidates: RTCIceCandidateInit[] = []

  /** Set by `linkPeers` so a created channel can be handed to the other peer. */
  onDataChannelCreated: ((channel: FakeDataChannel) => void) | null = null

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
    this.onDataChannelCreated?.(channel)
    return channel as unknown as RTCDataChannel
  }

  deliverDataChannel(channel: FakeDataChannel): void {
    this.receivedChannels.push(channel)
    this.ondatachannel?.({ channel: channel as unknown as RTCDataChannel } as RTCDataChannelEvent)
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

/** Connects the host's created channel to the guest, the way a real pair does. */
function linkPeers(host: FakeRTCPeerConnection, guest: FakeRTCPeerConnection): void {
  host.onDataChannelCreated = (channel) => {
    const remote = new FakeDataChannel(channel.label, channel.options)
    channel.remote = remote
    remote.remote = channel
    guest.deliverDataChannel(remote)
  }
}

/** Lets every queued microtask (encrypt, decrypt, chain links) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
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

// ---------------------------------------------------------------------------
// The Phase 2 seam: JSON → AES-GCM envelope → binary DataChannel frame.
// ---------------------------------------------------------------------------

describe('encodeFrame / decodeFrame (the Phase 2 encryption seam)', () => {
  async function makeKey(): Promise<CryptoKey> {
    const pair = await generateKeypair()
    const peer = await generateKeypair()
    return (await deriveSessionMaterial(pair.privateKey, await publicKeyBase64(peer), SESSION_CODE))
      .sessionKey
  }

  async function publicKeyBase64(pair: CryptoKeyPair): Promise<string> {
    return toBase64(await exportPublicKey(pair.publicKey))
  }

  it('round-trips every Phase 2 frame kind', async () => {
    const key = await makeKey()
    const frames: Frame[] = [
      { t: 'hello', from: 'host', text: 'hello there' },
      { t: 'hello', from: 'guest', text: '' },
      { t: 'phrase-confirm' },
      { t: 'session-end' },
    ]

    for (const frame of frames) {
      await expect(decodeFrame(await encodeFrame(frame, key), key)).resolves.toEqual(frame)
    }
  })

  it('produces a binary [iv(12)][ciphertext + tag] envelope, not JSON text', async () => {
    const key = await makeKey()
    const frame: Frame = { t: 'hello', from: 'host', text: 'sensitive payload' }

    const envelope = await encodeFrame(frame, key)

    expect(envelope).toBeInstanceOf(ArrayBuffer)
    expect(envelope.byteLength).toBeGreaterThan(12 + 16)
    // The plaintext must not be recoverable from the wire bytes.
    const asText = new TextDecoder().decode(new Uint8Array(envelope))
    expect(asText).not.toContain('sensitive payload')
    expect(asText).not.toContain('hello')
  })

  it('uses a fresh IV per encryption so identical frames differ on the wire', async () => {
    const key = await makeKey()
    const frame: Frame = { t: 'phrase-confirm' }

    const first = new Uint8Array(await encodeFrame(frame, key))
    const second = new Uint8Array(await encodeFrame(frame, key))

    expect([...first.slice(0, 12)]).not.toEqual([...second.slice(0, 12)])
    expect([...first]).not.toEqual([...second])
  })

  it('rejects a frame encrypted under a different session key', async () => {
    const key = await makeKey()
    const otherKey = await makeKey()

    await expect(decodeFrame(await encodeFrame({ t: 'phrase-confirm' }, key), otherKey)).rejects.toThrow()
  })

  it('rejects a tampered envelope', async () => {
    const key = await makeKey()
    const envelope = new Uint8Array(await encodeFrame({ t: 'phrase-confirm' }, key))
    const lastIndex = envelope.length - 1
    const lastByte = envelope[lastIndex]
    if (lastByte === undefined) throw new Error('test bug: the envelope is empty')
    envelope[lastIndex] = lastByte ^ 0x01

    await expect(decodeFrame(envelope.buffer, key)).rejects.toThrow()
  })

  it('rejects a text frame outright — Phase 1 plaintext is no longer accepted', async () => {
    const key = await makeKey()

    await expect(decodeFrame(JSON.stringify({ t: 'hello', from: 'host', text: 'x' }), key)).rejects.toThrow(
      /expected a binary encrypted envelope/,
    )
    await expect(decodeFrame(null, key)).rejects.toThrow(/expected a binary encrypted envelope/)
    await expect(decodeFrame(new ArrayBuffer(4), key)).rejects.toThrow()
  })

  it('rejects decrypted JSON that is not a Phase 2 frame', async () => {
    const key = await makeKey()

    await expect(
      decodeFrame(await encodeFrame({ t: 'phantom' } as unknown as Frame, key), key),
    ).rejects.toThrow(/not a Phase 2 Frame/)
  })
})

describe('isFrame', () => {
  it('accepts the Phase 2 frame kinds and both hello roles', () => {
    expect(isFrame({ t: 'hello', from: 'host', text: 'a' })).toBe(true)
    expect(isFrame({ t: 'hello', from: 'guest', text: '' })).toBe(true)
    expect(isFrame({ t: 'phrase-confirm' })).toBe(true)
    expect(isFrame({ t: 'session-end' })).toBe(true)
  })

  it('rejects unknown tags, wrong roles, wrong field types and non-objects', () => {
    expect(isFrame({ t: 'hi', from: 'host', text: 'a' })).toBe(false)
    expect(isFrame({ t: 'hello', from: 'peer', text: 'a' })).toBe(false)
    expect(isFrame({ t: 'hello', from: 'host', text: 1 })).toBe(false)
    expect(isFrame({ t: 'hello', from: 'host' })).toBe(false)
    // Phase 3 message kinds are not part of the Phase 2 union.
    expect(isFrame({ t: 'text-delta', id: 'x', content: 'y' })).toBe(false)
    expect(isFrame(null)).toBe(false)
    expect(isFrame('phrase-confirm')).toBe(false)
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

  /** A real session key, derived exactly the way `useSession` derives it. */
  async function makeSessionKey(): Promise<CryptoKey> {
    const ours = await generateKeypair()
    const peer = await generateKeypair()
    const peerPublic = toBase64(await exportPublicKey(peer.publicKey))
    return (await deriveSessionMaterial(ours.privateKey, peerPublic, SESSION_CODE)).sessionKey
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

  it('refuses to send before the channel is open, synchronously', async () => {
    const { connection } = await hostWithChannel()

    // The guard must throw from send() itself (ORCHESTRATION.md D3): a rejected
    // promise could not be caught by the existing call sites.
    expect(() => {
      connection.send({ t: 'hello', from: 'host', text: 'hi' })
    }).toThrow(/data channel is not open/)
  })

  it('refuses to send before the session key exists, synchronously', async () => {
    const { connection, channel } = await hostWithChannel()
    channel.open()

    expect(connection.hasSessionKey).toBe(false)
    expect(() => {
      connection.send({ t: 'phrase-confirm' })
    }).toThrow(/session key is not ready/)
    expect(channel.sent).toEqual([])
  })

  it('sends an encrypted binary frame once the key is installed', async () => {
    const { connection, channel } = await hostWithChannel()
    const key = await makeSessionKey()
    channel.open()

    expect(connection.hasSessionKey).toBe(false)
    connection.setSessionKey(key)
    expect(connection.hasSessionKey).toBe(true)

    const message: Frame = { t: 'hello', from: 'host', text: 'hi' }
    connection.send(message)

    // send() is still synchronous and void: the envelope lands on the queue, not
    // on the channel, until the encryption resolves.
    expect(channel.sent).toEqual([])
    await connection.drain()

    const envelope = channel.sent[0]
    expect(envelope).toBeInstanceOf(ArrayBuffer)
    await expect(decodeFrame(envelope, key)).resolves.toEqual(message)
  })

  it('never puts plaintext on the channel, whatever the frame says', async () => {
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(await makeSessionKey())

    connection.send({ t: 'hello', from: 'guest', text: 'TOP-SECRET-PLAINTEXT' })
    await connection.drain()

    const envelope = channel.sent[0]
    expect(envelope).toBeInstanceOf(ArrayBuffer)
    const wire = new TextDecoder().decode(new Uint8Array(envelope as ArrayBuffer))
    expect(wire).not.toContain('TOP-SECRET-PLAINTEXT')
    expect(wire).not.toContain('hello')
  })

  it('preserves send order through the asynchronous encrypt queue', async () => {
    const { connection, channel } = await hostWithChannel()
    channel.open()
    const key = await makeSessionKey()
    connection.setSessionKey(key)

    for (let i = 0; i < 20; i += 1) {
      connection.send({ t: 'hello', from: 'host', text: `frame-${i}` })
    }

    await connection.drain()

    const decoded: Frame[] = []
    for (const envelope of channel.sent) {
      decoded.push(await decodeFrame(envelope, key))
    }
    expect(decoded).toEqual(
      Array.from({ length: 20 }, (_unused, i): Frame => ({ t: 'hello', from: 'host', text: `frame-${i}` })),
    )
  })

  it('reports an asynchronous send failure through onSendError instead of throwing', async () => {
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(await makeSessionKey())
    const errors: unknown[] = []
    connection.onSendError((error) => errors.push(error))

    // The channel closes between the synchronous guard and the queued write.
    expect(() => {
      connection.send({ t: 'phrase-confirm' })
    }).not.toThrow()
    channel.readyState = 'closed'
    await connection.drain()

    expect(errors).toHaveLength(1)
    expect(channel.sent).toEqual([])
  })

  it('drops a queued frame silently when the peer was torn down first', async () => {
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(await makeSessionKey())
    const errors: unknown[] = []
    connection.onSendError((error) => errors.push(error))

    connection.send({ t: 'phrase-confirm' })
    connection.close()
    await connection.drain()

    expect(channel.sent).toEqual([])
    expect(errors).toEqual([])
  })

  it('decodes encrypted inbound frames and drops the ones it cannot decrypt', async () => {
    const key = await makeSessionKey()
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(key)
    const received: Frame[] = []
    connection.onMessage((message) => received.push(message))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    channel.receive(await encodeFrame({ t: 'hello', from: 'guest', text: 'hello back' }, key))
    expect(() => {
      channel.receive('{ not json')
      channel.receive(new ArrayBuffer(4))
      channel.receive(new TextEncoder().encode('text frame').buffer)
    }).not.toThrow()
    await settle()

    expect(received).toEqual([{ t: 'hello', from: 'guest', text: 'hello back' }])
    // The dev-only note must never carry the frame or the plaintext.
    expect(warn.mock.calls.flat().join(' ')).not.toContain('hello back')
    warn.mockRestore()
  })

  it('keeps delivering after a subscriber throws', async () => {
    const key = await makeSessionKey()
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(key)
    const received: Frame[] = []
    connection.onMessage(() => {
      throw new Error('subscriber blew up')
    })
    connection.onMessage((message) => received.push(message))

    const envelope = await encodeFrame({ t: 'hello', from: 'guest', text: 'still fine' }, key)
    expect(() => {
      channel.receive(envelope)
    }).not.toThrow()
    await settle()
    expect(received).toEqual([{ t: 'hello', from: 'guest', text: 'still fine' }])
  })

  it('preserves inbound order although decryption is asynchronous', async () => {
    const key = await makeSessionKey()
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(key)
    const received: Frame[] = []
    connection.onMessage((message) => received.push(message))

    // All envelopes are handed over in one synchronous burst; a non-serialised
    // decrypt could deliver a later frame first.
    const envelopes = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        encodeFrame({ t: 'hello', from: 'guest', text: `in-${i}` }, key),
      ),
    )
    for (const envelope of envelopes) {
      channel.receive(envelope)
    }
    await settle()

    expect(received).toEqual(
      Array.from({ length: 10 }, (_unused, i): Frame => ({ t: 'hello', from: 'guest', text: `in-${i}` })),
    )
  })

  it('stops delivering messages after unsubscribe', async () => {
    const key = await makeSessionKey()
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(key)
    const received: Frame[] = []
    const unsubscribe = connection.onMessage((message) => received.push(message))

    const envelope = await encodeFrame({ t: 'hello', from: 'guest', text: 'ignored' }, key)
    unsubscribe()
    channel.receive(envelope)
    await settle()

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
    expect(connection.hasSessionKey).toBe(false)
  })

  it('delivers nothing after close', async () => {
    const key = await makeSessionKey()
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(key)
    const received: Frame[] = []
    connection.onMessage((message) => received.push(message))

    const envelope = await encodeFrame({ t: 'hello', from: 'guest', text: 'too late' }, key)
    connection.close()
    channel.receive(envelope)
    await settle()

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

// ---------------------------------------------------------------------------
// Two-party end-to-end test over the real transport and the real derivation.
// ---------------------------------------------------------------------------

describe('two peers over the Phase 2 encrypted seam (PLAN.md §10, §11, §16 Phase 2)', () => {
  const originalRtcPeerConnection = (globalThis as unknown as Record<string, unknown>)['RTCPeerConnection']

  beforeEach(() => {
    installFakeRtcPeerConnection()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(() => {
    ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = originalRtcPeerConnection
  })

  interface PeerPair {
    host: PeerConnection
    guest: PeerConnection
    hostChannel: FakeDataChannel
    guestChannel: FakeDataChannel
  }

  /** Brings up two real PeerConnections with a live, linked channel on both ends. */
  async function openPair(): Promise<PeerPair> {
    const host = new PeerConnection()
    const guest = new PeerConnection()
    const hostFake = fakePeers[0]
    const guestFake = fakePeers[1]
    if (!hostFake || !guestFake) throw new Error('test bug: expected two fake peers')
    linkPeers(hostFake, guestFake)

    const offer = await host.initAsHost()
    const answer = await guest.receiveOffer(offer)
    await host.receiveAnswer(answer)

    const hostChannel = hostFake.createdChannels[0]
    const guestChannel = guestFake.receivedChannels[0]
    if (!hostChannel || !guestChannel) throw new Error('test bug: the channel was not linked')

    hostChannel.open()
    guestChannel.open()
    return { host, guest, hostChannel, guestChannel }
  }

  /** Both devices derive their own session material from only their own private key. */
  async function deriveBothEnds(): Promise<{
    pair: PeerPair
    hostMaterial: { sessionKey: CryptoKey; phrase: [string, string, string] }
    guestMaterial: { sessionKey: CryptoKey; phrase: [string, string, string] }
  }> {
    const pair = await openPair()
    const hostKeys = await generateKeypair()
    const guestKeys = await generateKeypair()

    // Only the public halves travel, exactly as the join/pubkey messages carry them.
    const hostPublic = toBase64(await exportPublicKey(hostKeys.publicKey))
    const guestPublic = toBase64(await exportPublicKey(guestKeys.publicKey))

    const hostMaterial = await deriveSessionMaterial(hostKeys.privateKey, guestPublic, SESSION_CODE)
    const guestMaterial = await deriveSessionMaterial(guestKeys.privateKey, hostPublic, SESSION_CODE)

    pair.host.setSessionKey(hostMaterial.sessionKey)
    pair.guest.setSessionKey(guestMaterial.sessionKey)
    return { pair, hostMaterial, guestMaterial }
  }

  it('derives the same three safety words independently on both devices', async () => {
    const { hostMaterial, guestMaterial } = await deriveBothEnds()

    expect(hostMaterial.phrase).toHaveLength(3)
    expect(hostMaterial.phrase).toEqual(guestMaterial.phrase)
    for (const word of hostMaterial.phrase) {
      expect(word).toBe(word.toUpperCase())
      expect(word).not.toBe('')
    }
  })

  it('exchanges encrypted frames in both directions', async () => {
    const { pair } = await deriveBothEnds()
    const hostReceived: Frame[] = []
    const guestReceived: Frame[] = []
    pair.host.onMessage((message) => hostReceived.push(message))
    pair.guest.onMessage((message) => guestReceived.push(message))

    pair.host.send({ t: 'hello', from: 'host', text: 'from the host' })
    pair.guest.send({ t: 'phrase-confirm' })
    await pair.host.drain()
    await pair.guest.drain()
    await settle()

    expect(hostReceived).toEqual([{ t: 'phrase-confirm' }])
    expect(guestReceived).toEqual([{ t: 'hello', from: 'host', text: 'from the host' }])
  })

  it('puts only envelopes on the wire', async () => {
    const { pair } = await deriveBothEnds()

    pair.host.send({ t: 'hello', from: 'host', text: 'PLAINTEXT-MARKER' })
    await pair.host.drain()

    const wire = pair.hostChannel.sent[0]
    expect(wire).toBeInstanceOf(ArrayBuffer)
    const asText = new TextDecoder().decode(new Uint8Array(wire as ArrayBuffer))
    expect(asText).not.toContain('PLAINTEXT-MARKER')
    expect(asText).not.toContain('"t"')
  })

  it('drops a frame the receiver cannot authenticate and keeps working afterwards', async () => {
    const { pair, guestMaterial } = await deriveBothEnds()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const received: Frame[] = []
    pair.guest.onMessage((message) => received.push(message))

    // A third keypair stands in for a guest holding a session key the host never
    // derived, so the host's envelope cannot authenticate.
    const impostor = await generateKeypair()
    const impostorPublic = toBase64(await exportPublicKey(impostor.publicKey))
    const wrongMaterial = await deriveSessionMaterial(
      impostor.privateKey,
      impostorPublic,
      SESSION_CODE,
    )
    pair.guest.setSessionKey(wrongMaterial.sessionKey)

    pair.host.send({ t: 'hello', from: 'host', text: 'cannot be read' })
    await pair.host.drain()
    await settle()

    // Dropped silently: no throw, no partial plaintext, no delivered message.
    expect(received).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).not.toContain('cannot be read')

    // The real key still works, so one bad frame does not poison the channel.
    pair.guest.setSessionKey(guestMaterial.sessionKey)
    pair.host.send({ t: 'session-end' })
    await pair.host.drain()
    await settle()

    expect(received).toEqual([{ t: 'session-end' }])
  })

  it('resolves drain() without rejecting even when sends fail', async () => {
    const { pair } = await deriveBothEnds()
    const errors: unknown[] = []
    pair.host.onSendError((error) => errors.push(error))

    pair.host.send({ t: 'session-end' })
    // Closed after the synchronous guard, before the queued write.
    pair.hostChannel.readyState = 'closed'

    await expect(pair.host.drain()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('carries a hello greeting that the receiving end reads as a HelloMessage', async () => {
    const { pair } = await deriveBothEnds()
    const received: HelloMessage[] = []
    pair.guest.onMessage((message) => {
      if (message.t === 'hello') received.push(message)
    })

    pair.host.send({ t: 'hello', from: 'host', text: 'Hello from the host device' })
    await pair.host.drain()
    await settle()

    expect(received).toEqual([{ t: 'hello', from: 'host', text: 'Hello from the host device' }])
  })
})

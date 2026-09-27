/**
 * Unit tests for the WebRTC module and the encrypted item seam (PLAN.md §10,
 * §11.3, §16 Phase 3).
 *
 * `RTCPeerConnection` does not exist in node or jsdom, so the global is replaced
 * with the fake below. The fake links two peers together, which is what lets the
 * real `PeerConnection` — not a re-implementation of it — carry frames in both
 * directions through a real AES-GCM envelope, with two real P-256 keypairs and the
 * real `deriveSessionMaterial()` key-derivation path.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encrypt, exportPublicKey, generateKeypair, toBase64 } from './crypto'
import { CHUNK_SIZE } from './chunker'
import type { WireMessage } from './protocol'
import {
  DATA_CHANNEL_LABEL,
  FILE_PUMP_BUFFER_THRESHOLD,
  PeerConnection,
  PendingIceCandidates,
  buildIceServers,
  decodeFrame,
  encodeFrame,
} from './webrtc'
import { deriveSessionMaterial } from '../hooks/useSession'

const SESSION_CODE = 'A7X3K9P2'

/** PLAN.md §12's chunk size, used by the MessagePack size test. */
const CHUNK_SIZED_BYTES = CHUNK_SIZE

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

  /** The pump threshold this fake reports back, as a real channel would. */
  bufferedAmountLowThreshold = 0
  bufferedAmount = 0

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onbufferedamountlow: ((event: Event) => void) | null = null

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
  'turns:turn.cloudflare.com:443?transport=tcp',
]
/** PLAN.md §17: the TCP-443 entry a captive portal or DPI network will pass. */
const TURN_TCP_443_URL = 'turns:turn.cloudflare.com:443?transport=tcp'

/**
 * The URL list of the TURN entry in a built server list.
 *
 * Empty when there is no TURN entry at all, so a missing entry fails the
 * expectations below instead of silently passing them.
 */
function turnUrls(servers: RTCIceServer[]): string[] {
  const urls = servers[1]?.urls
  return Array.isArray(urls) ? urls : []
}

describe('DATA_CHANNEL_LABEL', () => {
  it('is the label both peers agree on', () => {
    expect(DATA_CHANNEL_LABEL).toBe('qrbit-main')
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
    // PLAN.md §12: UDP, TCP, standard TURNS, and the §17 TCP-443 last resort.
    expect(servers[1]?.urls).toEqual(TURN_URLS)
    expect(servers[1]?.urls).toHaveLength(4)
    expect(servers[1]?.username).toBe('user')
    expect(servers[1]?.credential).toBe('cred')
  })

  it('puts the TURN credentials on the TURN entry and nowhere else', () => {
    const servers = buildIceServers({ turnUsername: 'user', turnCredential: 'cred' })

    expect(servers[0]?.username).toBeUndefined()
    expect(servers[0]?.credential).toBeUndefined()
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
    const urls = turnUrls(buildIceServers({ turnUsername: 'user', turnCredential: 'cred' }))

    expect(urls).toEqual(TURN_URLS)
    expect(urls).toContain('turn:turn.cloudflare.com:3478?transport=udp')
    expect(urls).toContain('turn:turn.cloudflare.com:3478?transport=tcp')
    expect(urls).toContain('turns:turn.cloudflare.com:5349')
    expect(urls).toContain(TURN_TCP_443_URL)
  })

  it('tries the TCP-443 relay last, as the hostile-network last resort (§17)', () => {
    const urls = turnUrls(buildIceServers({ turnUsername: 'user', turnCredential: 'cred' }))

    // §12 orders the list best-effort first, so the entry with the narrowest reach
    // must not pre-empt the standard ports. ICE prioritises by list order.
    expect(urls).toHaveLength(4)
    expect(urls[urls.length - 1]).toBe(TURN_TCP_443_URL)
    expect(urls.filter((url) => url === TURN_TCP_443_URL)).toHaveLength(1)
  })

  it('returns a fresh array each call so callers cannot corrupt shared state', () => {
    const first = buildIceServers()
    first.push({ urls: 'stun:example.invalid:3478' })
    first[0]!.urls = 'stun:mutated.invalid:3478'

    expect(buildIceServers()).toEqual([{ urls: STUN_URL }])
  })

  it('prefers server-supplied TURN URLs when provided (ORCHESTRATION.md D11)', () => {
    const customUrls = [
      'turns:custom.turn.cloudflare.com:5349',
      'turns:custom.turn.cloudflare.com:443?transport=tcp',
    ]
    const servers = buildIceServers({
      turnUsername: 'user',
      turnCredential: 'cred',
      turnUrls: customUrls,
    })

    expect(servers).toHaveLength(2)
    expect(servers[0]?.urls).toBe(STUN_URL)
    expect(servers[1]?.urls).toEqual(customUrls)
    expect(servers[1]?.username).toBe('user')
    expect(servers[1]?.credential).toBe('cred')
  })

  it('filters out port 53 URLs from server-supplied TURN URLs for defense in depth', () => {
    const customWith53 = [
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:53?transport=udp',
      'turn:turn.cloudflare.com:53',
      'turns:turn.cloudflare.com:5349',
    ]
    const servers = buildIceServers({
      turnUsername: 'user',
      turnCredential: 'cred',
      turnUrls: customWith53,
    })

    expect(servers[1]?.urls).toEqual([
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:5349',
    ])
  })

  it('falls back to hardcoded TURN URLs when server-supplied list is empty or only port 53', () => {
    const emptyServers = buildIceServers({
      turnUsername: 'user',
      turnCredential: 'cred',
      turnUrls: [],
    })
    expect(emptyServers[1]?.urls).toEqual(TURN_URLS)

    const only53Servers = buildIceServers({
      turnUsername: 'user',
      turnCredential: 'cred',
      turnUrls: ['turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:53'],
    })
    expect(only53Servers[1]?.urls).toEqual(TURN_URLS)
  })
})

// ---------------------------------------------------------------------------
// The Phase 2 seam: JSON → AES-GCM envelope → binary DataChannel frame.
// ---------------------------------------------------------------------------

describe('encodeFrame / decodeFrame (the encryption seam)', () => {
  async function makeKey(): Promise<CryptoKey> {
    const pair = await generateKeypair()
    const peer = await generateKeypair()
    return (await deriveSessionMaterial(pair.privateKey, await publicKeyBase64(peer), SESSION_CODE))
      .sessionKey
  }

  async function publicKeyBase64(pair: CryptoKeyPair): Promise<string> {
    return toBase64(await exportPublicKey(pair.publicKey))
  }

  it('round-trips every kind of WireMessage the protocol defines', async () => {
    const key = await makeKey()
    const frames: WireMessage[] = [
      { t: 'phrase-confirm' },
      { t: 'session-end' },
      { t: 'item-announce', id: 'a', type: 'text' },
      {
        t: 'item-announce',
        id: 'b',
        type: 'file',
        fileName: 'holiday.png',
        mimeType: 'image/png',
        totalSize: 4096,
        totalChunks: 1,
      },
      { t: 'text-delta', id: 'a', content: 'hello there' },
      { t: 'richtext-delta', id: 'c', content: '{"type":"doc"}' },
      { t: 'file-chunk', id: 'b', index: 0, data: new Uint8Array([1, 2, 3, 250]) },
      { t: 'file-done', id: 'b' },
      { t: 'item-delete', id: 'a' },
      {
        t: 'locked-payload',
        id: 'd',
        ciphertext: new Uint8Array([9, 9]),
        iv: new Uint8Array(12),
        salt: new Uint8Array(16),
      },
    ]

    for (const frame of frames) {
      await expect(decodeFrame(await encodeFrame(frame, key), key)).resolves.toEqual(frame)
    }
  })

  it('keeps a 16 KiB file chunk at its own size on the wire (PLAN.md §19 decision 7)', async () => {
    const key = await makeKey()
    const data = new Uint8Array(CHUNK_SIZED_BYTES)
    for (let i = 0; i < data.byteLength; i += 1) data[i] = i % 251

    const envelope = await encodeFrame({ t: 'file-chunk', id: 'f', index: 0, data }, key)

    // MessagePack carries the bytes as `bin`; a JSON encoding would have to spell
    // 16 384 numbers or a base64 string and this ceiling would be far higher.
    expect(envelope.byteLength).toBeLessThan(CHUNK_SIZED_BYTES + 256)
    const decoded = await decodeFrame(envelope, key)
    expect(decoded.t).toBe('file-chunk')
    if (decoded.t !== 'file-chunk') throw new Error('unreachable')
    expect(decoded.data).toEqual(data)
  })

  it('produces a binary [iv(12)][ciphertext + tag] envelope, not readable text', async () => {
    const key = await makeKey()
    const frame: WireMessage = { t: 'text-delta', id: 'a', content: 'sensitive payload' }

    const envelope = await encodeFrame(frame, key)

    expect(envelope).toBeInstanceOf(ArrayBuffer)
    expect(envelope.byteLength).toBeGreaterThan(12 + 16)
    // The plaintext must not be recoverable from the wire bytes.
    const asText = new TextDecoder().decode(new Uint8Array(envelope))
    expect(asText).not.toContain('sensitive payload')
    expect(asText).not.toContain('text-delta')
  })

  it('uses a fresh IV per encryption so identical frames differ on the wire', async () => {
    const key = await makeKey()
    const frame: WireMessage = { t: 'phrase-confirm' }

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

  it('rejects a text frame outright — plaintext is never accepted', async () => {
    const key = await makeKey()

    await expect(decodeFrame(JSON.stringify({ t: 'session-end' }), key)).rejects.toThrow(
      /expected a binary encrypted envelope/,
    )
    await expect(decodeFrame(null, key)).rejects.toThrow(/expected a binary encrypted envelope/)
    await expect(decodeFrame(new ArrayBuffer(4), key)).rejects.toThrow()
  })

  it('rejects a decrypted payload that is not a WireMessage', async () => {
    const key = await makeKey()

    // 0x80 is a valid, complete MessagePack empty map: the decoder succeeds and the
    // schema check in protocol.ts is what rejects it.
    const emptyMap = new Uint8Array([0x80])
    await expect(decodeFrame(await encrypt(key, emptyMap), key)).rejects.toThrow(
      /not a valid WireMessage/,
    )
  })

  it('refuses to encode a value that is not a WireMessage at all', async () => {
    const key = await makeKey()

    await expect(
      encodeFrame({ t: 'phantom' } as unknown as WireMessage, key),
    ).rejects.toThrow(/not a WireMessage/)
  })
})

describe('the item gate is the only way to send item traffic (PLAN.md §8)', () => {
  const originalRtcPeerConnection = (globalThis as unknown as Record<string, unknown>)['RTCPeerConnection']

  beforeEach(() => {
    installFakeRtcPeerConnection()
  })

  afterAll(() => {
    ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = originalRtcPeerConnection
  })

  /** Every message that carries session items must be refused before markActive(). */
  const ITEM_FRAMES: WireMessage[] = [
    { t: 'item-announce', id: 'a', type: 'text' },
    { t: 'text-delta', id: 'a', content: 'x' },
    { t: 'richtext-delta', id: 'b', content: '{}' },
    { t: 'file-chunk', id: 'c', index: 0, data: new Uint8Array([1]) },
    { t: 'file-done', id: 'c' },
    { t: 'item-delete', id: 'a' },
    {
      t: 'locked-payload',
      id: 'd',
      ciphertext: new Uint8Array([1]),
      iv: new Uint8Array(12),
      salt: new Uint8Array(16),
    },
  ]

  async function openKeyedConnection(): Promise<{
    connection: PeerConnection
    channel: FakeDataChannel
    key: CryptoKey
  }> {
    const connection = new PeerConnection()
    await connection.initAsHost()
    const fake = fakePeers[fakePeers.length - 1]
    const channel = fake?.createdChannels[0]
    if (!channel) throw new Error('test bug: no data channel')
    channel.open()

    const ours = await generateKeypair()
    const peer = await generateKeypair()
    const key = (
      await deriveSessionMaterial(
        ours.privateKey,
        toBase64(await exportPublicKey(peer.publicKey)),
        SESSION_CODE,
      )
    ).sessionKey
    connection.setSessionKey(key)
    return { connection, channel, key }
  }

  it('refuses every item-bearing frame until markActive() is called', async () => {
    const { connection, channel } = await openKeyedConnection()
    expect(connection.isActive).toBe(false)

    for (const frame of ITEM_FRAMES) {
      expect(() => {
        connection.send(frame)
      }).toThrow(/marked active/)
      expect(() => {
        void connection.sendAwaitable(frame)
      }).toThrow(/marked active/)
    }

    await connection.drain()
    // Nothing was encrypted and nothing reached the channel: the gate is structural,
    // not a warning.
    expect(channel.sent).toEqual([])
  })

  it('still carries the control frames before the session is active', async () => {
    const { connection, channel, key } = await openKeyedConnection()

    connection.send({ t: 'phrase-confirm' })
    connection.send({ t: 'session-end' })
    await connection.drain()

    expect(channel.sent).toHaveLength(2)
    await expect(decodeFrame(channel.sent[0], key)).resolves.toEqual({ t: 'phrase-confirm' })
    await expect(decodeFrame(channel.sent[1], key)).resolves.toEqual({ t: 'session-end' })
  })

  it('carries item frames once markActive() has been called', async () => {
    const { connection, channel, key } = await openKeyedConnection()

    connection.markActive()
    expect(connection.isActive).toBe(true)
    connection.send({ t: 'text-delta', id: 'a', content: 'now allowed' })
    await connection.drain()

    await expect(decodeFrame(channel.sent[0], key)).resolves.toEqual({
      t: 'text-delta',
      id: 'a',
      content: 'now allowed',
    })
  })

  it('closes the gate again on teardown', async () => {
    const { connection, channel } = await openKeyedConnection()
    connection.markActive()

    connection.close()

    expect(connection.isActive).toBe(false)
    // And the torn-down peer cannot be used as a second path either: the channel is
    // gone, so even a control frame is refused.
    expect(() => {
      connection.send({ t: 'phrase-confirm' })
    }).toThrow()
    expect(channel.sent).toEqual([])
  })
})

describe('backpressure for the file pumps (PLAN.md §9)', () => {
  const originalRtcPeerConnection = (globalThis as unknown as Record<string, unknown>)['RTCPeerConnection']

  beforeEach(() => {
    installFakeRtcPeerConnection()
  })

  afterAll(() => {
    ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = originalRtcPeerConnection
  })

  async function openChannel(): Promise<{ connection: PeerConnection; channel: FakeDataChannel }> {
    const connection = new PeerConnection()
    await connection.initAsHost()
    const fake = fakePeers[fakePeers.length - 1]
    const channel = fake?.createdChannels[0]
    if (!channel) throw new Error('test bug: no data channel')
    channel.open()
    return { connection, channel }
  }

  it('arms the channel with the pump threshold', async () => {
    const { channel } = await openChannel()

    // The browser fires `bufferedamountlow` at this threshold; the pump parks on it.
    expect(channel.bufferedAmountLowThreshold).toBe(FILE_PUMP_BUFFER_THRESHOLD)
    expect(FILE_PUMP_BUFFER_THRESHOLD).toBe(256 * 1024)
  })

  it('resolves immediately when the channel is already below the threshold', async () => {
    const { connection, channel } = await openChannel()
    channel.bufferedAmount = FILE_PUMP_BUFFER_THRESHOLD

    await expect(connection.waitForBackpressure()).resolves.toBeUndefined()
  })

  it('parks above the threshold and resumes on bufferedamountlow', async () => {
    const { connection, channel } = await openChannel()
    channel.bufferedAmount = FILE_PUMP_BUFFER_THRESHOLD + 1

    let resumed = false
    const waiting = connection.waitForBackpressure().then(() => {
      resumed = true
    })
    await settle()
    expect(resumed).toBe(false)

    channel.bufferedAmount = 0
    channel.onbufferedamountlow?.(new Event('bufferedamountlow'))
    await waiting

    expect(resumed).toBe(true)
  })

  it('wakes a parked pump on teardown instead of leaving it hanging', async () => {
    const { connection, channel } = await openChannel()
    channel.bufferedAmount = FILE_PUMP_BUFFER_THRESHOLD + 1
    const waiting = connection.waitForBackpressure()

    connection.close()

    // A promise that could never settle would leave a pump's await alive for the life
    // of the tab (the failure the teardown requirement is about).
    await expect(waiting).resolves.toBeUndefined()
  })

  it('wakes a parked pump when the session work is stopped without a teardown', async () => {
    const { connection, channel } = await openChannel()
    channel.bufferedAmount = FILE_PUMP_BUFFER_THRESHOLD + 1
    const waiting = connection.waitForBackpressure()

    connection.releaseBackpressure()

    await expect(waiting).resolves.toBeUndefined()
    // Not a teardown: the channel was left exactly as it was, so the peer is still
    // usable for the frames (control or otherwise) that follow.
    expect(connection.bufferedAmount).toBe(FILE_PUMP_BUFFER_THRESHOLD + 1)
    expect(channel.closed).toBe(false)
  })

  it('wakes a parked pump when the channel closes underneath it', async () => {
    const { connection, channel } = await openChannel()
    channel.bufferedAmount = FILE_PUMP_BUFFER_THRESHOLD + 1
    const waiting = connection.waitForBackpressure()

    channel.readyState = 'closed'
    channel.onclose?.(new Event('close'))

    await expect(waiting).resolves.toBeUndefined()
    expect(connection.bufferedAmount).toBe(FILE_PUMP_BUFFER_THRESHOLD + 1)
  })

  it('reads a channel with no bufferedAmount property as zero', async () => {
    const { connection, channel } = await openChannel()
    // A test double (or an engine quirk) that never reports the counter must not make
    // every pump wait forever.
    delete (channel as unknown as Record<string, unknown>)['bufferedAmount']

    expect(connection.bufferedAmount).toBe(0)
    await expect(connection.waitForBackpressure()).resolves.toBeUndefined()
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

    // The TURN credentials the worker issued must reach the real RTCPeerConnection
    // configuration — including the §17 TCP-443 relay — not merely buildIceServers.
    const turn = fake.config.iceServers?.[1]
    expect(turn?.username).toBe('user')
    expect(turn?.credential).toBe('cred')
    expect(turn?.urls).toContain(TURN_TCP_443_URL)
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
      connection.send({ t: 'phrase-confirm' })
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

    const message: WireMessage = { t: 'phrase-confirm' }
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
    connection.markActive()

    connection.send({ t: 'text-delta', id: 'a', content: 'TOP-SECRET-PLAINTEXT' })
    await connection.drain()

    const envelope = channel.sent[0]
    expect(envelope).toBeInstanceOf(ArrayBuffer)
    const wire = new TextDecoder().decode(new Uint8Array(envelope as ArrayBuffer))
    expect(wire).not.toContain('TOP-SECRET-PLAINTEXT')
    expect(wire).not.toContain('text-delta')
  })

  it('preserves send order through the asynchronous encrypt queue', async () => {
    const { connection, channel } = await hostWithChannel()
    channel.open()
    const key = await makeSessionKey()
    connection.setSessionKey(key)
    connection.markActive()

    for (let i = 0; i < 20; i += 1) {
      connection.send({ t: 'text-delta', id: 'a', content: `frame-${i}` })
    }

    await connection.drain()

    const decoded: WireMessage[] = []
    for (const envelope of channel.sent) {
      decoded.push(await decodeFrame(envelope, key))
    }
    expect(decoded).toEqual(
      Array.from(
        { length: 20 },
        (_unused, i): WireMessage => ({ t: 'text-delta', id: 'a', content: `frame-${i}` }),
      ),
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
    const received: WireMessage[] = []
    connection.onMessage((message) => received.push(message))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    channel.receive(await encodeFrame({ t: 'text-delta', id: 'a', content: 'CANARY-PLAINTEXT' }, key))
    expect(() => {
      channel.receive('{ not json')
      channel.receive(new ArrayBuffer(4))
      channel.receive(new TextEncoder().encode('text frame').buffer)
    }).not.toThrow()
    await settle()

    expect(received).toEqual([{ t: 'text-delta', id: 'a', content: 'CANARY-PLAINTEXT' }])
    // The dev-only note must never carry the frame or the plaintext.
    expect(warn.mock.calls.flat().join(' ')).not.toContain('CANARY-PLAINTEXT')
    warn.mockRestore()
  })

  it('keeps delivering after a subscriber throws', async () => {
    const key = await makeSessionKey()
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(key)
    const received: WireMessage[] = []
    connection.onMessage(() => {
      throw new Error('subscriber blew up')
    })
    connection.onMessage((message) => received.push(message))

    const envelope = await encodeFrame({ t: 'file-done', id: 'stay' }, key)
    expect(() => {
      channel.receive(envelope)
    }).not.toThrow()
    await settle()
    expect(received).toEqual([{ t: 'file-done', id: 'stay' }])
  })

  it('preserves inbound order although decryption is asynchronous', async () => {
    const key = await makeSessionKey()
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(key)
    const received: WireMessage[] = []
    const frameCount = 10

    // The completion signal is the queue's own progress: the test resolves once
    // the tenth frame has reached a subscriber, so nothing depends on how many
    // microtasks or timers the decrypt chain happens to need on a loaded machine
    // (the previous fixed `settle()` budget was what made this test load-sensitive).
    const allDelivered = new Promise<void>((resolve) => {
      connection.onMessage((message) => {
        received.push(message)
        if (received.length === frameCount) resolve()
      })
    })

    // All envelopes are handed over in one synchronous burst; a non-serialised
    // decrypt could deliver a later frame first.
    const envelopes = await Promise.all(
      Array.from({ length: frameCount }, (_unused, i) =>
        encodeFrame({ t: 'text-delta', id: 'a', content: `in-${i}` }, key),
      ),
    )
    for (const envelope of envelopes) {
      channel.receive(envelope)
    }
    await allDelivered

    expect(received).toEqual(
      Array.from({ length: frameCount }, (_unused, i): WireMessage => ({ t: 'text-delta', id: 'a', content: `in-${i}` })),
    )
  })

  it('stops delivering messages after unsubscribe', async () => {
    const key = await makeSessionKey()
    const { connection, channel } = await hostWithChannel()
    channel.open()
    connection.setSessionKey(key)
    const received: WireMessage[] = []
    const unsubscribe = connection.onMessage((message) => received.push(message))

    const envelope = await encodeFrame({ t: 'item-delete', id: 'ignored' }, key)
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
    const received: WireMessage[] = []
    connection.onMessage((message) => received.push(message))

    const envelope = await encodeFrame({ t: 'item-delete', id: 'too late' }, key)
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
    const hostReceived: WireMessage[] = []
    const guestReceived: WireMessage[] = []
    pair.host.onMessage((message) => hostReceived.push(message))
    pair.guest.onMessage((message) => guestReceived.push(message))

    pair.host.send({ t: 'phrase-confirm' })
    pair.host.markActive()
    pair.host.send({ t: 'text-delta', id: 'a', content: 'from the host' })
    pair.guest.send({ t: 'phrase-confirm' })
    await pair.host.drain()
    await pair.guest.drain()
    await settle()

    expect(hostReceived).toEqual([{ t: 'phrase-confirm' }])
    expect(guestReceived).toEqual([
      { t: 'phrase-confirm' },
      { t: 'text-delta', id: 'a', content: 'from the host' },
    ])
  })

  it('puts only envelopes on the wire', async () => {
    const { pair } = await deriveBothEnds()
    pair.host.markActive()

    pair.host.send({ t: 'text-delta', id: 'a', content: 'PLAINTEXT-MARKER' })
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
    const received: WireMessage[] = []
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

    pair.host.markActive()
    pair.host.send({ t: 'text-delta', id: 'a', content: 'CANNOT-BE-READ' })
    await pair.host.drain()
    await settle()

    // Dropped silently: no throw, no partial plaintext, no delivered message.
    expect(received).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).not.toContain('CANNOT-BE-READ')

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

  it('carries an item frame that the receiving end reads as a text-delta', async () => {
    const { pair } = await deriveBothEnds()
    const received: WireMessage[] = []
    pair.guest.onMessage((message) => {
      if (message.t === 'text-delta') received.push(message)
    })

    pair.host.markActive()
    pair.host.send({ t: 'text-delta', id: 'item-1', content: 'typed on the host' })
    await pair.host.drain()
    await settle()

    expect(received).toEqual([{ t: 'text-delta', id: 'item-1', content: 'typed on the host' }])
  })
})

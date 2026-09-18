/** @vitest-environment jsdom */
/**
 * Hook-level pairing tests for `useSession` (PLAN.md §8, §10, §11, §13).
 *
 * These drive the real orchestration: the real `useSession`, the real
 * `SignalingClient` (over an injected fake socket), the real `PeerConnection` and
 * the real Web Crypto derivation. Only the two browser APIs jsdom does not provide
 * are faked — `WebSocket` and `RTCPeerConnection` — exactly as the Phase 1 tests do.
 * The fake transport links the hook's peer to a host-side `PeerConnection` built by
 * the test, so frames genuinely cross between two independently keyed devices.
 *
 * `IS_REACT_ACT_ENVIRONMENT` is false on purpose: the hook's updates arrive from
 * asynchronous socket and channel callbacks, which `act()` cannot wrap without
 * inventing a fake ordering. State is asserted through the store and the hook's
 * returned values instead.
 */

import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

// The library store and its IndexedDB are NOT part of a session; `fake-indexeddb` is
// here to prove that a session never writes to them (see the boundary describe below).
import 'fake-indexeddb/auto'

import { CHUNK_SIZE, FileAssembler, chunkFile } from '../lib/chunker'
import {
  LOCKED_ITEM_MAX_PLAINTEXT_BYTES,
  encryptItem,
  exportPublicKey,
  generateKeypair,
  toBase64,
} from '../lib/crypto'
import * as cryptoModule from '../lib/crypto'
import type {
  LibraryFileItem,
  LibraryImageItem,
  LibraryLockedItem,
  LibraryTextItem,
} from '../lib/library'
import type { WireMessage } from '../lib/protocol'
import { WIRE_MAX_FRAME_BYTES, encodeWire } from '../lib/protocol'
import { PeerConnection } from '../lib/webrtc'
import { useSessionStore } from '../store/sessionStore'
import type { ItemStatus, LockedItem } from '../store/sessionStore'
import { PEER_REJOINED_REASON, deriveSessionMaterial, mintHostSession, useSession } from './useSession'
import { queueLibrarySends, takeQueuedLibrarySends } from './useSession'
import type { HostSession, UseSessionResult } from './useSession'
const SESSION_CODE = 'A7X3K9P2'
/** A code the Home screen minted and handed to the session page (PLAN.md §16 Phase 6). */
const HOME_MINTED_CODE = 'ABCDEFGH'

// ---------------------------------------------------------------------------
// Fake WebSocket: replaces the global the default SignalingClient factory uses.
// ---------------------------------------------------------------------------

let sockets: FakeWebSocket[] = []

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
    sockets.push(this)
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

  /** Acts as the signaling worker relaying one frame to this device. */
  deliver(message: unknown): void {
    const frame = JSON.stringify(message)
    this.onmessage?.({ data: frame } as unknown as MessageEvent)
  }

  /** The frames this device has sent, parsed. */
  sentFrames(): { type: string; [key: string]: unknown }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; [key: string]: unknown })
  }

  sentOfType(type: string): { type: string; [key: string]: unknown } | null {
    return this.sentFrames().find((frame) => frame.type === type) ?? null
  }
}

// ---------------------------------------------------------------------------
// Fake RTCPeerConnection: replaces the global `PeerConnection` constructs.
// ---------------------------------------------------------------------------

let fakePeers: FakeRTCPeerConnection[] = []

class FakeDataChannel {
  readonly label: string
  readonly options: RTCDataChannelInit | undefined
  readonly sent: unknown[] = []

  /** The other end of the channel once two fake peers are linked. */
  remote: FakeDataChannel | null = null

  readyState: RTCDataChannelState = 'connecting'
  binaryType: BinaryType = 'blob'
  closed = false

  /** The pump threshold the PeerConnection armed, echoed back like a real channel. */
  bufferedAmountLowThreshold = 0
  bufferedAmount = 0

  /**
   * While true, every frame handed to this channel leaves 1 MiB queued behind it and
   * only `releaseBackpressure()` drains it. That is how a test parks a file pump at a
   * known point instead of racing a whole transfer.
   */
  holdBackpressure = false

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
    if (this.holdBackpressure) this.bufferedAmount += 1024 * 1024
    this.remote?.receive(data)
  }

  releaseBackpressure(): void {
    this.bufferedAmount = 0
    this.onbufferedamountlow?.(new Event('bufferedamountlow'))
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
  readonly createdChannels: FakeDataChannel[] = []
  readonly receivedChannels: FakeDataChannel[] = []

  /** The configuration `PeerConnection` handed over — where the ICE servers are visible. */
  readonly config: RTCConfiguration | undefined

  onDataChannelCreated: ((channel: FakeDataChannel) => void) | null = null

  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  closed = false

  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null
  onconnectionstatechange: ((event: Event) => void) | null = null

  constructor(config?: RTCConfiguration) {
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

  async addIceCandidate(): Promise<void> {
    // No ICE in these tests: the fake never emits candidates.
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }
}

/** Connects a host-side peer's channel to the hook's peer, as a real pair would. */
function linkChannel(host: FakeRTCPeerConnection, guest: FakeRTCPeerConnection): void {
  host.onDataChannelCreated = (channel) => {
    const remote = new FakeDataChannel(channel.label, channel.options)
    channel.remote = remote
    remote.remote = channel
    guest.deliverDataChannel(remote)
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let latest: UseSessionResult | null = null
let root: ReturnType<typeof createRoot> | null = null
/** The worker's `/session/new` route, as this suite sees it. */
let mintFetch: Mock

function renderSessionProbe(code: string | null): void {
  function Probe() {
    latest = useSession({ code })
    return null
  }

  const container = document.createElement('div')
  document.body.append(container)
  const created = createRoot(container)
  created.render(<Probe />)
  root = created
}

function session(): UseSessionResult {
  if (!latest) throw new Error('test bug: the session probe has not rendered')
  return latest
}

function latestSocket(): FakeWebSocket {
  const socket = sockets[sockets.length - 1]
  if (!socket) throw new Error('test bug: no signaling socket has been created')
  return socket
}

/** Lets the deferred effect, the socket callbacks and the frame queues run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${description}`)
}

interface PairedDevices {
  /** The hook under test, acting as the guest. */
  guestSocket: FakeWebSocket
  guestChannel: FakeDataChannel
  /** A real host-side transport with its own independent keypair. */
  host: PeerConnection
  hostChannel: FakeDataChannel
  hostMaterial: { sessionKey: CryptoKey; phrase: [string, string, string] }
  hostReceived: WireMessage[]
}

/**
 * Brings a real pairing up: the guest hook joins with a real public key, the host
 * derives from it, the offer/answer crosses, and both channels open. The session is
 * left in 'pairing' — call `activatePairing()` for the 'active' phase.
 *
 * The channel is up and the guest's session key was installed before its safety
 * phrase appeared (see `performKeyExchange`), so this is the point at which
 * `useSession` would put a frame on the wire. That the encrypted path really works in
 * both directions is proven by `activatePairing()`, which crosses a phrase-confirm
 * each way.
 */
async function pairDevices(): Promise<PairedDevices> {
  renderSessionProbe(SESSION_CODE)

  await waitFor(() => sockets.length === 1, 'the guest signaling socket')
  const guestSocket = latestSocket()
  guestSocket.fireOpen()
  await waitFor(() => guestSocket.sentOfType('join') !== null, 'the guest join frame')

  const join = guestSocket.sentOfType('join')
  const guestPublicKey = join?.['publicKey']
  expect(typeof guestPublicKey).toBe('string')

  // The host device: its own keypair, and derivation from the guest's real key.
  const hostKeys = await generateKeypair()
  const hostPublicKey = toBase64(await exportPublicKey(hostKeys.publicKey))
  const hostMaterial = await deriveSessionMaterial(
    hostKeys.privateKey,
    guestPublicKey as string,
    SESSION_CODE,
  )

  const host = new PeerConnection()
  const guestFake = fakePeers[0]
  const hostFake = fakePeers[1]
  if (!guestFake || !hostFake) throw new Error('test bug: expected a peer on each side')
  linkChannel(hostFake, guestFake)

  const hostReceived: WireMessage[] = []
  host.onMessage((message) => hostReceived.push(message))

  const offer = await host.initAsHost()
  host.setSessionKey(hostMaterial.sessionKey)

  // D2: the host's offer and the peer's real key travel in the same cue.
  guestSocket.deliver({ type: 'pubkey', publicKey: hostPublicKey })
  await waitFor(() => useSessionStore.getState().safetyPhrase !== null, 'the guest safety phrase')

  guestSocket.deliver({ type: 'offer', sdp: offer.sdp })
  await waitFor(() => guestSocket.sentOfType('answer') !== null, 'the guest answer frame')
  const answer = guestSocket.sentOfType('answer')

  await host.receiveAnswer({ type: 'answer', sdp: answer?.['sdp'] as string })

  const hostChannel = hostFake.createdChannels[0]
  const guestChannel = guestFake.receivedChannels[0]
  if (!hostChannel || !guestChannel) throw new Error('test bug: the data channel was not linked')
  hostChannel.open()
  guestChannel.open()

  await waitFor(() => useSessionStore.getState().phase === 'pairing', 'the pairing phase')
  await settle()

  return { guestSocket, guestChannel, host, hostChannel, hostMaterial, hostReceived }
}

/**
 * Takes a paired session through the both-confirms gate (PLAN.md §8) using the real
 * encrypted `phrase-confirm` in each direction, and returns in the 'active' phase.
 *
 * This is also the proof that the encrypted channel carries traffic both ways: the
 * guest's confirm is decrypted by the host, and the host's confirm is decrypted by
 * the hook.
 */
async function activatePairing(devices: PairedDevices): Promise<void> {
  session().confirmPhrase()
  await waitFor(() => useSessionStore.getState().phraseConfirmed, 'the local confirmation')

  devices.host.send({ t: 'phrase-confirm' })
  await devices.host.drain()
  await waitFor(() => useSessionStore.getState().phase === 'active', 'the active phase')
  await waitFor(
    () => devices.hostReceived.some((message) => message.t === 'phrase-confirm'),
    'the guest phrase-confirm frame',
  )
}

beforeEach(() => {
  sockets = []
  fakePeers = []
  latest = null
  root = null

  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = false
  ;(globalThis as unknown as Record<string, unknown>)['WebSocket'] = FakeWebSocket
  ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = FakeRTCPeerConnection
  // The host flow creates its session through the worker's /session/new route.
  mintFetch = vi.fn(
    async (): Promise<unknown> => ({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => ({ code: SESSION_CODE }),
    }),
  )
  ;(globalThis as unknown as Record<string, unknown>)['fetch'] = mintFetch

  useSessionStore.getState().reset()
  // The pending-send queue is module-scoped memory, so a leftover selection from another
  // test would otherwise fire into this one's session.
  takeQueuedLibrarySends()
})

afterEach(() => {
  vi.restoreAllMocks()
  root?.unmount()
  for (const socket of sockets) {
    socket.onmessage = null
    socket.onopen = null
    socket.onclose = null
    socket.onerror = null
  }
  useSessionStore.getState().reset()
})

describe('useSession Phase 2 pairing (PLAN.md §8, §10, §13)', () => {
  it('exchanges real public keys and derives the same three words as the peer', async () => {
    const devices = await pairDevices()

    const state = useSessionStore.getState()
    expect(state.phase).toBe('pairing')
    expect(state.safetyPhrase).toEqual(devices.hostMaterial.phrase)
    expect(state.phraseConfirmed).toBe(false)
    expect(state.peerConfirmed).toBe(false)

    // The encrypted phrase-confirm now crosses both ways, and only then is the
    // session active — which is the retired hello greeting's job and more.
    await activatePairing(devices)

    expect(useSessionStore.getState().phase).toBe('active')
    expect(devices.hostReceived).toContainEqual({ t: 'phrase-confirm' })
  })

  it('never lets a plaintext frame reach the channel', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    // Real item traffic on top of the handshake, so the whole wire is exercised.
    const id = session().addTextItem()
    session().updateTextItem(id, 'PLAINTEXT-MARKER')
    await waitFor(
      () => devices.hostReceived.some((message) => message.t === 'text-delta'),
      'the delta frame',
    )

    const wire = [...devices.guestChannel.sent, ...devices.hostChannel.sent]
    expect(wire.length).toBeGreaterThan(0)
    for (const frame of wire) {
      expect(frame).toBeInstanceOf(ArrayBuffer)
      const text = new TextDecoder().decode(new Uint8Array(frame as ArrayBuffer))
      expect(text).not.toContain('hello')
      expect(text).not.toContain('"t"')
      expect(text).not.toContain('PLAINTEXT-MARKER')
      expect(text).not.toContain('item-announce')
    }
  })

  it('advances sender to active once sender confirms and sends phrase-confirm (decision D14)', async () => {
    const { hostReceived } = await pairDevices()

    // The sender (guest) confirms: advances to active immediately without waiting for host
    session().confirmPhrase()
    await waitFor(() => useSessionStore.getState().phraseConfirmed, 'the local confirmation')
    await waitFor(() => useSessionStore.getState().phase === 'active', 'the active phase')

    // The guest's own confirm crossed as an encrypted, authenticated frame to inform receiver
    await waitFor(
      () => hostReceived.some((message) => message.t === 'phrase-confirm'),
      'the guest phrase-confirm frame',
    )
  })

  it('does not reach active when only the peer confirms', async () => {
    const { host } = await pairDevices()

    host.send({ t: 'phrase-confirm' })
    await host.drain()
    await waitFor(() => useSessionStore.getState().peerConfirmed, 'the peer confirmation')
    await settle()

    const state = useSessionStore.getState()
    expect(state.phase).toBe('pairing')
    expect(state.phraseConfirmed).toBe(false)
  })

  it('receiver does not reach active on receiver confirmation alone (decision D14)', async () => {
    const devices = await pairDevicesAsReceiver()

    session().confirmPhrase()
    await waitFor(() => useSessionStore.getState().phraseConfirmed, 'the local confirmation')
    await settle()

    expect(useSessionStore.getState().phase).toBe('pairing')
  })

  it('advances receiver to active when sender confirms without receiver confirming (decision D14)', async () => {
    const devices = await pairDevicesAsReceiver()

    devices.guest.send({ t: 'phrase-confirm' })
    await devices.guest.drain()
    await waitFor(() => useSessionStore.getState().peerConfirmed, 'the sender confirmation')
    await waitFor(() => useSessionStore.getState().phase === 'active', 'the active phase')
    expect(useSessionStore.getState().phraseConfirmed).toBe(false)
  })

  it('receiver aborts cleanly before confirming (decision D14)', async () => {
    const devices = await pairDevicesAsReceiver()

    session().abort()
    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')
    expect(useSessionStore.getState().errorMessage).toBe(null)
  })

  it('receiver exits pairing when sender aborts before confirming (decision D14)', async () => {
    const devices = await pairDevicesAsReceiver()

    devices.guest.send({ t: 'session-end' })
    await devices.guest.drain()
    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')
    expect(useSessionStore.getState().errorMessage).toBe(null)
  })

  it('aborts cleanly: the peer is told, the channel closes, no error is shown', async () => {
    const { guestSocket, guestChannel, hostReceived } = await pairDevices()

    session().abort()
    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')
    // The session-end frame is queued (D3), so the peer learns of the end a tick
    // after the teardown; the abort deliberately waits for it to leave first.
    await waitFor(
      () => hostReceived.some((message) => message.t === 'session-end'),
      'the peer to be told the session ended',
    )

    expect(useSessionStore.getState().errorMessage).toBe(null)
    expect(guestChannel.closed).toBe(true)
    expect(guestSocket.closed).toBe(true)
  })

  it('ends the session when the peer sends session-end', async () => {
    const { host } = await pairDevices()

    host.send({ t: 'session-end' })
    await host.drain()
    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')

    expect(useSessionStore.getState().errorMessage).toBe(null)
  })
})

describe('useSession as the host (ORCHESTRATION.md D2, D4 and D5)', () => {
  /** Renders the host hook and returns its signaling socket with the join frame. */
  async function startHost(): Promise<{
    socket: FakeWebSocket
    join: { type: string; [key: string]: unknown }
  }> {
    renderSessionProbe(null)

    await waitFor(() => sockets.length === 1, 'the host signaling socket')
    const socket = latestSocket()
    socket.fireOpen()
    await waitFor(() => socket.sentOfType('join') !== null, 'the host join frame')

    const join = socket.sentOfType('join')
    if (!join) throw new Error('test bug: the host sent no join frame')
    return { socket, join }
  }

  it('does not offer before the peer-joined cue, then derives from the peer key', async () => {
    const { socket, join } = await startHost()

    expect(join['role']).toBe('host')
    // PLAN.md §13: the join carries the real P-256 public key, not Phase 1's empty string.
    expect(typeof join['publicKey']).toBe('string')
    expect(join['publicKey']).not.toBe('')

    // The worker rejects a premature offer, so nothing may be sent before the cue.
    await settle()
    expect(socket.sentOfType('offer')).toBe(null)
    expect(useSessionStore.getState().sessionCode).toBe(SESSION_CODE)

    const peerKeys = await generateKeypair()
    const peerPublicKey = toBase64(await exportPublicKey(peerKeys.publicKey))
    socket.deliver({ type: 'pubkey', publicKey: peerPublicKey })

    await waitFor(() => socket.sentOfType('offer') !== null, 'the host offer frame')
    await waitFor(() => useSessionStore.getState().phase === 'pairing', 'the pairing phase')

    // The host derived the phrase from the peer's public key and its own private key.
    const expected = await deriveSessionMaterial(peerKeys.privateKey, join['publicKey'] as string, SESSION_CODE)
    expect(useSessionStore.getState().safetyPhrase).toEqual(expected.phrase)
  })

  it('fails fast when a second peer-joined cue arrives after the offer (D4)', async () => {
    const { socket } = await startHost()

    socket.deliver({
      type: 'pubkey',
      publicKey: toBase64(await exportPublicKey((await generateKeypair()).publicKey)),
    })
    await waitFor(() => socket.sentOfType('offer') !== null, 'the host offer frame')
    const offersAfterFirstCue = socket.sentFrames().filter((frame) => frame.type === 'offer').length

    socket.deliver({
      type: 'pubkey',
      publicKey: toBase64(await exportPublicKey((await generateKeypair()).publicKey)),
    })
    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')

    const state = useSessionStore.getState()
    expect(state.errorMessage).toBe(PEER_REJOINED_REASON)
    // Fail fast means never re-offering: the second cue must not produce an offer.
    expect(socket.sentFrames().filter((frame) => frame.type === 'offer')).toHaveLength(
      offersAfterFirstCue,
    )
  })

  it('ignores the duplicate copy of the peer-joined cue instead of aborting (D5)', async () => {
    const { socket } = await startHost()

    const peerKeys = await generateKeypair()
    const peerPublicKey = toBase64(await exportPublicKey(peerKeys.publicKey))

    socket.deliver({ type: 'pubkey', publicKey: peerPublicKey })
    await waitFor(() => socket.sentOfType('offer') !== null, 'the host offer frame')
    await waitFor(() => useSessionStore.getState().phase === 'pairing', 'the pairing phase')

    // The Durable Object sends the peer's key twice — once directly to the joiner and
    // once from the buffer it filled while that joiner was away (session.ts handleJoin).
    // The duplicate repeats a key this host has already exchanged with, so it is not a
    // re-join: the session must keep pairing and the host must not offer again.
    socket.deliver({ type: 'pubkey', publicKey: peerPublicKey })
    await settle()

    const state = useSessionStore.getState()
    expect(state.phase).toBe('pairing')
    expect(state.errorMessage).toBe(null)
    expect(socket.sentFrames().filter((frame) => frame.type === 'offer')).toHaveLength(1)
  })

  it('ignores the duplicate cue when both copies land before the offer is latched (D5)', async () => {
    const { socket } = await startHost()

    const peerPublicKey = toBase64(await exportPublicKey((await generateKeypair()).publicKey))
    // Back to back, with no await between them: the copy arrives while the first cue is
    // still deriving, which is the timing the Durable Object's two sends cannot rule out.
    socket.deliver({ type: 'pubkey', publicKey: peerPublicKey })
    socket.deliver({ type: 'pubkey', publicKey: peerPublicKey })

    await waitFor(() => socket.sentOfType('offer') !== null, 'the host offer frame')
    await waitFor(() => useSessionStore.getState().phase === 'pairing', 'the pairing phase')
    await settle()

    const state = useSessionStore.getState()
    expect(state.phase).toBe('pairing')
    expect(state.errorMessage).toBe(null)
    expect(socket.sentFrames().filter((frame) => frame.type === 'offer')).toHaveLength(1)
  })

  it('rejects a peer that joins with no public key instead of pairing in the clear', async () => {
    const { socket } = await startHost()

    socket.deliver({ type: 'pubkey', publicKey: '' })
    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')

    expect(useSessionStore.getState().errorMessage).not.toBe(null)
    expect(socket.sentOfType('offer')).toBe(null)
  })
})

describe('useSession host sessions (PLAN.md §16 Phase 6, ORCHESTRATION.md D13)', () => {
  const newSessionCalls = (): unknown[][] =>
    mintFetch.mock.calls.filter(([req]) => String(req).endsWith('/new'))

  it('mints a code and joins as host', async () => {
    renderSessionProbe(null)

    await waitFor(() => sockets.length === 1, 'the host signaling socket')
    const socket = latestSocket()
    socket.fireOpen()
    await waitFor(() => socket.sentOfType('join') !== null, 'the host join frame')

    expect(socket.url).toContain(SESSION_CODE)
    expect(socket.sentOfType('join')?.['role']).toBe('host')
    expect(useSessionStore.getState().sessionCode).toBe(SESSION_CODE)
    expect(newSessionCalls()).toHaveLength(1)
  })

  it('fetches TURN credentials from the turn route for host at connect time (ORCHESTRATION.md D10)', async () => {
    mintFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/turn')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
            username: 'home-user',
            credential: 'home-secret',
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: SESSION_CODE }),
      }
    })

    renderSessionProbe(null)

    await waitFor(() => fakePeers.length >= 1, 'the host peer connection')
    const turn = fakePeers[0]?.config?.iceServers?.find((server) =>
      String(server.urls).includes('turn:'),
    )
    expect(turn?.username).toBe('home-user')
    expect(turn?.credential).toBe('home-secret')
    expect(newSessionCalls()).toHaveLength(1)
    expect(
      mintFetch.mock.calls.some(([req]) => String(req).endsWith(`/${SESSION_CODE}/turn`)),
    ).toBe(true)
  })

  it('mints a new code on restart', async () => {
    renderSessionProbe(null)
    await waitFor(() => sockets.length === 1, 'the first host socket')

    session().restart()

    // PLAN.md §19 decision 10: a restart is a NEW session, so the stale code must not be
    // reused (a peer could still be waiting on it).
    await waitFor(() => sockets.length === 2, 'the restarted host socket')
    await waitFor(() => useSessionStore.getState().sessionCode === SESSION_CODE, 'the fresh code')
    expect(newSessionCalls()).toHaveLength(2)
    expect(latestSocket().url).toContain(SESSION_CODE)
  })

  it('drains the queue for a real guest joining the host session (D8)', async () => {
    const item = libraryTextItem('queued from the QR screen', 'Queued note')
    queueLibrarySends([item])

    const devices = await pairDevicesAsReceiver()
    const guestReceived: WireMessage[] = []
    devices.guest.onMessage((message) => guestReceived.push(message))

    expect(newSessionCalls()).toHaveLength(1)
    expect(useSessionStore.getState().sessionCode).toBe(SESSION_CODE)

    await activateReceiverPairing(devices)

    await waitFor(
      () => framesOf(guestReceived, 'text-delta').length === 1,
      'the queued item to reach the guest',
    )
    expect(framesOf(guestReceived, 'text-delta')[0]?.content).toBe('queued from the QR screen')
    expect(takeQueuedLibrarySends()).toEqual([])
  })
})

describe('TURN credential flow (ORCHESTRATION.md D10, D11)', () => {
  it('mintHostSession no longer requires credentials (ORCHESTRATION.md D10)', async () => {
    mintFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 'A7X3K9P2' }),
    })
    const minted = await mintHostSession()
    expect(minted).toEqual({ code: 'A7X3K9P2' })
  })

  it('fetches TURN credentials from the turn route for guest at connect time', async () => {
    mintFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/turn')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
            username: 'turn-guest-user',
            credential: 'turn-guest-cred',
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })

    renderSessionProbe('GUESTCOD')

    await waitFor(() => fakePeers.length >= 1, 'the guest peer connection')
    const turn = fakePeers[0]?.config?.iceServers?.find((server) =>
      String(server.urls).includes('turn:'),
    )
    expect(turn?.username).toBe('turn-guest-user')
    expect(turn?.credential).toBe('turn-guest-cred')
    expect(mintFetch.mock.calls.some(([req]) => String(req).endsWith('/GUESTCOD/turn'))).toBe(true)
  })

  it('re-fetches credentials on restart for both roles', async () => {
    let turnFetchCount = 0
    mintFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/turn')) {
        turnFetchCount++
        return {
          ok: true,
          status: 200,
          json: async () => ({
            urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
            username: `user-${turnFetchCount}`,
            credential: `cred-${turnFetchCount}`,
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: SESSION_CODE }),
      }
    })

    renderSessionProbe(null)
    await waitFor(() => fakePeers.length >= 1, 'the first peer connection')
    expect(turnFetchCount).toBe(1)

    session().restart()

    await waitFor(() => fakePeers.length >= 2, 'the restarted peer connection')
    expect(turnFetchCount).toBe(2)
  })

  it('degrades to STUN-only when turn route fails without failing the session', async () => {
    mintFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/turn')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'TURN unavailable' }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: SESSION_CODE }),
      }
    })

    renderSessionProbe('GUESTCOD')
    await waitFor(() => fakePeers.length >= 1, 'the peer connection')

    const servers = fakePeers[0]?.config?.iceServers ?? []
    expect(servers.every((s) => !String(s.urls).includes('turn:'))).toBe(true)
    expect(servers.some((s) => String(s.urls).includes('stun:'))).toBe(true)

    // Session continues to connect without an error
    await waitFor(() => sockets.length >= 1, 'the signaling socket')
    expect(useSessionStore.getState().errorMessage).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Item transport (PLAN.md §9, §10, §12, §16 Phase 3)
// ---------------------------------------------------------------------------

/**
 * Deterministic bytes, so a reassembled file can be compared exactly.
 *
 * The `ArrayBuffer` backing is explicit because `new File([bytes], …)` accepts only a
 * view over an `ArrayBuffer`, not over an `ArrayBufferLike`.
 */
function patternedBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length))
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + 7) % 251
  }
  return bytes
}

/** The board's live copy of a locked item, or null when this session has none. */
function lockedItemOf(id: string): LockedItem | null {
  const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
  return item?.type === 'locked' ? item : null
}

/** A cheap, exact fingerprint for a payload too large to deep-compare element-wise. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  return toBase64(await crypto.subtle.digest('SHA-256', bytes))
}

/** One readable label per frame, for wire-order assertions. */
function describeFrame(message: WireMessage): string {
  return message.t === 'file-chunk' ? `file-chunk:${message.index}` : message.t
}

function framesOf<K extends WireMessage['t']>(
  frames: readonly WireMessage[],
  type: K,
): Extract<WireMessage, { t: K }>[] {
  return frames.filter((frame): frame is Extract<WireMessage, { t: K }> => frame.t === type)
}

interface ReceivingDevices {
  /** The hook under test. It is the host here, so it is the receiving side. */
  hostChannel: FakeDataChannel
  /** A real guest-side transport that feeds the hook real frames. */
  guest: PeerConnection
  guestChannel: FakeDataChannel
}

/**
 * Brings a real pairing up with the hook as the HOST — the receiving side of the
 * item path — and a raw `PeerConnection` as the guest that sends into it.
 *
 * A second hook instance cannot stand in for the sender: `useSessionStore` holds one
 * session (PLAN.md §9), so two hooks in one test would share the board and fight over
 * the phase. The raw peer is the same transport the hook uses, with the real key
 * derivation, so the frames crossing are genuinely encrypted and genuinely decoded.
 */
async function pairDevicesAsReceiver(): Promise<ReceivingDevices> {
  renderSessionProbe(null)
  const sessionCode = SESSION_CODE

  await waitFor(() => sockets.length === 1, 'the host signaling socket')
  const hostSocket = latestSocket()
  hostSocket.fireOpen()
  await waitFor(() => hostSocket.sentOfType('join') !== null, 'the host join frame')

  const join = hostSocket.sentOfType('join')
  const hostPublicKey = join?.['publicKey']
  if (typeof hostPublicKey !== 'string') throw new Error('test bug: the host sent no public key')

  const hookFake = fakePeers[0]
  if (!hookFake) throw new Error('test bug: the hook built no peer')

  const guestKeys = await generateKeypair()
  const guest = new PeerConnection()
  const guestFake = fakePeers[1]
  if (!guestFake) throw new Error('test bug: the guest built no peer')
  linkChannel(hookFake, guestFake)

  // The guest holds the same session key the hook derives from the guest's real key.
  guest.setSessionKey(
    (await deriveSessionMaterial(guestKeys.privateKey, hostPublicKey, sessionCode)).sessionKey,
  )

  hostSocket.deliver({
    type: 'pubkey',
    publicKey: toBase64(await exportPublicKey(guestKeys.publicKey)),
  })
  await waitFor(() => hostSocket.sentOfType('offer') !== null, 'the host offer frame')
  const offer = hostSocket.sentOfType('offer')

  const answer = await guest.receiveOffer({ type: 'offer', sdp: offer?.['sdp'] as string })
  hostSocket.deliver({ type: 'answer', sdp: answer.sdp })

  await waitFor(() => guestFake.receivedChannels.length === 1, 'the guest data channel')
  const hostChannel = hookFake.createdChannels[0]
  const guestChannel = guestFake.receivedChannels[0]
  if (!hostChannel || !guestChannel) throw new Error('test bug: the data channel was not linked')
  hostChannel.open()
  guestChannel.open()
  await settle()

  return { hostChannel, guest, guestChannel }
}

/** Takes the receiver-side pair through the both-confirms gate. */
async function activateReceiverPairing(devices: ReceivingDevices): Promise<void> {
  session().confirmPhrase()
  await waitFor(() => useSessionStore.getState().phraseConfirmed, 'the local confirmation')

  devices.guest.send({ t: 'phrase-confirm' })
  await devices.guest.drain()
  await waitFor(() => useSessionStore.getState().phase === 'active', 'the active phase')

  // The guest stands in for a sender, so it needs the same open gate `useSession`
  // opens on its own side.
  devices.guest.markActive()
}

/** Sends a whole file the way `useSession`'s pump does: announce → chunks → done. */
async function sendWholeFile(guest: PeerConnection, id: string, file: File): Promise<void> {
  for await (const frame of chunkFile(id, file)) {
    guest.send(frame)
  }
  await guest.drain()
}

describe('useSession items — the sender side (PLAN.md §9, §10, §12)', () => {
  it('is a no-op before both devices confirmed, and no item frame reaches the wire', async () => {
    const devices = await pairDevices()

    // The retired Phase 2 hello means nothing at all crosses before the phrase is
    // confirmed, so the whole channel is still empty here.
    expect(devices.guestChannel.sent).toEqual([])

    expect(session().addTextItem('early')).toBe('')
    expect(session().addRichTextItem('{}')).toBe('')
    expect(session().addFileItem(new File([patternedBytes(8)], 'early.bin'))).toBe('')
    expect(() => {
      session().updateTextItem('x', 'y')
    }).not.toThrow()
    expect(() => {
      session().updateRichTextItem('x', 'y')
    }).not.toThrow()
    expect(() => {
      session().deleteItem('x')
    }).not.toThrow()

    await waitFor(() => useSessionStore.getState().phase === 'pairing', 'the pairing phase')
    await settle()

    expect(useSessionStore.getState().items).toEqual([])
    expect(devices.guestChannel.sent).toEqual([])
    expect(devices.hostReceived).toEqual([])
  })

  it('announces a text item and streams one debounced delta for a burst of keystrokes', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const id = session().addTextItem()
    expect(id).not.toBe('')
    expect(useSessionStore.getState().items.map((item) => item.id)).toContain(id)

    await waitFor(
      () => devices.hostReceived.some((message) => message.t === 'item-announce' && message.id === id),
      'the announce frame',
    )
    expect(framesOf(devices.hostReceived, 'item-announce')[0]).toEqual({
      t: 'item-announce',
      id,
      type: 'text',
    })

    const startedAt = Date.now()
    session().updateTextItem(id, 'h')
    session().updateTextItem(id, 'he')
    session().updateTextItem(id, 'hey')

    // The sender's own row follows the keyboard immediately; the wire does not — the
    // debounce timer has not fired yet.
    expect(useSessionStore.getState().items.find((item) => item.id === id)).toMatchObject({
      content: 'hey',
    })
    expect(framesOf(devices.hostReceived, 'text-delta')).toEqual([])

    await waitFor(() => framesOf(devices.hostReceived, 'text-delta').length === 1, 'one delta')
    // Measured from the last keystroke: the delta waits out PLAN.md §19 decision 8
    // rather than going out on the next tick. Asserted as a floor, never a ceiling, so
    // a loaded machine can only make this later.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90)
    expect(framesOf(devices.hostReceived, 'text-delta')).toEqual([
      { t: 'text-delta', id, content: 'hey' },
    ])
  })

  it('announces an initial text content instead of waiting for a keystroke', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const id = session().addTextItem('typed before the item existed')

    expect(useSessionStore.getState().items.find((item) => item.id === id)).toMatchObject({
      content: 'typed before the item existed',
    })
    await waitFor(
      () => framesOf(devices.hostReceived, 'text-delta').length === 1,
      'the initial delta',
    )
    expect(framesOf(devices.hostReceived, 'text-delta')[0]).toEqual({
      t: 'text-delta',
      id,
      content: 'typed before the item existed',
    })
  })

  it('streams a rich-text item as its Tiptap JSON', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const id = session().addRichTextItem()
    const first = JSON.stringify({ type: 'doc', content: [] })
    const second = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })

    session().updateRichTextItem(id, first)
    session().updateRichTextItem(id, second)
    expect(useSessionStore.getState().items.find((item) => item.id === id)).toMatchObject({
      type: 'richtext',
      content: second,
    })

    await waitFor(
      () => framesOf(devices.hostReceived, 'richtext-delta').length === 1,
      'the debounced richtext delta',
    )
    expect(framesOf(devices.hostReceived, 'richtext-delta')).toEqual([
      { t: 'richtext-delta', id, content: second },
    ])
    // No text-delta ever crosses for a rich-text item: the two kinds stay apart.
    expect(framesOf(devices.hostReceived, 'text-delta')).toEqual([])
  })

  it('chunks a file in order, completes its row, and classifies images by MIME type', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const imageBytes = patternedBytes(CHUNK_SIZE * 2 + 7)
    const imageFile = new File([imageBytes], 'photo.png', { type: 'image/png' })
    const imageId = session().addFileItem(imageFile)

    expect(useSessionStore.getState().items.find((item) => item.id === imageId)).toMatchObject({
      type: 'image',
      status: 'pending',
      fileName: 'photo.png',
      mimeType: 'image/png',
      totalSize: imageFile.size,
      totalChunks: 3,
      progress: 0,
    })

    // The sender's row carries the source File itself — a `File` IS a `Blob`, so this
    // is the same object, not a copy or a read. That one field is what puts the image
    // preview and the file download link up before a single chunk has crossed
    // (PLAN.md §9), and it is the half of the pipeline the component tests inject by
    // hand.
    const pendingRow = useSessionStore.getState().items.find((item) => item.id === imageId)
    if (pendingRow?.type !== 'image') throw new Error('test bug: the sender item is not an image')
    expect(pendingRow.blob).toBe(imageFile)

    await waitFor(
      () => devices.hostReceived.some((message) => message.t === 'file-done'),
      'file-done',
    )

    // The sender's own type and the announced type are decided by the same rule.
    expect(framesOf(devices.hostReceived, 'item-announce')[0]).toMatchObject({
      t: 'item-announce',
      id: imageId,
      type: 'image',
      fileName: 'photo.png',
      mimeType: 'image/png',
      totalSize: imageFile.size,
      totalChunks: 3,
    })

    const chunks = framesOf(devices.hostReceived, 'file-chunk')
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2])
    expect(chunks.every((chunk) => chunk.id === imageId)).toBe(true)

    // Reassembled with the real assembler the receiver uses: byte-identical.
    const assembler = new FileAssembler()
    for (const chunk of chunks) assembler.addChunk(chunk.index, chunk.data)
    expect(assembler.isComplete(3)).toBe(true)
    const assembled = await assembler.assemble('image/png').arrayBuffer()
    expect(new Uint8Array(assembled)).toEqual(imageBytes)

    await waitFor(() => {
      const item = useSessionStore.getState().items.find((candidate) => candidate.id === imageId)
      return item?.type === 'image' && item.status === 'complete' && item.progress === 100
    }, 'the sender row to complete')

    // The receive path never writes an item this device created (no assembler exists
    // for it), and the sender's own progress/completion writes spread the item, so the
    // source file survives the whole transfer untouched.
    const completedRow = useSessionStore.getState().items.find((item) => item.id === imageId)
    if (completedRow?.type !== 'image') throw new Error('test bug: the sender item is not an image')
    expect(completedRow.blob).toBe(imageFile)
    expect(completedRow.status).toBe('complete')

    // Every frame that left this device — announces, 16 KiB chunks and the done frame
    // alike — was an encrypted binary envelope, never a readable one.
    expect(devices.guestChannel.sent.length).toBeGreaterThan(4)
    for (const envelope of devices.guestChannel.sent) {
      expect(envelope).toBeInstanceOf(ArrayBuffer)
      const text = new TextDecoder().decode(new Uint8Array(envelope as ArrayBuffer))
      expect(text).not.toContain('photo.png')
      expect(text).not.toContain('file-chunk')
    }

    // A file with no image MIME type announces as a plain file, locally and on the wire.
    const plainId = session().addFileItem(new File([patternedBytes(4)], 'notes.bin', { type: '' }))
    expect(useSessionStore.getState().items.find((item) => item.id === plainId)).toMatchObject({
      type: 'file',
    })
    await waitFor(
      () =>
        framesOf(devices.hostReceived, 'item-announce').some(
          (announce) => announce.id === plainId && announce.type === 'file',
        ),
      'the plain-file announce',
    )
  })

  it('does not let a file starve a text item, and runs a second file alongside the first', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    // Hold the channel full: the pump may write one frame and then has to wait for the
    // buffer, which is exactly the state a 1 GiB transfer is in for most of its life.
    devices.guestChannel.holdBackpressure = true

    const firstBytes = patternedBytes(CHUNK_SIZE * 3 + 100)
    const firstId = session().addFileItem(new File([firstBytes], 'first.bin', { type: '' }))
    await waitFor(
      () => framesOf(devices.hostReceived, 'item-announce').some((m) => m.id === firstId),
      'the first announce',
    )

    // One release lets exactly one chunk through; the pump parks again after it.
    devices.guestChannel.releaseBackpressure()
    await waitFor(
      () => framesOf(devices.hostReceived, 'file-chunk').some((chunk) => chunk.index === 0),
      'chunk 0',
    )

    // A text item typed while the file is in flight, and a second small file.
    const textId = session().addTextItem()
    session().updateTextItem(textId, 'typed mid-transfer')
    const secondId = session().addFileItem(new File([patternedBytes(10)], 'second.bin', { type: '' }))

    await waitFor(
      () => framesOf(devices.hostReceived, 'text-delta').length === 1,
      'the delta sent during the transfer',
    )

    const order = devices.hostReceived.map(describeFrame)
    expect(order.indexOf('text-delta')).toBeGreaterThan(order.indexOf('file-chunk:0'))
    expect(order).not.toContain('file-done')

    // Let both pumps finish: the second file must complete without the first blocking it.
    devices.guestChannel.holdBackpressure = false
    devices.guestChannel.releaseBackpressure()
    await waitFor(() => {
      const done = new Set(framesOf(devices.hostReceived, 'file-done').map((frame) => frame.id))
      return done.has(firstId) && done.has(secondId)
    }, 'both files to finish')

    // The second file's single chunk arrived after the first file's, but neither waited
    // for the other to complete: that is the async independence PLAN.md §9 asks for.
    expect(describeFrame(devices.hostReceived[devices.hostReceived.length - 1]!)).toBe('file-done')
    for (const id of [firstId, secondId]) {
      const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
      expect(item?.type === 'file' && item.status === 'complete' && item.progress === 100).toBe(true)
    }
  })

  it('sends item-delete and removes the item on both sides', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const id = session().addTextItem()
    await waitFor(
      () => useSessionStore.getState().items.some((item) => item.id === id),
      'the local item',
    )

    session().deleteItem(id)

    expect(useSessionStore.getState().items).toEqual([])
    await waitFor(
      () => framesOf(devices.hostReceived, 'item-delete').some((frame) => frame.id === id),
      'the item-delete frame',
    )
  })

  it('stops a transfer at teardown: no further frame, no completed row, no pending write', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    devices.guestChannel.holdBackpressure = true
    const id = session().addFileItem(
      new File([patternedBytes(CHUNK_SIZE * 4)], 'doomed.bin', { type: '' }),
    )
    await waitFor(
      () => framesOf(devices.hostReceived, 'item-announce').some((frame) => frame.id === id),
      'the announce frame',
    )
    const framesBeforeAbort = devices.guestChannel.sent.length

    session().abort()
    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')
    await settle()

    // Unpark the channel: a pump still watching it would write its next chunk now. It
    // must not, and nothing may escape as an unhandled rejection (vitest fails this
    // file if it does).
    devices.guestChannel.holdBackpressure = false
    devices.guestChannel.releaseBackpressure()
    await settle()

    expect(devices.guestChannel.sent.length).toBe(framesBeforeAbort + 1)
    expect(framesOf(devices.hostReceived, 'file-chunk')).toEqual([])
    expect(framesOf(devices.hostReceived, 'file-done')).toEqual([])
    const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
    expect(item?.status).not.toBe('complete')
    expect(useSessionStore.getState().errorMessage).toBe(null)
  })

  it('wakes a cancelled pump parked on backpressure when the peer ends the session', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    // Record whether each backpressure wait ever settles, without changing what it
    // does. The parked promise is the evidence: a pump that never wakes keeps its
    // closure and its File alive for the life of the tab.
    const original = PeerConnection.prototype.waitForBackpressure
    const settled: boolean[] = []
    vi.spyOn(PeerConnection.prototype, 'waitForBackpressure').mockImplementation(
      function (this: PeerConnection) {
        const index = settled.length
        settled.push(false)
        const waiting = original.call(this)
        void waiting.then(() => {
          settled[index] = true
        })
        return waiting
      },
    )

    // Hold the channel full: the pump writes its announce and then parks before its
    // first chunk, which is where a large transfer spends most of its life.
    devices.guestChannel.holdBackpressure = true
    const id = session().addFileItem(
      new File([patternedBytes(CHUNK_SIZE * 2)], 'parked.bin', { type: '' }),
    )
    await waitFor(
      () => framesOf(devices.hostReceived, 'item-announce').some((frame) => frame.id === id),
      'the announce frame',
    )
    await waitFor(() => settled.length > 0, 'the pump to park')
    await settle()
    expect(settled).toEqual([false])

    // A clean end from the peer: no close() runs on this path, so the channel that
    // would normally wake the pump stays open.
    devices.host.send({ t: 'session-end' })
    await devices.host.drain()
    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')
    await waitFor(() => settled[0] === true, 'the parked pump to be released')
    await settle()

    // Woken, the pump re-checks and exits: the session-end did not let a chunk out.
    expect(framesOf(devices.hostReceived, 'file-chunk')).toEqual([])
  })
})

describe('useSession items — the receive path (PLAN.md §9, §10, §12)', () => {
  it('upserts an announce and streams deltas into the store', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const textId = crypto.randomUUID()
    devices.guest.send({ t: 'item-announce', id: textId, type: 'text' })
    devices.guest.send({ t: 'text-delta', id: textId, content: 'first' })
    devices.guest.send({ t: 'text-delta', id: textId, content: 'first and second' })

    const richId = crypto.randomUUID()
    const doc = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
    devices.guest.send({ t: 'item-announce', id: richId, type: 'richtext' })
    devices.guest.send({ t: 'richtext-delta', id: richId, content: doc })
    await devices.guest.drain()

    await waitFor(
      () => useSessionStore.getState().items.length === 2,
      'both announced items',
    )
    await waitFor(() => {
      const text = useSessionStore.getState().items.find((item) => item.id === textId)
      return text?.type === 'text' && text.content === 'first and second'
    }, 'the live text content')
    await waitFor(() => {
      const rich = useSessionStore.getState().items.find((item) => item.id === richId)
      return rich?.type === 'richtext' && rich.content === doc
    }, 'the live richtext content')

    // Deltas for an id this session does not carry are dropped, not invented.
    devices.guest.send({ t: 'text-delta', id: crypto.randomUUID(), content: 'ghost' })
    await devices.guest.drain()
    await settle()
    expect(useSessionStore.getState().items).toHaveLength(2)
  })

  it('assembles a multi-chunk file byte-identically and reports 100%', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const bytes = patternedBytes(CHUNK_SIZE * 2 + 123)
    const file = new File([bytes], 'movie.bin', { type: 'application/octet-stream' })
    const id = crypto.randomUUID()

    // Watch the store while the file crosses. Both halves of the pipeline used to be
    // tested with a hand-injected blob, which is exactly why the partial-blob wiring
    // could be missing without a red test: these are the assertions that pin it.
    const captured: Array<{ size: number; status: ItemStatus; blob: Blob }> = []
    const unsubscribe = useSessionStore.subscribe((state) => {
      const item = state.items.find((candidate) => candidate.id === id)
      if (item?.type !== 'file' || item.blob === undefined) return
      if (captured[captured.length - 1]?.blob === item.blob) return
      captured.push({ size: item.blob.size, status: item.status, blob: item.blob })
    })

    try {
      await sendWholeFile(devices.guest, id, file)

      await waitFor(() => {
        const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
        return item?.status === 'complete'
      }, 'the received file to complete')
    } finally {
      unsubscribe()
    }

    const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
    if (item?.type !== 'file') throw new Error('test bug: the item is not a file')
    expect(item.progress).toBe(100)
    expect(item.totalChunks).toBe(3)
    expect(item.totalSize).toBe(bytes.byteLength)
    expect(item.fileName).toBe('movie.bin')
    const blob = item.blob
    if (!blob) throw new Error('the assembled blob is missing')

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/octet-stream')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)

    // The transport publishes the Blob alone. Object URLs belong to the components
    // that build and revoke them, so an URL written here would be a double-revoke
    // hazard the moment a row re-rendered or unmounted.
    expect('objectURL' in item).toBe(false)

    // The item's blob grew DURING the transfer, before file-done, at the same 10%
    // boundaries the progress ring uses: 3 chunks mean one partial blob per boundary
    // crossed, and each one is the file's own bytes from index 0.
    const midTransfer = captured.filter((entry) => entry.size > 0 && entry.size < file.size)
    expect(midTransfer.map((entry) => entry.size)).toEqual([CHUNK_SIZE, CHUNK_SIZE * 2])
    expect(midTransfer.every((entry) => entry.status === 'transferring')).toBe(true)

    const firstPartial = midTransfer[0]
    if (!firstPartial) throw new Error('test bug: no partial blob was published')
    const prefix = new Uint8Array(await firstPartial.blob.arrayBuffer())
    expect(prefix.byteLength).toBe(CHUNK_SIZE)
    expect(prefix).toEqual(bytes.subarray(0, CHUNK_SIZE))

    // And the completed blob is the whole file, byte-identically — the partial writes
    // were replaced, never truncated the final result.
    expect(captured[captured.length - 1]?.size).toBe(file.size)
    expect(captured[captured.length - 1]?.status).toBe('complete')
  })

  it('ignores item frames from a peer until the sender confirmed the phrase (decision D14)', async () => {
    const devices = await pairDevicesAsReceiver()

    // Even if this device (receiver) confirmed locally, sender has not confirmed
    session().confirmPhrase()
    await waitFor(() => useSessionStore.getState().phraseConfirmed, 'the local confirmation')
    await settle()
    expect(useSessionStore.getState().isSenderConfirmed()).toBe(false)

    // The peer's own send gate is open — it believes the session is live — which is
    // the state the phase-based gate would miss.
    devices.guest.markActive()
    const id = crypto.randomUUID()
    devices.guest.send({ t: 'item-announce', id, type: 'text' })
    devices.guest.send({ t: 'text-delta', id, content: 'arrived before the phrase' })
    await devices.guest.drain()
    await settle()

    // Holding the session key does not let the peer populate the board while the human
    // is still comparing the words: nothing is stored to appear when the phase flips.
    expect(useSessionStore.getState().items).toEqual([])

    // The same announce once both have confirmed is accepted — the gate drops frames
    // during pairing, it does not blacklist the peer.
    devices.guest.send({ t: 'phrase-confirm' })
    await devices.guest.drain()
    await waitFor(() => useSessionStore.getState().phase === 'active', 'the active phase')

    devices.guest.send({ t: 'item-announce', id, type: 'text' })
    devices.guest.send({ t: 'text-delta', id, content: 'arrived after the phrase' })
    await devices.guest.drain()
    await waitFor(() => {
      const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
      return item?.type === 'text' && item.content === 'arrived after the phrase'
    }, 'the item from after both confirmations')
  })

  it('writes progress in 10% steps rather than once per chunk', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const chunkCount = 25
    const id = crypto.randomUUID()
    const seen = new Set<number>()
    const unsubscribe = useSessionStore.subscribe((state) => {
      const item = state.items.find((candidate) => candidate.id === id)
      if (item?.type === 'file') seen.add(item.progress)
    })

    try {
      await sendWholeFile(
        devices.guest,
        id,
        new File([patternedBytes(CHUNK_SIZE * chunkCount)], 'big.bin', { type: '' }),
      )
      await waitFor(() => {
        const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
        return item?.status === 'complete'
      }, 'the transfer to complete')
    } finally {
      unsubscribe()
    }

    // 25 chunks must not mean 25 store writes (a 1 GiB transfer is ~65k chunks).
    expect(seen.size).toBeGreaterThan(1)
    expect(seen.size).toBeLessThanOrEqual(12)
    expect(Math.max(...seen)).toBe(100)
  })

  it('drops a chunk that arrives before its announce instead of buffering it', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    devices.guest.send({ t: 'file-chunk', id, index: 0, data: new Uint8Array([1, 2, 3]) })
    await devices.guest.drain()
    await settle()

    // Nothing was announced, so there is no item and no assembler to fill.
    expect(useSessionStore.getState().items).toEqual([])

    // The later announce cannot recover the dropped chunk: a file is never assembled
    // from a hole.
    devices.guest.send({
      t: 'item-announce',
      id,
      type: 'file',
      fileName: 'late.bin',
      mimeType: '',
      totalSize: 3,
      totalChunks: 1,
    })
    devices.guest.send({ t: 'file-done', id })
    await devices.guest.drain()
    await settle()

    const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
    if (item?.type !== 'file') throw new Error('test bug: the item is not a file')
    expect(item.status).not.toBe('complete')
    expect(item.blob).toBeUndefined()
  })

  it('bounds a hostile announce and ignores a chunk past its declared total', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const hostileId = crypto.randomUUID()
    devices.guest.send({
      t: 'item-announce',
      id: hostileId,
      type: 'file',
      fileName: 'huge.bin',
      mimeType: '',
      totalSize: Number.MAX_SAFE_INTEGER,
      totalChunks: Number.MAX_SAFE_INTEGER,
    })
    // A chunk that claims to be inside the declared range, and one past it.
    devices.guest.send({ t: 'file-chunk', id: hostileId, index: 0, data: new Uint8Array([7]) })
    await devices.guest.drain()
    await settle()

    // The announce preallocated nothing, so this finished instantly; the item exists
    // but is nowhere near complete and has no blob.
    const item = useSessionStore.getState().items.find((candidate) => candidate.id === hostileId)
    if (item?.type !== 'file') throw new Error('test bug: the item is not a file')
    expect(item.status).not.toBe('complete')
    expect(item.blob).toBeUndefined()

    // `file-done` with a count nowhere near the declared total must not walk 10^15
    // indices, and must not assemble anything.
    devices.guest.send({ t: 'file-done', id: hostileId })
    await devices.guest.drain()
    await settle()
    const afterDone = useSessionStore.getState().items.find((candidate) => candidate.id === hostileId)
    expect(afterDone?.status).not.toBe('complete')
    expect(afterDone?.type === 'file' && afterDone.blob).toBeUndefined()

    // And the session is not poisoned: a real file still transfers.
    const goodId = crypto.randomUUID()
    await sendWholeFile(devices.guest, goodId, new File([patternedBytes(24)], 'small.bin', { type: '' }))
    await waitFor(() => {
      const good = useSessionStore.getState().items.find((candidate) => candidate.id === goodId)
      return good?.status === 'complete'
    }, 'the good file to complete')
  })

  it('ignores a duplicate chunk and still assembles byte-identically', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    const first = new Uint8Array(CHUNK_SIZE).fill(1)
    const second = new Uint8Array(32).fill(2)
    const totalSize = first.byteLength + second.byteLength

    devices.guest.send({
      t: 'item-announce',
      id,
      type: 'file',
      fileName: 'dup.bin',
      mimeType: 'application/octet-stream',
      totalSize,
      totalChunks: 2,
    })
    devices.guest.send({ t: 'file-chunk', id, index: 0, data: first })
    // A replayed index with different bytes: the first copy wins, or the file would
    // silently change under the receiver.
    devices.guest.send({ t: 'file-chunk', id, index: 0, data: new Uint8Array(CHUNK_SIZE).fill(9) })
    devices.guest.send({ t: 'file-chunk', id, index: 1, data: second })
    devices.guest.send({ t: 'file-done', id })
    await devices.guest.drain()

    await waitFor(() => {
      const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
      return item?.status === 'complete'
    }, 'the file to complete')

    const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
    if (item?.type !== 'file' || !item.blob) throw new Error('test bug: no assembled blob')
    const assembled = new Uint8Array(await item.blob.arrayBuffer())
    expect(assembled.byteLength).toBe(totalSize)
    expect(assembled.subarray(0, CHUNK_SIZE)).toEqual(first)
    expect(assembled.subarray(CHUNK_SIZE)).toEqual(second)
  })

  it('drops a chunk outside the announced range, so an announce bounds the assembler', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    const first = new Uint8Array(CHUNK_SIZE).fill(1)
    const second = new Uint8Array(32).fill(2)
    const totalSize = first.byteLength + second.byteLength

    devices.guest.send({
      t: 'item-announce',
      id,
      type: 'file',
      fileName: 'bounded.bin',
      mimeType: 'application/octet-stream',
      totalSize,
      totalChunks: 2,
    })
    devices.guest.send({ t: 'file-chunk', id, index: 0, data: first })
    devices.guest.send({ t: 'file-chunk', id, index: 1, data: second })
    // Chunks the announce never promised: holding them would let a peer grow this
    // device's memory past the size it declared.
    devices.guest.send({ t: 'file-chunk', id, index: 5, data: new Uint8Array(1024).fill(9) })
    devices.guest.send({ t: 'file-chunk', id, index: 6, data: new Uint8Array(1024).fill(9) })
    devices.guest.send({ t: 'file-done', id })
    await devices.guest.drain()

    await waitFor(() => {
      const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
      return item?.status === 'complete'
    }, 'the declared file to complete')

    const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
    if (item?.type !== 'file' || !item.blob) throw new Error('test bug: no assembled blob')
    const assembled = new Uint8Array(await item.blob.arrayBuffer())
    // Exactly the declared bytes: the out-of-range chunks were not stored at all.
    expect(assembled.byteLength).toBe(totalSize)
    expect(assembled.subarray(0, CHUNK_SIZE)).toEqual(first)
    expect(assembled.subarray(CHUNK_SIZE)).toEqual(second)
  })

  it('keeps the first announce for an id, so a re-announce cannot wipe the item', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    devices.guest.send({ t: 'item-announce', id, type: 'text' })
    devices.guest.send({ t: 'text-delta', id, content: 'already typing' })
    await devices.guest.drain()
    await waitFor(() => {
      const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
      return item?.type === 'text' && item.content === 'already typing'
    }, 'the first content')

    // A hostile peer re-announces the same id. Replacing the item here would clear the
    // content that is already on the board (and, for a file, its transfer state).
    devices.guest.send({ t: 'item-announce', id, type: 'file', fileName: 'swapped.bin' })
    await devices.guest.drain()
    await settle()

    const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
    expect(useSessionStore.getState().items).toHaveLength(1)
    expect(item?.type).toBe('text')
    expect(item?.type === 'text' && item.content).toBe('already typing')
  })

  it('keeps a received file in memory only, never in web storage', async () => {
    // AGENTS.md: session data and its Blobs never touch IndexedDB, the Cache API or
    // localStorage. jsdom ships no IndexedDB or Cache API at all here, so the one
    // reachable sink is web storage — and a transfer must not touch even that.
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    await sendWholeFile(
      devices.guest,
      id,
      new File([patternedBytes(CHUNK_SIZE + 5)], 'memo.bin', { type: '' }),
    )
    await waitFor(() => {
      const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
      return item?.status === 'complete'
    }, 'the received file to complete')

    const item = useSessionStore.getState().items.find((candidate) => candidate.id === id)
    expect(item?.type === 'file' && item.blob).toBeInstanceOf(Blob)
    expect(setItem).not.toHaveBeenCalled()
  })

  it('removes a received item on item-delete without echoing it back', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    devices.guest.send({ t: 'item-announce', id, type: 'text' })
    devices.guest.send({ t: 'text-delta', id, content: 'to be removed' })
    await devices.guest.drain()
    await waitFor(() => useSessionStore.getState().items.length === 1, 'the item to arrive')

    const sentBeforeDelete = devices.hostChannel.sent.length
    devices.guest.send({ t: 'item-delete', id })
    await devices.guest.drain()
    await waitFor(() => useSessionStore.getState().items.length === 0, 'the item to be removed')

    // An echo would make two devices delete the same id at each other forever.
    expect(devices.hostChannel.sent.length).toBe(sentBeforeDelete)
  })
})

describe('useSession locked items — the sender side (PLAN.md §10, §11.4, §16 Phase 4)', () => {
  it('encrypts locally, sends the announce before the payload, and keeps ciphertext only', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)
    const framesBeforeCompose = devices.guestChannel.sent.length

    const id = await session().addLockedItem({
      label: 'Uni portal password',
      innerType: 'text',
      password: 'correct horse battery staple',
      content: 'the secret',
    })

    await waitFor(
      () => devices.hostReceived.some((message) => message.t === 'locked-payload'),
      'the locked payload frame',
    )

    // Both frames crossed the real encrypted channel, and in the order PLAN.md §10
    // needs: the receiver creates its row from the announce and fills it from the
    // payload that follows.
    const related = devices.hostReceived.filter(
      (message) => message.t === 'item-announce' || message.t === 'locked-payload',
    )
    expect(related.map(describeFrame)).toEqual(['item-announce', 'locked-payload'])
    expect(devices.guestChannel.sent.length).toBeGreaterThan(framesBeforeCompose)

    const announce = framesOf(devices.hostReceived, 'item-announce')[0]
    expect(announce).toEqual({
      t: 'item-announce',
      id,
      type: 'locked',
      label: 'Uni portal password',
      innerType: 'text',
    })

    const payload = framesOf(devices.hostReceived, 'locked-payload')[0]
    if (!payload) throw new Error('test bug: no locked payload frame')
    expect(payload.id).toBe(id)
    expect(payload.iv.byteLength).toBe(12)
    expect(payload.salt.byteLength).toBe(16)
    // Fresh per item: a reused IV under a per-item key would leak plaintext XOR.
    expect(payload.ciphertext.byteLength).toBeGreaterThan(0)

    // The whole wire is encrypted envelopes, and the plaintext is not in any of them.
    for (const frame of devices.guestChannel.sent) {
      expect(frame).toBeInstanceOf(ArrayBuffer)
      const text = new TextDecoder().decode(new Uint8Array(frame as ArrayBuffer))
      expect(text).not.toContain('the secret')
      expect(text).not.toContain('locked-payload')
      expect(text).not.toContain('correct horse')
    }

    // The sender's own row is what the receiver's will be: label, inner type and
    // ciphertext — never the plaintext the sender typed (PLAN.md §9 has no field for
    // it, unlike a regular file item, which keeps its source File for the preview).
    const mine = lockedItemOf(id)
    if (mine === null) throw new Error('test bug: the sender has no locked row')
    expect(mine.status).toBe('complete')
    expect(mine.label).toBe('Uni portal password')
    expect(mine.innerType).toBe('text')
    expect(mine.ciphertext).toEqual(payload.ciphertext)
    expect('plaintextContent' in mine).toBe(false)
    expect(mine.unlocked).toBeUndefined()

    // The sender checks its own item the same way anyone else opens it: with the
    // password, which is the only way to be sure it decrypts back to what was meant.
    expect(await session().unlockItem(id, 'not the password')).toBe(false)
    expect(lockedItemOf(id)?.unlocked).toBeUndefined()
    expect('plaintextContent' in (lockedItemOf(id) ?? {})).toBe(false)

    expect(await session().unlockItem(id, 'correct horse battery staple')).toBe(true)
    expect(lockedItemOf(id)?.unlocked).toBe(true)
    expect(lockedItemOf(id)?.plaintextContent).toBe('the secret')

    session().lockItemAgain(id)
    expect(lockedItemOf(id)?.unlocked).toBe(false)
    expect(lockedItemOf(id)?.plaintextContent).toBeUndefined()
    // Re-locking does not touch the ciphertext: the password can bring it back.
    expect(lockedItemOf(id)?.ciphertext).toEqual(payload.ciphertext)
  })

  it('carries a locked file at exactly D6’s cap, inside the wire frame bound (decision D6)', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    // The largest item D6 allows: one frame has to hold this and its MessagePack
    // envelope, well under the 4 MiB `WIRE_MAX_FRAME_BYTES` the receiver enforces.
    const bytes = patternedBytes(LOCKED_ITEM_MAX_PLAINTEXT_BYTES)
    const id = await session().addLockedItem({
      label: 'At the cap',
      innerType: 'file',
      password: 'pw',
      content: new File([bytes], 'cap.bin'),
    })

    await waitFor(
      () => devices.hostReceived.some((message) => message.t === 'locked-payload'),
      'the payload frame',
    )

    const payload = framesOf(devices.hostReceived, 'locked-payload')[0]
    if (!payload) throw new Error('test bug: no locked payload frame')
    // GCM appends its 16-byte tag to the ciphertext.
    expect(payload.ciphertext.byteLength).toBe(bytes.byteLength + 16)

    // Measured the way the transport measures it: the decoded MessagePack bytes of the
    // whole message, which is what `decodeWire` bounds. The session envelope around it
    // adds only an IV and a tag (28 bytes).
    const frameBytes = encodeWire({
      t: 'locked-payload',
      id,
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      salt: payload.salt,
    })
    expect(frameBytes.byteLength).toBeLessThan(WIRE_MAX_FRAME_BYTES)

    // And the item at the cap still decrypts back byte-identically on the device that
    // made it. Compared by digest: a 3 MiB element-wise deep equality costs more than
    // the transfer it is checking.
    expect(await session().unlockItem(id, 'pw')).toBe(true)
    const revealed = lockedItemOf(id)?.plaintextContent
    if (!(revealed instanceof Blob)) throw new Error('test bug: the unlocked file is not a Blob')
    const revealedBytes = new Uint8Array(await revealed.arrayBuffer())
    expect(revealedBytes.byteLength).toBe(bytes.byteLength)
    expect(await digestOf(revealedBytes)).toBe(await digestOf(bytes))
  })

  it('sends no locked frame at all before both devices confirmed the phrase (PLAN.md §8)', async () => {
    const devices = await pairDevices()
    const framesBefore = devices.guestChannel.sent.length

    await expect(
      session().addLockedItem({
        label: 'Early',
        innerType: 'text',
        password: 'pw',
        content: 'the secret',
      }),
    ).rejects.toThrow(/active/)

    await settle()

    // Neither frame, and no local row: the gate is the same one every other item
    // frame goes through, so a forgotten check here cannot open it early.
    expect(devices.guestChannel.sent.length).toBe(framesBefore)
    expect(devices.guestChannel.sent).toEqual([])
    expect(useSessionStore.getState().items).toEqual([])
  })

  it('refuses a locked file over D6’s cap before anything reaches the wire (decision D6)', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)
    const framesBefore = devices.guestChannel.sent.length

    const oversized = new File(['x'.repeat(LOCKED_ITEM_MAX_PLAINTEXT_BYTES + 1)], 'huge.bin')

    await expect(
      session().addLockedItem({
        label: 'Too big',
        innerType: 'file',
        password: 'pw',
        content: oversized,
      }),
    ).rejects.toThrow(/at most 3 MiB/)

    await settle()

    // No frame, no payload, no local row — an item nobody can be sent must not exist
    // on this board either, or the sender would see a row the peer never got.
    expect(devices.guestChannel.sent.length).toBe(framesBefore)
    expect(devices.hostReceived.some((message) => message.t === 'locked-payload')).toBe(false)
    expect(useSessionStore.getState().items).toEqual([])
  })

  it('refuses locked text over D6’s cap before anything reaches the wire (decision D6)', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)
    const framesBefore = devices.guestChannel.sent.length

    // One ASCII character is one UTF-8 byte, so this content is exactly one byte over
    // the cap — the size that used to encrypt cleanly and then be dropped by the peer
    // while this device's own row already said 'complete'.
    const oversized = 'x'.repeat(LOCKED_ITEM_MAX_PLAINTEXT_BYTES + 1)

    await expect(
      session().addLockedItem({
        label: 'Too much text',
        innerType: 'text',
        password: 'pw',
        content: oversized,
      }),
    ).rejects.toThrow(/at most 3 MiB — send it as a regular text item instead/)

    await settle()

    expect(devices.guestChannel.sent.length).toBe(framesBefore)
    expect(devices.hostReceived.some((message) => message.t === 'locked-payload')).toBe(false)
    expect(useSessionStore.getState().items).toEqual([])
  })

  it('refuses locked rich text over D6’s cap before anything reaches the wire (decision D6)', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)
    const framesBefore = devices.guestChannel.sent.length

    // A Tiptap document is a JSON string, so the cap is on the JSON's UTF-8 bytes.
    const oversized = `{"type":"doc","content":"${'x'.repeat(LOCKED_ITEM_MAX_PLAINTEXT_BYTES)}"}`

    await expect(
      session().addLockedItem({
        label: 'Too much rich text',
        innerType: 'richtext',
        password: 'pw',
        content: oversized,
      }),
    ).rejects.toThrow(/at most 3 MiB — send it as a regular rich text item instead/)

    await settle()

    expect(devices.guestChannel.sent.length).toBe(framesBefore)
    expect(devices.hostReceived.some((message) => message.t === 'locked-payload')).toBe(false)
    expect(useSessionStore.getState().items).toEqual([])
  })

  it('still sends a locked text item at exactly D6’s cap, inside the wire frame bound', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const content = 'x'.repeat(LOCKED_ITEM_MAX_PLAINTEXT_BYTES)
    const id = await session().addLockedItem({
      label: 'At the cap',
      innerType: 'text',
      password: 'pw',
      content,
    })

    await waitFor(
      () => devices.hostReceived.some((message) => message.t === 'locked-payload'),
      'the payload frame',
    )

    const payload = framesOf(devices.hostReceived, 'locked-payload')[0]
    if (!payload) throw new Error('test bug: no locked payload frame')
    // GCM appends its 16-byte tag to the ciphertext, exactly as for a file.
    expect(payload.ciphertext.byteLength).toBe(LOCKED_ITEM_MAX_PLAINTEXT_BYTES + 16)

    // Also measured the way the receiver does: the decoded MessagePack bytes of the
    // whole message must stay under the bound `decodeWire` enforces.
    const frameBytes = encodeWire({
      t: 'locked-payload',
      id,
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      salt: payload.salt,
    })
    expect(frameBytes.byteLength).toBeLessThan(WIRE_MAX_FRAME_BYTES)

    // And the item at the cap decrypts back to exactly what was typed.
    expect(await session().unlockItem(id, 'pw')).toBe(true)
    expect(lockedItemOf(id)?.plaintextContent).toBe(content)
  })
})

describe('useSession locked items — the receive path (PLAN.md §10, §16 Phase 4)', () => {
  it('completes a received locked item from its payload, then unlocks it with the password', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    const plaintext = new TextEncoder().encode('the secret')
    const encrypted = await encryptItem('hunter2', plaintext)

    devices.guest.send({
      t: 'item-announce',
      id,
      type: 'locked',
      label: 'Uni portal password',
      innerType: 'text',
    })
    await devices.guest.drain()
    await waitFor(() => lockedItemOf(id) !== null, 'the locked row')

    // PLAN.md §9: the label is readable before the password is typed, and the row has
    // nothing to decrypt yet — so it is still transferring, not complete.
    expect(lockedItemOf(id)?.status).toBe('transferring')
    expect(lockedItemOf(id)?.label).toBe('Uni portal password')
    expect(lockedItemOf(id)?.ciphertext.byteLength).toBe(0)
    await expect(session().unlockItem(id, 'hunter2')).rejects.toThrow(/payload/)

    devices.guest.send({
      t: 'locked-payload',
      id,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      salt: encrypted.salt,
    })
    await devices.guest.drain()
    await waitFor(() => lockedItemOf(id)?.status === 'complete', 'the locked payload to land')

    const received = lockedItemOf(id)
    if (received === null) throw new Error('test bug: the locked row went away')
    expect(received.ciphertext).toEqual(encrypted.ciphertext)
    expect(received.iv).toEqual(encrypted.iv)
    expect(received.salt).toEqual(encrypted.salt)
    // The payload is not a reveal: an arrival is not a password (PLAN.md §17).
    expect(received.unlocked).toBeUndefined()
    expect('plaintextContent' in received).toBe(false)

    expect(await session().unlockItem(id, 'nope')).toBe(false)
    expect(lockedItemOf(id)?.unlocked).toBeUndefined()
    expect('plaintextContent' in (lockedItemOf(id) ?? {})).toBe(false)

    expect(await session().unlockItem(id, 'hunter2')).toBe(true)
    expect(lockedItemOf(id)?.unlocked).toBe(true)
    expect(lockedItemOf(id)?.plaintextContent).toBe('the secret')
  })

  it('drops a payload for an unknown id, and the second payload for an id it knows', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    // An unknown id is not an invitation to invent a row: buffering unannounced bytes
    // would let a peer make this device hold items nobody announced (PLAN.md §2/§17).
    devices.guest.send({
      t: 'locked-payload',
      id: crypto.randomUUID(),
      ciphertext: new Uint8Array([9, 9, 9]),
      iv: new Uint8Array(12),
      salt: new Uint8Array(16),
    })
    await devices.guest.drain()
    await settle()
    expect(useSessionStore.getState().items).toEqual([])

    const id = crypto.randomUUID()
    const first = await encryptItem('hunter2', new TextEncoder().encode('first'))
    devices.guest.send({ t: 'item-announce', id, type: 'locked', label: 'First' })
    devices.guest.send({
      t: 'locked-payload',
      id,
      ciphertext: first.ciphertext,
      iv: first.iv,
      salt: first.salt,
    })
    await devices.guest.drain()
    await waitFor(() => lockedItemOf(id)?.status === 'complete', 'the first payload')

    // A second payload for the same id is refused: the first one wins, so a peer cannot
    // swap the ciphertext out from under a label the user has already read.
    const second = await encryptItem('other', new TextEncoder().encode('second'))
    devices.guest.send({
      t: 'locked-payload',
      id,
      ciphertext: second.ciphertext,
      iv: second.iv,
      salt: second.salt,
    })
    await devices.guest.drain()
    await settle()

    expect(lockedItemOf(id)?.ciphertext).toEqual(first.ciphertext)
    // And the first payload's password is still the one that opens the item.
    expect(await session().unlockItem(id, 'hunter2')).toBe(true)
    expect(lockedItemOf(id)?.plaintextContent).toBe('first')
  })

  it('transfers a locked file within the cap and unlocks it byte-identically', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    const bytes = patternedBytes(64 * 1024)
    const encrypted = await encryptItem('hunter2', bytes)

    devices.guest.send({
      t: 'item-announce',
      id,
      type: 'locked',
      label: 'One time codes',
      innerType: 'file',
    })
    devices.guest.send({
      t: 'locked-payload',
      id,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      salt: encrypted.salt,
    })
    await devices.guest.drain()
    await waitFor(() => lockedItemOf(id)?.status === 'complete', 'the locked file payload')

    // A locked file is never chunked: it is one frame (PLAN.md §16 Phase 4, D6), so the
    // item goes straight from `transferring` to `complete` with no assembler involved.
    expect(lockedItemOf(id)?.status).toBe('complete')
    expect(await session().unlockItem(id, 'hunter2')).toBe(true)

    const revealed = lockedItemOf(id)?.plaintextContent
    if (!(revealed instanceof Blob)) throw new Error('test bug: the unlocked file is not a Blob')
    expect(new Uint8Array(await revealed.arrayBuffer())).toEqual(bytes)
  })

  it('drops a locked payload past the wire bound instead of failing the session', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    devices.guest.send({ t: 'item-announce', id, type: 'locked', label: 'Hostile' })
    await devices.guest.drain()
    await waitFor(() => lockedItemOf(id) !== null, 'the locked row')

    // D6 caps a locked item at compose time; this is the defensive backstop for a peer
    // that never had a compose UI. The frame is a valid `locked-payload` on the wire,
    // but its decoded size is past WIRE_MAX_FRAME_BYTES, so `decodeWire` refuses it.
    devices.guest.send({
      t: 'locked-payload',
      id,
      ciphertext: patternedBytes(5 * 1024 * 1024),
      iv: new Uint8Array(12),
      salt: new Uint8Array(16),
    })
    await devices.guest.drain()
    await settle()

    // The row stays as it was and the session is unharmed: a hostile frame costs the
    // frame, never the session (PLAN.md §17).
    expect(lockedItemOf(id)?.status).toBe('transferring')
    expect(lockedItemOf(id)?.ciphertext.byteLength).toBe(0)
    expect(useSessionStore.getState().errorMessage).toBe(null)
    expect(useSessionStore.getState().phase).toBe('active')

    // And a legitimate payload afterwards still completes the row, so the drop did not
    // poison the item.
    const encrypted = await encryptItem('hunter2', new TextEncoder().encode('late but fine'))
    devices.guest.send({
      t: 'locked-payload',
      id,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      salt: encrypted.salt,
    })
    await devices.guest.drain()
    await waitFor(() => lockedItemOf(id)?.status === 'complete', 'the following payload')
    expect(await session().unlockItem(id, 'hunter2')).toBe(true)
    expect(lockedItemOf(id)?.plaintextContent).toBe('late but fine')
  })

  it('drops every unlocked plaintext when the session ends (memory-only)', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    const encrypted = await encryptItem('hunter2', new TextEncoder().encode('the secret'))
    devices.guest.send({ t: 'item-announce', id, type: 'locked', label: 'Uni portal password' })
    devices.guest.send({
      t: 'locked-payload',
      id,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      salt: encrypted.salt,
    })
    await devices.guest.drain()
    await waitFor(() => lockedItemOf(id)?.status === 'complete', 'the locked payload')
    expect(await session().unlockItem(id, 'hunter2')).toBe(true)
    expect(lockedItemOf(id)?.plaintextContent).toBe('the secret')

    // AGENTS.md: the reveal is session-scoped, so the session ending takes the decrypted
    // bytes with it — the ciphertext stays, the plaintext does not.
    devices.guest.send({ t: 'session-end' })
    await devices.guest.drain()
    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')
    // The teardown effect is what drops it, so wait for the drop rather than for the
    // phase the store set synchronously.
    await waitFor(() => lockedItemOf(id)?.unlocked === false, 'the plaintext to be dropped')

    expect(lockedItemOf(id)?.unlocked).toBe(false)
    expect(lockedItemOf(id)?.plaintextContent).toBeUndefined()
    expect(lockedItemOf(id)?.ciphertext).toEqual(encrypted.ciphertext)
  })

  it('refuses a reveal whose unlock resolves after the session ended (PLAN.md §17)', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    const id = crypto.randomUUID()
    const encrypted = await encryptItem('hunter2', new TextEncoder().encode('the secret'))
    devices.guest.send({ t: 'item-announce', id, type: 'locked', label: 'Uni portal password' })
    devices.guest.send({
      t: 'locked-payload',
      id,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      salt: encrypted.salt,
    })
    await devices.guest.drain()
    await waitFor(() => lockedItemOf(id)?.status === 'complete', 'the locked payload')

    // The unlock awaits ~300ms of PBKDF2, and the session end lands inside that window —
    // the one moment the teardown (which runs once, at the phase change) cannot cover.
    // No await between the two calls, so the timing is exact instead of raced.
    const pending = session().unlockItem(id, 'hunter2')
    useSessionStore.getState().endSession(null)

    // The password WAS right, so the caller is told so; it is the reveal that is refused,
    // because the session that authorised it is over and plaintext may not outlive it.
    await expect(pending).resolves.toBe(true)

    await waitFor(() => useSessionStore.getState().phase === 'ended', 'the ended phase')
    await settle()

    expect(lockedItemOf(id)?.unlocked).toBeUndefined()
    expect('plaintextContent' in (lockedItemOf(id) ?? {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Library items (PLAN.md §7, §16 Phase 5, decisions D8 and D9)
// ---------------------------------------------------------------------------

/** A library item's base fields, so each case only states what it is about. */
function libraryBase(name: string): {
  id: string
  folderId: string
  name: string
  createdAt: number
  updatedAt: number
} {
  return {
    id: globalThis.crypto.randomUUID(),
    folderId: 'root',
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function libraryTextItem(content: string, name = 'note'): LibraryTextItem {
  return { ...libraryBase(name), type: 'text', content }
}

function libraryFileItem(blob: Blob, name: string, mimeType: string): LibraryFileItem {
  return { ...libraryBase(name), type: 'file', blob, mimeType, size: blob.size }
}

function libraryImageItem(blob: Blob, name: string, mimeType: string): LibraryImageItem {
  return { ...libraryBase(name), type: 'image', blob, mimeType, size: blob.size }
}

describe('useSession library items (PLAN.md §7, §16 Phase 5, D8/D9)', () => {
  it('is a no-op while the session is not active', async () => {
    const devices = await pairDevices()

    expect(() => {
      session().sendLibraryItem(libraryTextItem('too early'))
    }).not.toThrow()

    await settle()
    expect(devices.guestChannel.sent).toEqual([])
    expect(devices.hostReceived).toEqual([])
    expect(useSessionStore.getState().items).toEqual([])
  })

  it('announces a library text item and sends its stored content as the first delta', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const item = libraryTextItem('Portal password is hunter2', 'Portal password')
    session().sendLibraryItem(item)

    await waitFor(() => framesOf(devices.hostReceived, 'text-delta').length === 1, 'the delta')

    const announce = framesOf(devices.hostReceived, 'item-announce')[0]
    expect(announce).toMatchObject({ t: 'item-announce', type: 'text' })
    expect(framesOf(devices.hostReceived, 'text-delta')[0]).toEqual({
      t: 'text-delta',
      id: announce?.id,
      content: 'Portal password is hunter2',
    })
    // The sender's own row is the item that was picked, not a copy or an empty one.
    expect(useSessionStore.getState().items[0]).toMatchObject({
      id: announce?.id,
      type: 'text',
      status: 'complete',
      content: 'Portal password is hunter2',
    })
  })

  it('announces a library rich-text item as richtext, with its stored JSON', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const json = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
    session().sendLibraryItem({ ...libraryTextItem(json, 'Rich text note'), type: 'richtext' })

    await waitFor(
      () => framesOf(devices.hostReceived, 'richtext-delta').length === 1,
      'the richtext delta',
    )

    expect(framesOf(devices.hostReceived, 'item-announce')[0]).toMatchObject({ type: 'richtext' })
    expect(framesOf(devices.hostReceived, 'richtext-delta')[0]?.content).toBe(json)
  })

  it('runs a library file item through the chunk pipeline, byte-for-byte', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const bytes = patternedBytes(40 * 1024)
    const item = libraryFileItem(new Blob([bytes]), 'thesis.pdf', 'application/pdf')

    session().sendLibraryItem(item)

    await waitFor(
      () => devices.hostReceived.some((message) => message.t === 'file-done'),
      'file-done',
    )

    // The announce names the stored file: the library's name and MIME type become the
    // File's, so the receiver sees the item the user picked rather than a placeholder.
    expect(framesOf(devices.hostReceived, 'item-announce')[0]).toMatchObject({
      t: 'item-announce',
      type: 'file',
      fileName: 'thesis.pdf',
      mimeType: 'application/pdf',
      totalSize: bytes.byteLength,
      totalChunks: 3,
    })

    const chunks = framesOf(devices.hostReceived, 'file-chunk')
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2])

    // Reassembled with the receiver's own assembler: byte-identical to the stored blob.
    const assembler = new FileAssembler()
    for (const chunk of chunks) assembler.addChunk(chunk.index, chunk.data)
    expect(assembler.isComplete(3)).toBe(true)
    expect(new Uint8Array(await assembler.assemble('application/pdf').arrayBuffer())).toEqual(bytes)
  })

  it('sends a library image as an image item', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const bytes = patternedBytes(4 * 1024)
    session().sendLibraryItem(
      libraryImageItem(new Blob([bytes], { type: 'image/png' }), 'cat.png', 'image/png'),
    )

    await waitFor(
      () =>
        framesOf(devices.hostReceived, 'item-announce').some(
          (announce) => announce.type === 'image',
        ),
      'the image announce',
    )

    const announce = framesOf(devices.hostReceived, 'item-announce')[0]
    expect(announce).toMatchObject({ type: 'image', fileName: 'cat.png', mimeType: 'image/png' })
    // The sender's own row is an image too: the local type and the announced type come
    // from the same MIME rule (PLAN.md §9).
    expect(useSessionStore.getState().items[0]?.type).toBe('image')
  })

  it('sends a locked library item’s stored tuple without ever decrypting it (D9)', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const password = 'hunter2'
    const plaintext = 'the secret the sender never needs to know'
    const encrypted = await encryptItem(password, new TextEncoder().encode(plaintext))
    const item: LibraryLockedItem = {
      ...libraryBase('Uni portal password'),
      type: 'locked',
      label: 'Uni portal password',
      innerType: 'text',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      salt: encrypted.salt,
    }

    const decryptSpy = vi.spyOn(cryptoModule, 'decryptItem')
    session().sendLibraryItem(item)

    await waitFor(
      () => framesOf(devices.hostReceived, 'locked-payload').length === 1,
      'the locked payload',
    )

    // THE D9 ASSERTION: forwarding a locked item asks for no password, derives no key and
    // decrypts nothing. The tuple is what travels.
    expect(decryptSpy).not.toHaveBeenCalled()

    const announce = framesOf(devices.hostReceived, 'item-announce')[0]
    expect(announce).toEqual({
      t: 'item-announce',
      id: announce?.id,
      type: 'locked',
      label: 'Uni portal password',
      innerType: 'text',
    })

    const payload = framesOf(devices.hostReceived, 'locked-payload')[0]
    if (payload === undefined) throw new Error('test bug: no payload frame')
    expect(payload.ciphertext).toEqual(encrypted.ciphertext)
    expect(payload.iv).toEqual(encrypted.iv)
    expect(payload.salt).toEqual(encrypted.salt)

    // The sender's own row carries the same tuple, and no plaintext — the whole point of
    // the item is that its content is opaque until the receiver types the password.
    const row = lockedItemOf(announce?.id ?? '')
    expect(row?.ciphertext).toEqual(encrypted.ciphertext)
    expect(row?.iv).toEqual(encrypted.iv)
    expect(row?.salt).toEqual(encrypted.salt)
    expect(row?.unlocked).toBeUndefined()
    expect(row?.plaintextContent).toBeUndefined()

    // Positive control: this spy DOES see useSession's own decryption call, so the
    // assertion above is about the send path and not about a spy that intercepts nothing.
    expect(await session().unlockItem(announce?.id ?? '', password)).toBe(true)
    expect(decryptSpy).toHaveBeenCalledTimes(1)
    expect(lockedItemOf(announce?.id ?? '')?.plaintextContent).toBe(plaintext)
  })

  it('refuses a stored locked tuple past D6’s cap, before any frame is sent', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    const oversized: LibraryLockedItem = {
      ...libraryBase('Too big'),
      type: 'locked',
      label: 'Too big',
      innerType: 'file',
      ciphertext: patternedBytes(LOCKED_ITEM_MAX_PLAINTEXT_BYTES + 17),
      iv: patternedBytes(12),
      salt: patternedBytes(16),
    }

    expect(() => {
      session().sendLibraryItem(oversized)
    }).toThrow(/3 MiB/)

    await settle()
    // The announce never went out either: the check runs before the first frame.
    expect(framesOf(devices.hostReceived, 'item-announce')).toEqual([])
    expect(framesOf(devices.hostReceived, 'locked-payload')).toEqual([])
    expect(useSessionStore.getState().items).toEqual([])
  })
})

describe('useSession pending sends (PLAN.md §7, §16 Phase 5, D8)', () => {
  it('sends a queued selection the moment the session goes active', async () => {
    const devices = await pairDevices()

    const item = libraryTextItem('queued on the Home screen', 'Queued note')
    queueLibrarySends([item])

    // The safety-phrase gate still holds: nothing crosses before BOTH devices confirm.
    await settle()
    expect(devices.guestChannel.sent).toEqual([])

    await activatePairing(devices)

    await waitFor(() => framesOf(devices.hostReceived, 'text-delta').length === 1, 'the queued delta')
    expect(framesOf(devices.hostReceived, 'text-delta')[0]?.content).toBe(
      'queued on the Home screen',
    )
    // Drained: the same selection is not re-announced by the next phase change.
    expect(takeQueuedLibrarySends()).toEqual([])
    useSessionStore.getState().setPhase('pairing')
    useSessionStore.getState().setPhase('active')
    await settle()
    expect(framesOf(devices.hostReceived, 'item-announce')).toHaveLength(1)
  })

  it('keeps the untaken remainder queued when a send ends the session mid-drain', async () => {
    const devices = await pairDevices()

    // The first item is one D6 refuses, and that refusal ends the session inside the
    // drain. The second is a perfectly good selection this session will now never carry:
    // it must still be waiting rather than be destroyed by the race.
    const oversized: LibraryLockedItem = {
      ...libraryBase('Too big'),
      type: 'locked',
      label: 'Too big',
      innerType: 'file',
      ciphertext: patternedBytes(LOCKED_ITEM_MAX_PLAINTEXT_BYTES + 17),
      iv: patternedBytes(12),
      salt: patternedBytes(16),
    }
    const survivor = libraryTextItem('selected second', 'Second note')
    queueLibrarySends([oversized, survivor])

    expect(useSessionStore.getState().errorMessage).toBe(null)
    // Straight to the item gate: this test is about the drain, and the both-confirms
    // handshake would end the session before the drain's own phase could be observed.
    useSessionStore.getState().setPhase('active')

    await waitFor(() => useSessionStore.getState().errorMessage !== null, 'the D6 rejection')
    await settle()

    // The failure reaches the user through the store's error surface...
    expect(useSessionStore.getState().phase).toBe('ended')
    expect(useSessionStore.getState().errorMessage).toMatch(/3 MiB/)
    // ...and the item the session never got to is still queued, announced by nobody.
    expect(takeQueuedLibrarySends().map((item) => item.id)).toEqual([survivor.id])
    expect(framesOf(devices.hostReceived, 'item-announce')).toEqual([])
    expect(framesOf(devices.hostReceived, 'text-delta')).toEqual([])
  })

  it('reports only the items that arrived as received (PLAN.md §8 Phase 4)', async () => {
    const devices = await pairDevicesAsReceiver()
    await activateReceiverPairing(devices)

    // This device creates one item of its own, so the board carries both origins.
    const mine = session().addTextItem('mine')

    const theirs = crypto.randomUUID()
    devices.guest.send({ t: 'item-announce', id: theirs, type: 'text' })
    devices.guest.send({ t: 'text-delta', id: theirs, content: 'theirs' })
    await devices.guest.drain()
    await waitFor(() => useSessionStore.getState().items.length === 2, 'both items')

    expect(session().receivedItems.map((item) => item.id)).toEqual([theirs])
    expect(session().receivedItems.map((item) => item.id)).not.toContain(mine)
  })
})

// ---------------------------------------------------------------------------
// Page teardown (PLAN.md §16 Phase 8, §17)
// ---------------------------------------------------------------------------

/**
 * The `beforeunload` path, at the level where the frame is real.
 *
 * `pages/Session.tsx` owns the listener and decides when it exists; these cases pin
 * what the hook does when it is asked: the peer is told the session is over, the
 * session itself is left running (the tab is what is going away, not the transport,
 * which is what still has to carry the frame), and nothing is sent once the session
 * has ended.
 */
describe('useSession unload notification (PLAN.md §16 Phase 8)', () => {
  it('puts session-end on the wire and leaves the session running', async () => {
    const devices = await pairDevices()

    session().notifyUnload()

    await waitFor(
      () => framesOf(devices.hostReceived, 'session-end').length === 1,
      'the session-end frame',
    )
    expect(framesOf(devices.hostReceived, 'session-end')).toEqual([{ t: 'session-end' }])
    // Deliberately NOT abort(): the session is still up and the peer is not cut off.
    expect(useSessionStore.getState().phase).toBe('pairing')
    expect(useSessionStore.getState().errorMessage).toBe(null)
    expect(devices.guestChannel.closed).toBe(false)
  })

  it('sends from an active session as well', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)

    session().notifyUnload()

    await waitFor(
      () => framesOf(devices.hostReceived, 'session-end').length === 1,
      'the session-end frame',
    )
  })

  it('sends nothing once the session has ended, even with the channel still open', async () => {
    const devices = await pairDevices()

    // A clean end that leaves the channel up: exactly the state a second unload would
    // find if the page did not stop listening on the phase change.
    useSessionStore.getState().endSession(null)
    session().notifyUnload()
    await settle()

    expect(framesOf(devices.hostReceived, 'session-end')).toEqual([])
    expect(devices.guestChannel.closed).toBe(false)
  })

  it('reports a transport that fails mid-session instead of staying “Connected”', async () => {
    const devices = await pairDevices()
    await activatePairing(devices)
    expect(session().status).toEqual({ label: 'Connected', tone: 'ok' })

    // A dead peer connection during an active session is the one state in which
    // 'Connected' would make a user wait for a transfer that can never arrive.
    useSessionStore.getState().setConnectionState('failed')
    await waitFor(() => session().status.tone === 'error', 'the failed status')
    expect(session().status).toEqual({ label: 'Connection failed', tone: 'error' })

    useSessionStore.getState().setConnectionState('disconnected')
    await waitFor(() => session().status.tone === 'warn', 'the disconnected status')
    expect(session().status).toEqual({ label: 'Connection lost', tone: 'warn' })
  })
})

describe('useSession never touches IndexedDB (AGENTS.md, PLAN.md §1/§17)', () => {
  it('writes nothing during a whole session that never saves — queue included', async () => {
    // fake-indexeddb's own classes, so these spies see the real call sites the library
    // layer would use. Nothing in the session path may reach them.
    const writes = [
      vi.spyOn(IDBObjectStore.prototype, 'add'),
      vi.spyOn(IDBObjectStore.prototype, 'put'),
      vi.spyOn(IDBObjectStore.prototype, 'delete'),
      vi.spyOn(IDBObjectStore.prototype, 'clear'),
      vi.spyOn(IDBFactory.prototype, 'open'),
    ]

    const devices = await pairDevices()
    await activatePairing(devices)

    // Every kind of session traffic: a composed text item, a chunked file, a locked item
    // composed here (PBKDF2 + AES-GCM), a library item sent by hand, and one that came
    // from the Home screen's queue.
    const textId = session().addTextItem('typed here')
    session().updateTextItem(textId, 'typed here and edited')
    session().addFileItem(new File([patternedBytes(20 * 1024)], 'notes.bin'))
    await session().addLockedItem({
      label: 'Uni portal password',
      innerType: 'text',
      password: 'hunter2',
      content: 'the secret',
    })
    session().sendLibraryItem(libraryTextItem('from the library', 'Library note'))
    queueLibrarySends([libraryTextItem('queued', 'Queued note')])
    useSessionStore.getState().setPhase('pairing')
    useSessionStore.getState().setPhase('active')

    await waitFor(() => framesOf(devices.hostReceived, 'file-done').length === 1, 'the file')
    await waitFor(() => framesOf(devices.hostReceived, 'locked-payload').length === 1, 'the locked item')
    await waitFor(() => framesOf(devices.hostReceived, 'text-delta').length >= 2, 'the deltas')
    await settle()

    // Keys, phrases, items, the queue — all of it stayed in memory.
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled()
    }
  })
})

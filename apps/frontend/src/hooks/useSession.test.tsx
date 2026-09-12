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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { exportPublicKey, generateKeypair, toBase64 } from '../lib/crypto'
import { PeerConnection } from '../lib/webrtc'
import type { Frame } from '../lib/webrtc'
import { useSessionStore } from '../store/sessionStore'
import { PEER_REJOINED_REASON, deriveSessionMaterial, useSession } from './useSession'
import type { UseSessionResult } from './useSession'

const SESSION_CODE = 'A7X3K9P2'

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
  readonly createdChannels: FakeDataChannel[] = []
  readonly receivedChannels: FakeDataChannel[] = []

  onDataChannelCreated: ((channel: FakeDataChannel) => void) | null = null

  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  closed = false

  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null
  onconnectionstatechange: ((event: Event) => void) | null = null

  constructor() {
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
  hostReceived: Frame[]
}

/**
 * Brings a real pairing up: the guest hook joins with a real public key, the host
 * derives from it, the offer/answer crosses, both channels open, and the guest's
 * encrypted greeting is read by the host.
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

  const hostReceived: Frame[] = []
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

  // Proves the whole chain at once: the guest's channel opened, its session key was
  // installed, its greeting was encrypted and the host authenticated and decrypted it.
  await waitFor(
    () => hostReceived.some((message) => message.t === 'hello'),
    'the encrypted guest greeting',
  )

  return { guestSocket, guestChannel, host, hostChannel, hostMaterial, hostReceived }
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
  ;(globalThis as unknown as Record<string, unknown>)['fetch'] = async (): Promise<unknown> => ({
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => ({ code: SESSION_CODE }),
  })

  useSessionStore.getState().reset()
})

afterEach(() => {
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
    const { hostMaterial, hostReceived, host } = await pairDevices()

    const state = useSessionStore.getState()
    expect(state.phase).toBe('pairing')
    expect(state.safetyPhrase).toEqual(hostMaterial.phrase)
    expect(state.phraseConfirmed).toBe(false)
    expect(state.peerConfirmed).toBe(false)

    // The greeting crossed in both directions as an encrypted frame.
    expect(hostReceived).toContainEqual({
      t: 'hello',
      from: 'guest',
      text: 'Hello from the guest device',
    })

    host.send({ t: 'hello', from: 'host', text: 'Hello from the host device' })
    await host.drain()
    await waitFor(
      () => session().peerHello === 'Hello from the host device',
      'the decrypted host greeting',
    )
  })

  it('never lets a plaintext frame reach the channel', async () => {
    const { guestChannel, hostChannel } = await pairDevices()

    const wire = [...guestChannel.sent, ...hostChannel.sent]
    expect(wire.length).toBeGreaterThan(0)
    for (const frame of wire) {
      expect(frame).toBeInstanceOf(ArrayBuffer)
      const text = new TextDecoder().decode(new Uint8Array(frame as ArrayBuffer))
      expect(text).not.toContain('hello')
      expect(text).not.toContain('"t"')
      expect(text).not.toContain('Hello from the guest')
    }
  })

  it('stays in pairing until BOTH devices have confirmed', async () => {
    const { host, hostReceived } = await pairDevices()

    // This device confirms first: still not active, and the confirm goes out.
    session().confirmPhrase()
    await waitFor(() => useSessionStore.getState().phraseConfirmed, 'the local confirmation')
    await settle()
    expect(useSessionStore.getState().phase).toBe('pairing')

    // The peer confirms: only now may the session start (PLAN.md §8 Phase 3).
    host.send({ t: 'phrase-confirm' })
    await host.drain()
    await settle()
    await waitFor(() => useSessionStore.getState().peerConfirmed, 'the peer confirmation')
    await waitFor(() => useSessionStore.getState().phase === 'active', 'the active phase')

    // The guest's own confirm crossed as an encrypted, authenticated frame.
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
    expect(state.bothConfirmed()).toBe(false)
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

/**
 * WebRTC peer connection over a single DataChannel (PLAN.md §12).
 *
 * Host = the device whose QR code was scanned; it creates the offer and the
 * DataChannel. Guest = the device that scanned; it answers and receives the
 * channel. Both sides then exchange messages symmetrically.
 *
 * PHASE 2 SCOPE: every frame crossing the channel is an AES-256-GCM envelope
 * (`[iv: 12 bytes][ciphertext + GCM tag]`, PLAN.md §10) produced by the session
 * key from `lib/crypto.ts`. No plaintext application data can reach the channel:
 * `send()` refuses to run until `setSessionKey()` has been called, and the
 * DataChannel only ever carries binary envelopes.
 */

import { decrypt, encrypt } from './crypto'
import type { SessionRole } from './signaling'

/**
 * The liveness greeting both devices exchange once the channel is up. It is the
 * Phase 1 "channel check" (PLAN.md §16) and still the simplest proof that the
 * encrypted bidirectional path works.
 */
export type HelloMessage = { t: 'hello'; from: SessionRole; text: string }

/**
 * Sent by both devices when the user accepts the safety phrase (PLAN.md §10).
 *
 * It carries no payload on purpose: its only meaning is "this human compared the
 * three words and they matched", and it is authenticated by the session key, so
 * an off-path attacker cannot forge it.
 */
export type PhraseConfirmMessage = { t: 'phrase-confirm' }

/** A device leaving the session deliberately (the overlay's Abort button). */
export type SessionEndMessage = { t: 'session-end' }

/**
 * The Phase 2 wire payload.
 *
 * PHASE 3 SEAM: PLAN.md §16 replaces this union wholesale with the full
 * `protocol.ts` `WireMessage` set (items, chunks, deltas) and swaps the JSON
 * serialisation inside `encodeFrame` / `decodeFrame` for MessagePack. Both the
 * union and the serialisation live behind those two functions, so call sites
 * (`send` / `onMessage`) do not change when that happens. Phase 3 must also send
 * item frames only while the session is 'active': PLAN.md §8 holds the session in
 * 'pairing' until both devices confirm the safety phrase, and the union here is
 * deliberately too small to carry an item before that.
 */
export type Frame = HelloMessage | PhraseConfirmMessage | SessionEndMessage

export interface PeerConnectionOptions {
  /** Short-lived TURN credential issued by the signaling worker (PLAN.md §13). */
  turnUsername?: string
  turnCredential?: string
}

/** DataChannel label for the main control/data channel. */
export const DATA_CHANNEL_LABEL = 'qrdrop-main'

const STUN_SERVERS: readonly RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]

/**
 * TURN fallback endpoints from PLAN.md §12.
 *
 * TODO (Phase 7): PLAN.md §17 requires TURN over TCP 443 for hostile/DPI
 * networks. The spec annotates `turns:turn.cloudflare.com:5349` as "TCP 443", but
 * 5349 is the conventional TURNS port. Phase 7 must confirm the real endpoint
 * and likely add `turns:turn.cloudflare.com:443?transport=tcp`. Tracked in
 * TODO.md.
 */
const TURN_URLS: readonly string[] = [
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turns:turn.cloudflare.com:5349',
]

/**
 * Builds the ICE server list (PLAN.md §12).
 *
 * When the worker has not issued TURN credentials, this returns STUN only.
 * Advertising a TURN server with empty credentials is worse than omitting it:
 * some browsers reject the whole configuration, which would break NAT
 * traversal entirely rather than just losing the relay fallback.
 */
export function buildIceServers(options: PeerConnectionOptions = {}): RTCIceServer[] {
  const { turnUsername, turnCredential } = options
  if (!turnUsername || !turnCredential) {
    return STUN_SERVERS.map((server) => ({ ...server }))
  }
  return [
    ...STUN_SERVERS.map((server) => ({ ...server })),
    { urls: [...TURN_URLS], username: turnUsername, credential: turnCredential },
  ]
}

/**
 * PHASE 2 SEAM — outbound (PLAN.md §10, §11.3).
 *
 * Every outbound frame passes through here. The payload is JSON-encoded (Phase 3
 * swaps that for MessagePack), encrypted with the session key, and returned as
 * the `[iv: 12 bytes][ciphertext + GCM tag]` envelope that `send()` hands to the
 * DataChannel as a binary frame.
 *
 * The caller must never fall back to sending the JSON bytes when encryption is
 * unavailable: `PeerConnection.send()` throws instead, so plaintext application
 * data cannot reach the wire.
 */
export async function encodeFrame(message: Frame, sessionKey: CryptoKey): Promise<ArrayBuffer> {
  const plaintext = new TextEncoder().encode(JSON.stringify(message))
  return encrypt(sessionKey, plaintext)
}

/**
 * PHASE 2 SEAM — inbound.
 *
 * Reverses `encodeFrame`: authenticates and decrypts the envelope, then parses
 * the JSON payload. Throws on anything it cannot decrypt or decode, including
 * the GCM authentication failure of a wrong key or a tampered frame; callers
 * must treat a throw as "drop this frame" (PLAN.md §17). Because the throw can
 * happen after the tag check only, no partial plaintext is ever produced.
 */
export async function decodeFrame(raw: unknown, sessionKey: CryptoKey): Promise<Frame> {
  if (!(raw instanceof ArrayBuffer)) {
    // The channel is configured for `arraybuffer` (see attachDataChannel), so
    // anything else is either a protocol violation or a Phase 1 text frame.
    throw new Error('webrtc: expected a binary encrypted envelope')
  }

  const plaintext = await decrypt(sessionKey, raw)
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext))

  if (!isFrame(parsed)) {
    throw new Error('webrtc: decrypted frame is not a Phase 2 Frame')
  }
  return parsed
}

/** Validates a decrypted payload as one of the Phase 2 frames. */
export function isFrame(value: unknown): value is Frame {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>

  switch (record['t']) {
    case 'hello':
      return (
        (record['from'] === 'host' || record['from'] === 'guest') &&
        typeof record['text'] === 'string'
      )
    case 'phrase-confirm':
    case 'session-end':
      return true
    default:
      return false
  }
}

/**
 * PLAN.md §17: a frame whose GCM tag does not verify is dropped, and the drop is
 * noted in development only. The frame, the key and any plaintext are never
 * logged — not even in development.
 */
function noteDroppedFrame(): void {
  if (import.meta.env.DEV) {
    console.warn('webrtc: dropped an inbound frame that failed to decrypt')
  }
}

/**
 * Buffers ICE candidates that arrive before the remote description is set.
 *
 * `addIceCandidate()` rejects with InvalidStateError in that window, and because
 * the two peers exchange offers, answers and candidates concurrently over one
 * signaling socket, candidates routinely arrive first. This is the normal case,
 * not an edge case, so they are queued and flushed once the remote description
 * lands.
 */
export class PendingIceCandidates {
  private queue: RTCIceCandidateInit[] = []

  push(candidate: RTCIceCandidateInit): void {
    this.queue.push(candidate)
  }

  get size(): number {
    return this.queue.length
  }

  /** Returns the queued candidates in arrival order and empties the buffer. */
  drain(): RTCIceCandidateInit[] {
    return this.queue.splice(0, this.queue.length)
  }

  clear(): void {
    this.queue.length = 0
  }
}

export class PeerConnection {
  private readonly peer: RTCPeerConnection
  private dataChannel: RTCDataChannel | null = null
  private readonly pendingCandidates = new PendingIceCandidates()
  private remoteDescriptionSet = false
  private channelOpen = false
  private closed = false

  /**
   * The AES-GCM session key (PLAN.md §11.2). Null until the ECDH exchange has
   * completed, which is what keeps plaintext off the wire: `send()` refuses to
   * queue anything while it is null.
   */
  private sessionKey: CryptoKey | null = null

  /**
   * Outbound frames, strictly ordered. `send()` keeps its synchronous `void`
   * signature (ORCHESTRATION.md D3) while AES-GCM is asynchronous, so the
   * enqueue is synchronous and only the encrypt+write is deferred. Each link
   * swallows its own failure after reporting it, so the chain never rejects and
   * one bad frame cannot stall the frames behind it.
   */
  private outbound: Promise<void> = Promise.resolve()

  /**
   * Inbound frames, strictly ordered for the same reason `outbound` exists:
   * decryption is asynchronous, so handling two frames concurrently would let a
   * slow decrypt of frame 1 land after frame 2.
   */
  private inbound: Promise<void> = Promise.resolve()

  private readonly iceCandidateHandlers = new Set<(candidate: RTCIceCandidateInit) => void>()
  private readonly dataChannelOpenHandlers = new Set<() => void>()
  private readonly messageHandlers = new Set<(message: Frame) => void>()
  private readonly stateChangeHandlers = new Set<(state: RTCPeerConnectionState) => void>()
  private readonly sendErrorHandlers = new Set<(error: unknown) => void>()

  constructor(options: PeerConnectionOptions = {}) {
    this.peer = new RTCPeerConnection({
      iceServers: buildIceServers(options),
      // PLAN.md §17: try a direct path first, fall back to TURN automatically.
      iceTransportPolicy: 'all',
    })

    this.peer.onicecandidate = (event: RTCPeerConnectionIceEvent): void => {
      if (event.candidate) {
        this.emitIceCandidate(event.candidate.toJSON())
      }
    }

    this.peer.ondatachannel = (event: RTCDataChannelEvent): void => {
      this.attachDataChannel(event.channel)
    }

    this.peer.onconnectionstatechange = (): void => {
      this.emitStateChange(this.peer.connectionState)
    }
  }

  /**
   * Installs the session key derived from the ECDH shared secret (PLAN.md §11.2).
   *
   * Until this is called, `send()` throws and inbound frames are dropped: there
   * is no key to encrypt or authenticate with, and sending the payload in the
   * clear is never an acceptable fallback.
   */
  setSessionKey(key: CryptoKey): void {
    this.sessionKey = key
  }

  /** Whether application frames can be encrypted and decrypted yet. */
  get hasSessionKey(): boolean {
    return this.sessionKey !== null
  }

  /**
   * Resolves once every frame accepted by `send()` has been written to the
   * channel (or dropped after a teardown).
   *
   * Never rejects: the outbound chain reports failures through `onSendError`
   * instead, so awaiting this can be done from a `void` context without risking
   * an unhandled rejection.
   */
  drain(): Promise<void> {
    return this.outbound
  }

  /**
   * Host side: creates the DataChannel and the offer.
   *
   * Returns the offer to relay over signaling. Trickle ICE is in use, so the
   * initial offer is sufficient — candidates follow as separate messages.
   */
  async initAsHost(): Promise<RTCSessionDescriptionInit> {
    const channel = this.peer.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true })
    this.attachDataChannel(channel)

    const offer = await this.peer.createOffer()
    await this.peer.setLocalDescription(offer)
    return offer
  }

  /** Host side: applies the guest's answer, then flushes buffered candidates. */
  async receiveAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.peer.setRemoteDescription(answer)
    this.remoteDescriptionSet = true
    await this.flushPendingCandidates()
  }

  /** Guest side: applies the offer, produces the answer. */
  async receiveOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.peer.setRemoteDescription(offer)
    this.remoteDescriptionSet = true
    await this.flushPendingCandidates()

    const answer = await this.peer.createAnswer()
    await this.peer.setLocalDescription(answer)
    return answer
  }

  /** Buffers the candidate if the remote description is not set yet. */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate)
      return
    }
    await this.peer.addIceCandidate(candidate)
  }

  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): () => void {
    this.iceCandidateHandlers.add(handler)
    return () => {
      this.iceCandidateHandlers.delete(handler)
    }
  }

  onDataChannelOpen(handler: () => void): () => void {
    // The channel can open before a handler subscribes (the guest learns of it
    // via ondatachannel, and React registers effects afterwards). Without this
    // replay the "open" edge would be lost and the session would never start.
    if (this.channelOpen) {
      let cancelled = false
      queueMicrotask(() => {
        if (cancelled || this.closed) return
        // Same guard as every live emit path: a throwing subscriber must not
        // surface as an uncaught microtask exception.
        this.invokeSafely(handler)
      })
      return () => {
        cancelled = true
      }
    }
    this.dataChannelOpenHandlers.add(handler)
    return () => {
      this.dataChannelOpenHandlers.delete(handler)
    }
  }

  onMessage(handler: (message: Frame) => void): () => void {
    this.messageHandlers.add(handler)
    return () => {
      this.messageHandlers.delete(handler)
    }
  }

  onStateChange(handler: (state: RTCPeerConnectionState) => void): () => void {
    this.stateChangeHandlers.add(handler)
    return () => {
      this.stateChangeHandlers.delete(handler)
    }
  }

  /**
   * Reports a frame that failed after `send()` returned.
   *
   * Encryption and the channel write are asynchronous, so they cannot throw at
   * the caller (ORCHESTRATION.md D3). Without this channel those failures would
   * vanish, which is why callers are expected to subscribe and end the session
   * with a real message rather than leaving the user on a silent spinner.
   */
  onSendError(handler: (error: unknown) => void): () => void {
    this.sendErrorHandlers.add(handler)
    return () => {
      this.sendErrorHandlers.delete(handler)
    }
  }

  /**
   * Encrypts and sends a frame (PLAN.md §10).
   *
   * The guards are deliberately synchronous: a caller that sends before the
   * channel is open, or before the session key exists, gets an immediate throw
   * instead of a frame that silently disappears — or worse, goes out in
   * plaintext. Only the encryption and the write are deferred to the internal
   * queue, which keeps `void` (ORCHESTRATION.md D3) while preserving send order.
   */
  send(message: Frame): void {
    const channel = this.dataChannel
    if (!channel || channel.readyState !== 'open') {
      throw new Error('webrtc: data channel is not open')
    }
    const key = this.sessionKey
    if (!key) {
      throw new Error('webrtc: session key is not ready — refusing to send an unencrypted frame')
    }

    this.outbound = this.outbound.then(async (): Promise<void> => {
      try {
        const frame = await encodeFrame(message, key)
        // Teardown can win the race against the encryption; there is nothing
        // left to send and nothing to report in that case.
        if (this.closed) return

        const current = this.dataChannel
        if (!current || current.readyState !== 'open') {
          throw new Error('webrtc: data channel closed before the encrypted frame could be sent')
        }
        current.send(frame)
      } catch (error) {
        this.emitSendError(error)
      }
    })
  }

  /**
   * Tears everything down. Idempotent, never throws, and removes every listener
   * so a late event cannot fire into a torn-down component. The session key is
   * dropped here too: it is only ever held in memory for the life of the peer.
   */
  close(): void {
    if (this.closed) return
    this.closed = true

    this.pendingCandidates.clear()
    this.channelOpen = false
    this.sessionKey = null

    this.iceCandidateHandlers.clear()
    this.dataChannelOpenHandlers.clear()
    this.messageHandlers.clear()
    this.stateChangeHandlers.clear()
    this.sendErrorHandlers.clear()

    const channel = this.dataChannel
    this.dataChannel = null
    if (channel) {
      channel.onopen = null
      channel.onmessage = null
      channel.onerror = null
      channel.onclose = null
      try {
        channel.close()
      } catch {
        // Already closed.
      }
    }

    try {
      this.peer.onicecandidate = null
      this.peer.ondatachannel = null
      this.peer.onconnectionstatechange = null
      this.peer.close()
    } catch {
      // Already closed.
    }
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel
    channel.binaryType = 'arraybuffer'

    channel.onopen = (): void => {
      this.channelOpen = true
      for (const handler of [...this.dataChannelOpenHandlers]) {
        this.invokeSafely(handler)
      }
    }

    channel.onmessage = (event: MessageEvent): void => {
      this.handleInbound(event.data)
    }

    channel.onerror = (): void => {
      // Fail-safe by design (PLAN.md §17): a dropped frame must never crash the
      // session, and nothing about the frame may be logged in production.
    }

    channel.onclose = (): void => {
      this.channelOpen = false
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates.drain()) {
      try {
        await this.peer.addIceCandidate(candidate)
      } catch {
        // Drop it and keep going. ICE routinely produces candidates that a peer
        // cannot use, and aborting the flush would discard the usable ones.
      }
    }
  }

  /**
   * Decrypts an inbound frame and hands it to the subscribers, strictly in
   * arrival order (a queue, not `void decodeFrame(...), so a slow decrypt cannot
   * let a later frame overtake an earlier one).
   */
  private handleInbound(raw: unknown): void {
    const key = this.sessionKey
    if (!key || this.closed) {
      // No key yet, or the peer is gone. Either way this cannot be a legitimate
      // frame: an encrypted envelope is unreadable without the session key, so
      // it is dropped rather than guessed at.
      return
    }

    this.enqueueInbound(async (): Promise<void> => {
      let message: Frame
      try {
        message = await decodeFrame(raw, key)
      } catch {
        // PLAN.md §17: a frame that fails its AES-GCM authentication tag (or
        // cannot be decoded at all) is dropped silently. Partial plaintext never
        // reaches a handler, and nothing is thrown out of the channel callback.
        noteDroppedFrame()
        return
      }

      if (this.closed) return
      for (const handler of [...this.messageHandlers]) {
        this.invokeSafely(() => {
          handler(message)
        })
      }
    })
  }

  /**
   * Appends a task to the inbound chain. Like `send()`'s chain, the link absorbs
   * its own failure: nothing awaits this promise, so an escaping rejection would
   * surface as an unhandled rejection in the browser (and would stall the frames
   * queued behind it). A frame that cannot be handled is dropped instead.
   */
  private enqueueInbound(task: () => Promise<void>): void {
    this.inbound = this.inbound.then(async (): Promise<void> => {
      try {
        await task()
      } catch {
        noteDroppedFrame()
      }
    })
  }

  private invokeSafely(action: () => void): void {
    try {
      action()
    } catch {
      // A misbehaving subscriber must not break delivery to the others.
    }
  }

  private emitIceCandidate(candidate: RTCIceCandidateInit): void {
    for (const handler of [...this.iceCandidateHandlers]) {
      this.invokeSafely(() => {
        handler(candidate)
      })
    }
  }

  private emitStateChange(state: RTCPeerConnectionState): void {
    for (const handler of [...this.stateChangeHandlers]) {
      this.invokeSafely(() => {
        handler(state)
      })
    }
  }

  private emitSendError(error: unknown): void {
    for (const handler of [...this.sendErrorHandlers]) {
      this.invokeSafely(() => {
        handler(error)
      })
    }
  }
}

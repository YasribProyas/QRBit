/**
 * WebRTC peer connection over a single DataChannel (PLAN.md §12).
 *
 * Host = the device whose QR code was scanned; it creates the offer and the
 * DataChannel. Guest = the device that scanned; it answers and receives the
 * channel. Both sides then exchange messages symmetrically.
 *
 * PHASE 1 SCOPE: frames are plain JSON. Encryption is Phase 2 — see the
 * encode/decode seam below.
 */

import type { SessionRole } from './signaling'

/**
 * The Phase 1 wire payload.
 *
 * Phase 3 widens this to the full `protocol.ts` `WireMessage` union; `send()`
 * and `onMessage()` are intentionally shaped so that swap needs no call-site
 * changes here.
 */
export type HelloMessage = { t: 'hello'; from: SessionRole; text: string }

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
 * PHASE 2 SEAM — outbound.
 *
 * Every outbound frame passes through here, and every inbound frame through
 * `decodeFrame()`, so Phase 2 inserts AES-256-GCM in exactly these two places
 * and no call site changes.
 *
 * Phase 2 will replace the body with the PLAN.md §10 envelope
 * (`[iv: 12 bytes][ciphertext + GCM tag]`) as an ArrayBuffer, encrypted under
 * the ECDH/HKDF-derived session key. That makes the seam asynchronous; `send()`
 * will then serialise through an internal promise queue so its `void` signature
 * is preserved.
 */
export function encodeFrame(message: HelloMessage): string {
  return JSON.stringify(message)
}

/**
 * PHASE 2 SEAM — inbound.
 *
 * Throws on anything it cannot decode. Callers must treat a throw as "drop this
 * frame": PLAN.md §17 requires that an authentication failure never crash the
 * app and never surface partial plaintext.
 */
export function decodeFrame(raw: unknown): HelloMessage {
  if (typeof raw !== 'string') {
    throw new Error('webrtc: expected a text frame')
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isHelloMessage(parsed)) {
    throw new Error('webrtc: frame is not a HelloMessage')
  }
  return parsed
}

export function isHelloMessage(value: unknown): value is HelloMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record['t'] === 'hello' &&
    (record['from'] === 'host' || record['from'] === 'guest') &&
    typeof record['text'] === 'string'
  )
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

  private readonly iceCandidateHandlers = new Set<(candidate: RTCIceCandidateInit) => void>()
  private readonly dataChannelOpenHandlers = new Set<() => void>()
  private readonly messageHandlers = new Set<(message: HelloMessage) => void>()
  private readonly stateChangeHandlers = new Set<(state: RTCPeerConnectionState) => void>()

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

  onMessage(handler: (message: HelloMessage) => void): () => void {
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
   * Sends a message. Throws if the DataChannel is not open — callers send only
   * after `onDataChannelOpen`, so a throw here means a lifecycle bug rather than
   * something worth queueing silently.
   */
  send(message: HelloMessage): void {
    const channel = this.dataChannel
    if (!channel || channel.readyState !== 'open') {
      throw new Error('webrtc: data channel is not open')
    }
    channel.send(encodeFrame(message))
  }

  /**
   * Tears everything down. Idempotent, never throws, and removes every listener
   * so a late event cannot fire into a torn-down component.
   */
  close(): void {
    if (this.closed) return
    this.closed = true

    this.pendingCandidates.clear()
    this.channelOpen = false

    this.iceCandidateHandlers.clear()
    this.dataChannelOpenHandlers.clear()
    this.messageHandlers.clear()
    this.stateChangeHandlers.clear()

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

  private handleInbound(raw: unknown): void {
    let message: HelloMessage
    try {
      message = decodeFrame(raw)
    } catch {
      // PLAN.md §17: a frame that fails to decode (or, from Phase 2, fails its
      // AES-GCM authentication tag) is dropped silently. Partial plaintext must
      // never reach a handler.
      return
    }

    for (const handler of [...this.messageHandlers]) {
      this.invokeSafely(() => {
        handler(message)
      })
    }
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
}

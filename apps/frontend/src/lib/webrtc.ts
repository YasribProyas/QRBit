/**
 * WebRTC peer connection over a single DataChannel (PLAN.md §10, §12).
 *
 * Host = the device whose QR code was scanned; it creates the offer and the
 * DataChannel. Guest = the device that scanned; it answers and receives the
 * channel. Both sides then exchange messages symmetrically.
 *
 * Every frame crossing the channel is the PLAN.md §10 `WireMessage` set from
 * `lib/protocol.ts`, MessagePack-encoded and then wrapped in an AES-256-GCM
 * envelope (`[iv: 12 bytes][ciphertext + GCM tag]`) produced by the session key
 * from `lib/crypto.ts`. No plaintext application data can reach the channel:
 * `send()` refuses to run until `setSessionKey()` has been called, and the
 * DataChannel only ever carries binary envelopes.
 *
 * Item traffic is gated a second time: every item-bearing frame is rejected until
 * `markActive()` runs, which `useSession` does once both devices have confirmed
 * the safety phrase (PLAN.md §8). That gate lives here, in the single `send()`
 * path — call sites do not repeat it, so a new call site cannot forget it.
 *
 * The Phase 1 `hello` greeting is RETIRED (PLAN.md §16 Phase 3): the encrypted
 * both-sides `phrase-confirm` already proves the channel in both directions, so a
 * separate liveness frame would prove nothing new about it.
 */

import { decrypt, encrypt } from './crypto'
import { decodeWire, encodeWire } from './protocol'
import type { WireMessage } from './protocol'

/**
 * The only frames that may cross the channel *before* the session is active: the
 * two control messages. Everything else carries session items and is gated.
 *
 * Written as an allow-list rather than a list of item kinds on purpose: a message
 * kind added by a later phase is item-bearing until it is explicitly classified
 * as control here, so forgetting to update this cannot open the gate.
 */
const CONTROL_MESSAGE_TYPES = new Set<WireMessage['t']>(['phrase-confirm', 'session-end'])

/**
 * Whether a frame carries session items (PLAN.md §8/§9) rather than the two control
 * frames that may always cross.
 *
 * Exported so the receive-side gate in `useSession` classifies frames exactly as the
 * send gate below does: one spelling of "this frame carries items", so a message kind
 * added by a later phase cannot be gated on one direction and not the other.
 */
export function isItemMessage(message: WireMessage): boolean {
  return !CONTROL_MESSAGE_TYPES.has(message.t)
}

/**
 * How many bytes a file pump may leave queued in the DataChannel before it waits
 * for the channel to drain (PLAN.md §9: "a large file in-flight does not block
 * text items added after it").
 *
 * 256 KiB was chosen as the threshold: it is small enough that a text-delta never
 * sits behind more than a fraction of a second of a relayed transfer (16 KiB
 * chunks), and large enough that the pump is not woken for every chunk. Without
 * it, enqueueing a whole file's chunks at once would put a `text-delta` behind up
 * to 65k frames on a 1 GiB transfer.
 */
export const FILE_PUMP_BUFFER_THRESHOLD = 256 * 1024

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
 * The single outbound seam (PLAN.md §10, §11.3).
 *
 * Every outbound frame passes through here. The message is MessagePack-encoded by
 * `protocol.ts` and encrypted with the session key, and the result is the
 * `[iv: 12 bytes][ciphertext + GCM tag]` envelope that the DataChannel carries as
 * a binary frame.
 *
 * A caller must never fall back to sending the encoded bytes when encryption is
 * unavailable: `PeerConnection.send()` throws instead, so plaintext application
 * data cannot reach the wire.
 */
export async function encodeFrame(message: WireMessage, sessionKey: CryptoKey): Promise<ArrayBuffer> {
  return encrypt(sessionKey, encodeWire(message))
}

/**
 * The single inbound seam.
 *
 * Reverses `encodeFrame`: authenticates and decrypts the envelope, then the
 * MessagePack payload is validated by `protocol.ts`. Throws on anything it cannot
 * decrypt or decode, including the GCM authentication failure of a wrong key or a
 * tampered frame; callers must treat a throw as "drop this frame" (PLAN.md §17).
 * Because the payload is parsed only after the tag check has passed, no partial
 * plaintext is ever produced.
 */
export async function decodeFrame(raw: unknown, sessionKey: CryptoKey): Promise<WireMessage> {
  if (!(raw instanceof ArrayBuffer)) {
    // The channel is configured for `arraybuffer` (see attachDataChannel), so
    // anything else is a protocol violation.
    throw new Error('webrtc: expected a binary encrypted envelope')
  }

  const plaintext = await decrypt(sessionKey, raw)
  return decodeWire(plaintext)
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
   * Whether the session has been explicitly marked active (PLAN.md §8: both
   * devices confirmed the safety phrase). Item-bearing frames are refused until
   * this is true — see `send()`. Reset by `close()`: a torn-down peer must never be
   * able to carry items into a new attempt.
   */
  private active = false

  /**
   * Pumps parked on `waitForBackpressure()` (one per in-flight file). Resolved by
   * the channel's `bufferedamountlow` event, or by teardown — a promise that can
   * never settle would leave a pump's `await` hanging for the life of the tab.
   */
  private readonly backpressureWaiters = new Set<() => void>()

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
  private readonly messageHandlers = new Set<(message: WireMessage) => void>()
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
   * Opens the item gate (PLAN.md §8). Called once, by `useSession`, when both
   * devices have confirmed the safety phrase.
   *
   * Deliberately one-way and explicit: there is no timeout, no implicit "the peer
   * confirmed" path, and no way for a call site to send around it, because the
   * gate is enforced in `send()` itself.
   */
  markActive(): void {
    this.active = true
  }

  /** Whether item-bearing frames may be sent yet. */
  get isActive(): boolean {
    return this.active
  }

  /**
   * How many bytes the DataChannel still has queued. Always a number: a channel
   * that is gone (or a test double without the property) reads as zero rather than
   * `undefined`, which would make a pump wait for an event that never comes.
   */
  get bufferedAmount(): number {
    const amount = this.dataChannel?.bufferedAmount
    return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
  }

  /**
   * Resolves when the channel's queue has fallen back to
   * `FILE_PUMP_BUFFER_THRESHOLD` or below (PLAN.md §9).
   *
   * Resolves immediately when there is no usable channel, so a torn-down session
   * cannot park a pump forever on an event that will never fire again.
   */
  waitForBackpressure(): Promise<void> {
    const channel = this.dataChannel
    if (this.closed || !channel || channel.readyState !== 'open') {
      return Promise.resolve()
    }
    if (this.bufferedAmount <= FILE_PUMP_BUFFER_THRESHOLD) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const settle = (): void => {
        this.backpressureWaiters.delete(settle)
        resolve()
      }
      this.backpressureWaiters.add(settle)
    })
  }

  /**
   * Wakes every pump parked on `waitForBackpressure()`.
   *
   * `close()` already does this, but not every teardown is a close: when the peer
   * ends the session the pumps are cancelled while the channel is still open, and a
   * pump left parked on an event that will not fire again keeps its closure — and the
   * `File` it holds — alive until the channel closes. `useSession`'s `stopItemWork`
   * calls this so a cancelled pump exits on the next microtask instead.
   */
  releaseBackpressure(): void {
    this.releaseBackpressureWaiters()
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

  onMessage(handler: (message: WireMessage) => void): () => void {
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
   * channel is open, before the session key exists, or before the session has been
   * marked active gets an immediate throw instead of a frame that silently
   * disappears — or worse, goes out in plaintext or before the human compared the
   * safety phrase. Only the encryption and the write are deferred to the internal
   * queue, which keeps `void` (ORCHESTRATION.md D3) while preserving send order.
   */
  send(message: WireMessage): void {
    void this.enqueue(message)
  }

  /**
   * `send()` for a caller that must know when the frame has actually been written:
   * the file pumps (PLAN.md §9), which feed one chunk at a time and must observe
   * the channel between chunks.
   *
   * Same guards, same single ordered queue as `send()` — a pump frame can never
   * overtake an announce or a delta. The returned promise carries the same
   * no-rejection contract as `drain()` (a write that fails is reported through
   * `onSendError`), so a pump awaiting it cannot surface an unhandled rejection.
   */
  sendAwaitable(message: WireMessage): Promise<void> {
    return this.enqueue(message)
  }

  private enqueue(message: WireMessage): Promise<void> {
    const channel = this.dataChannel
    if (!channel || channel.readyState !== 'open') {
      throw new Error('webrtc: data channel is not open')
    }
    const key = this.sessionKey
    if (!key) {
      throw new Error('webrtc: session key is not ready — refusing to send an unencrypted frame')
    }
    if (isItemMessage(message) && !this.active) {
      throw new Error('webrtc: refusing to send an item frame before the channel is marked active')
    }

    const pending = this.outbound.then(async (): Promise<void> => {
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
    this.outbound = pending
    return pending
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
    this.active = false
    this.releaseBackpressureWaiters()

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
      channel.onbufferedamountlow = null
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
    // The pump parks when the queue is above the threshold; the channel reports
    // when it has drained back down to it (PLAN.md §9).
    channel.bufferedAmountLowThreshold = FILE_PUMP_BUFFER_THRESHOLD

    channel.onopen = (): void => {
      this.channelOpen = true
      for (const handler of [...this.dataChannelOpenHandlers]) {
        this.invokeSafely(handler)
      }
    }

    channel.onmessage = (event: MessageEvent): void => {
      this.handleInbound(event.data)
    }

    channel.onbufferedamountlow = (): void => {
      this.releaseBackpressureWaiters()
    }

    channel.onerror = (): void => {
      // Fail-safe by design (PLAN.md §17): a dropped frame must never crash the
      // session, and nothing about the frame may be logged in production.
    }

    channel.onclose = (): void => {
      this.channelOpen = false
      // A closed channel will never report a low buffer again, so any parked pump
      // is woken here; it then sees the session is no longer live and stops.
      this.releaseBackpressureWaiters()
    }
  }

  /**
   * Wakes every pump parked on `waitForBackpressure()`. Called from the channel's
   * `bufferedamountlow` event and from every teardown path.
   */
  private releaseBackpressureWaiters(): void {
    for (const settle of [...this.backpressureWaiters]) {
      settle()
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
      let message: WireMessage
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

/**
 * WebSocket signaling client (PLAN.md §13).
 *
 * The signaling worker brokers the WebRTC handshake only — it never sees item
 * data. This client is deliberately minimal: connect, exchange four message
 * types, then get out of the way.
 *
 * Per PLAN.md §19.10 there is NO reconnect logic. Sessions are single-use; if
 * the socket drops, the caller starts a brand new session. This client is
 * therefore single-use too, and `connect()` may only be called once.
 */

/** Per-session role, assigned by who generated the QR code (PLAN.md §8). */
export type SessionRole = 'host' | 'guest'

/**
 * Signaling messages, per PLAN.md §13.
 *
 * `publicKey` is carried from Phase 1 onward but is an empty string until
 * Phase 2 fills it with the raw P-256 ECDH public key.
 */
export type SignalingMessage =
  | { type: 'join'; role: SessionRole; publicKey: string }
  | { type: 'pubkey'; publicKey: string }
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  | { type: 'paired' }
  | { type: 'error'; message: string }

export interface SignalingCloseInfo {
  code: number
  reason: string
}

/** Returned by every `on*` subscription so React effects can tear down cleanly. */
export type Unsubscribe = () => void

export type SignalingMessageHandler = (message: SignalingMessage) => void
export type SignalingCloseHandler = (info: SignalingCloseInfo) => void
export type SignalingErrorHandler = (error: unknown) => void

export interface SignalingClientOptions {
  /**
   * Overrides the global `WebSocket` constructor.
   *
   * Exists so units tests can drive the client with a fake socket. The default
   * is the real browser/Node `WebSocket`, so production callers pass nothing.
   */
  socketFactory?: (url: string) => WebSocket
}

/** WebSocket.OPEN, as a literal so a fake socket need not carry the static. */
const SOCKET_OPEN = 1

const SIGNALING_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'join',
  'pubkey',
  'offer',
  'answer',
  'ice',
  'paired',
  'error',
])

function hasStringField(value: object, key: string): boolean {
  return typeof (value as Record<string, unknown>)[key] === 'string'
}

function isNonNullObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/**
 * Whether a signaling message is the worker's "a peer has joined" cue.
 *
 * PLAN.md §13 defines no explicit peer-joined frame. `pubkey` is that cue: the
 * Durable Object sends it to an arriving participant whose peer has already
 * attached, and it is the only frame that means "the other role is now here". It
 * carries the peer's real P-256 public key (Phase 2), so reading it as the join
 * signal stays semantically correct.
 */
export function isPeerJoinedCue(
  message: SignalingMessage,
): message is Extract<SignalingMessage, { type: 'pubkey' }> {
  return message.type === 'pubkey'
}

/**
 * Whether the host may open the SDP exchange in response to a message.
 *
 * This is load-bearing. The Durable Object relays SDP only while both roles are
 * connected and rejects an offer sent before the peer has joined with
 * `peer-not-connected`, which ends the session — so the host must not offer until the
 * `pubkey` cue arrives. Guests never offer, and `offerSent` is the once-only guard:
 * the DO can deliver `pubkey` twice (a direct send plus a flushed buffered copy) and a
 * duplicate offer would be relayed after pairing and rejected as `session-done`.
 */
export function shouldHostSendOffer(
  message: SignalingMessage,
  role: SessionRole | null,
  offerSent: boolean,
): boolean {
  return role === 'host' && !offerSent && isPeerJoinedCue(message)
}

/**
 * Whether a peer-joined cue means the other device *re-joined* a code this host
 * has already offered into.
 *
 * Pre-pairing, the Durable Object releases a disconnected role's slot but keeps the
 * code joinable until its TTL (ORCHESTRATION.md D1). A guest that drops out and taps
 * "Try again" therefore re-joins the same code, and the DO sends this host a second
 * cue — but `offerSent` is latched, so no second offer can ever be sent and the
 * handshake can never complete. PLAN.md §19 decision 10 makes sessions single-use and
 * rules out reconnect logic, so the only remaining option is to fail fast (D4)
 * instead of leaving both UIs on "Connecting…" until the 300s TTL closes the sockets.
 *
 * That host also receives a *duplicate* of the very first cue, with no re-join involved:
 * the DO hands the peer's key to the newcomer directly and then flushes the copy it
 * buffered while waiting for that newcomer (`session.ts` `handleJoin`), so whoever joins
 * second sees this cue twice. In Phase 2 the two kinds of cue are still distinguishable,
 * because every attempt generates a fresh ephemeral keypair: a duplicate repeats the key
 * this host has already exchanged with, while a genuine re-join arrives with a new one.
 * So a cue is only a re-join when its `publicKey` differs from `exchangedPeerPublicKey`
 * (ORCHESTRATION.md D5). A `null` there means no exchange has completed yet, which cannot
 * be a re-join.
 */
export function isPeerRejoinedCue(
  message: SignalingMessage,
  role: SessionRole | null,
  offerSent: boolean,
  exchangedPeerPublicKey: string | null,
): boolean {
  if (role !== 'host' || !offerSent) return false
  if (!isPeerJoinedCue(message)) return false
  if (exchangedPeerPublicKey === null) return false
  return message.publicKey !== exchangedPeerPublicKey
}

/**
 * Validates an unknown value as a `SignalingMessage`.
 *
 * Frames arrive from the network, so the client treats every inbound payload as
 * untrusted and rejects anything that is not exactly one of the shapes above.
 */
export function isSignalingMessage(value: unknown): value is SignalingMessage {
  if (!isNonNullObject(value)) return false
  const { type } = value as { type?: unknown }
  if (typeof type !== 'string' || !SIGNALING_MESSAGE_TYPES.has(type)) return false

  switch (type) {
    case 'join': {
      const { role } = value as { role?: unknown }
      return (role === 'host' || role === 'guest') && hasStringField(value, 'publicKey')
    }
    case 'pubkey':
      return hasStringField(value, 'publicKey')
    case 'offer':
    case 'answer':
      return hasStringField(value, 'sdp')
    case 'ice':
      return isNonNullObject((value as { candidate?: unknown }).candidate)
    case 'paired':
      return true
    case 'error':
      return hasStringField(value, 'message')
    default:
      return false
  }
}

export class SignalingClient {
  private readonly baseUrl: string
  private readonly socketFactory: (url: string) => WebSocket

  private socket: WebSocket | null = null
  private connectAttempted = false
  private paired = false

  /**
   * Set while a `connect()` promise is still pending, so `close()` can reject it
   * instead of leaving the caller awaiting a socket that will never open.
   */
  private pendingReject: ((error: unknown) => void) | null = null

  private readonly messageHandlers = new Set<SignalingMessageHandler>()
  private readonly closeHandlers = new Set<SignalingCloseHandler>()
  private readonly errorHandlers = new Set<SignalingErrorHandler>()

  constructor(url: string, options: SignalingClientOptions = {}) {
    this.baseUrl = url.replace(/\/+$/, '')
    this.socketFactory = options.socketFactory ?? ((socketUrl: string) => new WebSocket(socketUrl))
  }

  /**
   * True once the worker has reported both peers paired (PLAN.md §13).
   *
   * The Durable Object self-destructs immediately after sending `paired`, so the
   * socket closing right afterwards is the expected teardown, not a failure.
   * Callers should check this before reporting an error to the user.
   */
  get isPaired(): boolean {
    return this.paired
  }

  private buildUrl(sessionCode: string): string {
    return `${this.baseUrl}/session/${encodeURIComponent(sessionCode)}/ws`
  }

  /**
   * Opens the signaling socket and sends the `join` frame.
   *
   * Resolves once the join has been written to an open socket. Rejects if the
   * socket errors or closes before that happens.
   */
  async connect(sessionCode: string, role: SessionRole, publicKey: string): Promise<void> {
    if (this.connectAttempted) {
      throw new Error('signaling: client is single-use (PLAN.md §19.10: no session reconnect)')
    }
    this.connectAttempted = true

    const socket = this.socketFactory(this.buildUrl(sessionCode))
    this.socket = socket

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const succeed = (): void => {
        if (settled) return
        settled = true
        this.pendingReject = null
        resolve()
      }

      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        this.pendingReject = null
        reject(error)
      }

      this.pendingReject = fail

      socket.onopen = (): void => {
        try {
          this.transmit({ type: 'join', role, publicKey })
          succeed()
        } catch (error) {
          fail(error)
        }
      }

      socket.onmessage = (event: MessageEvent): void => {
        this.handleInbound(event.data)
      }

      socket.onerror = (event: Event): void => {
        this.emitError(event)
        fail(new Error('signaling: socket error before the join was accepted'))
      }

      socket.onclose = (event: CloseEvent): void => {
        this.socket = null
        this.emitClose({ code: event.code, reason: event.reason })
        fail(new Error(`signaling: socket closed before the join was accepted (code ${event.code})`))
      }
    })
  }

  /**
   * Sends a signaling message.
   *
   * Throws if the socket is not open. Callers send only after `connect()` has
   * resolved, so a throw here indicates a genuine lifecycle bug rather than a
   * transient condition worth silently queueing.
   */
  send(message: SignalingMessage): void {
    this.transmit(message)
  }

  onMessage(handler: SignalingMessageHandler): Unsubscribe {
    this.messageHandlers.add(handler)
    return () => {
      this.messageHandlers.delete(handler)
    }
  }

  onClose(handler: SignalingCloseHandler): Unsubscribe {
    this.closeHandlers.add(handler)
    return () => {
      this.closeHandlers.delete(handler)
    }
  }

  onError(handler: SignalingErrorHandler): Unsubscribe {
    this.errorHandlers.add(handler)
    return () => {
      this.errorHandlers.delete(handler)
    }
  }

  /**
   * Tears the client down. Idempotent, never throws, and never notifies
   * subscribers — `close()` is called from React cleanup, where a state update
   * after unmount would be a bug.
   */
  close(): void {
    const socket = this.socket
    const pendingReject = this.pendingReject
    this.socket = null
    this.pendingReject = null

    this.messageHandlers.clear()
    this.closeHandlers.clear()
    this.errorHandlers.clear()

    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close()
      } catch {
        // Already closed by the peer; nothing to do.
      }
    }

    if (pendingReject) {
      pendingReject(new Error('signaling: client closed before the join was accepted'))
    }
  }

  private transmit(message: SignalingMessage): void {
    const socket = this.socket
    if (!socket) {
      throw new Error('signaling: not connected')
    }
    if (socket.readyState !== SOCKET_OPEN) {
      throw new Error('signaling: socket is not open')
    }
    socket.send(JSON.stringify(message))
  }

  /** Never throws: a bad frame becomes an `onError` notification. */
  private handleInbound(data: unknown): void {
    if (typeof data !== 'string') {
      this.emitError(new Error('signaling: expected a text frame'))
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      this.emitError(new Error('signaling: malformed JSON frame'))
      return
    }

    if (!isSignalingMessage(parsed)) {
      this.emitError(new Error('signaling: unrecognised message shape'))
      return
    }

    if (parsed.type === 'paired') {
      this.paired = true
    }

    this.emitMessage(parsed)
  }

  private emitMessage(message: SignalingMessage): void {
    for (const handler of [...this.messageHandlers]) {
      try {
        handler(message)
      } catch (error) {
        this.emitError(error)
      }
    }
  }

  private emitClose(info: SignalingCloseInfo): void {
    for (const handler of [...this.closeHandlers]) {
      try {
        handler(info)
      } catch (error) {
        this.emitError(error)
      }
    }
  }

  private emitError(error: unknown): void {
    for (const handler of [...this.errorHandlers]) {
      try {
        handler(error)
      } catch {
        // A failing error handler must not cascade into further errors.
      }
    }
  }
}

import { DurableObject } from 'cloudflare:workers'

import { isValidSessionCode } from './codes'
import {
  applyJoin,
  applyRelease,
  applyRelay,
  createInitialState,
  shouldDestroyAfterSocketClose,
  type SessionState,
} from './sessionState'
import {
  otherRole,
  parseSignalingMessage,
  type SessionRole,
  type SignalingMessage,
} from './types'

/**
 * One Durable Object per session (PLAN.md §19 decision 6). It holds exactly two
 * WebSockets and brokers the WebRTC handshake: pubkey, offer, answer and ICE. It
 * never sees file or item content.
 *
 * PLAN.md §17 requires the DO to log nothing and to destroy all state after
 * `paired`, so there are no console statements in this module by design. SDP, ICE
 * candidates, public keys and message payloads are never logged anywhere.
 */

/** WebSocket close codes in the application range (4000-4999). */
const CLOSE_SESSION_EXPIRED = 4410
const CLOSE_ROLE_TAKEN = 4409
const CLOSE_SESSION_DONE = 4404

/**
 * Upper bound on messages buffered for a peer that has not attached yet. The cap
 * exists so an abandoned session cannot grow memory without bound.
 */
const MAX_BUFFERED_MESSAGES = 64

const CREATED_AT_STORAGE_KEY = 'createdAt'

const DEFAULT_SESSION_TTL_SECONDS = 300

/** Expiration TTL for the burned session code KV marker: 24h (86400s). */
const BURNED_CODE_KV_TTL_SECONDS = 86400

const SESSION_PATH = /^\/session\/([^/]+)\/(ws|create)$/

/**
 * Reads the session TTL from the environment.
 *
 * worker-configuration.d.ts types SESSION_TTL_SECONDS as the string literal "300",
 * so it must be parsed and defended against a malformed override.
 */
function resolveSessionTtlSeconds(env: Env): number {
  const parsed = Number(env.SESSION_TTL_SECONDS)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_SESSION_TTL_SECONDS
}

export class SessionDurableObject extends DurableObject<Env> {
  private state: SessionState
  private sessionCode: string | null = null
  private readonly sockets = new Map<SessionRole, WebSocket>()
  /** Sockets that have upgraded but not yet announced a role. */
  private readonly unjoined = new Set<WebSocket>()
  private readonly roles = new Map<WebSocket, SessionRole>()
  /** Messages awaiting delivery, keyed by the role that should receive them. */
  private readonly buffered = new Map<SessionRole, SignalingMessage[]>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.state = createInitialState(Date.now())
    // blockConcurrencyWhile guarantees no request is served before the stored
    // creation time has been restored, so the 300s window cannot be silently
    // extended by an eviction and a cold start.
    void ctx.blockConcurrencyWhile(async () => {
      await this.restore()
    })
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const match = SESSION_PATH.exec(url.pathname)

    if (match === null) return new Response('Not found', { status: 404 })

    const code = match[1] ?? ''
    // Defence in depth: the worker already rejected malformed codes before any DO
    // lookup, but the DO refuses them too rather than trusting its caller.
    if (!isValidSessionCode(code)) return new Response('Invalid session code', { status: 400 })

    this.sessionCode = code

    const action = match[2]

    if (action === 'create') {
      // Reaching here is enough: the constructor's restore() has already stamped and
      // persisted createdAt, which is what starts the 300s expiry (PLAN.md §17).
      return new Response(null, { status: 204 })
    }

    return this.openSocket(request)
  }

  /**
   * Fires when the session TTL elapses (PLAN.md §17: codes expire 5 minutes from
   * creation). Join is refused for an expired code anyway; the alarm exists so the
   * DO reliably releases its sockets and its stored timestamp even if every
   * participant vanishes without closing.
   */
  override async alarm(): Promise<void> {
    await this.destroy()
  }

  private async restore(): Promise<void> {
    const stored = await this.ctx.storage.get<number>(CREATED_AT_STORAGE_KEY)

    if (typeof stored === 'number') {
      this.state = { ...this.state, createdAt: stored }
      return
    }

    await this.ctx.storage.put(CREATED_AT_STORAGE_KEY, this.state.createdAt)
    await this.ctx.storage.setAlarm(
      this.state.createdAt + resolveSessionTtlSeconds(this.env) * 1000,
    )
  }

  private openSocket(request: Request): Response {
    if (this.state.phase === 'DONE') {
      return new Response('Session already paired', { status: 404 })
    }
    if (this.isAtSocketCapacity()) {
      // PLAN.md §19 decision 6: exactly two sockets per session.
      return new Response('Session is full', { status: 409 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    server.accept()
    this.unjoined.add(server)
    server.addEventListener('message', (event: MessageEvent) => {
      // workerd types MessageEvent.data as any; narrow it at the boundary so the
      // untyped runtime payload never escapes past this line.
      const data: unknown = event.data
      this.handleMessage(server, data)
    })
    server.addEventListener('close', () => {
      this.handleSocketClosed(server)
    })
    server.addEventListener('error', () => {
      this.handleSocketClosed(server)
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  private isAtSocketCapacity(): boolean {
    return this.sockets.size + this.unjoined.size >= 2
  }

  private handleMessage(socket: WebSocket, raw: unknown): void {
    // The signaling protocol is text-only JSON (PLAN.md §13). Binary frames are not
    // part of it and are dropped without inspection.
    if (typeof raw !== 'string') return

    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      this.sendToSocket(socket, { type: 'error', message: 'Malformed JSON' })
      return
    }

    const message = parseSignalingMessage(decoded)
    if (message === null) {
      this.sendToSocket(socket, { type: 'error', message: 'Unsupported message' })
      return
    }

    const role = this.roles.get(socket)

    if (role === undefined) {
      if (message.type !== 'join') {
        this.sendToSocket(socket, { type: 'error', message: 'First message must be join' })
        return
      }
      this.handleJoin(socket, message)
      return
    }

    this.handleRelay(role, message)
  }

  private handleJoin(socket: WebSocket, message: Extract<SignalingMessage, { type: 'join' }>): void {
    const result = applyJoin(
      this.state,
      message.role,
      message.publicKey,
      Date.now(),
      resolveSessionTtlSeconds(this.env),
    )

    if (!result.ok) {
      this.sendToSocket(socket, { type: 'error', message: result.reason })
      this.closeSocket(socket, closeCodeForJoinRejection(result.reason), result.reason)
      return
    }

    this.state = result.state
    this.unjoined.delete(socket)
    this.roles.set(socket, message.role)
    this.sockets.set(message.role, socket)

    // Hand the newcomer the peer's public key if the peer is already here, and tell
    // the peer about the newcomer's key (PLAN.md §13 'pubkey').
    const peerPublicKey =
      message.role === 'host' ? this.state.guestPublicKey : this.state.hostPublicKey
    if (peerPublicKey !== null) {
      this.sendToSocket(socket, { type: 'pubkey', publicKey: peerPublicKey })
    }
    this.deliver(otherRole(message.role), { type: 'pubkey', publicKey: message.publicKey })

    this.flushBuffered(message.role)
  }

  private handleRelay(sender: SessionRole, message: SignalingMessage): void {
    if (message.type === 'join') {
      this.sendToRole(sender, { type: 'error', message: 'Already joined' })
      return
    }

    const result = applyRelay(
      this.state,
      sender,
      message,
      Date.now(),
      resolveSessionTtlSeconds(this.env),
    )

    if (!result.ok) {
      this.sendToRole(sender, { type: 'error', message: result.reason })
      return
    }

    this.state = result.state

    if (result.deliver) {
      this.deliver(otherRole(sender), message)
    }
    if (result.paired) {
      this.announcePaired()
    }
  }

  /**
   * Tells both participants that pairing is complete, then discards all session state
   * (PLAN.md §17).
   *
   * The sockets deliberately stay open a little longer. PLAN.md §13 says the DO
   * "destroys itself" after sending `paired`, but tear-down cannot be immediate:
   * SDP has only just been exchanged at that point, and trickle ICE candidates still
   * have to be relayed or the WebRTC connection would never finish establishing.
   * So state is destroyed here, ICE continues to pass through statelessly, and the
   * DO fully self-destructs when the last socket closes or the 300s alarm fires.
   */
  private announcePaired(): void {
    const paired: SignalingMessage = { type: 'paired' }
    for (const socket of this.sockets.values()) {
      this.sendToSocket(socket, paired)
    }
    this.buffered.clear()
    void this.markBurnedInKv()
  }

  /**
   * Writes the burned:<code> marker to KV so the code can never be rejoined (Change 3).
   * Fails open if KV is unavailable or throws.
   */
  private async markBurnedInKv(): Promise<void> {
    if (!this.sessionCode) return
    try {
      const kv = this.env.RATE_LIMIT
      if (typeof kv === 'object' && kv !== null && 'put' in kv) {
        await kv.put(`burned:${this.sessionCode}`, '1', {
          expirationTtl: BURNED_CODE_KV_TTL_SECONDS,
        })
      }
    } catch {
      // Fail open per policy: logging/throwing is forbidden.
    }
  }

  private deliver(recipient: SessionRole, message: SignalingMessage): void {
    const socket = this.sockets.get(recipient)

    if (socket !== undefined) {
      this.sendToSocket(socket, message)
      return
    }

    // Host and guest do not join in lockstep: the host typically produces its offer
    // before the guest has attached. Without buffering, that opening offer would be
    // dropped and the handshake could never start.
    const queue = this.buffered.get(recipient) ?? []
    queue.push(message)
    while (queue.length > MAX_BUFFERED_MESSAGES) {
      queue.shift()
    }
    this.buffered.set(recipient, queue)
  }

  private flushBuffered(recipient: SessionRole): void {
    const queue = this.buffered.get(recipient)
    if (queue === undefined) return

    this.buffered.delete(recipient)
    for (const message of queue) {
      this.sendToRole(recipient, message)
    }
  }

  private handleSocketClosed(socket: WebSocket): void {
    const role = this.roles.get(socket)
    if (role !== undefined) {
      this.roles.delete(socket)
      if (this.sockets.get(role) === socket) {
        this.sockets.delete(role)
        this.releaseRole(role)
      }
    }
    this.unjoined.delete(socket)

    // A close before pairing leaves the session alive and joinable: PLAN.md §17 makes
    // the TTL the expiry mechanism for a code, not the first socket close. Only a
    // completed pairing ends the DO from here; the TTL alarm handles the rest.
    if (shouldDestroyAfterSocketClose(this.state, this.sockets.size + this.unjoined.size)) {
      void this.destroy()
    }
  }

  /**
   * Frees a role whose socket closed before pairing, so a fresh connection can take
   * the slot again. Messages queued for the departed role are dropped with it: they
   * were addressed to a peer that no longer exists.
   */
  private releaseRole(role: SessionRole): void {
    this.state = applyRelease(this.state, role)
    this.buffered.delete(role)
  }

  /** Releases every socket and every stored byte. Idempotent. */
  private async destroy(): Promise<void> {
    for (const socket of this.sockets.values()) {
      this.closeSocket(socket, 1000, 'session ended')
    }
    for (const socket of this.unjoined) {
      this.closeSocket(socket, 1000, 'session ended')
    }

    this.sockets.clear()
    this.unjoined.clear()
    this.roles.clear()
    this.buffered.clear()

    // Burn the code on EVERY end-of-life path, not only on pairing. Without this a
    // session that expired un-paired (the 300s alarm) or was abandoned by both sockets
    // left no durable trace, and because identity is pure idFromName(code) a later
    // request would instantiate a fresh DO, re-stamp createdAt and re-arm a fresh
    // 300s window — making a code PLAN.md §17 says has expired joinable again.
    // Runs before deleteAll() so the code is still readable.
    await this.markBurnedInKv()

    this.state = { ...createInitialState(this.state.createdAt), phase: 'DONE' }

    await this.ctx.storage.deleteAll()
  }

  private sendToRole(role: SessionRole, message: SignalingMessage): void {
    const socket = this.sockets.get(role)
    if (socket === undefined) return
    this.sendToSocket(socket, message)
  }

  private sendToSocket(socket: WebSocket, message: SignalingMessage): void {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // The socket is already closing or closed. Signaling offers no delivery
      // guarantee, and PLAN.md §19 decision 10 makes a dropped session a matter of
      // starting a new one rather than reconnecting.
    }
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason)
    } catch {
      // Already closed. Nothing to release.
    }
  }
}

function closeCodeForJoinRejection(reason: 'expired' | 'role-taken' | 'session-done'): number {
  switch (reason) {
    case 'expired':
      return CLOSE_SESSION_EXPIRED
    case 'role-taken':
      return CLOSE_ROLE_TAKEN
    case 'session-done':
      return CLOSE_SESSION_DONE
  }
}

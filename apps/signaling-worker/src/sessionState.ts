import type { SessionRole, SignalingMessage } from './types'

/**
 * The signaling session state machine, kept pure and free of runtime dependencies.
 *
 * This lives apart from session.ts because session.ts imports `cloudflare:workers`,
 * a specifier that only resolves inside workerd. Keeping the transitions here lets
 * session.test.ts exercise them directly in a plain node environment instead of
 * mocking the Durable Object runtime.
 *
 * PLAN.md §13 defines the phases: CREATED → HOST_CONNECTED → GUEST_CONNECTED →
 * EXCHANGING → DONE.
 */

export type SessionPhase = 'CREATED' | 'HOST_CONNECTED' | 'GUEST_CONNECTED' | 'EXCHANGING' | 'DONE'

export interface SessionState {
  phase: SessionPhase
  /** Epoch millis. Stamped at creation so the TTL runs from code creation. */
  createdAt: number
  hostJoined: boolean
  guestJoined: boolean
  hostPublicKey: string | null
  guestPublicKey: string | null
  offerRelayed: boolean
  answerRelayed: boolean
}

export function createInitialState(createdAt: number): SessionState {
  return {
    phase: 'CREATED',
    createdAt,
    hostJoined: false,
    guestJoined: false,
    hostPublicKey: null,
    guestPublicKey: null,
    offerRelayed: false,
    answerRelayed: false,
  }
}

export function isExpired(state: SessionState, now: number, ttlSeconds: number): boolean {
  return now - state.createdAt >= ttlSeconds * 1000
}

export type JoinRejectionReason = 'expired' | 'role-taken' | 'session-done'

export type JoinResult = { ok: true; state: SessionState } | { ok: false; reason: JoinRejectionReason }

/**
 * Attaches a participant to the session.
 *
 * Rejects a second host or a second guest, which is what caps the session at the two
 * sockets PLAN.md §19 decision 6 specifies. The two join orders are both supported:
 * whether host or guest arrives first, the session reaches EXCHANGING once both have.
 */
export function applyJoin(
  state: SessionState,
  role: SessionRole,
  publicKey: string,
  now: number,
  ttlSeconds: number,
): JoinResult {
  if (state.phase === 'DONE') return { ok: false, reason: 'session-done' }
  if (isExpired(state, now, ttlSeconds)) return { ok: false, reason: 'expired' }

  const alreadyJoined = role === 'host' ? state.hostJoined : state.guestJoined
  if (alreadyJoined) return { ok: false, reason: 'role-taken' }

  const next: SessionState = {
    ...state,
    hostJoined: role === 'host' ? true : state.hostJoined,
    guestJoined: role === 'guest' ? true : state.guestJoined,
    hostPublicKey: role === 'host' ? publicKey : state.hostPublicKey,
    guestPublicKey: role === 'guest' ? publicKey : state.guestPublicKey,
  }

  if (next.hostJoined && next.guestJoined) {
    next.phase = 'EXCHANGING'
  } else {
    next.phase = role === 'host' ? 'HOST_CONNECTED' : 'GUEST_CONNECTED'
  }

  return { ok: true, state: next }
}

/**
 * Releases the slot held by a participant whose socket closed before pairing.
 *
 * The session code stays usable, so a fresh connection may take the released role
 * again. PLAN.md §17 makes the 5-minute TTL the expiry mechanism for a code, not the
 * first socket close, so the server keeps an unpaired code joinable instead of
 * burning it.
 *
 * That is a server-side duty only — it does NOT mean the client resumes. PLAN.md §19
 * decision 10 makes sessions single-use, and per ORCHESTRATION.md D4 the host ends the
 * session when a peer re-joins a code it has already offered into. A re-join therefore
 * reaches this server and is failed fast by the peer's client; the claim that releasing
 * the slot "lets a mobile network blip recover in production" was only half true.
 *
 * The earlier React StrictMode justification is also obsolete: useSession defers
 * connect with setTimeout(…, 0) plus a `cancelled` flag, so the throwaway StrictMode
 * mount never opens a socket at all.
 *
 * Both relay flags reset because the partial SDP handshake belonged to the departed
 * peer: keeping `offerRelayed` set could let a stale `answer` from the surviving peer
 * declare pairing before its replacement had ever sent an offer.
 */
export function applyRelease(state: SessionState, role: SessionRole): SessionState {
  // Pairing is terminal: once both sockets have exchanged SDP the session is over and
  // a released slot must never be reissued (PLAN.md §17, §19 decision 10).
  if (state.phase === 'DONE') return state

  const hostJoined = role === 'host' ? false : state.hostJoined
  const guestJoined = role === 'guest' ? false : state.guestJoined

  const next: SessionState = {
    ...state,
    hostJoined,
    guestJoined,
    hostPublicKey: role === 'host' ? null : state.hostPublicKey,
    guestPublicKey: role === 'guest' ? null : state.guestPublicKey,
    offerRelayed: false,
    answerRelayed: false,
  }

  if (hostJoined && guestJoined) {
    next.phase = 'EXCHANGING'
  } else if (hostJoined) {
    next.phase = 'HOST_CONNECTED'
  } else if (guestJoined) {
    next.phase = 'GUEST_CONNECTED'
  } else {
    next.phase = 'CREATED'
  }

  return next
}

/**
 * Whether a socket close should tear the Durable Object down.
 *
 * A close before pairing only releases that role's slot and leaves the code
 * joinable; the DO is destroyed here only once pairing has completed (phase DONE) and
 * every socket is gone. An unpaired DO is instead destroyed by its TTL alarm, which
 * `restore()` sets to createdAt + SESSION_TTL_SECONDS (PLAN.md §17).
 */
export function shouldDestroyAfterSocketClose(state: SessionState, openSockets: number): boolean {
  return state.phase === 'DONE' && openSockets === 0
}

export type RelayRejectionReason =
  | 'expired'
  | 'session-done'
  | 'sender-not-joined'
  | 'peer-not-connected'
  | 'sender-role-mismatch'

export type RelayResult =
  | {
      ok: true
      state: SessionState
      /** True when the message must be forwarded to the other participant. */
      deliver: boolean
      /** True when this relay completed pairing, so the DO must announce it. */
      paired: boolean
    }
  | { ok: false; reason: RelayRejectionReason }

/**
 * Applies a relayed message from one participant to the other.
 *
 * Pairing is declared complete on the SDP round trip — once the host has relayed an
 * `offer` and the guest an `answer`. A pubkey-only exchange deliberately does NOT
 * complete pairing, because public keys are exchanged before the SDP handshake and
 * the peers are not yet able to connect.
 *
 * The SDP legs are role-checked: an `offer` may only come from the host and an
 * `answer` only from the guest. Otherwise one joined participant could relay both
 * legs and declare its own pairing, which is a self-inflicted DoS in Phase 1 and —
 * because Phase 2 gates the safety-phrase overlay on `paired` — a security hole once
 * keys are involved.
 */
export function applyRelay(
  state: SessionState,
  sender: SessionRole,
  message: SignalingMessage,
  now: number,
  ttlSeconds: number,
): RelayResult {
  if (isExpired(state, now, ttlSeconds)) return { ok: false, reason: 'expired' }

  if (state.phase === 'DONE') {
    // Pairing is complete and all session state has been discarded (PLAN.md §17).
    // Trickle ICE must still reach the peer or the connection cannot finish
    // establishing, so ICE alone is passed through statelessly.
    if (message.type === 'ice') return { ok: true, state, deliver: true, paired: false }
    return { ok: false, reason: 'session-done' }
  }

  const senderJoined = sender === 'host' ? state.hostJoined : state.guestJoined
  if (!senderJoined) return { ok: false, reason: 'sender-not-joined' }

  const receiverJoined = sender === 'host' ? state.guestJoined : state.hostJoined
  if (!receiverJoined) return { ok: false, reason: 'peer-not-connected' }

  // Role/type coherence. Only the host may offer and only the guest may answer, so a
  // single participant cannot relay both legs to drive this session to DONE. Its own
  // reason: 'sender-not-joined' would misreport a sender that is in fact joined.
  if (message.type === 'offer' && sender !== 'host') {
    return { ok: false, reason: 'sender-role-mismatch' }
  }
  if (message.type === 'answer' && sender !== 'guest') {
    return { ok: false, reason: 'sender-role-mismatch' }
  }

  const next: SessionState = { ...state }
  if (message.type === 'offer') next.offerRelayed = true
  if (message.type === 'answer') next.answerRelayed = true

  const paired = next.offerRelayed && next.answerRelayed
  if (paired) {
    next.phase = 'DONE'
    // PLAN.md §17: destroy all state after pairing. The public keys are the only
    // identifying material the DO holds, so they go first.
    next.hostPublicKey = null
    next.guestPublicKey = null
  }

  return { ok: true, state: next, deliver: true, paired }
}

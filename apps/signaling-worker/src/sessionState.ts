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

export type RelayRejectionReason =
  | 'expired'
  | 'session-done'
  | 'sender-not-joined'
  | 'peer-not-connected'

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
 * Pairing is declared complete on the SDP round trip — once one side has relayed an
 * `offer` and the other an `answer`. A pubkey-only exchange deliberately does NOT
 * complete pairing, because public keys are exchanged before the SDP handshake and
 * the peers are not yet able to connect.
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

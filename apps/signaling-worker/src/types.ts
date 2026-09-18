/**
 * Signaling wire types shared by the Worker, the Durable Object and the tests.
 * PLAN.md §13.
 */

export type SessionRole = 'host' | 'guest'

export interface TurnCredentials {
  iceServers: string[]
  urls: string[]
  username: string
  credential: string
}

export interface SessionTurnResponse {
  iceServers: string[]
  urls: string[]
  username: string
  credential: string
}

/**
 * An opaque ICE candidate relayed by the Durable Object.
 *
 * workerd's runtime types do not ship the DOM WebRTC types, so `RTCIceCandidateInit`
 * is unavailable inside this package. This interface is deliberately structurally
 * identical to the DOM `RTCIceCandidateInit` the frontend uses in
 * `apps/frontend/src/lib/signaling.ts`, so the shared `SignalingMessage` union stays
 * assignment-compatible on both sides of the wire.
 *
 * DEVIATION from the shared contract: the contract names `RTCIceCandidateInit`
 * directly, which cannot compile in a Workers-targeted package.
 */
export interface IceCandidateInit {
  candidate?: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

/**
 * Messages brokered by the Durable Object. `paired` and `error` are authored by the
 * server only — see parseSignalingMessage, which refuses to accept them from a peer.
 */
export type SignalingMessage =
  | { type: 'join'; role: SessionRole; publicKey: string }
  | { type: 'pubkey'; publicKey: string }
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice'; candidate: IceCandidateInit }
  | { type: 'paired' }
  | { type: 'error'; message: string }

export interface SessionNewResponse {
  code: string
}

export function isSessionRole(value: unknown): value is SessionRole {
  return value === 'host' || value === 'guest'
}

export function otherRole(role: SessionRole): SessionRole {
  return role === 'host' ? 'guest' : 'host'
}

/**
 * Validates an untrusted value into a SignalingMessage.
 *
 * Returning null for anything unrecognised keeps the Durable Object's relay strictly
 * typed: message bodies arrive as JSON from the network and are never trusted.
 */
export function parseSignalingMessage(value: unknown): SignalingMessage | null {
  if (typeof value !== 'object' || value === null) return null

  const record = value as Record<string, unknown>

  switch (record['type']) {
    case 'join': {
      const role = record['role']
      const publicKey = record['publicKey']
      if (!isSessionRole(role)) return null
      if (typeof publicKey !== 'string') return null
      return { type: 'join', role, publicKey }
    }
    case 'pubkey': {
      const publicKey = record['publicKey']
      if (typeof publicKey !== 'string') return null
      return { type: 'pubkey', publicKey }
    }
    case 'offer': {
      const sdp = record['sdp']
      if (typeof sdp !== 'string') return null
      return { type: 'offer', sdp }
    }
    case 'answer': {
      const sdp = record['sdp']
      if (typeof sdp !== 'string') return null
      return { type: 'answer', sdp }
    }
    case 'ice': {
      const candidate = parseIceCandidate(record['candidate'])
      if (candidate === null) return null
      return { type: 'ice', candidate }
    }
    default:
      // 'paired' and 'error' are server-authored. A peer must never be able to
      // inject them, because the server is the only authority on pairing state.
      return null
  }
}

function parseIceCandidate(value: unknown): IceCandidateInit | null {
  if (typeof value !== 'object' || value === null) return null

  const record = value as Record<string, unknown>
  const candidate: IceCandidateInit = {}

  const rawCandidate = record['candidate']
  if (rawCandidate !== undefined) {
    if (typeof rawCandidate !== 'string') return null
    candidate.candidate = rawCandidate
  }

  const sdpMid = record['sdpMid']
  if (sdpMid !== undefined) {
    if (sdpMid !== null && typeof sdpMid !== 'string') return null
    candidate.sdpMid = sdpMid
  }

  const sdpMLineIndex = record['sdpMLineIndex']
  if (sdpMLineIndex !== undefined) {
    if (sdpMLineIndex !== null && typeof sdpMLineIndex !== 'number') return null
    candidate.sdpMLineIndex = sdpMLineIndex
  }

  const usernameFragment = record['usernameFragment']
  if (usernameFragment !== undefined) {
    if (usernameFragment !== null && typeof usernameFragment !== 'string') return null
    candidate.usernameFragment = usernameFragment
  }

  return candidate
}

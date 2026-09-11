import { describe, expect, it } from 'vitest'

import {
  applyJoin,
  applyRelease,
  applyRelay,
  createInitialState,
  isExpired,
  shouldDestroyAfterSocketClose,
  type SessionState,
} from './sessionState'
import { parseSignalingMessage, type SessionRole, type SignalingMessage } from './types'

const TTL_SECONDS = 300
const CREATED_AT = 1_000_000
const NOW = CREATED_AT
const HOST_KEY = 'host-public-key'
const GUEST_KEY = 'guest-public-key'

function joinOrThrow(
  state: SessionState,
  role: SessionRole,
  publicKey: string,
  now: number = NOW,
): SessionState {
  const result = applyJoin(state, role, publicKey, now, TTL_SECONDS)
  if (!result.ok) throw new Error(`expected join to succeed, got ${result.reason}`)
  return result.state
}

function stateWithBoth(): SessionState {
  return joinOrThrow(joinOrThrow(createInitialState(CREATED_AT), 'host', HOST_KEY), 'guest', GUEST_KEY)
}

function relayOrThrow(
  state: SessionState,
  sender: SessionRole,
  message: SignalingMessage,
  now: number = NOW,
): Extract<ReturnType<typeof applyRelay>, { ok: true }> {
  const result = applyRelay(state, sender, message, now, TTL_SECONDS)
  if (!result.ok) throw new Error(`expected relay to succeed, got ${result.reason}`)
  return result
}

const OFFER: SignalingMessage = { type: 'offer', sdp: 'v=0 offer' }
const ANSWER: SignalingMessage = { type: 'answer', sdp: 'v=0 answer' }
const PUBKEY: SignalingMessage = { type: 'pubkey', publicKey: 'peer-key' }
const ICE: SignalingMessage = { type: 'ice', candidate: { candidate: 'candidate:1', sdpMid: '0' } }

describe('createInitialState', () => {
  it('starts CREATED with no participants and no relayed traffic', () => {
    const state = createInitialState(CREATED_AT)

    expect(state.phase).toBe('CREATED')
    expect(state.hostJoined).toBe(false)
    expect(state.guestJoined).toBe(false)
    expect(state.hostPublicKey).toBeNull()
    expect(state.guestPublicKey).toBeNull()
    expect(state.offerRelayed).toBe(false)
    expect(state.answerRelayed).toBe(false)
  })
})

describe('isExpired', () => {
  it('is false before the TTL elapses', () => {
    const state = createInitialState(CREATED_AT)
    expect(isExpired(state, CREATED_AT + TTL_SECONDS * 1000 - 1, TTL_SECONDS)).toBe(false)
  })

  it('is true exactly at the TTL boundary', () => {
    const state = createInitialState(CREATED_AT)
    expect(isExpired(state, CREATED_AT + TTL_SECONDS * 1000, TTL_SECONDS)).toBe(true)
  })

  it('is true well past the TTL', () => {
    const state = createInitialState(CREATED_AT)
    expect(isExpired(state, CREATED_AT + TTL_SECONDS * 1000 * 10, TTL_SECONDS)).toBe(true)
  })
})

describe('applyJoin', () => {
  it('moves to HOST_CONNECTED when the host arrives first', () => {
    const state = joinOrThrow(createInitialState(CREATED_AT), 'host', HOST_KEY)

    expect(state.phase).toBe('HOST_CONNECTED')
    expect(state.hostJoined).toBe(true)
    expect(state.guestJoined).toBe(false)
    expect(state.hostPublicKey).toBe(HOST_KEY)
  })

  it('moves to GUEST_CONNECTED when the guest arrives first', () => {
    const state = joinOrThrow(createInitialState(CREATED_AT), 'guest', GUEST_KEY)

    expect(state.phase).toBe('GUEST_CONNECTED')
    expect(state.guestJoined).toBe(true)
    expect(state.guestPublicKey).toBe(GUEST_KEY)
  })

  it('reaches EXCHANGING once both sides are present, in either order', () => {
    const hostThenGuest = stateWithBoth()
    expect(hostThenGuest.phase).toBe('EXCHANGING')

    const guestFirst = joinOrThrow(createInitialState(CREATED_AT), 'guest', GUEST_KEY)
    const guestThenHost = joinOrThrow(guestFirst, 'host', HOST_KEY)
    expect(guestThenHost.phase).toBe('EXCHANGING')
  })

  it('rejects a second host, which is what caps the session at two sockets', () => {
    const result = applyJoin(stateWithBoth(), 'host', 'imposter', NOW, TTL_SECONDS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('role-taken')
  })

  it('rejects a second guest', () => {
    const result = applyJoin(stateWithBoth(), 'guest', 'imposter', NOW, TTL_SECONDS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('role-taken')
  })

  it('rejects a third participant once both roles are taken', () => {
    const occupied = stateWithBoth()
    for (const role of ['host', 'guest'] as const) {
      expect(applyJoin(occupied, role, 'third', NOW, TTL_SECONDS).ok).toBe(false)
    }
  })

  it('rejects a join after the code has expired (PLAN.md §17)', () => {
    const result = applyJoin(
      createInitialState(CREATED_AT),
      'host',
      HOST_KEY,
      CREATED_AT + TTL_SECONDS * 1000,
      TTL_SECONDS,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('expired')
  })

  it('rejects a join once the session has already paired', () => {
    const paired = relayOrThrow(relayOrThrow(stateWithBoth(), 'host', OFFER).state, 'guest', ANSWER)
    expect(paired.state.phase).toBe('DONE')

    const result = applyJoin(paired.state, 'host', 'late', NOW, TTL_SECONDS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('session-done')
  })

  it('does not mutate the state it was given', () => {
    const original = createInitialState(CREATED_AT)
    const snapshot = structuredClone(original)

    applyJoin(original, 'host', HOST_KEY, NOW, TTL_SECONDS)

    expect(original).toEqual(snapshot)
  })
})

describe('applyRelease', () => {
  it('frees the role slot when a participant disconnects before pairing', () => {
    const hostOnly = joinOrThrow(createInitialState(CREATED_AT), 'host', HOST_KEY)
    const released = applyRelease(hostOnly, 'host')

    expect(released.hostJoined).toBe(false)
    expect(released.hostPublicKey).toBeNull()
    expect(released.phase).toBe('CREATED')
  })

  it('keeps the other participant attached when one side disconnects', () => {
    const released = applyRelease(stateWithBoth(), 'host')

    expect(released.hostJoined).toBe(false)
    expect(released.guestJoined).toBe(true)
    expect(released.guestPublicKey).toBe(GUEST_KEY)
    expect(released.phase).toBe('GUEST_CONNECTED')
  })

  it('lets the released role join again before the code expires (PLAN.md §17)', () => {
    const hostOnly = joinOrThrow(createInitialState(CREATED_AT), 'host', HOST_KEY)
    const released = applyRelease(hostOnly, 'host')

    const result = applyJoin(released, 'host', 'second-host-key', NOW, TTL_SECONDS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.hostPublicKey).toBe('second-host-key')
    expect(result.state.phase).toBe('HOST_CONNECTED')
  })

  it('reaches EXCHANGING when the released role is taken while the peer stays', () => {
    const released = applyRelease(stateWithBoth(), 'guest')

    const result = applyJoin(released, 'guest', 'second-guest-key', NOW, TTL_SECONDS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.phase).toBe('EXCHANGING')
  })

  it('still refuses a second concurrent host after a release', () => {
    const released = applyRelease(joinOrThrow(createInitialState(CREATED_AT), 'host', HOST_KEY), 'host')
    const rejoin = applyJoin(released, 'host', 'second-host-key', NOW, TTL_SECONDS)
    if (!rejoin.ok) throw new Error(`expected re-join to succeed, got ${rejoin.reason}`)

    const imposter = applyJoin(rejoin.state, 'host', 'imposter', NOW, TTL_SECONDS)

    expect(imposter.ok).toBe(false)
    if (imposter.ok) return
    expect(imposter.reason).toBe('role-taken')
  })

  it('does not reissue a slot once pairing is complete', () => {
    const paired = relayOrThrow(relayOrThrow(stateWithBoth(), 'host', OFFER).state, 'guest', ANSWER)

    const released = applyRelease(paired.state, 'host')

    expect(released).toEqual(paired.state)
    expect(released.phase).toBe('DONE')
  })

  it('restarts the SDP handshake so a stale answer cannot declare pairing', () => {
    const afterOffer = relayOrThrow(stateWithBoth(), 'host', OFFER)
    const released = applyRelease(afterOffer.state, 'host')

    expect(released.offerRelayed).toBe(false)
    expect(released.answerRelayed).toBe(false)

    // The survivor's answer is refused against the missing peer, so pairing cannot
    // complete until the replacement peer has offered.
    const staleAnswer = applyRelay(released, 'guest', ANSWER, NOW, TTL_SECONDS)
    expect(staleAnswer.ok).toBe(false)
    if (staleAnswer.ok) return
    expect(staleAnswer.reason).toBe('peer-not-connected')
  })

  it('does not mutate the state it was given', () => {
    const original = stateWithBoth()
    const snapshot = structuredClone(original)

    applyRelease(original, 'host')

    expect(original).toEqual(snapshot)
  })
})

describe('shouldDestroyAfterSocketClose', () => {
  it('does not destroy an unpaired session when its last socket closes', () => {
    expect(shouldDestroyAfterSocketClose(createInitialState(CREATED_AT), 0)).toBe(false)
    expect(shouldDestroyAfterSocketClose(joinOrThrow(createInitialState(CREATED_AT), 'host', HOST_KEY), 0)).toBe(
      false,
    )
    expect(shouldDestroyAfterSocketClose(stateWithBoth(), 0)).toBe(false)
  })

  it('destroys a paired session once both sockets are closed', () => {
    const paired = relayOrThrow(relayOrThrow(stateWithBoth(), 'host', OFFER).state, 'guest', ANSWER)

    expect(shouldDestroyAfterSocketClose(paired.state, 1)).toBe(false)
    expect(shouldDestroyAfterSocketClose(paired.state, 0)).toBe(true)
  })

  it('leaves a never-paired session to the TTL alarm, not a socket close', () => {
    const hostOnly = joinOrThrow(createInitialState(CREATED_AT), 'host', HOST_KEY)

    // The pre-pairing close releases the slot and keeps the DO alive...
    const released = applyRelease(hostOnly, 'host')
    expect(shouldDestroyAfterSocketClose(released, 0)).toBe(false)

    // ...and the 300s window from creation is what ends it (PLAN.md §17).
    expect(isExpired(released, CREATED_AT + TTL_SECONDS * 1000 - 1, TTL_SECONDS)).toBe(false)
    expect(isExpired(released, CREATED_AT + TTL_SECONDS * 1000, TTL_SECONDS)).toBe(true)
  })
})

describe('applyRelay', () => {
  it('rejects a sender that never joined', () => {
    const result = applyRelay(createInitialState(CREATED_AT), 'host', OFFER, NOW, TTL_SECONDS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('sender-not-joined')
  })

  it('rejects relaying before the peer has connected', () => {
    const hostOnly = joinOrThrow(createInitialState(CREATED_AT), 'host', HOST_KEY)
    const result = applyRelay(hostOnly, 'host', OFFER, NOW, TTL_SECONDS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('peer-not-connected')
  })

  it('relays a public key without declaring pairing complete', () => {
    // Keys are exchanged before SDP; pairing must not complete on a key exchange
    // alone or the DO would tear down before any offer could be relayed.
    const hostKeyRelayed = relayOrThrow(stateWithBoth(), 'host', PUBKEY)
    expect(hostKeyRelayed.deliver).toBe(true)
    expect(hostKeyRelayed.paired).toBe(false)

    const guestKeyRelayed = relayOrThrow(hostKeyRelayed.state, 'guest', PUBKEY)
    expect(guestKeyRelayed.paired).toBe(false)
    expect(guestKeyRelayed.state.phase).toBe('EXCHANGING')
  })

  it('completes pairing on the SDP round trip', () => {
    const afterOffer = relayOrThrow(stateWithBoth(), 'host', OFFER)
    expect(afterOffer.paired).toBe(false)
    expect(afterOffer.state.phase).toBe('EXCHANGING')

    const afterAnswer = relayOrThrow(afterOffer.state, 'guest', ANSWER)
    expect(afterAnswer.paired).toBe(true)
    expect(afterAnswer.state.phase).toBe('DONE')
  })

  it('completes pairing on the legitimate host-offer/guest-answer sequence', () => {
    const afterOffer = relayOrThrow(stateWithBoth(), 'host', OFFER)
    expect(afterOffer.deliver).toBe(true)
    expect(afterOffer.paired).toBe(false)

    const afterAnswer = relayOrThrow(afterOffer.state, 'guest', ANSWER)

    expect(afterAnswer.paired).toBe(true)
    expect(afterAnswer.state.phase).toBe('DONE')
  })

  it('rejects an offer that did not come from the host', () => {
    const result = applyRelay(stateWithBoth(), 'guest', OFFER, NOW, TTL_SECONDS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('sender-role-mismatch')
  })

  it('rejects an answer that did not come from the guest', () => {
    const result = applyRelay(stateWithBoth(), 'host', ANSWER, NOW, TTL_SECONDS)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('sender-role-mismatch')
  })

  it('refuses a single participant relaying both SDP legs, in either order', () => {
    // In Phase 2 `paired` gates the safety-phrase overlay, so a peer must not be able
    // to complete the exchange on its own.
    const guestAnswer = relayOrThrow(stateWithBoth(), 'guest', ANSWER)
    const guestOffer = applyRelay(guestAnswer.state, 'guest', OFFER, NOW, TTL_SECONDS)
    expect(guestOffer.ok).toBe(false)
    if (guestOffer.ok) return
    expect(guestOffer.reason).toBe('sender-role-mismatch')
    expect(guestAnswer.state.phase).toBe('EXCHANGING')

    const hostOffer = relayOrThrow(stateWithBoth(), 'host', OFFER)
    const hostAnswer = applyRelay(hostOffer.state, 'host', ANSWER, NOW, TTL_SECONDS)
    expect(hostAnswer.ok).toBe(false)
    if (hostAnswer.ok) return
    expect(hostAnswer.reason).toBe('sender-role-mismatch')

    // Still EXCHANGING and half-relayed: the spoofed leg never advanced the session.
    expect(hostOffer.state.phase).toBe('EXCHANGING')
    expect(hostOffer.state.offerRelayed).toBe(true)
    expect(hostOffer.state.answerRelayed).toBe(false)
  })

  it('discards the public keys on pairing (PLAN.md §17 destroys all state)', () => {
    const afterOffer = relayOrThrow(stateWithBoth(), 'host', OFFER)
    const afterAnswer = relayOrThrow(afterOffer.state, 'guest', ANSWER)

    expect(afterAnswer.state.hostPublicKey).toBeNull()
    expect(afterAnswer.state.guestPublicKey).toBeNull()
  })

  it('still delivers ICE after pairing so the connection can finish establishing', () => {
    const paired = relayOrThrow(relayOrThrow(stateWithBoth(), 'host', OFFER).state, 'guest', ANSWER)

    const ice = relayOrThrow(paired.state, 'host', ICE)
    expect(ice.deliver).toBe(true)
    expect(ice.state.phase).toBe('DONE')
  })

  it('refuses further SDP or key traffic after pairing', () => {
    const paired = relayOrThrow(relayOrThrow(stateWithBoth(), 'host', OFFER).state, 'guest', ANSWER)

    for (const message of [OFFER, ANSWER, PUBKEY]) {
      const result = applyRelay(paired.state, 'host', message, NOW, TTL_SECONDS)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('session-done')
    }
  })

  it('rejects a relay after expiry', () => {
    const result = applyRelay(
      stateWithBoth(),
      'host',
      OFFER,
      CREATED_AT + TTL_SECONDS * 1000,
      TTL_SECONDS,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('expired')
  })

  it('does not mutate the state it was given', () => {
    const original = stateWithBoth()
    const snapshot = structuredClone(original)

    applyRelay(original, 'host', OFFER, NOW, TTL_SECONDS)

    expect(original).toEqual(snapshot)
  })
})

describe('parseSignalingMessage at the relay boundary', () => {
  it('accepts each client-authored message type', () => {
    expect(parseSignalingMessage({ type: 'join', role: 'host', publicKey: '' })).toEqual({
      type: 'join',
      role: 'host',
      publicKey: '',
    })
    expect(parseSignalingMessage({ type: 'pubkey', publicKey: 'k' })).toEqual({
      type: 'pubkey',
      publicKey: 'k',
    })
    expect(parseSignalingMessage({ type: 'offer', sdp: 'v=0' })).toEqual({
      type: 'offer',
      sdp: 'v=0',
    })
    expect(parseSignalingMessage({ type: 'answer', sdp: 'v=0' })).toEqual({
      type: 'answer',
      sdp: 'v=0',
    })
    expect(parseSignalingMessage({ type: 'ice', candidate: { candidate: 'c' } })).toEqual({
      type: 'ice',
      candidate: { candidate: 'c' },
    })
  })

  it('refuses client-authored paired and error messages', () => {
    // The server is the only authority on pairing state; a peer must never be able
    // to announce it or inject an error frame.
    expect(parseSignalingMessage({ type: 'paired' })).toBeNull()
    expect(parseSignalingMessage({ type: 'error', message: 'spoofed' })).toBeNull()
  })

  it('rejects unknown types and non-objects', () => {
    expect(parseSignalingMessage({ type: 'nope' })).toBeNull()
    expect(parseSignalingMessage(null)).toBeNull()
    expect(parseSignalingMessage(undefined)).toBeNull()
    expect(parseSignalingMessage('offer')).toBeNull()
    expect(parseSignalingMessage(42)).toBeNull()
    expect(parseSignalingMessage([])).toBeNull()
  })

  it('rejects messages with missing or mistyped fields', () => {
    expect(parseSignalingMessage({ type: 'join', role: 'nobody', publicKey: '' })).toBeNull()
    expect(parseSignalingMessage({ type: 'join', role: 'host' })).toBeNull()
    expect(parseSignalingMessage({ type: 'pubkey' })).toBeNull()
    expect(parseSignalingMessage({ type: 'offer', sdp: 1 })).toBeNull()
    expect(parseSignalingMessage({ type: 'ice' })).toBeNull()
    expect(parseSignalingMessage({ type: 'ice', candidate: 'not-an-object' })).toBeNull()
    expect(parseSignalingMessage({ type: 'ice', candidate: { sdpMLineIndex: 'zero' } })).toBeNull()
  })

  it('accepts a null-valued ICE field, which is what the browser actually sends', () => {
    expect(parseSignalingMessage({ type: 'ice', candidate: { sdpMid: null, sdpMLineIndex: null } })).toEqual({
      type: 'ice',
      candidate: { sdpMid: null, sdpMLineIndex: null },
    })
  })
})

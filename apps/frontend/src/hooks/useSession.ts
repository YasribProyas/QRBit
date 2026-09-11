/**
 * Session orchestration for Phase 1 (PLAN.md §8).
 *
 * Owns the whole handshake: role assignment from the URL, session creation,
 * signaling, the offer/answer/ICE exchange, and the first DataChannel messages.
 * `pages/Session.tsx` stays presentational because of this.
 *
 * PHASE 2 SEAM: ECDH key exchange, the safety phrase and the phrase-confirm gate
 * slot in here, between the `paired` message and the point the session is marked
 * active. The `pubkey` and `paired` branches below are already reserved for it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { buildNewSessionUrl, SIGNALING_WS_URL } from '../config'
import { SignalingClient } from '../lib/signaling'
import type { SessionRole, SignalingMessage } from '../lib/signaling'
import type { HelloMessage, PeerConnectionOptions } from '../lib/webrtc'
import { useSessionStore } from '../store/sessionStore'
import type { SessionPhase } from '../store/sessionStore'
import { useWebRTC } from './useWebRTC'

export type StatusTone = 'idle' | 'ok' | 'warn' | 'error'

export interface SessionStatus {
  label: string
  tone: StatusTone
}

interface TurnCredentials {
  username: string
  credential: string
}

interface NewSessionResponse {
  code: string
  turnCredentials?: TurnCredentials
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Validates the worker's `/session/new` payload.
 *
 * The response crosses a network boundary, so it is treated as untrusted rather
 * than cast. A malformed payload fails loudly here instead of producing a
 * session that can never pair.
 */
export function parseNewSessionResponse(value: unknown): NewSessionResponse {
  if (!isRecord(value)) {
    throw new Error('the signaling server returned an unexpected payload for a new session')
  }

  const code = value['code']
  if (typeof code !== 'string' || code === '') {
    throw new Error('the signaling server returned a session without a code')
  }

  const result: NewSessionResponse = { code }
  const turnCredentials = value['turnCredentials']

  if (isRecord(turnCredentials)) {
    const username = turnCredentials['username']
    const credential = turnCredentials['credential']
    if (typeof username === 'string' && typeof credential === 'string') {
      result.turnCredentials = { username, credential }
    }
  }

  return result
}

async function requestNewSession(): Promise<NewSessionResponse> {
  const response = await fetch(buildNewSessionUrl(), { headers: { accept: 'application/json' } })
  if (!response.ok) {
    throw new Error(`the signaling server refused to create a session (HTTP ${response.status})`)
  }
  const payload: unknown = await response.json()
  return parseNewSessionResponse(payload)
}

/** Normalises anything thrown into a message safe to show the user. */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message
  }
  if (typeof error === 'string' && error.trim() !== '') {
    return error
  }
  return 'Something went wrong starting the session'
}

/**
 * Maps session state onto the status bar required by PLAN.md §8 Phase 1:
 * Connecting / Connected / Ended / Error.
 */
export function describeSessionStatus(
  phase: SessionPhase,
  connectionState: RTCPeerConnectionState,
  errorMessage: string | null,
): SessionStatus {
  if (errorMessage !== null) {
    return { label: 'Error', tone: 'error' }
  }
  if (phase === 'ended') {
    return { label: 'Session ended', tone: 'idle' }
  }
  if (phase === 'active' || connectionState === 'connected') {
    return { label: 'Connected', tone: 'ok' }
  }
  if (connectionState === 'failed') {
    return { label: 'Connection failed', tone: 'error' }
  }
  if (connectionState === 'disconnected') {
    return { label: 'Connection lost', tone: 'warn' }
  }
  return { label: 'Connecting…', tone: 'warn' }
}

export interface UseSessionOptions {
  /** The `code` URL param. Present means guest; absent means host (PLAN.md §8). */
  code: string | null
}

export interface UseSessionResult {
  role: SessionRole | null
  phase: SessionPhase
  sessionCode: string | null
  connectionState: RTCPeerConnectionState
  errorMessage: string | null
  status: SessionStatus
  /** How the UI explains this device's role for the current session. */
  roleLabel: string
  /** The greeting this device put on the wire, once the channel opened. */
  localHello: string | null
  /** The greeting received from the peer. */
  peerHello: string | null
  /** Tears the current attempt down and starts a fresh one. */
  restart: () => void
}

export function useSession(options: UseSessionOptions): UseSessionResult {
  const { code } = options

  const role = useSessionStore((state) => state.role)
  const phase = useSessionStore((state) => state.phase)
  const sessionCode = useSessionStore((state) => state.sessionCode)
  const connectionState = useSessionStore((state) => state.connectionState)
  const errorMessage = useSessionStore((state) => state.errorMessage)

  const startConnecting = useSessionStore((state) => state.startConnecting)
  const setSessionCode = useSessionStore((state) => state.setSessionCode)
  const setPhase = useSessionStore((state) => state.setPhase)
  const endSession = useSessionStore((state) => state.endSession)
  const reset = useSessionStore((state) => state.reset)

  const [localHello, setLocalHello] = useState<string | null>(null)
  const [peerHello, setPeerHello] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const signalingRef = useRef<SignalingClient | null>(null)
  const roleRef = useRef<SessionRole | null>(null)
  const sendRef = useRef<((message: HelloMessage) => void) | null>(null)

  const handleIceCandidate = useCallback((candidate: RTCIceCandidateInit): void => {
    try {
      signalingRef.current?.send({ type: 'ice', candidate })
    } catch {
      // The signaling socket has gone away. The DataChannel does not need ICE
      // relayed any more, so there is nothing to report here.
    }
  }, [])

  const handlePeerMessage = useCallback((message: HelloMessage): void => {
    setPeerHello(message.text)
  }, [])

  const handleChannelOpen = useCallback((): void => {
    const currentRole = roleRef.current
    const send = sendRef.current
    if (!currentRole || !send) return

    setPhase('active')

    const text = `Hello from the ${currentRole} device`
    setLocalHello(text)

    try {
      send({ t: 'hello', from: currentRole, text })
    } catch (error) {
      endSession(describeError(error))
    }
  }, [endSession, setPhase])

  const webRtc = useWebRTC({
    onIceCandidate: handleIceCandidate,
    onMessage: handlePeerMessage,
    onOpen: handleChannelOpen,
  })

  const { createPeer, initAsHost, receiveOffer, receiveAnswer, addIceCandidate, send, close } = webRtc

  // The channel-open handler is defined before the peer exists, so the send
  // function is reached through a ref rather than closing over a stale value.
  useEffect(() => {
    sendRef.current = send
  }, [send])

  useEffect(() => {
    let cancelled = false
    const isStale = (): boolean => cancelled

    /*
     * Sends the host offer exactly once, and only after the peer has attached.
     *
     * The Durable Object relays SDP only while both roles are connected: it enters
     * EXCHANGING when the second role joins (PLAN.md §13) and rejects an offer
     * relayed before that with a `peer-not-connected` error, which would end the
     * session. `pubkey` is the worker's signal that a peer has joined, so it is the
     * cue to open the SDP exchange.
     *
     * The `offerSent` guard is load-bearing: the worker can deliver `pubkey` more
     * than once (a direct send to the joiner plus a flushed buffered message), and a
     * duplicate offer would be relayed after pairing and rejected as `session-done`.
     */
    let offerSent = false
    const sendHostOffer = async (client: SignalingClient): Promise<void> => {
      if (offerSent) return
      offerSent = true

      const offer = await initAsHost()
      if (isStale()) return
      if (!offer.sdp) {
        throw new Error('the host offer did not contain an SDP payload')
      }
      client.send({ type: 'offer', sdp: offer.sdp })
    }

    const handleSignalingMessage = async (client: SignalingClient, message: SignalingMessage): Promise<void> => {
      if (isStale()) return
      try {
        switch (message.type) {
          case 'offer': {
            // Hosts never receive an offer.
            if (roleRef.current !== 'guest') return
            const answer = await receiveOffer({ type: 'offer', sdp: message.sdp })
            if (isStale()) return
            if (!answer.sdp) {
              throw new Error('the guest answer did not contain an SDP payload')
            }
            client.send({ type: 'answer', sdp: answer.sdp })
            return
          }
          case 'answer': {
            // Guests never receive an answer.
            if (roleRef.current !== 'host') return
            await receiveAnswer({ type: 'answer', sdp: message.sdp })
            return
          }
          case 'ice': {
            await addIceCandidate(message.candidate)
            return
          }
          case 'paired': {
            // PHASE 2 SEAM: the safety-phrase overlay is shown here and the
            // session is held until both sides confirm. Phase 1 proceeds.
            return
          }
          case 'pubkey': {
            // PHASE 2 SEAM: this carries the peer's P-256 public key, used for ECDH
            // key agreement. It also announces that a peer has joined, which is when
            // the host may open the SDP exchange (see sendHostOffer).
            if (roleRef.current !== 'host') return
            await sendHostOffer(client)
            return
          }
          case 'error': {
            endSession(message.message)
            return
          }
          default: {
            // 'join' is client-to-server only and never arrives here.
            return
          }
        }
      } catch (error) {
        if (isStale()) return
        endSession(describeError(error))
      }
    }

    const run = async (): Promise<void> => {
      const nextRole: SessionRole = code !== null && code !== '' ? 'guest' : 'host'
      roleRef.current = nextRole
      setLocalHello(null)
      setPeerHello(null)
      startConnecting(nextRole, code)

      try {
        let activeCode = code
        let peerOptions: PeerConnectionOptions | undefined

        if (activeCode === null || activeCode === '') {
          // Host: create the session, then display its code for the guest to scan.
          const created = await requestNewSession()
          if (isStale()) return
          activeCode = created.code
          setSessionCode(created.code)

          if (created.turnCredentials) {
            peerOptions = {
              turnUsername: created.turnCredentials.username,
              turnCredential: created.turnCredentials.credential,
            }
          }
        }

        createPeer(peerOptions)
        if (isStale()) return

        const client = new SignalingClient(SIGNALING_WS_URL)
        signalingRef.current = client

        // Subscriptions are registered before connect() so a fast peer reply
        // cannot arrive before there is anything listening for it.
        client.onError((error) => {
          if (isStale()) return
          endSession(describeError(error))
        })

        client.onClose((info) => {
          if (isStale()) return
          // Once paired, the worker has discarded all session state and only keeps
          // relaying trickle ICE; the close is part of normal completion rather than
          // a failure (PLAN.md §13, §17). Whether the DataChannel is still healthy is
          // tracked separately, via the peer connection's own state.
          if (client.isPaired) return

          const state = useSessionStore.getState()
          if (state.errorMessage !== null || state.phase === 'ended') return

          const detail = info.reason !== '' ? `${info.reason} (code ${info.code})` : `code ${info.code}`
          endSession(`the signaling connection closed before pairing (${detail})`)
        })

        client.onMessage((message) => {
          void handleSignalingMessage(client, message)
        })

        await client.connect(activeCode, nextRole, '')
        if (isStale()) return

        // The host's offer is deliberately not sent here. It waits for the peer to
        // join, which the worker reports with a `pubkey` message — see
        // sendHostOffer. Sending it at this point would be rejected by the Durable
        // Object as `peer-not-connected` and would end the session before the guest
        // had a chance to connect.
      } catch (error) {
        if (isStale()) return
        endSession(describeError(error))
      }
    }

    // Deferred by a tick so React 19 StrictMode's throwaway mount/unmount cycle
    // cannot open two signaling sockets. StrictMode runs mount → unmount →
    // remount synchronously, before this timer fires, so the first cycle's
    // cleanup cancels it and exactly one connection survives. That matters:
    // a Durable Object accepts only one host and one guest (PLAN.md §13), so a
    // duplicate join would be rejected and the session could never pair.
    const timer = window.setTimeout(() => {
      void run()
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      signalingRef.current?.close()
      signalingRef.current = null
      roleRef.current = null
      close()
    }
  }, [
    code,
    attempt,
    createPeer,
    initAsHost,
    receiveOffer,
    receiveAnswer,
    addIceCandidate,
    close,
    startConnecting,
    setSessionCode,
    endSession,
  ])

  // The signaling connection is closed on unmount so the worker's Durable Object
  // sees this device leave instead of waiting for its session to expire.
  useEffect(() => {
    const handleBeforeUnload = (): void => {
      signalingRef.current?.close()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  const restart = useCallback((): void => {
    signalingRef.current?.close()
    signalingRef.current = null
    close()
    reset()
    setAttempt((current) => current + 1)
  }, [close, reset])

  const roleLabel =
    role === 'host'
      ? 'Host — waiting for another device to scan your code'
      : role === 'guest'
        ? 'Guest — you opened the other device’s session'
        : 'Assigning role…'

  return {
    role,
    phase,
    sessionCode,
    connectionState,
    errorMessage,
    status: describeSessionStatus(phase, connectionState, errorMessage),
    roleLabel,
    localHello,
    peerHello,
    restart,
  }
}

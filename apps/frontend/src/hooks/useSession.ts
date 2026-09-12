/**
 * Session orchestration (PLAN.md §8).
 *
 * Owns the whole handshake: role assignment from the URL, session creation,
 * signaling, the ECDH public-key exchange, the offer/answer/ICE exchange, the
 * safety-phrase gate, and the first encrypted DataChannel frames. `pages/Session.tsx`
 * stays presentational because of this.
 *
 * PHASE 2 SCOPE: the phase sequence is connecting → pairing (the safety-phrase
 * overlay is up and the session is held until both devices confirm) → active
 * (PLAN.md §8). Nothing here stores key material: the keypair, the session key and
 * the phrase live in memory for the lifetime of the session and are dropped when the
 * peer connection closes (AGENTS.md forbids persistence).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { buildNewSessionUrl, SIGNALING_WS_URL } from '../config'
import {
  deriveSafetyPhraseBytes,
  deriveSessionKey,
  deriveSharedSecret,
  exportPublicKey,
  fromBase64,
  generateKeypair,
  importPeerPublicKey,
  toBase64,
} from '../lib/crypto'
import { bytesToPhrase } from '../lib/safetyPhrase'
import { SignalingClient, isPeerRejoinedCue, shouldHostSendOffer } from '../lib/signaling'
import type { SessionRole, SignalingMessage } from '../lib/signaling'
import type { Frame, PeerConnectionOptions } from '../lib/webrtc'
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

/** Overwrites a buffer that held key material. Never logged, never returned. */
function zeroBytes(bytes: ArrayBuffer | Uint8Array): void {
  if (bytes instanceof Uint8Array) {
    bytes.fill(0)
    return
  }
  new Uint8Array(bytes).fill(0)
}

/**
 * Derives this session's encryption key and safety phrase from the peer's public
 * key (PLAN.md §11.1–§11.3, §11.6).
 *
 * `sessionId` is the 8-character session code both devices already know and is used
 * as the HKDF salt; only the public keys cross the (untrusted) signaling channel, so
 * a compromised worker cannot derive any of this. The session key and the phrase
 * bytes come from different HKDF info strings, which is why showing the three words
 * on screen gives nothing away about the key.
 *
 * The raw shared secret is zeroed as soon as both derivations have consumed it —
 * it must never be stored, transported, logged or persisted.
 */
export async function deriveSessionMaterial(
  privateKey: CryptoKey,
  peerPublicKeyBase64: string,
  sessionId: string,
): Promise<{ sessionKey: CryptoKey; phrase: [string, string, string] }> {
  // `fromBase64` rejects empty or malformed input, so a peer that joined without a
  // real public key surfaces here instead of producing a session nobody can read.
  const peerPublicKey = await importPeerPublicKey(fromBase64(peerPublicKeyBase64).buffer)
  const sharedSecret = await deriveSharedSecret(privateKey, peerPublicKey)

  try {
    const sessionKey = await deriveSessionKey(sharedSecret, sessionId)
    const phraseBytes = await deriveSafetyPhraseBytes(sharedSecret, sessionId)
    const phrase = bytesToPhrase(phraseBytes)
    zeroBytes(phraseBytes)
    return { sessionKey, phrase }
  } finally {
    zeroBytes(sharedSecret)
  }
}

/**
 * PLAN.md §8 Phase 2: the session advances to 'active' only once BOTH devices have
 * confirmed the safety phrase; until then the overlay stays up and no item traffic
 * flows. Pure so the gate can be pinned by a test without a React harness.
 */
export function nextPhaseForConfirmations(
  phase: SessionPhase,
  phraseConfirmed: boolean,
  peerConfirmed: boolean,
): SessionPhase {
  return phase === 'pairing' && phraseConfirmed && peerConfirmed ? 'active' : phase
}

/**
 * The user-facing reason a session ends when the other device re-joins the code
 * after the host has already offered (ORCHESTRATION.md D4).
 *
 * A replaced peer cannot be served: PLAN.md §19 decision 10 makes sessions
 * single-use and `shouldHostSendOffer` latches at one offer per host attempt, so
 * there is no handshake left to resume. Reporting this explicitly is better UX than
 * the silent spinner the Durable Object's 300s TTL would otherwise produce.
 */
export const PEER_REJOINED_REASON = 'The other device reconnected — start a new session'

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
  /** The three words both devices must see identically (PLAN.md §8 Phase 2). */
  safetyPhrase: readonly [string, string, string] | null
  /** This device's user has accepted the phrase. */
  phraseConfirmed: boolean
  /** The peer's encrypted phrase-confirm has arrived. */
  peerConfirmed: boolean
  /** Records this device's confirmation; the phrase-confirm follows once the channel is live. */
  confirmPhrase: () => void
  /** Tells the peer the session is over, then tears everything down. */
  abort: () => void
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
  const safetyPhrase = useSessionStore((state) => state.safetyPhrase)
  const phraseConfirmed = useSessionStore((state) => state.phraseConfirmed)
  const peerConfirmed = useSessionStore((state) => state.peerConfirmed)

  const startConnecting = useSessionStore((state) => state.startConnecting)
  const setSessionCode = useSessionStore((state) => state.setSessionCode)
  const setPhase = useSessionStore((state) => state.setPhase)
  const setSafetyPhrase = useSessionStore((state) => state.setSafetyPhrase)
  const setPeerConfirmed = useSessionStore((state) => state.setPeerConfirmed)
  const confirmPhrase = useSessionStore((state) => state.confirmPhrase)
  const endSession = useSessionStore((state) => state.endSession)
  const reset = useSessionStore((state) => state.reset)

  const [localHello, setLocalHello] = useState<string | null>(null)
  const [peerHello, setPeerHello] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  /**
   * The two conditions that make the encrypted channel usable. Both are tracked
   * separately from the store because they gate *sends*, not what the UI shows.
   */
  const [channelOpen, setChannelOpen] = useState(false)
  const [sessionKeyReady, setSessionKeyReady] = useState(false)

  const signalingRef = useRef<SignalingClient | null>(null)
  const roleRef = useRef<SessionRole | null>(null)
  /** This device's ephemeral keypair. Its private half never leaves memory. */
  const keypairRef = useRef<CryptoKeyPair | null>(null)
  /** The 8-character code used as the HKDF salt (PLAN.md §11.2). */
  const sessionCodeRef = useRef<string | null>(null)
  /** Whether the ECDH exchange has already produced a session key this attempt. */
  const keysExchangedRef = useRef(false)
  /**
   * The peer public key this attempt has completed a key exchange with.
   *
   * The Durable Object can send the peer-joined cue twice (a direct send plus a
   * flushed buffered copy), and a genuine re-join of the same code arrives as a
   * second cue carrying a new ephemeral key, so this is what tells the two apart
   * (ORCHESTRATION.md D5).
   */
  const exchangedPeerKeyRef = useRef<string | null>(null)
  const helloSentRef = useRef(false)
  const confirmSentRef = useRef(false)

  const handleIceCandidate = useCallback((candidate: RTCIceCandidateInit): void => {
    try {
      signalingRef.current?.send({ type: 'ice', candidate })
    } catch {
      // The signaling socket has gone away. The DataChannel does not need ICE
      // relayed any more, so there is nothing to report here.
    }
  }, [])

  const handlePeerMessage = useCallback(
    (message: Frame): void => {
      switch (message.t) {
        case 'hello': {
          setPeerHello(message.text)
          return
        }
        case 'phrase-confirm': {
          // PLAN.md §8: the session may only proceed once BOTH devices confirm, so
          // this flag alone never starts the session — see
          // nextPhaseForConfirmations.
          setPeerConfirmed(true)
          return
        }
        case 'session-end': {
          // The peer aborted on purpose. Its socket teardown closes this channel
          // moments later, so all that is left is the ended state (PLAN.md §8 Phase 4).
          endSession(null)
          return
        }
      }
    },
    [endSession, setPeerConfirmed],
  )

  const handleChannelOpen = useCallback((): void => {
    setChannelOpen(true)
  }, [])

  /**
   * Encryption and the channel write are asynchronous, so a send failure cannot be
   * caught by the caller of `send()` (ORCHESTRATION.md D3). This is where it is
   * reported instead of being swallowed.
   */
  const handleSendError = useCallback(
    (error: unknown): void => {
      endSession(describeError(error))
    },
    [endSession],
  )

  const webRtc = useWebRTC({
    onIceCandidate: handleIceCandidate,
    onMessage: handlePeerMessage,
    onOpen: handleChannelOpen,
    onSendError: handleSendError,
  })

  const {
    createPeer,
    initAsHost,
    receiveOffer,
    receiveAnswer,
    addIceCandidate,
    setSessionKey,
    send,
    drain,
    close,
  } = webRtc

  useEffect(() => {
    let cancelled = false
    const isStale = (): boolean => cancelled

    /*
     * Sends the host offer exactly once, and only after the peer has attached.
     *
     * The only cue that a peer has joined is the `pubkey` message: PLAN.md §13 has no
     * explicit peer-joined frame. Should the host offer before that cue, the Durable
     * Object rejects the relay with `peer-not-connected` and the session ends, so the
     * cue check in `shouldHostSendOffer` is load-bearing. The `offerSent` guard is
     * equally so: the worker can deliver `pubkey` more than once (a direct send to the
     * joiner plus a flushed buffered message), and a duplicate offer would be relayed
     * after pairing and rejected as `session-done`.
     */
    let offerSent = false
    const sendHostOffer = async (client: SignalingClient, cue: SignalingMessage): Promise<void> => {
      if (!shouldHostSendOffer(cue, roleRef.current, offerSent)) return
      offerSent = true

      const offer = await initAsHost()
      if (isStale()) return
      if (!offer.sdp) {
        throw new Error('the host offer did not contain an SDP payload')
      }
      client.send({ type: 'offer', sdp: offer.sdp })
    }

    /**
     * Runs the ECDH exchange with the peer's public key and installs the result
     * (PLAN.md §13/§11.1–§11.2). The peer's key arrives in the `pubkey` message,
     * before any offer is created, so the session key exists before the DataChannel
     * can open — that ordering is what makes it impossible to send a frame before it
     * can be encrypted.
     */
    const performKeyExchange = async (peerPublicKey: string): Promise<void> => {
      if (keysExchangedRef.current) return

      const keypair = keypairRef.current
      const activeCode = sessionCodeRef.current
      if (!keypair || activeCode === null) {
        throw new Error('the peer sent a public key before this device was ready')
      }

      // Claimed before the first await: the worker can deliver the cue twice, and both
      // copies would otherwise start their own derivation.
      keysExchangedRef.current = true
      let material: { sessionKey: CryptoKey; phrase: [string, string, string] }
      try {
        material = await deriveSessionMaterial(keypair.privateKey, peerPublicKey, activeCode)
      } catch (error) {
        // Nothing was installed, so a later cue (or a restart) may derive again.
        keysExchangedRef.current = false
        throw error
      }
      if (isStale()) return

      exchangedPeerKeyRef.current = peerPublicKey
      setSessionKey(material.sessionKey)
      setSessionKeyReady(true)
      setSafetyPhrase(material.phrase)
      // The peer has joined and the words are now on screen: PLAN.md §8's 'pairing'
      // phase, which the overlay gates (the session is held until both confirm).
      setPhase('pairing')
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
            // The Durable Object has seen the offer and the answer. The safety-phrase
            // gate is driven by the DataChannel and the phrase-confirms, not by this
            // message, so there is nothing to do here (PLAN.md §8 Phase 2).
            return
          }
          case 'pubkey': {
            // 'pubkey' means 'peer joined' — it is the cue that this host may open the
            // SDP exchange (see sendHostOffer and shouldHostSendOffer) and it carries
            // the peer's real P-256 public key (PLAN.md §13).
            if (
              isPeerRejoinedCue(
                message,
                roleRef.current,
                offerSent,
                exchangedPeerKeyRef.current,
              )
            ) {
              // The other device re-joined a code this host has already offered into,
              // so there is no second offer to send and no handshake to resume. Fail
              // fast rather than sitting on the cue until the TTL closes the sockets
              // (ORCHESTRATION.md D4, PLAN.md §19 decision 10). A duplicate copy of the
              // cue carrying the key this host already exchanged with is not a re-join
              // and falls through (ORCHESTRATION.md D5).
              endSession(PEER_REJOINED_REASON)
              return
            }
            await performKeyExchange(message.publicKey)
            await sendHostOffer(client, message)
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
      keypairRef.current = null
      keysExchangedRef.current = false
      exchangedPeerKeyRef.current = null
      sessionCodeRef.current = null
      helloSentRef.current = false
      confirmSentRef.current = false
      setLocalHello(null)
      setPeerHello(null)
      setChannelOpen(false)
      setSessionKeyReady(false)
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

        // PLAN.md §13: each device generates an ephemeral keypair before joining and
        // publishes only the public half, base64-encoded, in its join message. The
        // worker relays it and never sees a private key.
        const keypair = await generateKeypair()
        if (isStale()) return
        keypairRef.current = keypair
        const publicKey = toBase64(await exportPublicKey(keypair.publicKey))
        if (isStale()) return

        sessionCodeRef.current = activeCode

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

        await client.connect(activeCode, nextRole, publicKey)
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
      keypairRef.current = null
      sessionCodeRef.current = null
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
    setSessionKey,
    close,
    startConnecting,
    setSessionCode,
    setPhase,
    setSafetyPhrase,
    endSession,
  ])

  /**
   * Sends the encrypted greeting once the channel is usable (PLAN.md §16 Phase 1's
   * channel check, now inside the AES-GCM envelope).
   *
   * It waits for BOTH conditions: the DataChannel can open before the session key is
   * installed, and `send()` refuses to run without a key, so opening the channel is
   * not on its own permission to put a frame on the wire.
   */
  useEffect(() => {
    const currentRole = roleRef.current
    if (!currentRole || !channelOpen || !sessionKeyReady || helloSentRef.current) return
    helloSentRef.current = true

    const text = `Hello from the ${currentRole} device`
    setLocalHello(text)

    try {
      send({ t: 'hello', from: currentRole, text })
    } catch (error) {
      endSession(describeError(error))
    }
  }, [channelOpen, sessionKeyReady, send, endSession])

  /**
   * Sends the encrypted phrase-confirm once this device has confirmed (PLAN.md §10).
   *
   * The user can read the three words and tap Confirmed while the WebRTC handshake is
   * still finishing, so the send waits for an open channel with a session key rather
   * than falling back to anything unencrypted.
   */
  useEffect(() => {
    if (!phraseConfirmed || !channelOpen || !sessionKeyReady || confirmSentRef.current) return
    confirmSentRef.current = true

    try {
      send({ t: 'phrase-confirm' })
    } catch (error) {
      endSession(describeError(error))
    }
  }, [phraseConfirmed, channelOpen, sessionKeyReady, send, endSession])

  /** PLAN.md §8 Phase 2 gate: pairing → active only once both devices confirmed. */
  useEffect(() => {
    const next = nextPhaseForConfirmations(phase, phraseConfirmed, peerConfirmed)
    if (next !== phase) {
      setPhase(next)
    }
  }, [phase, phraseConfirmed, peerConfirmed, setPhase])

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

  /**
   * The overlay's Abort button (PLAN.md §8 Phase 2).
   *
   * Tells the peer the session is over, then tears the connection down. The frame is
   * queued rather than written (ORCHESTRATION.md D3), so the teardown waits for
   * `drain()` — closing the channel underneath its own queue would drop the
   * session-end and leave the peer guessing. A channel that never opened has no peer
   * to tell, so the send is skipped there.
   */
  const abort = useCallback((): void => {
    try {
      send({ t: 'session-end' })
    } catch {
      // The channel was not usable; there is nobody to notify.
    }

    void drain().then(() => {
      signalingRef.current?.close()
      signalingRef.current = null
      close()
      // A deliberate end, not a failure: PLAN.md §8 Phase 4's "Session ended".
      endSession(null)
    })
  }, [send, drain, close, endSession])

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
    safetyPhrase,
    phraseConfirmed,
    peerConfirmed,
    confirmPhrase,
    abort,
    restart,
  }
}

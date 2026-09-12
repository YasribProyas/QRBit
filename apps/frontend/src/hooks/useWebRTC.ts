/**
 * React wrapper around the Phase 1 `PeerConnection` (PLAN.md §12).
 *
 * Owns exactly one peer connection for the lifetime of the component. The peer
 * is created explicitly by `createPeer()` rather than on mount, because the host
 * must wait for the signaling worker to issue TURN credentials before the ICE
 * server list can be built — and that list is fixed at construction.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PeerConnection } from '../lib/webrtc'
import type { PeerConnectionOptions } from '../lib/webrtc'
import type { WireMessage } from '../lib/protocol'
import { useSessionStore } from '../store/sessionStore'

export interface UseWebRTCHandlers {
  /** A local ICE candidate to relay to the peer over signaling. */
  onIceCandidate: (candidate: RTCIceCandidateInit) => void
  /** A message arrived on the DataChannel (already decrypted and authenticated). */
  onMessage: (message: WireMessage) => void
  /** The DataChannel is open; the session can start exchanging items. */
  onOpen: () => void
  /**
   * A frame failed after `send()` returned. Encryption and the channel write are
   * asynchronous (ORCHESTRATION.md D3), so this is the only way a send failure can
   * reach the session: without it the failure would be swallowed.
   */
  onSendError: (error: unknown) => void
}

export interface UseWebRTCResult {
  connectionState: RTCPeerConnectionState
  /** Constructs the peer. No-op if one already exists. */
  createPeer: (options?: PeerConnectionOptions) => void
  initAsHost: () => Promise<RTCSessionDescriptionInit>
  receiveOffer: (offer: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>
  receiveAnswer: (answer: RTCSessionDescriptionInit) => Promise<void>
  addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>
  /**
   * Installs the ECDH-derived session key. Until this is called the peer refuses
   * to send, so no plaintext application frame can reach the channel.
   */
  setSessionKey: (key: CryptoKey) => void
  send: (message: WireMessage) => void
  /**
   * `send()` for the file pumps: resolves once the frame has been written to the
   * channel, so a pump can wait for the channel between chunks (PLAN.md §9).
   */
  sendAwaitable: (message: WireMessage) => Promise<void>
  /** Resolves when the channel's queued bytes are back under the pump threshold. */
  waitForBackpressure: () => Promise<void>
  /**
   * Wakes every pump parked on `waitForBackpressure()`. Used when item work is
   * stopped without tearing the peer down (the peer's `session-end` path), so a
   * cancelled pump does not hold its `File` until the channel closes.
   */
  releaseBackpressure: () => void
  /**
   * Opens the item gate (PLAN.md §8). Until this is called the peer refuses every
   * item-bearing frame, whatever the call site does.
   */
  markActive: () => void
  /** Resolves once every accepted frame has left the channel. Never rejects. */
  drain: () => Promise<void>
  /** Tears down the peer. Idempotent. */
  close: () => void
}

export function useWebRTC(handlers: UseWebRTCHandlers): UseWebRTCResult {
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new')

  // PLAN.md §9 puts `connectionState` on the session store, and Phase 3 reads it from
  // there, so every peer state must be recorded in the store as well as in the local
  // copy the hook returns. Without this the store's value stays at 'new' forever.
  // The action reference is stable, so depending on it cannot rebuild the peer.
  const setStoreConnectionState = useSessionStore((state) => state.setConnectionState)

  const peerRef = useRef<PeerConnection | null>(null)
  const unsubscribersRef = useRef<readonly (() => void)[]>([])

  /**
   * The session key is held here as well as on the peer, so a key that arrives
   * before `createPeer()` is not lost — otherwise the session would refuse to send
   * for its whole lifetime.
   */
  const sessionKeyRef = useRef<CryptoKey | null>(null)

  /**
   * Same reason as `sessionKeyRef`: the both-confirms gate can land before the peer
   * is constructed (the host builds its peer only when the worker issues the TURN
   * credentials), and a gate that is lost there would lock every item frame out of
   * the session.
   */
  const activeRef = useRef(false)

  /**
   * Handlers are kept in a ref so a re-render with fresh closures never rebuilds
   * the peer connection — recreating it would drop the DataChannel mid-session.
   */
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

  const requirePeer = useCallback((): PeerConnection => {
    const peer = peerRef.current
    if (!peer) {
      throw new Error('webrtc: no peer connection — call createPeer() before using the peer')
    }
    return peer
  }, [])

  const createPeer = useCallback((options?: PeerConnectionOptions): void => {
    if (peerRef.current) return

    const peer = new PeerConnection(options)
    const sessionKey = sessionKeyRef.current
    if (sessionKey) {
      peer.setSessionKey(sessionKey)
    }
    if (activeRef.current) {
      peer.markActive()
    }
    peerRef.current = peer
    unsubscribersRef.current = [
      peer.onIceCandidate((candidate) => {
        handlersRef.current.onIceCandidate(candidate)
      }),
      peer.onMessage((message) => {
        handlersRef.current.onMessage(message)
      }),
      peer.onDataChannelOpen(() => {
        handlersRef.current.onOpen()
      }),
      peer.onStateChange((state) => {
        setConnectionState(state)
        setStoreConnectionState(state)
      }),
      peer.onSendError((error) => {
        handlersRef.current.onSendError(error)
      }),
    ]
  }, [setStoreConnectionState])

  const setSessionKey = useCallback((key: CryptoKey): void => {
    sessionKeyRef.current = key
    peerRef.current?.setSessionKey(key)
  }, [])

  const close = useCallback((): void => {
    for (const unsubscribe of unsubscribersRef.current) {
      unsubscribe()
    }
    unsubscribersRef.current = []

    const peer = peerRef.current
    peerRef.current = null
    sessionKeyRef.current = null
    activeRef.current = false
    peer?.close()

    setConnectionState('closed')
    setStoreConnectionState('closed')
  }, [setStoreConnectionState])

  const initAsHost = useCallback(async (): Promise<RTCSessionDescriptionInit> => {
    return await requirePeer().initAsHost()
  }, [requirePeer])

  const receiveOffer = useCallback(
    async (offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> => {
      return await requirePeer().receiveOffer(offer)
    },
    [requirePeer],
  )

  const receiveAnswer = useCallback(
    async (answer: RTCSessionDescriptionInit): Promise<void> => {
      await requirePeer().receiveAnswer(answer)
    },
    [requirePeer],
  )

  const addIceCandidate = useCallback(
    async (candidate: RTCIceCandidateInit): Promise<void> => {
      await requirePeer().addIceCandidate(candidate)
    },
    [requirePeer],
  )

  const send = useCallback(
    (message: WireMessage): void => {
      requirePeer().send(message)
    },
    [requirePeer],
  )

  const sendAwaitable = useCallback(
    (message: WireMessage): Promise<void> => {
      return requirePeer().sendAwaitable(message)
    },
    [requirePeer],
  )

  const waitForBackpressure = useCallback(async (): Promise<void> => {
    await peerRef.current?.waitForBackpressure()
  }, [])

  const releaseBackpressure = useCallback((): void => {
    peerRef.current?.releaseBackpressure()
  }, [])

  const markActive = useCallback((): void => {
    activeRef.current = true
    peerRef.current?.markActive()
  }, [])

  const drain = useCallback(async (): Promise<void> => {
    await peerRef.current?.drain()
  }, [])

  // Safety net: closing again from the caller is a no-op, so either teardown
  // path may run first without breaking the other.
  useEffect(() => {
    return () => {
      close()
    }
  }, [close])

  return {
    connectionState,
    createPeer,
    initAsHost,
    receiveOffer,
    receiveAnswer,
    addIceCandidate,
    setSessionKey,
    send,
    sendAwaitable,
    waitForBackpressure,
    releaseBackpressure,
    markActive,
    drain,
    close,
  }
}

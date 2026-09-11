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
import type { HelloMessage, PeerConnectionOptions } from '../lib/webrtc'
import { useSessionStore } from '../store/sessionStore'

export interface UseWebRTCHandlers {
  /** A local ICE candidate to relay to the peer over signaling. */
  onIceCandidate: (candidate: RTCIceCandidateInit) => void
  /** A message arrived on the DataChannel. */
  onMessage: (message: HelloMessage) => void
  /** The DataChannel is open; the session can start exchanging items. */
  onOpen: () => void
}

export interface UseWebRTCResult {
  connectionState: RTCPeerConnectionState
  /** Constructs the peer. No-op if one already exists. */
  createPeer: (options?: PeerConnectionOptions) => void
  initAsHost: () => Promise<RTCSessionDescriptionInit>
  receiveOffer: (offer: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>
  receiveAnswer: (answer: RTCSessionDescriptionInit) => Promise<void>
  addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>
  send: (message: HelloMessage) => void
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
    ]
  }, [setStoreConnectionState])

  const close = useCallback((): void => {
    for (const unsubscribe of unsubscribersRef.current) {
      unsubscribe()
    }
    unsubscribersRef.current = []

    const peer = peerRef.current
    peerRef.current = null
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
    (message: HelloMessage): void => {
      requirePeer().send(message)
    },
    [requirePeer],
  )

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
    send,
    close,
  }
}

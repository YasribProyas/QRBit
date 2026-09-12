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
import { CHUNK_SIZE, FileAssembler, chunkFile } from '../lib/chunker'
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
import type { WireMessage } from '../lib/protocol'
import { bytesToPhrase } from '../lib/safetyPhrase'
import { SignalingClient, isPeerRejoinedCue, shouldHostSendOffer } from '../lib/signaling'
import type { SessionRole, SignalingMessage } from '../lib/signaling'
import type { PeerConnectionOptions } from '../lib/webrtc'
import { isItemMessage } from '../lib/webrtc'
import { useSessionStore } from '../store/sessionStore'
import type { SessionItem, SessionPhase } from '../store/sessionStore'
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

/** PLAN.md §19 decision 8: the delay between the last keystroke and its delta. */
export const TEXT_DELTA_DEBOUNCE_MS = 100

/**
 * Progress is written to the store in 10% steps (PLAN.md §9).
 *
 * A 1 GiB transfer is ~65k chunks and a store write per chunk would re-render the
 * board 65k times, so intermediate values are dropped: only a jump of at least 10%
 * — plus the final 100% — reaches React.
 */
const PROGRESS_STEP_PERCENT = 10

/**
 * Whether the session may carry item traffic (PLAN.md §8).
 *
 * Read from the store rather than captured in a closure: every caller is a timer,
 * a frame handler or a pump that outlives the render it was created in, and a
 * captured phase would let them keep writing after the session ended.
 */
function sessionIsActive(): boolean {
  return useSessionStore.getState().phase === 'active'
}

/** The live copy of one item, or null when this session does not carry that id. */
function findSessionItem(id: string): SessionItem | null {
  return useSessionStore.getState().items.find((item) => item.id === id) ?? null
}

/**
 * PLAN.md §9's type for a chunked file: `image` for an image MIME type, `file`
 * otherwise.
 *
 * The same rule as `chunker.ts`'s private `announceTypeFor`, which decides the type
 * the peer stores: the sender's own row must not claim a different type from the one
 * it announces, and the test for `addFileItem` pins the two together.
 */
function localTypeFor(mimeType: string): 'image' | 'file' {
  return mimeType.startsWith('image/') ? 'image' : 'file'
}

/**
 * Maps an inbound `item-announce` onto the store item it creates (PLAN.md §9/§10).
 *
 * Returns null for a `locked` announce: Phase 4 owns locked items end to end (the
 * composing UI, `locked-payload` and `encryptItem`/`decryptItem` in `lib/crypto.ts`),
 * so this phase neither stores nor renders one.
 *
 * Optional announce fields are defaulted rather than trusted — the peer is a holder
 * of the session key, not a trusted party (PLAN.md §2). An announce with no
 * `totalChunks` derives them from `totalSize`; with neither, the item is an empty
 * file whose `file-done` completes immediately.
 *
 * Text and rich-text items are created as `complete`: their content streams live, so
 * there is no transfer for `pending`/`transferring` to describe.
 */
export function itemFromAnnounce(
  message: Extract<WireMessage, { t: 'item-announce' }>,
  createdAt: number,
): SessionItem | null {
  const { id } = message

  switch (message.type) {
    case 'text':
      return { id, type: 'text', status: 'complete', createdAt, content: '' }

    case 'richtext':
      return { id, type: 'richtext', status: 'complete', createdAt, content: '' }

    case 'image':
    case 'file': {
      const totalSize = message.totalSize ?? 0
      const totalChunks = message.totalChunks ?? Math.ceil(totalSize / CHUNK_SIZE)
      return {
        id,
        type: message.type,
        status: 'pending',
        createdAt,
        // A nameless announce still has to render: the board shows one file row per
        // item and an empty name would be indistinguishable from a layout bug.
        fileName: message.fileName ?? 'file',
        mimeType: message.mimeType ?? '',
        totalSize,
        totalChunks,
        progress: 0,
      }
    }

    case 'locked':
      return null
  }
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

  /**
   * The items API (PLAN.md §9/§10/§12), exactly the surface
   * `components/session/SessionBoard.tsx` declares as `ItemsApi` and the item
   * components call through it.
   *
   * Every method is a no-op while the session is not `active` — the board is only
   * rendered then, but the transport must not depend on that. The peer enforces the
   * same rule a second time (`markActive()`), so a forgotten check here cannot put
   * an item frame on the wire early.
   */
  /** Announces a new text item and returns its id ('' when the session is not active). */
  addTextItem: (initialContent?: string) => string
  /** Announces a new rich-text item and returns its id ('' when not active). */
  addRichTextItem: (initialJson?: string) => string
  /** Announces a new image/file item, starts its chunk pump, and returns its id. */
  addFileItem: (file: File) => string
  /** Updates the sender's own row immediately; the wire delta is debounced 100ms. */
  updateTextItem: (id: string, content: string) => void
  /** Updates the sender's own row immediately; the wire delta is debounced 100ms. */
  updateRichTextItem: (id: string, json: string) => void
  /** Sends `item-delete` and removes the item on this device. */
  deleteItem: (id: string) => void
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
  const upsertItem = useSessionStore((state) => state.upsertItem)
  const updateItem = useSessionStore((state) => state.updateItem)
  const removeItem = useSessionStore((state) => state.removeItem)

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
  const confirmSentRef = useRef(false)

  /**
   * Per-item transfer state. Deliberately refs, not state: the assemblers hold the
   * file bytes, the pumps hold the session's timing, and none of it is rendered —
   * putting it in React state would re-render the board per chunk.
   */
  const assemblersRef = useRef(new Map<string, FileAssembler>())
  /** The last progress value written to the store for an item (throttle, see PROGRESS_STEP_PERCENT). */
  const writtenProgressRef = useRef(new Map<string, number>())
  const debounceTimersRef = useRef(new Map<string, number>())
  const pumpsRef = useRef(new Map<string, () => void>())

  const handleIceCandidate = useCallback((candidate: RTCIceCandidateInit): void => {
    try {
      signalingRef.current?.send({ type: 'ice', candidate })
    } catch {
      // The signaling socket has gone away. The DataChannel does not need ICE
      // relayed any more, so there is nothing to report here.
    }
  }, [])

  const cancelDebounce = useCallback((id: string): void => {
    const timer = debounceTimersRef.current.get(id)
    if (timer === undefined) return
    window.clearTimeout(timer)
    debounceTimersRef.current.delete(id)
  }, [])

  /**
   * Records how much of an item has moved (PLAN.md §9), at most once per 10%.
   *
   * The value is derived from what has actually been sent or received, never from an
   * accumulating counter, so a dropped write costs nothing but a coarser progress
   * ring. Writes are the only per-item store updates during a transfer, which is what
   * keeps a 65k-chunk file from thrashing React.
   *
   * `blobFor` is the receiver's partial-blob source (PLAN.md §9's progressive
   * reveal). It is called only when a value is actually published — the same 10%
   * boundary as the progress write, so at most ~10 partial Blobs are built per item
   * rather than one per chunk. The sender's pump passes nothing: its item already
   * carries the source file.
   */
  const writeProgress = useCallback(
    (id: string, received: number, total: number, blobFor?: () => Blob): void => {
      const progress = total <= 0 ? 100 : Math.floor((received / total) * 100)
      const written = writtenProgressRef.current.get(id) ?? -1
      // The final 100% is always written: it is the one value the UI waits for.
      if (progress < 100 && progress - written < PROGRESS_STEP_PERCENT) return
      writtenProgressRef.current.set(id, progress)

      const blob = blobFor?.()
      updateItem(id, (current) => {
        if (current.type !== 'image' && current.type !== 'file') return current
        return {
          ...current,
          progress,
          status: current.status === 'complete' ? 'complete' : 'transferring',
          ...(blob === undefined ? {} : { blob }),
        }
      })
    },
    [updateItem],
  )

  /**
   * Removes an item and its transfer state from this device only.
   *
   * Separate from `deleteItem` because the peer's `item-delete` lands here too: an
   * inbound delete must not be echoed back, or two devices would ping-pong the same
   * removal forever.
   */
  const forgetItem = useCallback(
    (id: string): void => {
      cancelDebounce(id)
      const cancelPump = pumpsRef.current.get(id)
      if (cancelPump) cancelPump()
      pumpsRef.current.delete(id)
      assemblersRef.current.delete(id)
      writtenProgressRef.current.delete(id)
      removeItem(id)
    },
    [cancelDebounce, removeItem],
  )

  /**
   * `item-announce` → a store item (PLAN.md §9).
   *
   * The first announce for an id wins: re-announcing an existing item must not wipe
   * content or an in-flight transfer, which is exactly what a hostile peer would aim
   * for. A `locked` announce is dropped — Phase 4 owns locked items.
   */
  const handleItemAnnounce = useCallback(
    (message: Extract<WireMessage, { t: 'item-announce' }>): void => {
      if (findSessionItem(message.id) !== null) return

      const item = itemFromAnnounce(message, Date.now())
      if (item === null) return

      if (item.type === 'image' || item.type === 'file') {
        assemblersRef.current.set(item.id, new FileAssembler())
      }
      upsertItem(item)
    },
    [upsertItem],
  )

  /**
   * `file-chunk` → the item's assembler (PLAN.md §12).
   *
   * A chunk for an id that has no accepted announce is dropped rather than buffered:
   * buffering would let a peer make this device allocate memory for items that were
   * never announced (PLAN.md §2 — holding the session key does not make the peer
   * trusted). Chunks past the announced total are dropped for the same reason: the
   * assembler can only ever hold as many chunks as the announce declared.
   *
   * The assembler is also what keeps the sender's own item out of this path: only
   * `handleItemAnnounce` ever creates one, and it refuses an id the board already
   * carries, so a chunk echoed back for an item this device created finds nothing
   * here and is dropped.
   */
  const handleFileChunk = useCallback(
    (message: Extract<WireMessage, { t: 'file-chunk' }>): void => {
      const assembler = assemblersRef.current.get(message.id)
      if (assembler === undefined) return

      const item = findSessionItem(message.id)
      if (item === null || (item.type !== 'image' && item.type !== 'file')) return
      if (message.index >= item.totalChunks) return

      assembler.addChunk(message.index, message.data)
      // PLAN.md §9's progressive reveal: the same throttle decision as the progress
      // write, so the partial Blob lands on the 10% boundaries and never carries an
      // object URL — the components own those (and their revocation).
      writeProgress(message.id, assembler.chunkCount(), item.totalChunks, () =>
        assembler.assemblePrefix(item.mimeType),
      )
    },
    [writeProgress],
  )

  /**
   * `file-done` → the assembled Blob on the item (PLAN.md §12, §17).
   *
   * `isComplete` walks the declared range, so it is only reached once the assembler
   * actually holds that many chunks: a hostile announce claiming 10^15 chunks and
   * sending nothing then costs one integer comparison and allocates nothing. The Blob
   * lives on the store item in memory only — never IndexedDB, the Cache API or
   * localStorage (AGENTS.md, PLAN.md §17).
   */
  const handleFileDone = useCallback(
    (id: string): void => {
      const assembler = assemblersRef.current.get(id)
      const item = findSessionItem(id)
      if (assembler === undefined || item === null) return
      if (item.type !== 'image' && item.type !== 'file') return
      if (assembler.chunkCount() !== item.totalChunks) return
      if (!assembler.isComplete(item.totalChunks)) return

      let blob: Blob
      try {
        blob = assembler.assemble(item.mimeType)
      } catch {
        // A gap in the run (a chunk that never arrived, or invented indices). An
        // incomplete transfer must never be shown as a file that is silently
        // truncated, so the item is left as it is.
        return
      }

      assemblersRef.current.delete(id)
      writtenProgressRef.current.delete(id)
      updateItem(id, (current) => {
        if (current.type !== 'image' && current.type !== 'file') return current
        return { ...current, status: 'complete', progress: 100, blob }
      })
    },
    [updateItem],
  )

  const handlePeerMessage = useCallback(
    (message: WireMessage): void => {
      // PLAN.md §8: the same classification the send gate uses — only the two control
      // frames may be handled before BOTH devices confirmed the phrase, so a peer that
      // holds the session key cannot populate the board while the safety-phrase overlay
      // is still up.
      //
      // Read from the store per frame, never captured and never derived from the phase:
      // the peer legitimately reaches 'active' a tick before this device's
      // phase-transition effect runs, so a phase-based gate would drop legitimate
      // frames arriving in that window.
      if (isItemMessage(message) && !useSessionStore.getState().bothConfirmed()) return

      switch (message.t) {
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
        case 'item-announce': {
          handleItemAnnounce(message)
          return
        }
        case 'text-delta': {
          // A delta for an id this session does not carry is a no-op, which is what
          // drops a delta whose announce never came.
          updateItem(message.id, (current) =>
            current.type === 'text' ? { ...current, content: message.content } : current,
          )
          return
        }
        case 'richtext-delta': {
          updateItem(message.id, (current) =>
            current.type === 'richtext' ? { ...current, content: message.content } : current,
          )
          return
        }
        case 'file-chunk': {
          handleFileChunk(message)
          return
        }
        case 'file-done': {
          handleFileDone(message.id)
          return
        }
        case 'item-delete': {
          forgetItem(message.id)
          return
        }
        case 'locked-payload': {
          // Phase 4 owns locked items end to end; the frame is valid on the wire
          // (protocol.ts) but means nothing to this phase yet.
          return
        }
      }
    },
    [endSession, forgetItem, handleFileChunk, handleFileDone, handleItemAnnounce, setPeerConfirmed, updateItem],
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
    sendAwaitable,
    waitForBackpressure,
    releaseBackpressure,
    markActive,
    drain,
    close,
  } = webRtc

  /**
   * Drops every trace of per-item transfer work: pumps, debounce timers, assemblers
   * and throttle state. The store's items are left alone — the UI still shows them
   * until the session is reset.
   *
   * The cancelled pumps still have to be woken: a pump parked in
   * `waitForBackpressure()` would otherwise keep its closure — and the `File` it
   * holds — alive until the channel closes, which on the `session-end` path is not
   * part of this teardown at all.
   *
   * Nothing here revokes object URLs: those belong to the components that created
   * them (`FileItem`/`ImageItem` revoke on unmount), because the transport never made
   * one and cannot know which of its Blobs are on screen.
   */
  const stopItemWork = useCallback((): void => {
    for (const cancel of pumpsRef.current.values()) cancel()
    pumpsRef.current.clear()
    for (const timer of debounceTimersRef.current.values()) window.clearTimeout(timer)
    debounceTimersRef.current.clear()
    assemblersRef.current.clear()
    writtenProgressRef.current.clear()
    releaseBackpressure()
  }, [releaseBackpressure])

  /**
   * Sends one item frame.
   *
   * Every call site is behind the `active` check, and the peer refuses item frames
   * until `markActive()` besides, so a throw here means a teardown race or a bug.
   * Reporting it beats losing the frame silently — the same contract the other sends
   * in this hook use.
   */
  const sendItemFrame = useCallback(
    (message: WireMessage): void => {
      try {
        send(message)
      } catch (error) {
        endSession(describeError(error))
      }
    },
    [send, endSession],
  )

  /**
   * Schedules the delta for an item, replacing any delta already pending for it
   * (PLAN.md §19 decision 8).
   *
   * One timer per item, and the frame carries the item's FULL content, so the newest
   * content is the only one worth sending: dropping a superseded delta loses nothing.
   */
  const scheduleDelta = useCallback(
    (message: Extract<WireMessage, { t: 'text-delta' | 'richtext-delta' }>): void => {
      const { id } = message
      cancelDebounce(id)

      const timer = window.setTimeout(() => {
        debounceTimersRef.current.delete(id)
        if (!sessionIsActive()) return
        sendItemFrame(message)
      }, TEXT_DELTA_DEBOUNCE_MS)
      debounceTimersRef.current.set(id, timer)
    },
    [cancelDebounce, sendItemFrame],
  )

  /**
   * Streams one file into the single outbound queue (PLAN.md §9/§12).
   *
   * This pump is what makes items independent. It awaits each chunk's write and then
   * the channel draining below `FILE_PUMP_BUFFER_THRESHOLD`, so a `text-delta`
   * appended while a 1 GiB file is in flight waits for one 16 KiB chunk instead of
   * for the whole file. `chunkFile` yields the announce, every chunk and the done
   * frame, so each file has exactly one ordered source; several files run their own
   * pumps and share the channel without a global coordinator.
   *
   * The pump re-checks the session before every frame: a session that ends (or is
   * restarted) mid-transfer stops the loop and returns, so no frame is ever queued
   * into a closed channel.
   *
   * The announce is emitted here, by the pump, because PLAN.md §12 makes it the head of
   * the file's stream — which also means it is enqueued one microtask after
   * `addFileItem` returns. A file and a text item added in the same task can therefore
   * reach the peer in the opposite order from this device's own board; the local rows
   * themselves are created synchronously in `addFileItem`.
   */
  const startFilePump = useCallback(
    (id: string, file: File, totalChunks: number): void => {
      let cancelled = false
      pumpsRef.current.set(id, () => {
        cancelled = true
      })

      const markErrored = (): void => {
        updateItem(id, (current) =>
          current.type === 'file' || current.type === 'image'
            ? { ...current, status: 'error' }
            : current,
        )
      }

      const run = async (): Promise<void> => {
        let sent = 0
        try {
          for await (const frame of chunkFile(id, file)) {
            if (cancelled || !sessionIsActive()) return

            if (frame.t === 'file-chunk') {
              // The one yield point: the next 16 KiB only goes out once the channel is
              // below the threshold, which is where a control frame gets its turn.
              await waitForBackpressure()
              if (cancelled || !sessionIsActive()) return
            }

            await sendAwaitable(frame)

            if (frame.t === 'file-chunk') {
              sent += 1
              writeProgress(id, sent, totalChunks)
            }
          }
        } catch {
          // A pump cancelled by teardown wakes from an await and exits here; that is
          // not a failure to report. Anything else (an unreadable file, a channel that
          // went away) is this item's error, not the session's.
          if (!cancelled && sessionIsActive()) markErrored()
          return
        } finally {
          pumpsRef.current.delete(id)
        }

        if (cancelled || !sessionIsActive()) return
        writtenProgressRef.current.delete(id)
        updateItem(id, (current) =>
          current.type === 'file' || current.type === 'image'
            ? { ...current, status: 'complete', progress: 100 }
            : current,
        )
      }

      void run()
    },
    [sendAwaitable, updateItem, waitForBackpressure, writeProgress],
  )

  const addTextItem = useCallback(
    (initialContent?: string): string => {
      if (!sessionIsActive()) return ''

      const id = crypto.randomUUID()
      const content = initialContent ?? ''
      upsertItem({ id, type: 'text', status: 'complete', createdAt: Date.now(), content })
      sendItemFrame({ t: 'item-announce', id, type: 'text' })
      // The announce carries no content, so an item that starts non-empty needs its
      // first delta immediately rather than on the first keystroke.
      if (content !== '') sendItemFrame({ t: 'text-delta', id, content })
      return id
    },
    [sendItemFrame, upsertItem],
  )

  const addRichTextItem = useCallback(
    (initialJson?: string): string => {
      if (!sessionIsActive()) return ''

      const id = crypto.randomUUID()
      const content = initialJson ?? ''
      upsertItem({ id, type: 'richtext', status: 'complete', createdAt: Date.now(), content })
      sendItemFrame({ t: 'item-announce', id, type: 'richtext' })
      if (content !== '') sendItemFrame({ t: 'richtext-delta', id, content })
      return id
    },
    [sendItemFrame, upsertItem],
  )

  const addFileItem = useCallback(
    (file: File): string => {
      if (!sessionIsActive()) return ''

      // The id is generated here and handed to `chunkFile`, so the local row and the
      // frames the peer receives carry the same id from the first frame on (PLAN.md §9).
      const id = crypto.randomUUID()
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

      upsertItem({
        id,
        type: localTypeFor(file.type),
        status: 'pending',
        createdAt: Date.now(),
        fileName: file.name,
        mimeType: file.type,
        totalSize: file.size,
        totalChunks,
        progress: 0,
        // The sender's own row has its bytes from the start: a `File` IS a `Blob`, so
        // this is the source object itself — no copy, no `arrayBuffer()`. It is what
        // gives the image its local preview and the file row its download link
        // immediately, and it is never overwritten: receiving writes (progress,
        // partial blobs) only ever run for an id this device did not create.
        blob: file,
      })
      startFilePump(id, file, totalChunks)
      return id
    },
    [startFilePump, upsertItem],
  )

  const updateTextItem = useCallback(
    (id: string, content: string): void => {
      if (!sessionIsActive()) return

      // The sender's own row follows every keystroke; only the wire is debounced, so
      // the person typing never sees their own text lag.
      updateItem(id, (current) => (current.type === 'text' ? { ...current, content } : current))
      scheduleDelta({ t: 'text-delta', id, content })
    },
    [scheduleDelta, updateItem],
  )

  const updateRichTextItem = useCallback(
    (id: string, json: string): void => {
      if (!sessionIsActive()) return

      updateItem(id, (current) =>
        current.type === 'richtext' ? { ...current, content: json } : current,
      )
      scheduleDelta({ t: 'richtext-delta', id, content: json })
    },
    [scheduleDelta, updateItem],
  )

  const deleteItem = useCallback(
    (id: string): void => {
      if (!sessionIsActive()) return

      forgetItem(id)
      sendItemFrame({ t: 'item-delete', id })
    },
    [forgetItem, sendItemFrame],
  )

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
      confirmSentRef.current = false
      stopItemWork()
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
      // Every per-item pump, timer and assembler belongs to this attempt; none of
      // them may survive into the next one.
      stopItemWork()
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
    stopItemWork,
  ])

  /**
   * Opens the item gate once the session is genuinely active (PLAN.md §8).
   *
   * The transport refuses item frames until this point, so the human comparison of
   * the three words is what authorises item traffic — not the handshake, and not the
   * render that drew the board.
   */
  useEffect(() => {
    if (phase === 'active') markActive()
  }, [phase, markActive])

  /**
   * PLAN.md §19 decision 10: sessions are single-use, so a finished session leaves no
   * live transfer work behind — no pump waiting on a channel, no assembler holding
   * file bytes, no timer that could still write.
   */
  useEffect(() => {
    if (phase === 'ended') stopItemWork()
  }, [phase, stopItemWork])

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
    // Stop feeding the queue first, so the session-end is not queued behind a file
    // that is still mid-transfer.
    stopItemWork()

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
  }, [send, drain, close, endSession, stopItemWork])

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
    safetyPhrase,
    phraseConfirmed,
    peerConfirmed,
    confirmPhrase,
    abort,
    restart,
    addTextItem,
    addRichTextItem,
    addFileItem,
    updateTextItem,
    updateRichTextItem,
    deleteItem,
  }
}

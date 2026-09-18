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
 *
 * PHASE 4: a locked item is encrypted here, on the sending device, under a password
 * that never crosses the wire (`addLockedItem`), announced and then delivered as one
 * `locked-payload` frame, and decrypted back into memory only when a user types that
 * password (`unlockItem`). Its plaintext lives on the store item for as long as the
 * session does — never in IndexedDB, the Cache API or localStorage (PLAN.md §16
 * Phase 4, §17).
 *
 * PHASE 5: a library item can be sent without leaving the session (`sendLibraryItem`),
 * and items selected on the Home screen wait in a module-scoped queue until a session
 * goes active (decision D8). Nothing on that path is persistent: the queue is an
 * in-memory array, and a locked library item travels as the `{ciphertext, iv, salt}`
 * tuple it is stored as — the send path never asks for a password and never decrypts
 * (decision D9). This module imports only the library's TYPES, so the session hook
 * cannot reach IndexedDB even by accident.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { buildNewSessionUrl, buildTurnCredentialsUrl, SIGNALING_WS_URL } from '../config'
import { CHUNK_SIZE, FileAssembler, chunkFile } from '../lib/chunker'
import {
  LOCKED_ITEM_MAX_PLAINTEXT_BYTES,
  decryptItem,
  deriveSafetyPhraseBytes,
  deriveSessionKey,
  deriveSharedSecret,
  encryptItem,
  exportPublicKey,
  fromBase64,
  generateKeypair,
  importPeerPublicKey,
  toBase64,
} from '../lib/crypto'
import type { LibraryItem } from '../lib/library'
import type { LockedInnerType, WireMessage } from '../lib/protocol'
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

export interface TurnCredentials {
  username: string
  credential: string
  urls?: string[]
}

interface NewSessionResponse {
  code: string
  turnCredentials?: TurnCredentials
}

/**
 * A host session this device ALREADY minted through `/session/new` (PLAN.md §16 Phase 6).
 *
 * The Home screen mints so its QR can show a live code; handing the same bundle to this
 * hook is what keeps one user intent to ONE session. Without it the host page would mint
 * a second code and the peer that scanned the first one would wait on a session nobody
 * ever joins. The bundle carries the TURN credentials that came with the code, because
 * they were issued for that session and are not re-obtainable without minting again.
 */
export interface HostSession {
  code: string
  turnCredentials?: TurnCredentials | null
}

/**
 * The Phase 1 session-code alphabet, mirrored from the worker's `codes.ts`
 * (`SESSION_CODE_ALPHABET`) and from the URL-scoped twin in `lib/barcode.ts`. The frontend
 * does not depend on the worker package, so the rule is restated: 30 symbols, with the
 * glyphs a human misreads (0, 1, I, L, O, U) left out.
 *
 * The match below is EXACT — no case folding and no character repair. The worker issues
 * codes from this uppercase alphabet and does not normalise a lookup, so a repaired code
 * would address a session that does not exist.
 */
export const SESSION_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

/** `SESSION_CODE_LENGTH` in the worker's `codes.ts`. */
export const SESSION_CODE_LENGTH = 8

/** A well-formed session code: 8 characters, all from the alphabet, exactly as issued. */
export function isValidSessionCode(value: string): boolean {
  if (value.length !== SESSION_CODE_LENGTH) return false
  for (const character of value) {
    if (!SESSION_CODE_ALPHABET.includes(character)) return false
  }
  return true
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
 * The four values a locked item is composed from (PLAN.md §16 Phase 4).
 *
 * `content` is the raw string for `text`, the Tiptap JSON for `richtext`, and the
 * `File` itself for `file` — the same content the compose modal collects. This
 * interface and the modal's own `LockedItemInput` describe one contract from two
 * sides of the same seam (a hook must not import a component), and `pages/Session.tsx`
 * hands this hook's result to `AddItemBar`, which is where the two are checked against
 * each other: a drift between them stops that page from compiling.
 */
export interface AddLockedItemInput {
  label: string
  innerType: LockedInnerType
  password: string
  content: string | File
}

/**
 * D6's cap in the unit its error message is worded in. Derived, never re-typed: the
 * number itself belongs to `lib/crypto.ts`.
 */
const LOCKED_ITEM_MAX_PLAINTEXT_MIB = LOCKED_ITEM_MAX_PLAINTEXT_BYTES / (1024 * 1024)

/**
 * D6's rejection, worded as an action: the regular item named here is still encrypted
 * end to end in transit, so the secret is not being asked to travel in the clear.
 */
function lockedItemTooLargeMessage(alternative: string): string {
  return `a locked item carries at most ${LOCKED_ITEM_MAX_PLAINTEXT_MIB} MiB — send it as ${alternative} instead`
}

/** Bytes AES-GCM appends to its plaintext; `encryptItem` produces ciphertext + tag. */
const GCM_TAG_BYTE_LENGTH = 16

/**
 * D6's cap, re-checked on the path that sends an ALREADY-ENCRYPTED library item.
 *
 * The tuple a library locked item holds was produced by `encryptItem` at compose time,
 * where D6 is enforced, so it is within the cap by construction — but a stored row is
 * input, not a guarantee, and this is the only frame in the protocol that carries a
 * whole item. Asserting here means an oversized tuple fails with a message that names
 * the limit instead of becoming an opaque encoder rejection after the announce has
 * already gone out.
 */
function assertSendableLockedTuple(ciphertext: Uint8Array): void {
  if (ciphertext.byteLength <= LOCKED_ITEM_MAX_PLAINTEXT_BYTES + GCM_TAG_BYTE_LENGTH) return
  throw new Error(
    `this locked item is larger than the ${LOCKED_ITEM_MAX_PLAINTEXT_MIB} MiB a locked item may carry`,
  )
}

/**
 * The bytes `encryptItem` is about to lock (PLAN.md §11.4, §16 Phase 4).
 *
 * Text and rich text are their UTF-8 bytes; a file is read out of the `File`. That
 * read is one-way on purpose: PLAN.md §9's `LockedItem` has no plaintext field, so the
 * sender's row keeps the ciphertext and nothing else — unlike a regular file item,
 * which keeps its source `File` for the preview.
 *
 * D6 is enforced here for EVERY inner type, not only `file`: a locked item travels in
 * ONE frame under `WIRE_MAX_FRAME_BYTES`, so the cap belongs to the plaintext the frame
 * has to carry. A file is measured before it is even read, text after it is encoded.
 * The compose modal checks the same cap for the user's benefit; this is the gate.
 *
 * The caller zeroes the returned buffer once it has been encrypted.
 */
async function lockedPlaintextFor(
  innerType: LockedInnerType,
  content: string | File,
): Promise<Uint8Array> {
  if (innerType === 'file') {
    if (!(content instanceof File)) {
      throw new Error('a locked file item needs a File to encrypt')
    }
    if (content.size > LOCKED_ITEM_MAX_PLAINTEXT_BYTES) {
      throw new Error(lockedItemTooLargeMessage('a regular file item'))
    }
    return new Uint8Array(await content.arrayBuffer())
  }

  if (typeof content !== 'string') {
    throw new Error(`a locked ${innerType} item needs a string to encrypt`)
  }

  // Measured on the ENCODED bytes — the same unit the file branch uses and the only
  // unit the frame's bound is about. Without this check an oversized locked text item
  // sends a `locked-payload` past `WIRE_MAX_FRAME_BYTES`, which the receiver drops
  // silently while the sender's row already reads 'complete'.
  const bytes = new TextEncoder().encode(content)
  if (bytes.byteLength > LOCKED_ITEM_MAX_PLAINTEXT_BYTES) {
    throw new Error(
      lockedItemTooLargeMessage(
        innerType === 'richtext' ? 'a regular rich text item' : 'a regular text item',
      ),
    )
  }
  return bytes
}

/**
 * Encrypts the plaintext and drops this device's copy of it, whichever way the
 * encryption goes (PLAN.md §11.4).
 *
 * Only the `{ ciphertext, iv, salt }` tuple leaves this function — never the
 * plaintext, and never the key, which is derived inside `encryptItem` from a password
 * this function does not keep.
 */
async function encryptLockedContent(
  password: string,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }> {
  try {
    return await encryptItem(password, plaintext)
  } finally {
    zeroBytes(plaintext)
  }
}

/**
 * Turns decrypted bytes into the plaintext an unlocked item holds, and drops the copy
 * it was handed (PLAN.md §9).
 *
 * A file becomes a `Blob`: PLAN.md §9's `LockedItem` carries no MIME type and the wire
 * announces none, so the bytes are handed over with no declared type and the row's
 * download name falls back to the item's label. Everything else is text, decoded as
 * UTF-8 — `richtext` included, whose plaintext is a Tiptap JSON document.
 *
 * Both the buffer this is given and the copy the Blob is built from are zeroed, so the
 * only readable plaintext left anywhere is the item's own `plaintextContent`, which is
 * what the user asked to see and lives no longer than the session (AGENTS.md).
 */
function revealFromDecrypted(innerType: LockedInnerType, decrypted: Uint8Array): string | Blob {
  try {
    if (innerType !== 'file') return new TextDecoder().decode(decrypted)

    const bytes = decrypted.slice()
    try {
      return new Blob([bytes])
    } finally {
      zeroBytes(bytes)
    }
  } finally {
    zeroBytes(decrypted)
  }
}

/**
 * Whether a rejection from Web Crypto means "this password did not open this item".
 *
 * Matched by name, not with `instanceof DOMException`: the error object comes from
 * whichever realm implements Web Crypto, and under jsdom (whose `crypto.subtle` is
 * Node's) it is not this realm's `DOMException` — an `instanceof` test would miss it
 * and let a wrong password escape as an unhandled rejection, which is the one thing
 * the contract forbids. `OperationError` is what AES-GCM raises for a failed tag
 * check, an IV of the wrong length and a ciphertext too short to hold a tag: all of
 * them mean the item did not decrypt with what was supplied, never something a retry
 * with the same inputs would fix.
 */
function isFailedDecryption(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return 'name' in error && error.name === 'OperationError'
}

/** Whether an item still holds decrypted plaintext that a teardown must drop. */
function holdsUnlockedPlaintext(item: SessionItem): boolean {
  return item.type === 'locked' && (item.unlocked === true || item.plaintextContent !== undefined)
}

/**
 * Drops every unlocked plaintext from the board (AGENTS.md, PLAN.md §17).
 *
 * An unlock is a session-scoped reveal: the decrypted bytes live on the store item for
 * as long as this session does and nowhere else, so the teardown that drops the
 * assemblers drops them too. `unlocked` goes back to false with the plaintext, so no
 * half-cleared row can render.
 *
 * The ciphertext stays: it is what the password can bring back, and it is not a secret
 * this function is responsible for.
 *
 * Read from the store rather than through a hook selector because the callers are
 * teardown paths, not renders, and a captured snapshot would be stale by the time one
 * of them runs.
 */
function discardUnlockedPlaintext(): void {
  const store = useSessionStore.getState()
  if (!store.items.some(holdsUnlockedPlaintext)) return

  store.setItems(
    store.items.map((item) =>
      holdsUnlockedPlaintext(item)
        ? { ...item, unlocked: false, plaintextContent: undefined }
        : item,
    ),
  )
}

/**
 * Maps an inbound `item-announce` onto the store item it creates (PLAN.md §9/§10).
 *
 * Optional announce fields are defaulted rather than trusted — the peer is a holder
 * of the session key, not a trusted party (PLAN.md §2). An announce with no
 * `totalChunks` derives them from `totalSize`; with neither, the item is an empty
 * file whose `file-done` completes immediately.
 *
 * Text and rich-text items are created as `complete`: their content streams live, so
 * there is no transfer for `pending`/`transferring` to describe. A `locked` item is
 * the opposite — it arrives as an announce plus a `locked-payload`, so its row exists
 * before it can be opened and starts `transferring`.
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
      // PLAN.md §10 carries a locked item in two frames: the announce names it, and the
      // `locked-payload` that follows carries the ciphertext. Hence `transferring`, and
      // hence three empty byte fields — the row has a label to show and a place to put
      // the ciphertext, and nothing to decrypt yet. The arrays are fresh per item rather
      // than one shared constant: an empty `Uint8Array` is still mutable.
      return {
        id,
        type: 'locked',
        status: 'transferring',
        createdAt,
        label: message.label ?? '',
        innerType: message.innerType ?? 'text',
        ciphertext: new Uint8Array(0),
        iv: new Uint8Array(0),
        salt: new Uint8Array(0),
      }
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

/**
 * Mints a host session through the worker's `/session/new` route (PLAN.md §13, §16
 * Phase 6, ORCHESTRATION.md D10), for the Home screen's live QR.
 *
 * D10: /session/new returns { code } only. TURN credentials are now fetched separately
 * from /session/:code/turn at connect time.
 */
export async function mintHostSession(): Promise<HostSession> {
  const created = await requestNewSession()
  return { code: created.code }
}

/**
 * Validates the worker's `/session/:code/turn` payload (ORCHESTRATION.md D10, D11).
 *
 * Untrusted response: requires valid username and credential strings, and extracts
 * the authoritative URLs list. Returns null on any validation failure.
 */
export function parseTurnCredentialsResponse(value: unknown): TurnCredentials | null {
  if (!isRecord(value)) return null

  const username = value['username']
  const credential = value['credential']
  if (typeof username !== 'string' || username.trim() === '') return null
  if (typeof credential !== 'string' || credential.trim() === '') return null

  const rawUrls = value['urls'] ?? value['iceServers']
  let urls: string[] | undefined
  if (Array.isArray(rawUrls)) {
    urls = rawUrls.filter((u): u is string => typeof u === 'string' && u.trim() !== '')
  }

  return {
    username: username.trim(),
    credential: credential.trim(),
    urls,
  }
}

/**
 * Fetches short-lived TURN credentials from the worker's `/session/:code/turn` route
 * (ORCHESTRATION.md D10).
 *
 * Never throws: a network failure or 503 (TURN unavailable) degrades gracefully
 * to STUN-only by returning null without failing the session.
 */
export async function requestTurnCredentials(
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<TurnCredentials | null> {
  try {
    const response = await fetchFn(buildTurnCredentialsUrl(code), {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    return parseTurnCredentialsResponse(payload)
  } catch {
    return null
  }
}

/** Normalises anything thrown into a message safe to show the user. */
/**
 * WebSocket close codes from `apps/signaling-worker/src/session.ts`.
 * Translated here so the user never sees the raw integers.
 */
const SIGNALING_CLOSE_MESSAGES: Readonly<Record<number, string>> = {
  4404: 'Session not found or already ended. Scan a new QR code or ask the sender to refresh theirs.',
  4409: 'Someone else joined the session first. Ask the sender to tap “New code” and share the fresh QR.',
  4410: 'Session code has expired (codes last 5 minutes). The sender needs to tap “New code” to refresh.',
}

/** Returns a human-readable error string from the close code embedded in a signaling error. */
function translateSignalingCloseCode(message: string): string | null {
  const match = /\bcode (\d+)\b/.exec(message)
  if (match === null || match[1] === undefined) return null
  const code = parseInt(match[1], 10)
  return SIGNALING_CLOSE_MESSAGES[code] ?? null
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    const translated = translateSignalingCloseCode(error.message)
    if (translated !== null) return translated
    return error.message
  }
  if (typeof error === 'string' && error.trim() !== '') {
    const translated = translateSignalingCloseCode(error)
    if (translated !== null) return translated
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

// ---------------------------------------------------------------------------
// The pending-send queue (PLAN.md §7 'pre-select then send', §16 Phase 5, D8)
// ---------------------------------------------------------------------------

/**
 * Library items the user picked on the Home screen, waiting for a session to carry
 * them (ORCHESTRATION.md D8).
 *
 * MEMORY ONLY, and deliberately module-scoped: this is how a selection survives the
 * navigation from `/` to `/session` without touching localStorage, the Cache API or
 * IndexedDB (AGENTS.md). It is not session state either — a session that never
 * activates leaves the queue alone, so the same selection is still waiting for the
 * next attempt, and nothing here outlives the tab.
 */
let queuedLibrarySends: LibraryItem[] = []

/** Adds items to the pending-send queue, in the order they should be announced. */
export function queueLibrarySends(items: readonly LibraryItem[]): void {
  queuedLibrarySends = [...queuedLibrarySends, ...items]
}

/**
 * Discards everything in the pending-send queue.
 *
 * Call this when the user cancels a scan or starts a new scan selection so items
 * chosen for one scan attempt do not silently leak into a later one.
 */
export function clearLibrarySends(): void {
  queuedLibrarySends = []
}

/**
 * Takes everything in the queue; the caller owns those items now.
 *
 * The hook calls this once, on the render where the session goes active, so an item is
 * announced exactly once per selection. Nothing else consumes the queue — the
 * on-screen 📚 picker sends immediately and never queues.
 */
export function takeQueuedLibrarySends(): LibraryItem[] {
  const queued = queuedLibrarySends
  queuedLibrarySends = []
  return queued
}

/**
 * Puts items back at the front of the queue, ahead of anything selected since.
 *
 * The drain's escape hatch: an item the session never carried belongs to the next
 * attempt, and it was selected before whatever was queued while this one was live.
 */
function requeueLibrarySends(items: readonly LibraryItem[]): void {
  if (items.length === 0) return
  queuedLibrarySends = [...items, ...queuedLibrarySends]
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
 *
 * The precedence is the point, and it is ordered by what the user must act on:
 *
 *   1. a failure this device knows the reason for (`errorMessage`);
 *   2. the session having ended, which is terminal;
 *   3. a transport that FAILED or DROPPED — checked before the phase, because an
 *      'active' session whose peer connection just died would otherwise keep reading
 *      'Connected', which is the one label that can make a user wait for a transfer
 *      that can never arrive;
 *   4. connected — either the peer connection says so or both devices confirmed the
 *      phrase (PLAN.md §8);
 *   5. anything else is still connecting: PLAN.md §8's "Connecting…" with a spinner is
 *      the expected wait, not a fault, so it is neutral rather than amber.
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
  if (connectionState === 'failed') {
    return { label: 'Connection failed', tone: 'error' }
  }
  if (connectionState === 'disconnected') {
    return { label: 'Connection lost', tone: 'warn' }
  }
  if (connectionState === 'connected' || phase === 'active') {
    return { label: 'Connected', tone: 'ok' }
  }
  return { label: 'Connecting…', tone: 'idle' }
}

export interface UseSessionOptions {
  /** The `code` URL param. Present means guest; absent means host (PLAN.md §8). */
  code: string | null
  /**
   * A host code this device already minted (PLAN.md §16 Phase 6). Used ONLY when `code`
   * is absent, and only on the first attempt: the host joins this code instead of
   * creating a second session. `restart()` is a new session (PLAN.md §19 decision 10)
   * and mints fresh like every other host. An absent or malformed code falls back to
   * minting fresh rather than connecting to a code the worker will reject.
   */
  hostSession?: HostSession | null
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
   * Tells the peer the session is over, synchronously, for a page that is being
   * torn down (PLAN.md §16 Phase 8: the `beforeunload` path). Sends nothing when
   * there is no session that can still carry traffic, and changes no state of its
   * own — unlike `abort()`, which also ends the session (see the implementation).
   */
  notifyUnload: () => void

  /**
   * The items API (PLAN.md §9/§10/§12), exactly the surface
   * `components/session/SessionBoard.tsx` declares as `ItemsApi` and the item
   * components call through it.
   *
   * The methods that put a frame on the wire are no-ops (or, for the async locked-item
   * send, rejections) while the session is not `active` — the board is only rendered
   * then, but the transport must not depend on that. The peer enforces the same rule a
   * second time (`markActive()`), so a forgotten check here cannot put an item frame on
   * the wire early. Unlocking and re-hiding are local to this device and carry no frame,
   * so they are not gated on the phase of a session that is ending.
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

  /**
   * Phase 4 (PLAN.md §16): encrypts the composed content under `input.password` on
   * this device and sends the item as an announce plus a `locked-payload`. Resolves
   * with the new item's id once both frames have been written; rejects while the
   * session is not active, for content that does not match its inner type, and for a
   * locked FILE over D6's cap.
   */
  addLockedItem: (input: AddLockedItemInput) => Promise<string>
  /**
   * Phase 4: decrypts a locked item with the password the user typed. Resolves true
   * with the plaintext revealed in memory, false for a wrong password (never a
   * rejection for one), and rejects only when there is nothing here to unlock.
   */
  unlockItem: (id: string, password: string) => Promise<boolean>
  /** Phase 4: re-hides an item — `unlocked` back to false, plaintext dropped. */
  lockItemAgain: (id: string) => void

  /**
   * Phase 5 (PLAN.md §7/§16, decision D8): sends a library item as session traffic,
   * converting it per its type. Text and rich text announce and then carry their stored
   * content; an image or file runs the ordinary chunk pipeline from its stored blob; a
   * locked item announces and delivers the `{ciphertext, iv, salt}` tuple it is STORED
   * as, with no password, no key derivation and no decryption (decision D9).
   *
   * A no-op while the session is not active, like every other send. Throws only when a
   * stored locked tuple is over D6's cap — a state the store should not be able to
   * produce, and one whose own message is better than the encoder's.
   */
  sendLibraryItem: (item: LibraryItem) => void

  /**
   * ADDITIVE to PLAN.md §9's state: the items THIS DEVICE did not create.
   *
   * PLAN.md §8 Phase 4 saves "each received item" to the library, and the board cannot
   * tell received from sent by looking at an item: `useSession` created some of them
   * (through the add bar, or from the library) and only ever saw the others as
   * `item-announce` frames. The hook records which ids it created for exactly this
   * question, so the ended screen offers to save what actually arrived rather than
   * what this device already has.
   */
  receivedItems: SessionItem[]
}

export function useSession(options: UseSessionOptions): UseSessionResult {
  const { code, hostSession } = options

  const role = useSessionStore((state) => state.role)
  const phase = useSessionStore((state) => state.phase)
  const sessionCode = useSessionStore((state) => state.sessionCode)
  const connectionState = useSessionStore((state) => state.connectionState)
  const errorMessage = useSessionStore((state) => state.errorMessage)
  const safetyPhrase = useSessionStore((state) => state.safetyPhrase)
  const phraseConfirmed = useSessionStore((state) => state.phraseConfirmed)
  const peerConfirmed = useSessionStore((state) => state.peerConfirmed)
  /**
   * The board's items, subscribed here as well as in the board: the ended screen needs
   * to know what arrived (`receivedItems`), and that answer is this device's, not the
   * rendering component's.
   */
  const items = useSessionStore((state) => state.items)

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
   * The pre-minted host bundle, read through a ref so the run effect's dependency list
   * stays exactly what it was. Only the first attempt consumes it; `attempt` is already
   * a dependency, so a restart re-runs the effect and this ref is simply ignored there.
   */
  const hostSessionRef = useRef<HostSession | null>(null)
  useEffect(() => {
    hostSessionRef.current = hostSession ?? null
  }, [hostSession])
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
   * The ids of the items THIS DEVICE created — the add bar's items and the ones sent
   * from the library. Everything else on the board arrived over the wire, which is what
   * `receivedItems` filters on (PLAN.md §8 Phase 4, §9).
   */
  const locallyCreatedIdsRef = useRef(new Set<string>())

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
   * for.
   *
   * Only image and file items get a chunk assembler: a `locked` item is never chunked,
   * so its row waits for one `locked-payload` frame instead (see `handleLockedPayload`),
   * and neither text nor rich text has a transfer to assemble.
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

  /**
   * `locked-payload` → the ciphertext on the row its announce created (PLAN.md §10).
   *
   * The frame fills a row in and does nothing else. `updateItem` is a no-op for an id
   * this session does not carry, which is what drops a payload whose announce never
   * came; the `transferring` status is what makes the FIRST payload for an id win. That
   * matters twice over: a second payload cannot swap the ciphertext of an item the user
   * has already read the label of, and a peer cannot overwrite this device's OWN locked
   * item — a sender's row is `complete` with its own ciphertext from the moment it was
   * composed.
   *
   * Nothing here decrypts: the peer's bytes stay ciphertext until `unlockItem` is given
   * the password, which never came over the wire (PLAN.md §9/§17).
   */
  const handleLockedPayload = useCallback(
    (message: Extract<WireMessage, { t: 'locked-payload' }>): void => {
      updateItem(message.id, (current) => {
        if (current.type !== 'locked' || current.status !== 'transferring') return current
        return {
          ...current,
          status: 'complete',
          ciphertext: message.ciphertext,
          iv: message.iv,
          salt: message.salt,
        }
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
          handleLockedPayload(message)
          return
        }
      }
    },
    [
      endSession,
      forgetItem,
      handleFileChunk,
      handleFileDone,
      handleItemAnnounce,
      handleLockedPayload,
      setPeerConfirmed,
      updateItem,
    ],
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
    // Decrypted plaintext belongs to the session that produced it, so it goes out with
    // the transfer state: this runs on teardown, on the ended phase and at the start of
    // a fresh attempt, which are exactly the session boundaries (PLAN.md §1, §17).
    discardUnlockedPlaintext()
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
      locallyCreatedIdsRef.current.add(id)
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
      locallyCreatedIdsRef.current.add(id)
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

      locallyCreatedIdsRef.current.add(id)
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

  /**
   * Composes a locked item end to end (PLAN.md §9/§10/§11.4, §16 Phase 4).
   *
   * The order is the point: the content is encrypted HERE, on this device, before any
   * frame exists. The password never crosses the wire, and neither does anything it
   * unlocks. `encryptItem` is where the ~300ms PBKDF2 derivation lives (PLAN.md §19
   * decision 9), which is what the compose modal's spinner covers.
   *
   * The sender's own row carries the label, the inner type and the ciphertext — exactly
   * what the receiver's row carries, and deliberately NOT the plaintext: PLAN.md §9's
   * `LockedItem` has no field for it. The sender unlocks its own item through
   * `unlockItem` with the password it chose, which is the only way to be sure the item
   * really decrypts back to what was meant.
   *
   * Rejects, and sends nothing at all, when the session is not active, when the content
   * does not match its declared inner type, or when the content is over D6's cap
   * (a file before it is read, text and rich text once encoded).
   */
  const addLockedItem = useCallback(
    async (input: AddLockedItemInput): Promise<string> => {
      if (!sessionIsActive()) {
        throw new Error('a locked item can only be sent while the session is active')
      }

      const { label, innerType, password, content } = input
      const plaintext = await lockedPlaintextFor(innerType, content)
      const { ciphertext, iv, salt } = await encryptLockedContent(password, plaintext)

      // PBKDF2 takes ~300ms, long enough for the session to end underneath it. Sending
      // now would be refused by the transport's own gate, and a row whose payload never
      // left is a row neither device can explain.
      if (!sessionIsActive()) {
        throw new Error('the session ended before the locked item could be sent')
      }

      const id = crypto.randomUUID()
      locallyCreatedIdsRef.current.add(id)
      upsertItem({
        id,
        type: 'locked',
        status: 'complete',
        createdAt: Date.now(),
        label,
        innerType,
        ciphertext,
        iv,
        salt,
      })

      // Announce first, then the payload (PLAN.md §10): the peer creates its row from
      // the announce and fills in the ciphertext when the payload lands. Awaiting each
      // write — not merely enqueueing it — is what makes the contract's "after
      // encryption + send" literal, and the transport's single ordered queue would hold
      // the order anyway. A write that fails after the guard is reported through the
      // transport's `onSendError`, like every other item frame; a guard that fails (the
      // channel went away) rejects this promise, which is the compose modal's inline
      // error rather than a silently lost secret.
      await sendAwaitable({ t: 'item-announce', id, type: 'locked', label, innerType })
      await sendAwaitable({ t: 'locked-payload', id, ciphertext, iv, salt })
      return id
    },
    [sendAwaitable, upsertItem],
  )

  /**
   * Sends one item from this device's library (PLAN.md §7, §16 Phase 5, decision D8).
   *
   * The conversion is per type, and each case reuses the same path the add bar takes so
   * there is one spelling of "an item enters a session":
   *
   *   - text / rich text — announce, plus the stored content as the item's first delta.
   *     PLAN.md §10's announce carries no content, and this content is already final.
   *   - image / file — the stored `Blob` becomes a `File` under the item's name and MIME
   *     type and goes through the ordinary chunk pipeline, chunker and all. The row
   *     this device shows carries that `File`, exactly like a picked one.
   *   - locked — announce + `locked-payload`, carrying the STORED `{ciphertext, iv,
   *     salt}` untouched (decision D9): no password is asked for, no key is derived and
   *     nothing is decrypted, because the tuple is what travels and the receiver needs
   *     the password to open it. That is the double-encryption property PLAN.md §2
   *     promises, and a sender forwarding a locked item it cannot open is the normal
   *     case, not a failure.
   *
   * The active gate is the same one every send uses, and the drain that feeds this from
   * the D8 queue holds nothing but these calls.
   */
  const sendLibraryItem = useCallback(
    (item: LibraryItem): void => {
      if (!sessionIsActive()) return

      switch (item.type) {
        case 'text':
          addTextItem(item.content)
          return
        case 'richtext':
          addRichTextItem(item.content)
          return
        case 'image':
        case 'file':
          addFileItem(new File([item.blob], item.name, { type: item.mimeType }))
          return
        case 'locked': {
          assertSendableLockedTuple(item.ciphertext)

          const id = crypto.randomUUID()
          locallyCreatedIdsRef.current.add(id)
          upsertItem({
            id,
            type: 'locked',
            status: 'complete',
            createdAt: Date.now(),
            label: item.label,
            innerType: item.innerType,
            ciphertext: item.ciphertext,
            iv: item.iv,
            salt: item.salt,
          })
          sendItemFrame({
            t: 'item-announce',
            id,
            type: 'locked',
            label: item.label,
            innerType: item.innerType,
          })
          sendItemFrame({
            t: 'locked-payload',
            id,
            ciphertext: item.ciphertext,
            iv: item.iv,
            salt: item.salt,
          })
          return
        }
      }
    },
    [addFileItem, addRichTextItem, addTextItem, sendItemFrame, upsertItem],
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

  /**
   * Decrypts a locked item with the password the user just typed (PLAN.md §11.4, §17).
   *
   * Three outcomes, deliberately distinct:
   *
   *   - `true` — the item now holds `unlocked: true` and its plaintext, in memory only
   *     (AGENTS.md: never IndexedDB, the Cache API or localStorage).
   *   - `false` — that password is not the item's password. GCM authentication failed,
   *     which is also what a tampered ciphertext, IV or salt produces; nothing can tell
   *     those apart and nothing should, since the user's next move is the same either
   *     way. The item is left exactly as it was.
   *   - a rejection — there is no locked item with that id, or its payload never
   *     arrived. Neither is something a password can fix, and reporting them as a wrong
   *     password would send the user hunting for a typo that was never the problem.
   *
   * The password is read once here and stored nowhere: `decryptItem` derives the item
   * key inside the call and drops it, and the decrypted bytes are turned into what the
   * item holds (a string, or a Blob) and then zeroed.
   *
   * The reveal itself is written only while the session is still active. `decryptItem`
   * is ~300ms of PBKDF2 (PLAN.md §19 decision 9), long enough for the peer's
   * `session-end` to land inside it, and the teardown that drops decrypted plaintext
   * runs once, at the phase change (PLAN.md §17) — so a reveal written after it would
   * sit in the store until reset/unmount, outliving the session that authorised it.
   * A correct password still resolves `true` in that case; only the write is dropped.
   */
  const unlockItem = useCallback(
    async (id: string, password: string): Promise<boolean> => {
      const item = findSessionItem(id)
      if (item === null || item.type !== 'locked') {
        throw new Error('unlockItem: this session has no locked item with that id')
      }
      if (item.status !== 'complete') {
        throw new Error('unlockItem: the encrypted payload for this item has not arrived')
      }

      let decrypted: Uint8Array
      try {
        decrypted = await decryptItem(password, item.salt, item.iv, item.ciphertext)
      } catch (error) {
        // A failed decryption is a failed unlock, not a session failure; anything else
        // is a bug in this device's own state, not a wrong password, and is not dressed
        // up as one.
        if (isFailedDecryption(error)) return false
        throw error
      }

      // Re-read from the store rather than trust the phase captured at the call: the
      // derivation above is where the session can end underneath this unlock. The
      // decrypted bytes are dropped on this path too — no copy of them may outlive
      // either the session or the reveal.
      if (useSessionStore.getState().phase !== 'active') {
        zeroBytes(decrypted)
        return true
      }

      // The reveal is built from its own copy of the decrypted bytes, and both that
      // copy and the original are dropped here (see `revealFromDecrypted`).
      const revealed = revealFromDecrypted(item.innerType, decrypted)

      // A no-op when the item went away while the key was being derived (the store is
      // re-read per update), so an unlock cannot outlive its own row.
      updateItem(id, (current) =>
        current.type === 'locked'
          ? { ...current, unlocked: true, plaintextContent: revealed }
          : current,
      )
      return true
    },
    [updateItem],
  )

  /**
   * Re-hides an unlocked item (PLAN.md §9's 'Lock again').
   *
   * The ciphertext stays — it is what the password can bring back — and the decrypted
   * plaintext is dropped from the store, the only place it ever lived.
   */
  const lockItemAgain = useCallback(
    (id: string): void => {
      updateItem(id, (current) =>
        current.type === 'locked'
          ? { ...current, unlocked: false, plaintextContent: undefined }
          : current,
      )
    },
    [updateItem],
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
      // The previous attempt's ids belong to its board, which `startConnecting` clears.
      locallyCreatedIdsRef.current.clear()
      stopItemWork()
      setChannelOpen(false)
      setSessionKeyReady(false)
      startConnecting(nextRole, code)

      try {
        let activeCode = code

        if (activeCode === null || activeCode === '') {
          /*
           * PLAN.md §16 Phase 6: the Home screen mints this session's code so its QR can
           * display it, and hands the bundle over when the user opens this page. Joining
           * that code is what keeps one user intent to one session — minting again here
           * would leave the peer that scanned the QR waiting on a code nobody ever joins.
           *
           * A malformed code is never produced by the worker; it can only arrive through
           * a hand-crafted navigation, and minting fresh is the honest response (the
           * alternative, connecting to it, would be rejected by the worker anyway).
           */
          const preMinted = attempt === 0 ? hostSessionRef.current : null
          if (preMinted !== null && isValidSessionCode(preMinted.code)) {
            activeCode = preMinted.code
            setSessionCode(preMinted.code)
          } else {
            // Host: create the session, then display its code for the guest to scan.
            const created = await requestNewSession()
            if (isStale()) return
            activeCode = created.code
            setSessionCode(created.code)
          }
        }

        // Fetch TURN credentials for both roles using activeCode (ORCHESTRATION.md D10).
        // Failure degrades gracefully to STUN-only without failing the session.
        const turnCredentials = await requestTurnCredentials(activeCode)
        if (isStale()) return

        let peerOptions: PeerConnectionOptions | undefined
        if (turnCredentials !== null) {
          peerOptions = {
            turnUsername: turnCredentials.username,
            turnCredential: turnCredentials.credential,
            turnUrls: turnCredentials.urls,
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
   * Hands the D8 queue to the session once the item gate is open (PLAN.md §7/§16 Phase 5).
   *
   * The queue is filled on the Home screen, before this page exists, so the items have
   * to wait for a session that can actually carry them: PLAN.md §8 gates item traffic on
   * the both-confirms transition, and a frame sent earlier would be refused by the
   * transport. Declared after the `markActive` effect so the gate is open by the time
   * this runs — React runs a commit's effects in declaration order.
   *
   * `sendLibraryItem` returns silently once the session is no longer active, so the drain
   * asks the same question itself, item by item, and hands any remainder back to the
   * queue instead of dropping it: a session that ends mid-drain (a rejected send ends it)
   * must not destroy a selection the user never got a notice about. A throw (D6's cap on a
   * stored tuple) is reported the way every other send failure is instead of vanishing
   * inside an effect.
   */
  useEffect(() => {
    if (phase !== 'active') return

    const queued = takeQueuedLibrarySends()
    for (const [index, item] of queued.entries()) {
      // Checked per item, not once for the loop: `sessionIsActive` reads the store, so it
      // sees a session that ended since the previous send.
      if (!sessionIsActive()) {
        requeueLibrarySends(queued.slice(index))
        return
      }

      try {
        sendLibraryItem(item)
      } catch (error) {
        // The item that failed is the one this device reports; the untaken rest of the
        // selection stays queued for the next attempt.
        requeueLibrarySends(queued.slice(index + 1))
        endSession(describeError(error))
        return
      }
    }
  }, [phase, endSession, sendLibraryItem])

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
   * The page-teardown half of `abort()`: the peer is told the session is over, and
   * nothing else happens (PLAN.md §16 Phase 8, §17).
   *
   * A closing tab gives a handler no chance to await anything, so this is the
   * synchronous path: `send()` puts the frame on the transport's queue and returns
   * (ORCHESTRATION.md D3 — the encryption and the channel write follow on that queue).
   * The ciphertext races the page teardown, which is the best an unload path can do:
   * a close that wins the race costs the peer a delayed end, never a wrong one, and
   * its socket teardown ends the session anyway.
   *
   * Deliberately state-free. The page is being torn down, so nothing here may call
   * `endSession`, `close` or `reset`: a React state write from an unload handler is a
   * write into a tree that is already going away, and dropping the transport would
   * discard the very frame this exists to send. The phase is read from the store per
   * call rather than captured, because the caller subscribes from an unload listener
   * that can be a commit behind the store — only a session that can still carry
   * traffic sends anything ('active', or 'pairing', where the channel is already up
   * and the phrase-confirm travels the same way).
   */
  const notifyUnload = useCallback((): void => {
    const { phase: currentPhase } = useSessionStore.getState()
    if (currentPhase !== 'active' && currentPhase !== 'pairing') return

    try {
      send({ t: 'session-end' })
    } catch {
      // The channel was not usable, so there is nobody to notify.
    }
  }, [send])

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

  /**
   * What PLAN.md §8 Phase 4 may save — the items that arrived over the wire.
   *
   * Derived against the ids this device created rather than stored, so an item can
   * never be half-labelled: the id is recorded with the row it belongs to, in the same
   * task, and the filter is therefore exact from the first render that sees the item.
   */
  const receivedItems = items.filter((item) => !locallyCreatedIdsRef.current.has(item.id))

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
    notifyUnload,
    addTextItem,
    addRichTextItem,
    addFileItem,
    addLockedItem,
    sendLibraryItem,
    updateTextItem,
    updateRichTextItem,
    deleteItem,
    unlockItem,
    lockItemAgain,
    receivedItems,
  }
}

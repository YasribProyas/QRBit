/**
 * QRBit wire protocol (PLAN.md §10) — the message union and its MessagePack
 * serialisation.
 *
 * Every application message is MessagePack-encoded (never JSON: PLAN.md §19
 * decision 7 — MessagePack carries a `Uint8Array` natively, so a 16 KiB file
 * chunk stays 16 KiB instead of ballooning into an array of numbers or a base64
 * string). The encoded bytes are then wrapped in the AES-256-GCM envelope
 * `[iv: 12 bytes][ciphertext || GCM tag]` by `lib/crypto.ts`; that envelope is
 * what `PeerConnection` actually puts on the DataChannel.
 *
 * This module is the serialisation half only: no crypto, no DOM, no hooks. It is
 * pure and runs in the plain node test environment.
 */

import { decode, encode } from '@msgpack/msgpack'
import type { DecoderOptions, EncoderOptions } from '@msgpack/msgpack'

import type { ItemType, LockedItem } from '../store/sessionStore'

/**
 * Re-exported, not re-declared: the store owns the PLAN.md §9 item union, and a
 * second copy here would silently drift from the items the board renders.
 */
export type { ItemType }

/**
 * The `LockedItem.innerType` values of PLAN.md §9, taken from the store's own
 * definition for the same reason as `ItemType`.
 *
 * DEVIATION from PLAN.md §10, which types this field as a bare `string`: §9
 * constrains it to three values, and widening it to `string` on the wire would
 * turn the announce → `LockedItem` mapping in Phase 4 into an unchecked cast.
 */
export type LockedInnerType = LockedItem['innerType']

/**
 * Every frame that can cross the (encrypted) DataChannel (PLAN.md §10).
 *
 * `locked-payload` is declared here because the wire format is fixed now, but
 * nothing in Phase 3 sends it — PLAN.md §16 Phase 4 adds the composing UI and the
 * `encryptItem` half of `lib/crypto.ts`.
 */
export type WireMessage =
  | {
      t: 'item-announce'
      id: string
      type: ItemType
      label?: string
      fileName?: string
      mimeType?: string
      totalSize?: number
      totalChunks?: number
      innerType?: LockedInnerType
    }
  | { t: 'text-delta'; id: string; content: string }
  | { t: 'richtext-delta'; id: string; content: string }
  | { t: 'file-chunk'; id: string; index: number; data: Uint8Array }
  | { t: 'file-done'; id: string }
  | { t: 'locked-payload'; id: string; ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }
  | { t: 'item-delete'; id: string }
  | { t: 'phrase-confirm' }
  | { t: 'session-end' }

// ---------------------------------------------------------------------------
// Decode bounds
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on one decoded frame, in bytes: 4 MiB (PLAN.md §17 — a peer is
 * untrusted even though it holds the session key, because the *peer* is exactly
 * what PLAN.md §2 does not trust).
 *
 * Rationale for the number: a legitimate `file-chunk` is at most `CHUNK_SIZE`
 * (16 KiB, PLAN.md §12), so this is 256× headroom; the only frame that can
 * legitimately be large is a Phase 4 `locked-payload`, which carries a whole
 * locked item in one message. The ceiling is enforced twice — on the incoming
 * byte array before decoding, and as MessagePack's own string/binary length
 * limit — so a hostile frame cannot make the decoder allocate without bound.
 *
 * Container amplification is handled separately: `WIRE_MAX_MAP_FIELDS` and
 * `WIRE_MAX_ARRAY_LENGTH` below keep a crafted frame from turning a few KiB of
 * one-byte headers into millions of JS containers. MessagePack has no decoder
 * depth option, so nesting is bounded by these limits plus the byte ceiling: a
 * pathologically deep frame decodes and is then rejected by the flat-shape
 * validator below, and any error the decoder itself raises — including a
 * stack-overflow `RangeError` — is caught by `decodeWire` and costs the frame,
 * not the session.
 */
export const WIRE_MAX_FRAME_BYTES = 4 * 1024 * 1024

/**
 * Largest map decoded from a frame. The widest message is `item-announce` with 9
 * fields, so 16 rejects a hostile "map with a million keys" without constraining
 * the protocol.
 */
const WIRE_MAX_MAP_FIELDS = 16

/**
 * Largest array decoded from a frame. No `WireMessage` contains an array at all
 * (that is the point of MessagePack here — byte payloads are `bin`, not arrays of
 * numbers), so this exists purely to bound hostile input.
 */
const WIRE_MAX_ARRAY_LENGTH = 32

/**
 * Nesting depth accepted by the encoder. A `WireMessage` is a flat map, so depth
 * 2 is the real maximum; the limit only exists to fail fast on a runaway object.
 */
const WIRE_MAX_STRUCTURE_DEPTH = 8

const WIRE_DECODER_OPTIONS: DecoderOptions = {
  maxStrLength: WIRE_MAX_FRAME_BYTES,
  maxBinLength: WIRE_MAX_FRAME_BYTES,
  maxMapLength: WIRE_MAX_MAP_FIELDS,
  maxArrayLength: WIRE_MAX_ARRAY_LENGTH,
  // Every `WireMessage` is a plain encoded map. Extension types are reserved
  // (notably MessagePack's `timestamp`), never part of this protocol, so a frame
  // carrying one is rejected rather than guessed at.
  maxExtLength: 0,
}

const WIRE_ENCODER_OPTIONS: EncoderOptions = {
  maxDepth: WIRE_MAX_STRUCTURE_DEPTH,
  /**
   * Optional fields left as `undefined` (`{ label: item.label }` with no label) are
   * omitted from the map instead of being written as `nil`. The validator below
   * stays strict as a result: a field is either absent or correctly typed, and a
   * decoded message can never hold `null` where the type promises `string`.
   */
  ignoreUndefined: true,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Exactly the fields PLAN.md §10 gives each variant — nothing more. */
const ITEM_ANNOUNCE_KEYS = [
  't',
  'id',
  'type',
  'label',
  'fileName',
  'mimeType',
  'totalSize',
  'totalChunks',
  'innerType',
] as const
const DELTA_KEYS = ['t', 'id', 'content'] as const
const FILE_CHUNK_KEYS = ['t', 'id', 'index', 'data'] as const
const ID_KEYS = ['t', 'id'] as const
const LOCKED_PAYLOAD_KEYS = ['t', 'id', 'ciphertext', 'iv', 'salt'] as const
const CONTROL_KEYS = ['t'] as const

/**
 * Compile-time exhaustiveness markers: if `ItemType` or `LockedInnerType` gains a
 * member, these maps stop type-checking, which forces the guards below to be
 * updated instead of silently rejecting the new value on the wire.
 */
const ITEM_TYPE_MARKER: Record<ItemType, true> = {
  text: true,
  richtext: true,
  image: true,
  file: true,
  locked: true,
}
const LOCKED_INNER_TYPE_MARKER: Record<LockedInnerType, true> = {
  text: true,
  richtext: true,
  file: true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    // Typed arrays and DataView are objects too, and `Object.keys` on them is not
    // what any caller means by "message".
    !ArrayBuffer.isView(value)
  )
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return false
  }
  return true
}

function isItemType(value: unknown): value is ItemType {
  return typeof value === 'string' && Object.hasOwn(ITEM_TYPE_MARKER, value)
}

function isLockedInnerType(value: unknown): value is LockedInnerType {
  return typeof value === 'string' && Object.hasOwn(LOCKED_INNER_TYPE_MARKER, value)
}

function isNonNegativeInteger(value: unknown): value is number {
  // Safe, not just integral: `Number.isInteger(1e21)` is true, and a chunk index
  // (or byte count) that large is nonsense that must not reach the board.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** An absent optional field, or the value the type allows. `null` is not allowed. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value)
}

function isOptionalInnerType(value: unknown): boolean {
  return value === undefined || isLockedInnerType(value)
}

function isItemAnnounce(record: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(record, ITEM_ANNOUNCE_KEYS) &&
    typeof record['id'] === 'string' &&
    isItemType(record['type']) &&
    isOptionalString(record['label']) &&
    isOptionalString(record['fileName']) &&
    isOptionalString(record['mimeType']) &&
    isOptionalCount(record['totalSize']) &&
    isOptionalCount(record['totalChunks']) &&
    isOptionalInnerType(record['innerType'])
  )
}

/**
 * Validates a decrypted frame (PLAN.md §10).
 *
 * The sender is a peer that holds the session key, so this is a schema check on
 * untrusted input, not a type assertion: an unknown `t`, a missing or mistyped
 * field, an extra field the protocol does not define, a negative or fractional
 * chunk index, or a `data` / `ciphertext` / `iv` / `salt` that is not a
 * `Uint8Array` (an array of numbers, a string, `null`, a `DataView`) is all
 * rejected.
 *
 * Never throws and never logs: any value at all maps to a boolean.
 */
export function isWireMessage(value: unknown): value is WireMessage {
  try {
    if (!isRecord(value)) return false

    switch (value['t']) {
      case 'item-announce':
        return isItemAnnounce(value)

      case 'text-delta':
      case 'richtext-delta':
        return (
          hasOnlyKeys(value, DELTA_KEYS) &&
          typeof value['id'] === 'string' &&
          typeof value['content'] === 'string'
        )

      case 'file-chunk':
        return (
          hasOnlyKeys(value, FILE_CHUNK_KEYS) &&
          typeof value['id'] === 'string' &&
          isNonNegativeInteger(value['index']) &&
          value['data'] instanceof Uint8Array
        )

      case 'file-done':
      case 'item-delete':
        return hasOnlyKeys(value, ID_KEYS) && typeof value['id'] === 'string'

      case 'locked-payload':
        return (
          hasOnlyKeys(value, LOCKED_PAYLOAD_KEYS) &&
          typeof value['id'] === 'string' &&
          value['ciphertext'] instanceof Uint8Array &&
          value['iv'] instanceof Uint8Array &&
          value['salt'] instanceof Uint8Array
        )

      case 'phrase-confirm':
      case 'session-end':
        return hasOnlyKeys(value, CONTROL_KEYS)

      default:
        return false
    }
  } catch {
    // `unknown` can be a Proxy whose traps throw (or an object with a hostile
    // `get`). The contract is a boolean, so a throwing accessor is a rejection.
    return false
  }
}

// ---------------------------------------------------------------------------
// MessagePack serialisation
// ---------------------------------------------------------------------------

/**
 * Serialises a message to MessagePack bytes (PLAN.md §10).
 *
 * The result is a view into the encoder's own buffer, so callers must respect
 * `byteOffset` / `byteLength` rather than the backing ArrayBuffer — which is
 * exactly what `crypto.encrypt()` and the DataChannel do with a `Uint8Array`.
 *
 * Validated on the way out as well as in: a frame that is malformed here is a bug
 * on this side of the channel, and failing locally beats sending the peer a
 * frame it will reject.
 */
export function encodeWire(message: WireMessage): Uint8Array {
  if (!isWireMessage(message)) {
    throw new Error('protocol: refusing to encode a value that is not a WireMessage')
  }
  return encode(message, WIRE_ENCODER_OPTIONS)
}

/**
 * Parses and validates a decrypted frame (PLAN.md §10).
 *
 * Throws a descriptive error for anything that is not a valid `WireMessage`:
 * empty bytes, non-MessagePack bytes, trailing garbage after the message,
 * a structure beyond the limits documented on `WIRE_MAX_FRAME_BYTES`, or a
 * decoded value that fails `isWireMessage`. Callers treat a throw as "drop this
 * frame" (PLAN.md §17) — the error message describes the frame only, never its
 * contents.
 *
 * The decoder is recursive, so a frame that exhausts the stack raises a
 * `RangeError`; it is caught here and rethrown as the same descriptive error, so
 * a crafted frame can slow a session down but can never crash it with an
 * unhandled exception.
 */
export function decodeWire(bytes: Uint8Array): WireMessage {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('protocol: decodeWire expects a Uint8Array of MessagePack bytes')
  }
  if (bytes.byteLength > WIRE_MAX_FRAME_BYTES) {
    throw new Error(
      `protocol: frame of ${bytes.byteLength} bytes exceeds the ${WIRE_MAX_FRAME_BYTES}-byte limit`,
    )
  }

  let decoded: unknown
  try {
    decoded = decode(bytes, WIRE_DECODER_OPTIONS)
  } catch (error) {
    throw new Error(`protocol: frame is not decodable MessagePack — ${describeError(error)}`)
  }

  if (!isWireMessage(decoded)) {
    throw new Error('protocol: decoded frame is not a valid WireMessage')
  }
  return decoded
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

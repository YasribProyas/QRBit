/**
 * QRDrop crypto core — key exchange, key derivation, session encryption,
 * locked-item encryption and export encryption (PLAN.md §11.1–§11.5, §2, §6.2, §10, §17).
 *
 * Everything here is native Web Crypto (`globalThis.crypto.subtle`). No
 * third-party crypto library is used or permitted (AGENTS.md, PLAN.md §8).
 *
 * Threat model (PLAN.md §2):
 *   - The signaling worker only relays public keys; it never sees the shared
 *     secret, so a compromised server cannot decrypt session traffic.
 *   - A TURN relay only ever sees the AES-GCM envelope produced below.
 *   - The safety phrase (`safetyPhrase.ts`) defeats an active MITM during
 *     pairing because a spliced ECDH yields a different phrase on each device.
 *
 * Key material rules honoured by this module:
 *   - The ECDH private key is generated non-extractable; only the public key
 *     is exportable.
 *   - The AES-GCM session key is non-extractable, so it cannot be read back out
 *     of the CryptoKey to be logged or persisted.
 *   - The raw shared secret is returned to the caller only as an ArrayBuffer and
 *     is never stored, logged or exported by this module.
 *   - No `console.*` call exists in this file, by design (PLAN.md §17: never log
 *     keys, SDP, ICE or item data).
 *
 * Locked-item rules honoured by the §11.4 functions below (PLAN.md §2, §6.2, §19.3):
 *   - The item key is derived from the user's password on every call and is never
 *     stored anywhere: no CryptoKey, no derived bits and no copy of the password
 *     outlives the operation that produced it.
 *   - Only `{ ciphertext, iv, salt }` ever leaves this module, which is exactly
 *     the tuple PLAN.md §6.2 stores (in Phase 5) and sends (in Phase 4).
 *
 * Export-encryption rules (§11.5, at the bottom of this file):
 *   - A whole-library `.qrdrop` file is encrypted with the same PBKDF2 + AES-GCM
 *     primitives as a locked item (§11.5: "same pattern as encryptItem"), but its
 *     salt travels inside the envelope because the file is self-contained.
 *   - Locked items are NOT decrypted on the way out of the library (PLAN.md §14,
 *     §19.4): their tuple is copied as it is, so an unencrypted export still
 *     holds them as opaque ciphertext and an encrypted export double-locks them.
 */

const ECDH_CURVE: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' }

/** AES-GCM IV length in bytes; prepended to every envelope (PLAN.md §10). */
const IV_BYTE_LENGTH = 12

/** SHA-256 length in bytes; ECDH on P-256 yields exactly this. */
const SHARED_SECRET_BYTE_LENGTH = 32

export const SESSION_KEY_BYTE_LENGTH = 32
export const PHRASE_BYTE_LENGTH = 3

/** HKDF domain-separation labels. Must differ per derived value (PLAN.md §11.2). */
const SESSION_KEY_INFO = 'qrdrop-session-v1'
const PHRASE_INFO = 'qrdrop-phrase-v1'

/**
 * Generates an ephemeral P-256 ECDH keypair (PLAN.md §11.1).
 *
 * `extractable: false` applies to the private key; Web Crypto always exposes the
 * public key as extractable, which is what `exportPublicKey()` needs. The
 * private key is never exportable, so a compromised page context cannot exfiltrate
 * it through `exportKey()`.
 */
export async function generateKeypair(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey(ECDH_CURVE, false, ['deriveBits'])
}

/**
 * Exports a public key as SPKI DER (PLAN.md §11.1) for transport over the
 * JSON-only signaling channel; wrap in `toBase64()` before sending.
 */
export async function exportPublicKey(key: CryptoKey): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.exportKey('spki', key)
}

/**
 * Imports a peer public key from SPKI DER. Throws a DOMException if the bytes
 * are not a valid P-256 SPKI key — callers must treat that as a failed pairing.
 *
 * Extractable is `true` here because a public key is public by definition: the
 * flag stops nothing, and leaving it on keeps the import symmetric with
 * `exportPublicKey()`.
 */
export async function importPeerPublicKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('spki', raw, ECDH_CURVE, true, [])
}

/**
 * ECDH between our private key and the peer's public key (PLAN.md §11.1).
 *
 * Returns the raw 32-byte shared secret. Callers must feed it straight into
 * `deriveSessionKey()` / `deriveSafetyPhraseBytes()` and drop the reference
 * immediately; it is not a key and must never be transported or logged.
 */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<ArrayBuffer> {
  const secret = await globalThis.crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    SHARED_SECRET_BYTE_LENGTH * 8,
  )
  return secret
}

function sessionSalt(sessionId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(sessionId)
}

/**
 * HKDF (SHA-256) over the shared secret with the session id as salt
 * (PLAN.md §11.2), imported as a non-extractable AES-256-GCM session key.
 *
 * Derivation is symmetric: both peers use the same session id and the same
 * secret, so both arrive at the same key. Only the public keys travel over the
 * wire — the session id is not a secret, it is the session code.
 */
export async function deriveSessionKey(
  sharedSecret: ArrayBuffer,
  sessionId: string,
): Promise<CryptoKey> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveKey'],
  )
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: sessionSalt(sessionId),
      info: new TextEncoder().encode(SESSION_KEY_INFO),
    },
    keyMaterial,
    { name: 'AES-GCM', length: SESSION_KEY_BYTE_LENGTH * 8 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * HKDF (SHA-256) over the same shared secret, but with info `qrdrop-phrase-v1`
 * instead of `qrdrop-session-v1` (PLAN.md §11.2/§11.6).
 *
 * The distinct info string is the whole point: HKDF output for different info
 * values is computationally independent, so the phrase — which is displayed on
 * screen and may be photographed — reveals nothing about the session key.
 *
 * Returns 3 bytes, one per phrase word.
 */
export async function deriveSafetyPhraseBytes(
  sharedSecret: ArrayBuffer,
  sessionId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: sessionSalt(sessionId),
      info: new TextEncoder().encode(PHRASE_INFO),
    },
    keyMaterial,
    PHRASE_BYTE_LENGTH * 8,
  )
  return new Uint8Array(bits)
}

/**
 * Web Crypto's `BufferSource` is typed as an `ArrayBuffer`-backed view, while a
 * bare `Uint8Array` may be backed by a `SharedArrayBuffer`.
 *
 * Copying into a fresh view keeps the PLAN.md §11.3 `Uint8Array` parameter (so
 * callers can hand over a MessagePack buffer or a slice without annotating it)
 * and satisfies the DOM types without a cast. Frames are at most one chunk
 * (§12), so the copy is negligible next to the AES work itself.
 */
function toBufferSourceView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

/**
 * AES-256-GCM encryption with a fresh random 96-bit IV (PLAN.md §10/§11.3).
 *
 * Envelope layout: `[iv: 12 bytes][ciphertext || GCM tag: 16 bytes]`.
 *
 * The IV is drawn from `globalThis.crypto.getRandomValues` on every call and is
 * never reused or derived from the plaintext. Reusing an IV under the same key
 * would leak the XOR of two plaintexts and forge GCM authentication, so this
 * function has no caller-supplied IV parameter by design.
 */
export async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<ArrayBuffer> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH))
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    toBufferSourceView(plaintext),
  )
  const envelope = new Uint8Array(IV_BYTE_LENGTH + ciphertext.byteLength)
  envelope.set(iv, 0)
  envelope.set(new Uint8Array(ciphertext), IV_BYTE_LENGTH)
  return envelope.buffer
}

/**
 * Decrypts a PLAN.md §10 envelope: the first 12 bytes are the IV, the remainder
 * is ciphertext followed by the 16-byte GCM tag.
 *
 * The GCM tag failure is deliberately NOT caught: a wrong key or a tampered
 * envelope must reject so the transport can drop the frame (PLAN.md §17 — drop
 * the message, never crash, never expose partial plaintext). Malformed envelopes
 * that cannot even contain an IV are rejected with a plain `Error` naming the
 * problem instead of an opaque DOMException.
 */
export async function decrypt(
  key: CryptoKey,
  envelope: ArrayBuffer,
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.byteLength < IV_BYTE_LENGTH) {
    throw new Error(
      `crypto: encrypted envelope is ${envelope.byteLength} bytes; ` +
        `expected at least a ${IV_BYTE_LENGTH}-byte IV`,
    )
  }
  const iv = envelope.slice(0, IV_BYTE_LENGTH)
  const ciphertext = envelope.slice(IV_BYTE_LENGTH)
  const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new Uint8Array(plaintext)
}

/**
 * PBKDF2 iteration count for item keys (PLAN.md §11.4, §19 decision 9).
 *
 * OWASP's 2023 recommendation. Costs roughly 300ms on a mid-range phone, which
 * is the point: an attacker who steals the `{ ciphertext, iv, salt }` tuple must
 * pay that cost per password guess, while a legitimate unlock pays it once and
 * shows a spinner.
 */
export const PBKDF2_ITERATIONS = 600_000

/** PBKDF2 salt length in bytes (PLAN.md §6.1/§9: `salt: Uint8Array // 16 bytes`). */
const ITEM_SALT_BYTE_LENGTH = 16

/** AES-256 key length in bits for item keys (PLAN.md §11.4: `keyLength=256`). */
const ITEM_KEY_BIT_LENGTH = 256

/**
 * Largest plaintext a single locked item may carry (orchestration decision D6).
 *
 * `locked-payload` sends the whole item in ONE frame, and `protocol.ts`
 * `WIRE_MAX_FRAME_BYTES` caps a frame at 4 MiB. The frame must hold the
 * ciphertext plus the 16-byte GCM tag, the 12-byte IV, the 16-byte salt and the
 * MessagePack envelope around them, so the plaintext is capped well below 4 MiB
 * to leave that headroom. Chunking an encrypted blob would mean a second chunk
 * pipeline for a rare case, so larger content is sent as a regular file item
 * (already E2EE in transit; locking exists for double encryption of secrets
 * like passwords and keys, not for media). The UI enforces this at compose
 * time with a clear error; `decodeWire`'s existing 4 MiB bound is the defensive
 * backstop.
 *
 * Kept here rather than in the UI so the one number has one spelling.
 */
export const LOCKED_ITEM_MAX_PLAINTEXT_BYTES = 3 * 1024 * 1024

/**
 * Derives a locked item's AES-256-GCM key from a password with PBKDF2
 * (PLAN.md §11.4).
 *
 * The returned key is non-extractable and usable only for encrypt/decrypt, so it
 * cannot be read back out of the CryptoKey and kept (PLAN.md §6.2, §19.3 — the
 * key is re-derived on every unlock and never stored). The password itself is
 * imported as non-extractable key material and dropped when this function
 * returns; nothing here caches it.
 *
 * The salt is supplied by the caller because decryption must reuse the salt that
 * was stored with the ciphertext.
 */
export async function deriveItemKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passwordMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toBufferSourceView(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    passwordMaterial,
    { name: 'AES-GCM', length: ITEM_KEY_BIT_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypts a locked item's plaintext under a password (PLAN.md §11.4).
 *
 * Returns the `{ ciphertext, iv, salt }` tuple that PLAN.md §6.1 stores in
 * IndexedDB and §10 puts on the wire; nothing else about the item is encrypted,
 * so the label stays readable by design (§9 — the receiver shows the label
 * before unlocking).
 *
 * Both the 16-byte salt and the 12-byte GCM IV are drawn fresh from
 * `globalThis.crypto.getRandomValues` on every call, so encrypting the same
 * plaintext with the same password twice yields unrelated output. The IV is
 * never caller-supplied: reuse under the same item key would leak plaintext XOR
 * and break GCM authentication. GCM's 16-byte tag is already appended to the
 * ciphertext by Web Crypto, so `ciphertext` is `plaintext.length + 16` bytes.
 */
export async function encryptItem(
  password: string,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(ITEM_SALT_BYTE_LENGTH))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH))
  const key = await deriveItemKey(password, salt)
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    toBufferSourceView(plaintext),
  )
  return { ciphertext: new Uint8Array(ciphertext), iv, salt }
}

/**
 * Decrypts a locked item with the password the user just typed (PLAN.md §11.4).
 *
 * The GCM failure is deliberately NOT caught: a wrong password, a tampered
 * ciphertext, a tampered IV or a swapped salt all reject with Web Crypto's
 * `OperationError` DOMException, which is how callers tell "this password is
 * wrong" from "here is the plaintext" (PLAN.md §16 Phase 4, §17). Catching it
 * here would turn a failed unlock into silently empty content.
 *
 * The key is derived inside this call and dropped with it; no part of the item
 * key survives the operation (PLAN.md §6.2, §19.3).
 */
export async function decryptItem(
  password: string,
  salt: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveItemKey(password, salt)
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSourceView(iv) },
    key,
    toBufferSourceView(ciphertext),
  )
  return new Uint8Array(plaintext)
}

/**
 * Encrypts a whole library export under a user password (PLAN.md §11.5).
 *
 * Same derivation and cipher as `encryptItem` — PBKDF2-SHA256 at
 * `PBKDF2_ITERATIONS` over a fresh 16-byte salt, then AES-256-GCM under a
 * non-extractable key with a fresh 12-byte IV — because §11.5 asks for the same
 * pattern. Only the envelope layout differs, and only because it must be: this
 * output is a self-contained file with nowhere else to put the salt.
 *
 * Layout: `[salt: 16 bytes][iv: 12 bytes][ciphertext || GCM tag: 16 bytes]`.
 * `lib/export.ts` prepends its own 4-byte 'QRDE' magic so an import can tell an
 * encrypted export from a JSON one; that header is not part of this envelope and
 * is stripped before the bytes reach `decryptExport`.
 *
 * The password is imported as non-extractable key material and dropped with the
 * derived key when this function returns; nothing here caches either (PLAN.md
 * §6.2, §19.3 — the same rule as a locked item, because the export password is
 * just as unrecoverable).
 */
export async function encryptExport(password: string, data: Uint8Array): Promise<ArrayBuffer> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(ITEM_SALT_BYTE_LENGTH))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH))
  const key = await deriveItemKey(password, salt)
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    toBufferSourceView(data),
  )

  const envelope = new Uint8Array(ITEM_SALT_BYTE_LENGTH + IV_BYTE_LENGTH + ciphertext.byteLength)
  envelope.set(salt, 0)
  envelope.set(iv, ITEM_SALT_BYTE_LENGTH)
  envelope.set(new Uint8Array(ciphertext), ITEM_SALT_BYTE_LENGTH + IV_BYTE_LENGTH)
  return envelope.buffer
}

/**
 * Decrypts a PLAN.md §11.5 export envelope produced by `encryptExport`.
 *
 * The caller must have stripped `lib/export.ts`'s 'QRDE' magic already: the first
 * 16 bytes here are the salt, the next 12 the IV, and the rest is ciphertext plus
 * GCM tag.
 *
 * The GCM failure is deliberately NOT caught, for the same reason `decryptItem`
 * does not catch it: the caller tells "this password did not open this file"
 * from "here is the JSON" by catching the `OperationError` DOMException, which is
 * also what a tampered ciphertext raises. An envelope too short to hold a salt
 * and an IV is rejected up front with a plain `Error` naming the problem, instead
 * of reaching `deriveItemKey` as a truncated salt.
 */
export async function decryptExport(
  password: string,
  data: ArrayBuffer,
): Promise<Uint8Array<ArrayBuffer>> {
  const headerByteLength = ITEM_SALT_BYTE_LENGTH + IV_BYTE_LENGTH
  if (data.byteLength < headerByteLength) {
    throw new Error(
      `crypto: encrypted export is ${data.byteLength} bytes; expected at least a ` +
        `${ITEM_SALT_BYTE_LENGTH}-byte salt and a ${IV_BYTE_LENGTH}-byte IV`,
    )
  }

  const salt = data.slice(0, ITEM_SALT_BYTE_LENGTH)
  const iv = data.slice(ITEM_SALT_BYTE_LENGTH, headerByteLength)
  const ciphertext = data.slice(headerByteLength)

  const key = await deriveItemKey(password, new Uint8Array(salt))
  const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new Uint8Array(plaintext)
}

/**
 * ADDITIONAL HELPERS (not in PLAN.md §11).
 *
 * The signaling channel is JSON only, so public keys must travel as text. These
 * helpers carry public keys exclusively — the string "public key" appears in
 * their names for that reason. Never encode a shared secret, session key or
 * plaintext with them.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const BASE64_LOOKUP: ReadonlyMap<string, number> = new Map(
  [...BASE64_ALPHABET].map((char, index): [string, number] => [char, index]),
)

/** Encodes bytes as standard (padded) base64. Implemented directly rather than
 * through `btoa` so the browser, the worker and the node test run all take the
 * same code path. */
export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let encoded = ''
  for (let i = 0; i < view.length; i += 3) {
    const first = view[i] ?? 0
    const second = view[i + 1]
    const third = view[i + 2]
    encoded += BASE64_ALPHABET.charAt(first >> 2)
    encoded += BASE64_ALPHABET.charAt(((first & 0x03) << 4) | ((second ?? 0) >> 4))
    encoded +=
      second === undefined
        ? '='
        : BASE64_ALPHABET.charAt(((second & 0x0f) << 2) | ((third ?? 0) >> 6))
    encoded += third === undefined ? '=' : BASE64_ALPHABET.charAt(third & 0x3f)
  }
  return encoded
}

function decodeBase64Char(char: string, index: number): number {
  const value = BASE64_LOOKUP.get(char)
  if (value === undefined) {
    throw new Error(`fromBase64: invalid character "${char}" at index ${index}`)
  }
  return value
}

/**
 * Decodes standard base64 produced by `toBase64()`.
 *
 * Strict: rejects empty input, wrong length, characters outside the alphabet,
 * padding anywhere but at the end, and non-canonical trailing bits, so a
 * corrupted public key fails loudly here instead of reaching `importKey()` as
 * plausible-looking garbage. Empty input is rejected on purpose: an empty string
 * is never a serialized public key, and failing here beats an opaque `importKey`
 * error further downstream.
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  if (text.length === 0) {
    throw new Error('fromBase64: empty input is not a valid base64 string')
  }
  if (text.length % 4 !== 0) {
    throw new Error(`fromBase64: length ${text.length} is not a multiple of 4`)
  }
  let padding = 0
  if (text.endsWith('==')) {
    padding = 2
  } else if (text.endsWith('=')) {
    padding = 1
  }
  const body = text.slice(0, text.length - padding)
  if (body.length % 4 === 1) {
    throw new Error('fromBase64: truncated base64 group')
  }
  const decoded = new Uint8Array((text.length / 4) * 3 - padding)
  let offset = 0
  for (let i = 0; i < body.length; i += 4) {
    const remaining = body.length - i
    const first = decodeBase64Char(body.charAt(i), i)
    const second = remaining > 1 ? decodeBase64Char(body.charAt(i + 1), i + 1) : 0
    const third = remaining > 2 ? decodeBase64Char(body.charAt(i + 2), i + 2) : 0
    const fourth = remaining > 3 ? decodeBase64Char(body.charAt(i + 3), i + 3) : 0
    if (remaining === 2 && (second & 0x0f) !== 0) {
      throw new Error('fromBase64: non-canonical trailing bits')
    }
    if (remaining === 3 && (third & 0x03) !== 0) {
      throw new Error('fromBase64: non-canonical trailing bits')
    }
    const group = (first << 18) | (second << 12) | (third << 6) | fourth
    if (offset < decoded.length) decoded[offset++] = (group >>> 16) & 0xff
    if (offset < decoded.length) decoded[offset++] = (group >>> 8) & 0xff
    if (offset < decoded.length) decoded[offset++] = group & 0xff
  }
  return decoded
}

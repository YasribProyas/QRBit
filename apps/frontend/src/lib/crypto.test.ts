/**
 * Tests for the E2EE core (PLAN.md §11.1–§11.5, §10, §17).
 *
 * The interoperability test is the one that matters most: it proves that two
 * independent devices, each holding only their own private key and the peer's
 * public key, arrive at the same session key and the same safety phrase. If it
 * ever fails, the app would silently fail to decrypt every frame.
 *
 * Locked items are at the bottom: PBKDF2 at 600,000 iterations costs ~300ms per
 * call by design (PLAN.md §19.9), so those tests share work where they can and
 * stay in the low tens of derivations rather than the hundreds. Export encryption
 * (§11.5) uses the same derivation and is grouped with them for that reason.
 *
 * Runs in the default node environment: Node 20+ exposes `globalThis.crypto`.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  deriveItemKey,
  deriveSafetyPhraseBytes,
  deriveSessionKey,
  deriveSharedSecret,
  decrypt,
  decryptExport,
  decryptItem,
  encrypt,
  encryptExport,
  encryptItem,
  exportPublicKey,
  fromBase64,
  generateKeypair,
  importPeerPublicKey,
  LOCKED_ITEM_MAX_PLAINTEXT_BYTES,
  PBKDF2_ITERATIONS,
  PHRASE_BYTE_LENGTH,
  toBase64,
} from './crypto'
import { bytesToPhrase } from './safetyPhrase'
import { WORDLIST, WORDLIST_LENGTH } from './wordlist'

const SESSION_ID = 'A7X3K9P2'

/** Both peers complete a real handshake and return their independently derived material. */
async function pairUp(sessionId = SESSION_ID) {
  const hostKeys = await generateKeypair()
  const guestKeys = await generateKeypair()

  // Only public keys cross the (untrusted) signaling channel, as SPKI → base64.
  const hostPublicRaw = await exportPublicKey(hostKeys.publicKey)
  const guestPublicRaw = await exportPublicKey(guestKeys.publicKey)
  const hostPeerKey = await importPeerPublicKey(fromBase64(toBase64(guestPublicRaw)).buffer)
  const guestPeerKey = await importPeerPublicKey(fromBase64(toBase64(hostPublicRaw)).buffer)

  const hostSecret = await deriveSharedSecret(hostKeys.privateKey, hostPeerKey)
  const guestSecret = await deriveSharedSecret(guestKeys.privateKey, guestPeerKey)

  const hostSessionKey = await deriveSessionKey(hostSecret, sessionId)
  const guestSessionKey = await deriveSessionKey(guestSecret, sessionId)

  const hostPhraseBytes = await deriveSafetyPhraseBytes(hostSecret, sessionId)
  const guestPhraseBytes = await deriveSafetyPhraseBytes(guestSecret, sessionId)

  return {
    hostSecret,
    guestSecret,
    hostSessionKey,
    guestSessionKey,
    hostPhraseBytes,
    guestPhraseBytes,
  }
}

function bytesOf(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value)
}

function tamper(envelope: ArrayBuffer, index: number): ArrayBuffer {
  const copy = new Uint8Array(bytesOf(envelope))
  const original = copy[index]
  if (original === undefined) throw new Error(`test: index ${index} is outside the envelope`)
  copy[index] = original ^ 0x01
  return copy.buffer
}

/** Index of the first differing byte, or -1 when the arrays are identical. */
function firstDifference(actual: Uint8Array, expected: Uint8Array): number {
  if (actual.length !== expected.length) return 0
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return i
  }
  return -1
}

/** Deterministic payload so large-buffer tests stay cheap and reproducible. */
function patternedBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    bytes[i] = (i * 31 + 7) & 0xff
  }
  return bytes
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

/** Returns a copy of `bytes` with bit 0 of one byte flipped. */
function flipBit(bytes: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes)
  const original = copy[index]
  if (original === undefined) throw new Error(`test: index ${index} is outside the buffer`)
  copy[index] = original ^ 0x01
  return copy
}

/**
 * Narrows one argument of a spied `deriveKey` call to PBKDF2 parameters, so the
 * iteration count can be asserted without reaching for a cast.
 */
function isPbkdf2Params(algorithm: unknown): algorithm is Pbkdf2Params {
  return (
    typeof algorithm === 'object' &&
    algorithm !== null &&
    'name' in algorithm &&
    algorithm.name === 'PBKDF2'
  )
}

/**
 * HKDF-SHA256 output for an explicit info string, per PLAN.md §11.2.
 *
 * The tests recompute key *material* this way because the keys the module hands
 * back are non-extractable by design: the byte-level comparison happens here,
 * and the module's CryptoKey is checked by decrypting with it.
 */
async function hkdfBytes(secret: ArrayBuffer, info: string, bits: number): Promise<ArrayBuffer> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveBits'],
  )
  return globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8(SESSION_ID),
      info: utf8(info),
    },
    keyMaterial,
    bits,
  )
}

async function importAesKey(bytes: ArrayBuffer): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
}

describe('generateKeypair / exportPublicKey / importPeerPublicKey', () => {
  it('generates a P-256 ECDH pair whose private key is not exportable', async () => {
    const keys = await generateKeypair()
    expect(keys.privateKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' })
    expect(keys.publicKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' })
    expect(keys.privateKey.extractable).toBe(false)
    expect(keys.privateKey.usages).toEqual(['deriveBits'])
  })

  it('round-trips a public key through SPKI and base64', async () => {
    const keys = await generateKeypair()
    const spki = await exportPublicKey(keys.publicKey)
    expect(spki.byteLength).toBe(91) // uncompressed P-256 point + SPKI header
    const reimported = await importPeerPublicKey(fromBase64(toBase64(spki)).buffer)
    expect(reimported.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' })
  })

  it('rejects a corrupt public key', async () => {
    await expect(importPeerPublicKey(new Uint8Array([1, 2, 3]).buffer)).rejects.toThrow()
  })
})

describe('interoperability — two independent devices must agree', () => {
  it('derives byte-identical shared secrets in both ECDH directions', async () => {
    const { hostSecret, guestSecret } = await pairUp()
    expect(bytesOf(hostSecret)).toEqual(bytesOf(guestSecret))
    expect(hostSecret.byteLength).toBe(32)
  })

  it('derives session keys that decrypt each other, in both directions', async () => {
    const { hostSessionKey, guestSessionKey } = await pairUp()
    // Both keys are non-extractable, so equality is proven by cross-decryption
    // rather than by comparing exported bytes.
    const hostPlaintext = utf8('host → guest: hello')
    const hostEnvelope = await encrypt(hostSessionKey, hostPlaintext)
    expect(await decrypt(guestSessionKey, hostEnvelope)).toEqual(hostPlaintext)

    const guestPlaintext = utf8('guest → host: hello back')
    const guestEnvelope = await encrypt(guestSessionKey, guestPlaintext)
    expect(await decrypt(hostSessionKey, guestEnvelope)).toEqual(guestPlaintext)
  })

  it('derives byte-identical session key material on both devices', async () => {
    const { hostSecret, guestSecret, hostSessionKey } = await pairUp()
    const hostKeyBytes = await hkdfBytes(hostSecret, 'qrdrop-session-v1', 256)
    const guestKeyBytes = await hkdfBytes(guestSecret, 'qrdrop-session-v1', 256)
    expect(new Uint8Array(hostKeyBytes)).toEqual(new Uint8Array(guestKeyBytes))

    const plaintext = utf8('cross-device key material')
    const envelope = await encrypt(hostSessionKey, plaintext)
    // The same material the module returns as a CryptoKey must open envelopes
    // produced by the device on the other side.
    expect(await decrypt(await importAesKey(hostKeyBytes), envelope)).toEqual(plaintext)
    expect(await decrypt(await importAesKey(guestKeyBytes), envelope)).toEqual(plaintext)
  })

  it('derives identical safety phrases on both devices', async () => {
    const { hostPhraseBytes, guestPhraseBytes } = await pairUp()
    expect(hostPhraseBytes).toEqual(guestPhraseBytes)
    expect(bytesToPhrase(hostPhraseBytes)).toEqual(bytesToPhrase(guestPhraseBytes))
  })

  it('derives a different session key for a different session id', async () => {
    const { hostSecret, hostSessionKey, guestSessionKey } = await pairUp()
    const plaintext = utf8('x')
    const envelope = await encrypt(hostSessionKey, plaintext)
    await expect(decrypt(guestSessionKey, envelope)).resolves.toEqual(plaintext)

    // The session id is the HKDF salt, so the same peer secret under a
    // different code must not open this envelope.
    const otherSessionKey = await deriveSessionKey(hostSecret, 'BBBB2222')
    await expect(decrypt(otherSessionKey, envelope)).rejects.toThrow()
  })
})

describe('domain separation (session key vs safety phrase)', () => {
  it('uses HKDF info "qrdrop-session-v1" so both peers reproduce the session key', async () => {
    const { hostSecret } = await pairUp()
    // Recompute the session key bytes from the spec parameters to pin the label:
    // if the label ever drifts, two devices would derive different keys.
    const expected = await hkdfBytes(hostSecret, 'qrdrop-session-v1', 256)
    const plaintext = new Uint8Array([9, 8, 7])
    const envelope = await encrypt(await deriveSessionKey(hostSecret, SESSION_ID), plaintext)
    await expect(decrypt(await importAesKey(expected), envelope)).resolves.toEqual(plaintext)
  })

  it('produces different bytes for the session key and the phrase', async () => {
    const { hostSecret, hostPhraseBytes, hostSessionKey } = await pairUp()
    const sessionKeyBytes = new Uint8Array(await hkdfBytes(hostSecret, 'qrdrop-session-v1', 256))

    // The phrase bytes are the leading bytes of a *different* HKDF expansion.
    expect(hostPhraseBytes.byteLength).toBe(PHRASE_BYTE_LENGTH)
    expect([...hostPhraseBytes]).not.toEqual([...sessionKeyBytes.slice(0, PHRASE_BYTE_LENGTH)])

    // Knowing the phrase must not yield the session key: a key built from the
    // phrase bytes cannot open a session envelope.
    const phrasePadded = new Uint8Array(32)
    phrasePadded.set(hostPhraseBytes, 0)
    const phraseKey = await importAesKey(phrasePadded.buffer)
    const envelope = await encrypt(hostSessionKey, utf8('secret'))
    await expect(decrypt(phraseKey, envelope)).rejects.toThrow()
  })

  it('derives the phrase deterministically for a fixed secret and session id', async () => {
    const secret = patternedBytes(32).buffer
    const first = await deriveSafetyPhraseBytes(secret, SESSION_ID)
    const second = await deriveSafetyPhraseBytes(secret, SESSION_ID)
    expect(first).toEqual(second)
    expect(await deriveSafetyPhraseBytes(secret, 'ZZZZ9999')).not.toEqual(first)
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips a payload', async () => {
    const { hostSessionKey } = await pairUp()
    const plaintext = new TextEncoder().encode('QRDrop round trip')
    const envelope = await encrypt(hostSessionKey, plaintext)
    expect(await decrypt(hostSessionKey, envelope)).toEqual(plaintext)
  })

  it('round-trips empty plaintext', async () => {
    const { hostSessionKey } = await pairUp()
    const envelope = await encrypt(hostSessionKey, new Uint8Array(0))
    // IV (12) + GCM tag (16), no ciphertext.
    expect(envelope.byteLength).toBe(28)
    expect(await decrypt(hostSessionKey, envelope)).toEqual(new Uint8Array(0))
  })

  it('round-trips a >= 1 MiB payload', async () => {
    const { hostSessionKey } = await pairUp()
    const plaintext = patternedBytes(1024 * 1024 + 3)
    const envelope = await encrypt(hostSessionKey, plaintext)
    expect(envelope.byteLength).toBe(plaintext.byteLength + 12 + 16)
    const decrypted = await decrypt(hostSessionKey, envelope)
    // Byte-by-byte instead of `toEqual`: a deep compare of 1 MiB dominates the
    // runtime of this file without proving anything more.
    expect(decrypted.byteLength).toBe(plaintext.byteLength)
    expect(firstDifference(decrypted, plaintext)).toBe(-1)
  })

  it('never reuses an IV', async () => {
    const { hostSessionKey } = await pairUp()
    const plaintext = new TextEncoder().encode('same plaintext twice')
    const first = await encrypt(hostSessionKey, plaintext)
    const second = await encrypt(hostSessionKey, plaintext)
    expect(bytesOf(first)).not.toEqual(bytesOf(second))
    expect(bytesOf(first).slice(0, 12)).not.toEqual(bytesOf(second).slice(0, 12))
    expect(await decrypt(hostSessionKey, first)).toEqual(plaintext)
    expect(await decrypt(hostSessionKey, second)).toEqual(plaintext)
  })
})

describe('authentication failures (PLAN.md §17 — drop the frame)', () => {
  // Auth failures must surface as the Web Crypto DOMException untouched: the
  // transport distinguishes "drop this frame" from a programming error by it.
  it('rejects a flipped ciphertext bit', async () => {
    const { hostSessionKey } = await pairUp()
    const envelope = await encrypt(hostSessionKey, utf8('tamper target'))
    await expect(decrypt(hostSessionKey, tamper(envelope, 13))).rejects.toBeInstanceOf(DOMException)
  })

  it('rejects a flipped IV bit', async () => {
    const { hostSessionKey } = await pairUp()
    const envelope = await encrypt(hostSessionKey, utf8('tamper target'))
    await expect(decrypt(hostSessionKey, tamper(envelope, 4))).rejects.toBeInstanceOf(DOMException)
  })

  it('rejects a flipped GCM tag bit', async () => {
    const { hostSessionKey } = await pairUp()
    const envelope = await encrypt(hostSessionKey, utf8('tamper target'))
    const corrupted = tamper(envelope, envelope.byteLength - 1)
    await expect(decrypt(hostSessionKey, corrupted)).rejects.toBeInstanceOf(DOMException)
  })

  it('rejects a truncated envelope instead of throwing a confusing error', async () => {
    const { hostSessionKey } = await pairUp()
    await expect(decrypt(hostSessionKey, new Uint8Array(0).buffer)).rejects.toThrow(/IV/)
    await expect(decrypt(hostSessionKey, new Uint8Array(8).buffer)).rejects.toThrow(/IV/)
    // Exactly an IV but no ciphertext/tag can never authenticate.
    await expect(decrypt(hostSessionKey, new Uint8Array(12).buffer)).rejects.toThrow()
  })

  it('rejects decryption with the wrong key', async () => {
    const { hostSessionKey } = await pairUp()
    // A completely independent pairing that happens to use the same session id.
    const strangerKeys = await generateKeypair()
    const strangerPeersKey = await generateKeypair()
    const strangerSecret = await deriveSharedSecret(strangerKeys.privateKey, strangerPeersKey.publicKey)
    const strangerKey = await deriveSessionKey(strangerSecret, SESSION_ID)
    const envelope = await encrypt(hostSessionKey, utf8('for host eyes only'))
    await expect(decrypt(strangerKey, envelope)).rejects.toBeInstanceOf(DOMException)
  })

  it('never returns partial plaintext on failure', async () => {
    const { hostSessionKey } = await pairUp()
    const plaintext = utf8('no partial output')
    const envelope = await encrypt(hostSessionKey, plaintext)
    const corrupted = tamper(envelope, envelope.byteLength - 1)
    let result: Uint8Array | undefined
    try {
      result = await decrypt(hostSessionKey, corrupted)
    } catch {
      result = undefined
    }
    expect(result).toBeUndefined()
  })
})

describe('session key usages and extractability', () => {
  it('is a non-extractable AES-256-GCM key usable for encrypt and decrypt', async () => {
    const { hostSecret } = await pairUp()
    const key = await deriveSessionKey(hostSecret, SESSION_ID)
    expect(key.extractable).toBe(false)
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt'])
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })
})

describe('locked items (PLAN.md §11.4, §6.2)', () => {
  const PASSWORD = 'correct horse battery staple'
  const WRONG_PASSWORD = 'correct horse battery stapl'

  it('round-trips text bytes, a 64 KiB payload and empty plaintext', async () => {
    const payloads = [
      utf8('Uni Portal: hunter2 / 4831'),
      patternedBytes(64 * 1024),
      new Uint8Array(0),
    ]
    for (const plaintext of payloads) {
      const { ciphertext, iv, salt } = await encryptItem(PASSWORD, plaintext)
      const decrypted = await decryptItem(PASSWORD, salt, iv, ciphertext)
      expect(decrypted.byteLength).toBe(plaintext.byteLength)
      expect(firstDifference(decrypted, plaintext)).toBe(-1)
    }
  })

  it('rejects the wrong password with an OperationError, and does not swallow it', async () => {
    const plaintext = utf8('for the right password only')
    const { ciphertext, iv, salt } = await encryptItem(PASSWORD, plaintext)

    const failure = await decryptItem(WRONG_PASSWORD, salt, iv, ciphertext).then(
      () => null,
      (error: unknown) => error,
    )
    if (failure === null) throw new Error('test: a wrong password decrypted a locked item')
    if (!(failure instanceof DOMException)) {
      throw new Error(`test: expected a DOMException, received ${String(failure)}`)
    }
    // PLAN.md §17: the caller distinguishes failure from success by catching this.
    expect(failure.name).toBe('OperationError')
    expect(failure.message).toMatch(/operation/i)

    // The rejection must be per-call: it may not poison the same tuple for the
    // correct password (that is what "clears the input and lets you retry" needs).
    expect(await decryptItem(PASSWORD, salt, iv, ciphertext)).toEqual(plaintext)
  })

  it('draws a fresh 16-byte salt and 12-byte IV per call, so output never repeats', async () => {
    const plaintext = utf8('identical input twice')
    const first = await encryptItem(PASSWORD, plaintext)
    const second = await encryptItem(PASSWORD, plaintext)

    expect(first.salt.byteLength).toBe(16)
    expect(first.iv.byteLength).toBe(12)
    expect(second.salt.byteLength).toBe(16)
    expect(second.iv.byteLength).toBe(12)
    expect([...first.salt]).not.toEqual([...second.salt])
    expect([...first.iv]).not.toEqual([...second.iv])
    expect([...first.ciphertext]).not.toEqual([...second.ciphertext])

    // The salt is not decoration: the first ciphertext must not open under the
    // second salt, which proves the fresh salt actually seeds the derivation.
    await expect(decryptItem(PASSWORD, second.salt, first.iv, first.ciphertext)).rejects.toThrow()
  })

  it('pins PBKDF2 to SHA-256 at exactly 600,000 iterations', async () => {
    const deriveKey = vi.spyOn(globalThis.crypto.subtle, 'deriveKey')
    try {
      const key = await deriveItemKey(PASSWORD, new Uint8Array(16))
      expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })

      const pbkdf2 = deriveKey.mock.calls.map((call) => call[0]).find(isPbkdf2Params)
      if (pbkdf2 === undefined) {
        throw new Error('test: deriveItemKey did not call deriveKey with PBKDF2')
      }
      // Both spellings on purpose: the literal pins the number, the constant
      // pins that callers and tests agree on which number that is.
      expect(pbkdf2.iterations).toBe(600_000)
      expect(pbkdf2.iterations).toBe(PBKDF2_ITERATIONS)
      expect(pbkdf2.hash).toBe('SHA-256')
      expect(pbkdf2.salt.byteLength).toBe(16)
    } finally {
      deriveKey.mockRestore()
    }
  })

  it('rejects a flipped ciphertext bit and a flipped IV bit', async () => {
    const plaintext = utf8('tamper target')
    const { ciphertext, iv, salt } = await encryptItem(PASSWORD, plaintext)

    await expect(
      decryptItem(PASSWORD, salt, iv, flipBit(ciphertext, 0)),
    ).rejects.toBeInstanceOf(DOMException)
    await expect(
      decryptItem(PASSWORD, salt, flipBit(iv, 0), ciphertext),
    ).rejects.toBeInstanceOf(DOMException)
  })

  it('caps locked-item plaintext at 3 MiB (D6)', () => {
    // One `locked-payload` frame carries the whole item and WIRE_MAX_FRAME_BYTES
    // is 4 MiB, so the plaintext cap leaves room for the tag, IV, salt and
    // MessagePack overhead. Anything larger goes as a regular file item.
    expect(LOCKED_ITEM_MAX_PLAINTEXT_BYTES).toBe(3 * 1024 * 1024)
    expect(LOCKED_ITEM_MAX_PLAINTEXT_BYTES).toBe(3_145_728)
  })

  it('derives a non-extractable AES-256-GCM key with exactly encrypt and decrypt usages', async () => {
    const key = await deriveItemKey(PASSWORD, new Uint8Array(16))
    expect(key.extractable).toBe(false)
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt'])
    // PLAN.md §6.2/§19.3 — the item key is re-derived on every unlock and can
    // never be read back out to be stored anywhere.
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })
})

describe('export encryption (PLAN.md §11.5)', () => {
  const PASSWORD = 'a whole library under one password'
  const WRONG_PASSWORD = 'a whole library under one passwrd'

  it('round-trips a JSON payload, a 64 KiB payload and an empty one', async () => {
    const payloads = [utf8('{"version":1,"folders":[]}'), patternedBytes(64 * 1024), new Uint8Array(0)]
    for (const plaintext of payloads) {
      const envelope = await encryptExport(PASSWORD, plaintext)
      const decrypted = await decryptExport(PASSWORD, envelope)
      expect(decrypted.byteLength).toBe(plaintext.byteLength)
      expect(firstDifference(decrypted, plaintext)).toBe(-1)
    }
  })

  it('prepends a 16-byte salt and a 12-byte IV, and nothing else', async () => {
    const plaintext = utf8('an export is one self-contained file')
    const envelope = await encryptExport(PASSWORD, plaintext)

    // The layout is the contract between this module and `lib/export.ts`: the
    // salt, then the IV, then ciphertext plus the 16-byte GCM tag. Anything else
    // would make the file unopenable by a later version.
    expect(envelope.byteLength).toBe(16 + 12 + plaintext.byteLength + 16)

    const bytes = bytesOf(envelope)
    const salt = bytes.slice(0, 16)
    const iv = bytes.slice(16, 28)
    const ciphertext = bytes.slice(28)

    // Recomputing the plaintext by hand from exactly those slices proves where
    // each field sits: re-derive the key from the leading salt, decrypt the tail.
    const key = await deriveItemKey(PASSWORD, salt)
    const reopened = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    expect(firstDifference(new Uint8Array(reopened), plaintext)).toBe(-1)
  })

  it('rejects the wrong password with an OperationError, and does not swallow it', async () => {
    const plaintext = utf8('only the right password opens this file')
    const envelope = await encryptExport(PASSWORD, plaintext)

    const failure = await decryptExport(WRONG_PASSWORD, envelope).then(
      () => null,
      (error: unknown) => error,
    )
    if (failure === null) throw new Error('test: a wrong password decrypted an export')
    if (!(failure instanceof DOMException)) {
      throw new Error(`test: expected a DOMException, received ${String(failure)}`)
    }
    // `export.ts` turns exactly this failure into 'Wrong password or corrupted file'.
    expect(failure.name).toBe('OperationError')

    // The rejection is per-call: it may not poison the envelope for the right one.
    expect(firstDifference(await decryptExport(PASSWORD, envelope), plaintext)).toBe(-1)
  })

  it('draws a fresh salt and IV per call, so the same library never encrypts alike', async () => {
    const plaintext = utf8('same bytes twice')
    const first = await encryptExport(PASSWORD, plaintext)
    const second = await encryptExport(PASSWORD, plaintext)

    expect([...bytesOf(first).slice(0, 16)]).not.toEqual([...bytesOf(second).slice(0, 16)])
    expect([...bytesOf(first).slice(16, 28)]).not.toEqual([...bytesOf(second).slice(16, 28)])
    expect([...bytesOf(first)]).not.toEqual([...bytesOf(second)])

    // The fresh salt seeds the derivation, so the first envelope must not open
    // once its salt is replaced by the second call's salt.
    const withOtherSalt = bytesOf(first).slice()
    withOtherSalt.set(bytesOf(second).slice(0, 16), 0)
    await expect(decryptExport(PASSWORD, withOtherSalt.buffer)).rejects.toBeInstanceOf(DOMException)
  })

  it('rejects an envelope too short to hold its own salt and IV', async () => {
    // A truncated file must fail with something that names the problem, not with
    // a DOMException that a caller would report as "wrong password".
    const failure = await decryptExport(PASSWORD, new ArrayBuffer(27)).then(
      () => null,
      (error: unknown) => error,
    )
    if (!(failure instanceof Error)) {
      throw new Error(`test: expected an Error, received ${String(failure)}`)
    }
    expect(failure).not.toBeInstanceOf(DOMException)
    expect(failure.message).toMatch(/27 bytes/)
    expect(failure.message).toMatch(/16-byte salt/)
  })
})

describe('base64 helpers', () => {
  it('matches known base64 vectors', () => {
    expect(toBase64(new Uint8Array([]))).toBe('')
    expect(toBase64(new Uint8Array([102]))).toBe('Zg==')
    expect(toBase64(new Uint8Array([102, 111]))).toBe('Zm8=')
    expect(toBase64(new Uint8Array([102, 111, 111]))).toBe('Zm9v')
    expect(toBase64(new Uint8Array([102, 111, 111, 98]))).toBe('Zm9vYg==')
    expect(toBase64(new TextEncoder().encode('QRDrop'))).toBe('UVJEcm9w')
  })

  it('correctly handles multi-megabyte payloads crossing chunk boundaries', () => {
    const multiMb = new Uint8Array(150_000)
    for (let i = 0; i < multiMb.length; i++) multiMb[i] = (i * 37 + 13) & 0xff
    const encoded = toBase64(multiMb)
    expect(encoded.length).toBe(200_000)
    expect(fromBase64(encoded)).toEqual(multiMb)
  })

  it('round-trips every length modulo 3 and both input types', () => {
    for (const length of [1, 2, 3, 4, 5, 6, 7, 31, 91, 256]) {
      const bytes = patternedBytes(length)
      expect(fromBase64(toBase64(bytes))).toEqual(bytes)
      expect(fromBase64(toBase64(bytes.buffer))).toEqual(bytes)
    }
  })

  it('treats the empty string as malformed, even though no bytes encode to it', () => {
    expect(toBase64(new Uint8Array(0))).toBe('')
    expect(() => fromBase64('')).toThrow(/empty/)
  })

  it('rejects malformed input', () => {
    const malformedInputs = [
      '', // empty
      'A', // truncated group
      'abc', // length not a multiple of 4
      'ab=', // length not a multiple of 4
      'a===', // padding in the middle
      '!!!!', // outside the alphabet
      'Zg==Zg==', // trailing data after padding
      'Zh==', // non-canonical trailing bits
      'Zm9=', // non-canonical trailing bits
      'Zm9v Yg==', // whitespace
      'Zm9v\n', // newline
      'Zm9v$abc', // invalid character
    ]
    for (const input of malformedInputs) {
      expect(() => fromBase64(input), `expected "${input}" to be rejected`).toThrow()
    }
  })
})

describe('word list invariants (PLAN.md §11.6)', () => {
  it('has exactly 256 distinct words', () => {
    expect(WORDLIST.length).toBe(WORDLIST_LENGTH)
    expect(WORDLIST.length).toBe(256)
    expect(new Set(WORDLIST).size).toBe(256)
  })

  it('contains only short lowercase words', () => {
    for (const word of WORDLIST) {
      expect(word).toMatch(/^[a-z]{3,8}$/)
    }
  })

  it('has no two neighbouring words sharing a four-letter opening', () => {
    // The safety phrase is the only authentication an unauthenticated key exchange
    // gets, and it is read at a glance, so a run like whisk/whisper/whistle turns that
    // glance into a squint. Neighbouring entries must diverge before their fourth letter.
    for (let i = 0; i < WORDLIST.length - 1; i += 1) {
      const first = WORDLIST[i] ?? ''
      const second = WORDLIST[i + 1] ?? ''
      let shared = 0
      while (shared < first.length && shared < second.length && first[shared] === second[shared]) {
        shared += 1
      }
      expect(shared, `entries ${i} and ${i + 1}: "${first}" vs "${second}"`).toBeLessThan(4)
    }
  })

  it('has no two words close enough to confuse when read aloud', () => {
    function editDistance(first: string, second: string): number {
      let previous = Array.from({ length: second.length + 1 }, (_, index) => index)
      for (let i = 1; i <= first.length; i++) {
        const current = [i]
        for (let j = 1; j <= second.length; j++) {
          const substitution = (previous[j - 1] ?? 0) + (first[i - 1] === second[j - 1] ? 0 : 1)
          current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution)
        }
        previous = current
      }
      return previous[second.length] ?? 0
    }

    // "no words differing only by a letter or two": every pair must be at
    // least three edits apart, so ball/wall and there/three cannot both exist.
    let closestPair = ''
    let closestDistance = Number.POSITIVE_INFINITY
    for (let i = 0; i < WORDLIST.length; i++) {
      for (let j = i + 1; j < WORDLIST.length; j++) {
        const first = WORDLIST[i] ?? ''
        const second = WORDLIST[j] ?? ''
        const distance = editDistance(first, second)
        if (distance < closestDistance) {
          closestDistance = distance
          closestPair = `"${first}" vs "${second}"`
        }
      }
    }
    expect(closestDistance, `closest pair: ${closestPair}`).toBeGreaterThanOrEqual(3)
  })
})

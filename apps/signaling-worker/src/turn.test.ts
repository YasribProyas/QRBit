import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TURN_TTL_SECONDS,
  generateTurnCredentials,
  turnCredentialExpiresAt,
} from './turn'

const SECRET = 'test-turn-shared-secret'
const USERNAME_PATTERN = /^\d+:[0-9a-f]{32}$/

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** Verifies the credential through Web Crypto's verify path, independently of sign. */
async function credentialIsValid(
  secret: string,
  username: string,
  credential: string,
): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, base64ToBytes(credential), encoder.encode(username))
}

describe('generateTurnCredentials', () => {
  it('returns null when no secret is configured so the caller can omit TURN', async () => {
    expect(await generateTurnCredentials('')).toBeNull()
    expect(await generateTurnCredentials('   ')).toBeNull()
  })

  it('mints a username of the form <expiry>:<nonce>', async () => {
    const credentials = await generateTurnCredentials(SECRET)
    expect(credentials).not.toBeNull()
    expect(credentials?.username).toMatch(USERNAME_PATTERN)
  })

  it('encodes an expiry one hour out by default (PLAN.md §13)', async () => {
    const before = Math.floor(Date.now() / 1000)
    const credentials = await generateTurnCredentials(SECRET)
    const after = Math.floor(Date.now() / 1000)

    const expiresAt = credentials === null ? null : turnCredentialExpiresAt(credentials.username)
    expect(expiresAt).not.toBeNull()
    expect(expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_TURN_TTL_SECONDS)
    expect(expiresAt).toBeLessThanOrEqual(after + DEFAULT_TURN_TTL_SECONDS)
  })

  it('honours a caller-supplied TTL', async () => {
    const before = Math.floor(Date.now() / 1000)
    const credentials = await generateTurnCredentials(SECRET, 60)
    const after = Math.floor(Date.now() / 1000)

    const expiresAt = credentials === null ? null : turnCredentialExpiresAt(credentials.username)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60)
    expect(expiresAt).toBeLessThanOrEqual(after + 60)
  })

  it('produces a credential that verifies against the username it was minted for', async () => {
    const credentials = await generateTurnCredentials(SECRET)
    expect(credentials).not.toBeNull()
    if (credentials === null) return

    expect(await credentialIsValid(SECRET, credentials.username, credentials.credential)).toBe(true)
  })

  it('produces a credential that fails for a different secret', async () => {
    const credentials = await generateTurnCredentials(SECRET)
    expect(credentials).not.toBeNull()
    if (credentials === null) return

    expect(await credentialIsValid('wrong-secret', credentials.username, credentials.credential)).toBe(
      false,
    )
  })

  it('produces a credential that fails for a different username', async () => {
    const credentials = await generateTurnCredentials(SECRET)
    expect(credentials).not.toBeNull()
    if (credentials === null) return

    expect(await credentialIsValid(SECRET, '9999999999:other', credentials.credential)).toBe(false)
  })

  it('is a base64-encoded SHA-256 HMAC, so it decodes to exactly 32 bytes', async () => {
    const credentials = await generateTurnCredentials(SECRET)
    expect(credentials).not.toBeNull()
    if (credentials === null) return

    expect(base64ToBytes(credentials.credential)).toHaveLength(32)
  })

  it('mints a fresh nonce per call so a credential is single-use per session', async () => {
    const first = await generateTurnCredentials(SECRET)
    const second = await generateTurnCredentials(SECRET)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first?.username).not.toBe(second?.username)
    expect(first?.credential).not.toBe(second?.credential)
  })

  it('rejects a TTL that is not a positive finite number', async () => {
    await expect(generateTurnCredentials(SECRET, 0)).rejects.toThrow(RangeError)
    await expect(generateTurnCredentials(SECRET, -60)).rejects.toThrow(RangeError)
    await expect(generateTurnCredentials(SECRET, Number.NaN)).rejects.toThrow(RangeError)
    await expect(generateTurnCredentials(SECRET, Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError)
  })
})

describe('turnCredentialExpiresAt', () => {
  it('reads back the encoded expiry', () => {
    expect(turnCredentialExpiresAt('1700000000:abc')).toBe(1_700_000_000)
  })

  it('returns null for a malformed username', () => {
    expect(turnCredentialExpiresAt('')).toBeNull()
    expect(turnCredentialExpiresAt('no-colon')).toBeNull()
    expect(turnCredentialExpiresAt(':abc')).toBeNull()
    expect(turnCredentialExpiresAt('not-a-number:abc')).toBeNull()
  })
})

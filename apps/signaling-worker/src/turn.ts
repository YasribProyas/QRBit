import type { TurnCredentials } from './types'

/**
 * TURN credential minting (PLAN.md §13).
 *
 * Cloudflare TURN uses the coturn "time-limited credential" mechanism: the username
 * carries the expiry so the TURN server can authorise a relay without a database
 * lookup, and the credential proves the username was minted by someone holding the
 * shared secret. The secret itself never leaves the worker.
 *
 * Web Crypto only — AGENTS.md forbids third-party crypto libraries.
 */

/** PLAN.md §13: TURN credentials expire after 1 hour. */
export const DEFAULT_TURN_TTL_SECONDS = 3600

const NONCE_BYTES = 16

/**
 * Mints a single-use TURN credential pair.
 *
 * Returns null when no secret is configured so the caller can omit `turnCredentials`
 * entirely and let the client fall back to STUN-only. An absent secret is a
 * deployment gap, not an error worth failing a session over.
 */
export async function generateTurnCredentials(
  secret: string,
  ttlSeconds: number = DEFAULT_TURN_TTL_SECONDS,
): Promise<TurnCredentials | null> {
  if (secret.trim() === '') return null

  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError('ttlSeconds must be a positive finite number')
  }

  // PLAN.md §13: username = `<unixTimestamp + 3600>:<randomId>`.
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds)
  const username = `${expiresAtSeconds}:${randomNonce()}`
  const credential = await hmacSha256Base64(secret, username)

  return { username, credential }
}

/**
 * Reads back the expiry encoded in a TURN username.
 *
 * Exported so tests can assert the expiry arithmetic independently of how the
 * username was produced. Returns null when the username is malformed.
 */
export function turnCredentialExpiresAt(username: string): number | null {
  const separator = username.indexOf(':')
  if (separator <= 0) return null

  const seconds = Number(username.slice(0, separator))
  return Number.isFinite(seconds) ? seconds : null
}

function randomNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES)
  crypto.getRandomValues(bytes)

  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return base64FromBuffer(signature)
}

function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)

  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  // btoa is available in the Workers runtime; the substring is binary-safe because
  // every byte was mapped through String.fromCharCode above.
  return btoa(binary)
}

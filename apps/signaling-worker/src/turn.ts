import type { TurnCredentials } from './types'

/**
 * TURN credential minting via Cloudflare Realtime TURN API (PLAN.md §13, ORCHESTRATION.md D11).
 *
 * Cloudflare Realtime TURN uses a REST API to generate short-lived TURN credentials:
 *   POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate
 *   Authorization: Bearer {TURN_KEY_SECRET}
 *   Content-Type: application/json
 *   { "ttl": <1..172800>, "customIdentifier": <string, max 128 chars> }
 *
 * Returns 201 with `{ iceServers: { urls: string[], username: string, credential: string } }`.
 *
 * When TURN_KEY_ID or TURN_KEY_SECRET is absent (e.g. local development or before keys
 * are provisioned), the mint returns null and the client falls back to STUN-only.
 */

/** Default TURN credential lifetime in seconds (wrangler.toml TURN_TTL_SECONDS). */
export const DEFAULT_TURN_TTL_SECONDS = 600

/** Cloudflare API bounds on TTL: 1 second minimum, 48 hours maximum (172800 seconds). */
export const MIN_TURN_TTL_SECONDS = 1
export const MAX_TURN_TTL_SECONDS = 172800

const MAX_CUSTOM_IDENTIFIER_LENGTH = 128
/**
 * Matches a TURN/TURNS URL whose port is 53, with or without a query string or
 * trailing path (`:53`, `:53?transport=udp`, `:53/`). A bare `:53?` substring test
 * misses the no-query form, and Chrome/Firefox block port 53 outright, so a relay
 * URL that survives this filter is one the browser will silently fail on.
 */
const PORT_53_URL = /:53(?:\?|\/|$)/

/**
 * Clamps TTL to Cloudflare's acceptable integer range [1..172800].
 */
export function clampTurnTtl(ttlSeconds?: number): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) {
    return DEFAULT_TURN_TTL_SECONDS
  }
  return Math.max(MIN_TURN_TTL_SECONDS, Math.min(MAX_TURN_TTL_SECONDS, Math.floor(ttlSeconds)))
}

/**
 * Mints TURN credentials using the Cloudflare Realtime TURN API.
 *
 * Returns null when TURN_KEY_ID or TURN_KEY_SECRET is missing or blank, when the HTTP
 * call fails, or when the response shape is unexpected. Never throws or rejects.
 */
export async function generateTurnCredentials(
  keyId: string | undefined,
  keySecret: string | undefined,
  sessionCode: string,
  ttlSeconds: number = DEFAULT_TURN_TTL_SECONDS,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<TurnCredentials | null> {
  if (
    keyId === undefined ||
    keyId.trim() === '' ||
    keySecret === undefined ||
    keySecret.trim() === ''
  ) {
    return null
  }

  const trimmedKeyId = keyId.trim()
  const trimmedSecret = keySecret.trim()
  const trimmedCode = sessionCode.trim()

  const customIdentifier = `qrdrop:${trimmedCode}`.slice(0, MAX_CUSTOM_IDENTIFIER_LENGTH)
  const ttl = clampTurnTtl(ttlSeconds)

  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(trimmedKeyId)}/credentials/generate`

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${trimmedSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl, customIdentifier }),
    })

    if (!response.ok) {
      return null
    }

    const payload: unknown = await response.json()
    return parseTurnResponse(payload)
  } catch {
    // Fail open: network failures or fetch rejections must never break session creation.
    return null
  }
}

function parseTurnResponse(payload: unknown): TurnCredentials | null {
  if (typeof payload !== 'object' || payload === null) return null

  const record = payload as Record<string, unknown>
  const rawIceServers = record['iceServers']
  if (typeof rawIceServers !== 'object' || rawIceServers === null) return null

  let target: Record<string, unknown>
  if (Array.isArray(rawIceServers)) {
    if (
      rawIceServers.length === 0 ||
      typeof rawIceServers[0] !== 'object' ||
      rawIceServers[0] === null
    ) {
      return null
    }
    target = rawIceServers[0] as Record<string, unknown>
  } else {
    target = rawIceServers as Record<string, unknown>
  }

  const username = target['username']
  const credential = target['credential']
  const urls = target['urls']

  if (typeof username !== 'string' || username.trim() === '') return null
  if (typeof credential !== 'string' || credential.trim() === '') return null
  if (!Array.isArray(urls)) return null

  const filteredUrls: string[] = []
  for (const item of urls) {
    if (typeof item !== 'string') return null
    // Filter port-53 URLs (Chrome and Firefox block port 53 to prevent DNS collisions)
    if (!PORT_53_URL.test(item)) {
      filteredUrls.push(item)
    }
  }

  return {
    iceServers: filteredUrls,
    urls: filteredUrls,
    username,
    credential,
  }
}

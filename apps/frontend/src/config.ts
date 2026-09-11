/**
 * Runtime configuration and signaling endpoint construction (PLAN.md §18).
 *
 * The dev defaults point at `wrangler dev`, which serves the signaling worker on
 * port 8787. Production sets VITE_SIGNALING_URL and VITE_APP_URL at build time.
 */

const DEFAULT_SIGNALING_URL = 'ws://localhost:8787'
const DEFAULT_APP_URL = 'http://localhost:5173'

/** Strips trailing slashes so `${base}/path` never produces a double slash. */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/** First candidate that is a non-blank string, or null. */
function firstNonBlank(...candidates: readonly (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim()
    }
  }
  return null
}

/**
 * Derives the HTTP base for the worker from its WebSocket base.
 *
 * `/session/new` is a plain HTTP GET (PLAN.md §13), but the single configured
 * value is the WebSocket URL the signaling client needs. Rather than make the
 * operator set the same host twice and risk them disagreeing, the HTTP base is
 * derived from the WebSocket base.
 */
export function toHttpBase(webSocketUrl: string): string {
  return webSocketUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
}

/** Base WebSocket URL of the signaling worker. Passed straight to SignalingClient. */
export const SIGNALING_WS_URL = stripTrailingSlashes(
  firstNonBlank(import.meta.env.VITE_SIGNALING_URL) ?? DEFAULT_SIGNALING_URL,
)

/** Public origin this app is served from. */
export const APP_URL = stripTrailingSlashes(firstNonBlank(import.meta.env.VITE_APP_URL) ?? DEFAULT_APP_URL)

/** `GET {SIGNALING_HTTP_URL}/session/new` creates a session and issues TURN credentials. */
export const SIGNALING_HTTP_URL = toHttpBase(SIGNALING_WS_URL)

/**
 * Builds the session URL that a QR code encodes (PLAN.md §8).
 *
 * The QR carries a full URL, so scanning it with any camera app opens the
 * session directly and no in-app scan is required.
 */
export function buildSessionUrl(code: string): string {
  return `${APP_URL}/session?code=${encodeURIComponent(code)}`
}

/** Full URL of the worker's session-creation route. */
export function buildNewSessionUrl(): string {
  return `${SIGNALING_HTTP_URL}/session/new`
}

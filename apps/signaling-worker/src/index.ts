import { generateSessionCode, isValidSessionCode } from './codes'
import { DEFAULT_TURN_TTL_SECONDS, generateTurnCredentials } from './turn'
import type { SessionNewResponse } from './types'

/**
 * wrangler resolves the Durable Object class from the main module, so the binding
 * declared in wrangler.toml only works if this re-export stays here.
 */
export { SessionDurableObject } from './session'

/**
 * Signaling entry point (PLAN.md §13).
 *
 * Routes:
 *   GET /session/new       -> { code, turnCredentials? }
 *   GET /session/:code/ws  -> WebSocket upgrade, handled by the session DO
 *   GET /healthz           -> 'ok'
 *
 * The worker only mints codes and forwards upgrades. It never inspects, stores or
 * logs SDP, ICE or item content — that is the Durable Object's relay at most, and
 * even there nothing is persisted.
 */

const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:5173'

/** PLAN.md §13: max 10 join attempts per IP per minute. */
const RATE_LIMIT_MAX_JOIN_ATTEMPTS = 10
const RATE_LIMIT_WINDOW_SECONDS = 60

const SESSION_SOCKET_PATH = /^\/session\/([^/]+)\/ws$/

const CSP_DIRECTIVES =
  "default-src 'self'; connect-src wss://*.workers.dev https://turn.cloudflare.com; worker-src 'self'"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const cors = corsHeaders(request, env)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: mergeHeaders(cors, securityHeaders()) })
    }

    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200, headers: mergeHeaders(cors, securityHeaders()) })
    }

    if (url.pathname === '/session/new') {
      if (!isValidSessionNewFetch(request)) {
        return json({ error: 'Forbidden' }, 403, cors)
      }
      return createSession(env, cors)
    }

    const match = SESSION_SOCKET_PATH.exec(url.pathname)
    if (match !== null) {
      // `?? ''` keeps a missing capture from leaking an undefined; an empty string
      // then fails isValidSessionCode and yields the same 400 as any other
      // malformed code.
      return openSignalingSocket(request, env, match[1] ?? '', cors)
    }

    return json({ error: 'Not found' }, 404, cors)
  },
} satisfies ExportedHandler<Env>

async function createSession(env: Env, cors: Headers): Promise<Response> {
  const code = generateSessionCode()
  const stub = env.SESSION.get(env.SESSION.idFromName(code))

  try {
    // Stamps createdAt inside the DO so the 300s expiry runs from creation even if
    // the guest never connects (PLAN.md §17).
    await stub.fetch(`https://session.internal/session/${code}/create`, { method: 'POST' })
  } catch {
    return json({ error: 'Session unavailable' }, 503, cors)
  }

  const secret = env.TURN_SECRET
  // Without a configured secret the client falls back to STUN-only rather than the
  // session failing outright (a deployment gap, not a user error).
  const turnCredentials =
    secret === undefined ? null : await generateTurnCredentials(secret, resolveTurnTtlSeconds(env))

  const body: SessionNewResponse = turnCredentials === null ? { code } : { code, turnCredentials }
  return json(body, 200, cors)
}

async function openSignalingSocket(
  request: Request,
  env: Env,
  code: string,
  cors: Headers,
): Promise<Response> {
  // Sec-Fetch-* browser-CSRF defense: browsers always send Sec-Fetch-Mode: websocket
  // for WebSocket upgrades. Rejects cross-origin fetch CSRF attempts.
  if (!isValidSessionWsFetch(request)) {
    return json({ error: 'Forbidden' }, 403, cors)
  }

  // PLAN.md §17: the code is validated server-side BEFORE the Durable Object lookup,
  // so malformed input can never allocate or address a DO.
  if (!isValidSessionCode(code)) {
    return json({ error: 'Invalid session code' }, 400, cors)
  }

  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'Expected WebSocket upgrade' }, 426, cors, { omitCsp: true })
  }

  if (await isRateLimited(request, env)) {
    return json({ error: 'Rate limit exceeded' }, 429, cors)
  }

  const stub = env.SESSION.get(env.SESSION.idFromName(code))
  // The original request is forwarded untouched: re-constructing it risks dropping
  // the Upgrade handshake. The DO parses the code from the same path it sees here.
  return stub.fetch(request)
}

/**
 * Sliding-window join limiter backed by Workers KV (PLAN.md §13).
 *
 * The expirationTtl is reapplied on every write because KV drops a key's expiry when
 * it is overwritten without one.
 *
 * A KV failure degrades to "rate limiting disabled" (false) rather than propagating.
 * That is a DELIBERATE fail-open choice for availability: the only cost is a missing
 * limit, while a thrown KV error would escape the fetch handler and 500 every
 * /session/:code/ws upgrade — including the ones the rate limiter is meant to protect.
 *
 * This is live-reachable: wrangler.toml currently ships a placeholder namespace id,
 * so the binding can be present but unable to serve a request.
 */
async function isRateLimited(request: Request, env: Env): Promise<boolean> {
  const kv = rateLimitBinding(env)
  if (kv === undefined) return false

  const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const key = `join:${clientIp}`

  try {
    const stored = await kv.get(key)
    const previous = stored === null ? 0 : Number(stored)
    const attempts = (Number.isFinite(previous) ? previous : 0) + 1

    if (attempts > RATE_LIMIT_MAX_JOIN_ATTEMPTS) return true

    await kv.put(key, String(attempts), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS })
    return false
  } catch {
    // Fail open, per the policy documented above. Nothing about the failure is
    // logged: PLAN.md §17 keeps the worker's logs free of request detail.
    return false
  }
}

/**
 * Resolves the RATE_LIMIT binding defensively.
 *
 * worker-configuration.d.ts types RATE_LIMIT as always present, but the namespace id
 * in wrangler.toml is still a placeholder and the binding can be absent at runtime.
 * Rate limiting degrades to "disabled" instead of throwing, so a missing binding can
 * never take the worker down.
 */
function rateLimitBinding(env: Env): KVNamespace | undefined {
  const candidate: unknown = env.RATE_LIMIT
  return isKvNamespace(candidate) ? candidate : undefined
}

function isKvNamespace(value: unknown): value is KVNamespace {
  return typeof value === 'object' && value !== null && 'get' in value && 'put' in value
}

function resolveTurnTtlSeconds(env: Env): number {
  const parsed = Number(env.TURN_TTL_SECONDS)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TURN_TTL_SECONDS
}

function allowedOrigins(env: Env): string[] {
  const configured = env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS
  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '')
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers()
  const origin = request.headers.get('Origin')

  // Only ever reflect an origin that is explicitly allowlisted — never a wildcard,
  // since this endpoint mints session codes.
  if (origin !== null && allowedOrigins(env).includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }

  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type')
  headers.set('Access-Control-Max-Age', '600')
  return headers
}

function json(
  body: unknown,
  status: number,
  headers: Headers,
  options?: { omitCsp?: boolean },
): Response {
  const responseHeaders = mergeHeaders(headers, securityHeaders(options))
  responseHeaders.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

/**
 * Returns security hardening headers (PLAN.md §16 Phase 8, §17).
 *
 * Content-Security-Policy is omitted on WebSocket upgrade responses (101) and the
 * 426 upgrade challenge, as browsers silently discard CSP on 101 and some reject the
 * handshake. It is included on all standard non-upgrade JSON responses and OPTIONS.
 */
function securityHeaders(options?: { omitCsp?: boolean }): Headers {
  const headers = new Headers()
  if (!options?.omitCsp) {
    headers.set('Content-Security-Policy', CSP_DIRECTIVES)
  }
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  return headers
}

/** Merges security headers after CORS headers so CORS values are preserved. */
function mergeHeaders(cors: Headers, security: Headers): Headers {
  const merged = new Headers(cors)
  for (const [key, value] of security.entries()) {
    merged.set(key, value)
  }
  return merged
}

/**
 * Sec-Fetch-* check on GET /session/new (PLAN.md §16 Phase 8).
 * Accepts: Sec-Fetch-Mode: cors AND Sec-Fetch-Site: cross-site (or same-origin/same-site in local dev).
 * Rejects other modes (e.g. 'navigate', 'no-cors') with 403.
 * Missing headers pass through (non-browser clients, curl, Postman).
 */
function isValidSessionNewFetch(request: Request): boolean {
  const mode = request.headers.get('Sec-Fetch-Mode')
  if (mode === null) return true
  if (mode !== 'cors') return false

  const site = request.headers.get('Sec-Fetch-Site')
  if (site === null) return true
  return site === 'cross-site' || site === 'same-origin' || site === 'same-site'
}

/**
 * Sec-Fetch-* check on GET /session/:code/ws (PLAN.md §16 Phase 8).
 * WebSocket from a browser always sends Sec-Fetch-Mode: websocket.
 * Rejects if the header is present but is NOT 'websocket' with 403.
 * Missing headers pass through (non-browser clients, wrangler dev).
 */
function isValidSessionWsFetch(request: Request): boolean {
  const mode = request.headers.get('Sec-Fetch-Mode')
  if (mode === null) return true
  return mode === 'websocket'
}

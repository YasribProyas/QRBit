import { generateSessionCode, isValidSessionCode } from './codes'
import { clampTurnTtl, generateTurnCredentials } from './turn'
import type { SessionNewResponse, SessionTurnResponse, TurnCredentials } from './types'

/**
 * wrangler resolves the Durable Object class from the main module, so the binding
 * declared in wrangler.toml only works if this re-export stays here.
 */
export { SessionDurableObject } from './session'

/**
 * Signaling entry point (PLAN.md §13, ORCHESTRATION.md D10, D11).
 *
 * Routes:
 *   GET /session/new            -> { code }
 *   GET /session/:code/turn     -> { iceServers: string[], username, credential } or 503
 *   GET /session/:code/ws       -> WebSocket upgrade, handled by the session DO
 *   GET /healthz                -> 'ok'
 *
 * The worker only mints codes, serves credentials, and forwards upgrades. It never
 * inspects, stores or logs SDP, ICE or item content — that is the Durable Object's relay
 * at most, and even there nothing is persisted.
 */

const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:5173'

/** Rate limit caps per IP per 60s window. */
const RATE_LIMIT_NEW_SESSION_CAP = 10
const RATE_LIMIT_TURN_CAP = 8
const RATE_LIMIT_JOIN_CAP = 10
const RATE_LIMIT_WINDOW_SECONDS = 60

/** Maximum number of TURN credential requests per session code across all clients. */
const MAX_TURN_REQUESTS_PER_SESSION = 4

/**
 * How long a minted code counts as "issued" for the purposes of buying relay
 * credentials (D10). 360s (300s session + 60s grace).
 */
const ISSUED_CODE_KV_TTL_SECONDS = 360

const SESSION_SOCKET_PATH = /^\/session\/([^/]+)\/ws$/
const SESSION_TURN_PATH = /^\/session\/([^/]+)\/turn$/

const CSP_CONNECT_SRC_HOSTS = "https://turn.cloudflare.com"

/**
 * `connect-src` for the hardening headers (PLAN.md §17).
 *
 * The origins allowed to call this API are exactly the origins whose documents need to
 * reach it, so the directive is DERIVED from ALLOWED_ORIGINS rather than hardcoded to
 * `*.workers.dev`. A hardcoded value silently rots the moment the app moves onto a custom
 * domain: the header still ships, and now blocks the one connection it exists to permit.
 */
function cspConnectSrc(env: Env): string {
  const sources = new Set<string>(["'self'"])
  for (const origin of allowedOrigins(env)) {
    sources.add(origin)
    const asWss = origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
    sources.add(asWss)
  }
  sources.add(CSP_CONNECT_SRC_HOSTS)
  return sources.size > 0 ? [...sources].join(' ') : CSP_CONNECT_SRC_HOSTS
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // CORS and hardening headers are merged ONCE per request, then threaded through
    // every response builder. Deriving them per-call would mean each new route has to
    // remember to apply them — and a route that forgets fails open, silently.
    const baseHeaders = mergeHeaders(
      corsHeaders(request, env),
      securityHeaders({ connectSrc: cspConnectSrc(env) }),
    )

    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200, headers: baseHeaders })
    }

    const origin = request.headers.get('Origin')
    if (origin !== null && !allowedOrigins(env).includes(origin)) {
      return json({ error: 'Forbidden origin' }, 403, baseHeaders)
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: baseHeaders })
    }

    if (url.pathname === '/session/new') {
      if (!isValidBrowserFetch(request)) {
        return json({ error: 'Forbidden' }, 403, baseHeaders)
      }
      if (await isRateLimited(request, env, 'new', RATE_LIMIT_NEW_SESSION_CAP)) {
        return json({ error: 'Rate limit exceeded' }, 429, baseHeaders)
      }
      return createSession(env, baseHeaders)
    }

    const turnMatch = SESSION_TURN_PATH.exec(url.pathname)
    if (turnMatch !== null) {
      const code = turnMatch[1] ?? ''
      return handleTurnCredentials(request, env, code, baseHeaders)
    }

    const wsMatch = SESSION_SOCKET_PATH.exec(url.pathname)
    if (wsMatch !== null) {
      // `?? ''` keeps a missing capture from leaking an undefined; an empty string
      // then fails isValidSessionCode and yields the same 400 as any other
      // malformed code.
      return openSignalingSocket(request, env, wsMatch[1] ?? '', baseHeaders)
    }

    return json({ error: 'Not found' }, 404, baseHeaders)
  },
} satisfies ExportedHandler<Env>

async function createSession(env: Env, baseHeaders: Headers): Promise<Response> {
  const code = generateSessionCode()
  const stub = env.SESSION.get(env.SESSION.idFromName(code))

  try {
    // Stamps createdAt inside the DO so the 300s expiry runs from creation even if
    // the guest never connects (PLAN.md §17).
    await stub.fetch(`https://session.internal/session/${code}/create`, { method: 'POST' })
  } catch {
    return json({ error: 'Session unavailable' }, 503, baseHeaders)
  }

  // D10: record that this code was issued, so the credential route can require it.
  // Best-effort on purpose. Failing the mint instead would let a KV write blip take the
  // whole product down. The consequence is fail-SAFE: with no marker, /session/:code/turn
  // answers 404 and this session falls back to STUN-only, which is a degraded connection
  // rather than an unbillable grant of paid relay capacity.
  await markCodeIssued(code, env)

  // D10: /session/new returns { code } ONLY. No TURN credentials in this response.
  const body: SessionNewResponse = { code }
  return json(body, 200, baseHeaders)
}

async function handleTurnCredentials(
  request: Request,
  env: Env,
  code: string,
  baseHeaders: Headers,
): Promise<Response> {
  // Sec-Fetch-* browser-CSRF defense: mode must be 'cors' when present.
  if (!isValidBrowserFetch(request)) {
    return json({ error: 'Forbidden' }, 403, baseHeaders)
  }

  // Reject malformed codes before KV or DO lookup.
  if (!isValidSessionCode(code)) {
    return json({ error: 'Invalid session code' }, 400, baseHeaders)
  }

  // Check burned registry (Change 3).
  if (await isCodeBurned(code, env)) {
    return json({ error: 'Session already paired or expired' }, 410, baseHeaders)
  }

  // D10: only a code this worker actually issued, still inside its window, may buy
  // relay traffic. Without this, any well-formed 8-character string — including one
  // whose session expired without ever pairing, which is never marked burned — would
  // mint live credentials and bill the operator's TURN allowance.
  if ((await codeIssuedStatus(code, env)) === 'absent') {
    return json({ error: 'Session not found' }, 404, baseHeaders)
  }

  if (await isRateLimited(request, env, 'turn', RATE_LIMIT_TURN_CAP)) {
    return json({ error: 'Rate limit exceeded' }, 429, baseHeaders)
  }

  // Per-session quota: protect against botnet / distributed TURN credential harvesting.
  // A session code only ever needs TURN for host and guest (max 4 fetches total).
  if (await isSessionTurnQuotaExceeded(code, env)) {
    return json({ error: 'Session TURN quota exceeded' }, 429, baseHeaders)
  }

  // Per-session KV credential caching: host and guest share credentials, cutting external
  // Cloudflare API calls by 50%+ and preventing re-minting on network retries.
  const cached = await getCachedTurnCredentials(code, env)
  if (cached !== null) {
    const body: SessionTurnResponse = {
      iceServers: cached.iceServers,
      urls: cached.urls,
      username: cached.username,
      credential: cached.credential,
    }
    return json(body, 200, baseHeaders)
  }

  const keyId = env.TURN_KEY_ID
  const keySecret = env.TURN_KEY_SECRET
  const ttl = resolveTurnTtlSeconds(env)

  const credentials = await generateTurnCredentials(keyId, keySecret, code, ttl)

  if (credentials === null) {
    // 503 when credentials unavailable (e.g. absent keys or Cloudflare API error)
    return json({ error: 'TURN unavailable' }, 503, baseHeaders)
  }

  await setCachedTurnCredentials(code, credentials, ttl, env)

  const body: SessionTurnResponse = {
    iceServers: credentials.iceServers,
    urls: credentials.urls,
    username: credentials.username,
    credential: credentials.credential,
  }
  return json(body, 200, baseHeaders)
}

async function openSignalingSocket(
  request: Request,
  env: Env,
  code: string,
  baseHeaders: Headers,
): Promise<Response> {
  // Sec-Fetch-* browser-CSRF defense: browsers always send Sec-Fetch-Mode: websocket
  // for WebSocket upgrades. Rejects cross-origin fetch CSRF attempts.
  if (!isValidSessionWsFetch(request)) {
    return json({ error: 'Forbidden' }, 403, baseHeaders)
  }

  // PLAN.md §17: the code is validated server-side BEFORE the Durable Object lookup,
  // so malformed input can never allocate or address a DO.
  if (!isValidSessionCode(code)) {
    return json({ error: 'Invalid session code' }, 400, baseHeaders)
  }

  // Check burned registry (Change 3).
  if (await isCodeBurned(code, env)) {
    return json({ error: 'Session already paired or expired' }, 410, baseHeaders)
  }

  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'Expected WebSocket upgrade' }, 426, withoutCsp(baseHeaders))
  }

  if (await isRateLimited(request, env, 'join', RATE_LIMIT_JOIN_CAP)) {
    return json({ error: 'Rate limit exceeded' }, 429, baseHeaders)
  }

  const stub = env.SESSION.get(env.SESSION.idFromName(code))
  // The original request is forwarded untouched: re-constructing it risks dropping
  // the Upgrade handshake. The DO parses the code from the same path it sees here.
  return stub.fetch(request)
}

/**
 * Checks if a session code has been marked as burned in KV.
 * Fails open (returns false) if KV fails.
 */
async function isCodeBurned(code: string, env: Env): Promise<boolean> {
  const kv = rateLimitBinding(env)
  if (kv === undefined) return false

  try {
    const value = await kv.get(`burned:${code}`)
    return value !== null
  } catch {
    return false
  }
}

/**
 * Records that `code` was issued by this worker (D10). Best-effort: a failure leaves
 * the code minted but unable to buy credentials, which is the safe direction.
 */
async function markCodeIssued(code: string, env: Env): Promise<void> {
  const kv = rateLimitBinding(env)
  if (kv === undefined) return

  try {
    await kv.put(`issued:${code}`, '1', { expirationTtl: ISSUED_CODE_KV_TTL_SECONDS })
  } catch {
    // Nothing about the failure is logged (PLAN.md §17), and the session still works
    // STUN-only — see the fail-safe note at the call site.
  }
}

/**
 * Whether a code was issued and is still inside its credential window.
 *
 * Three states, because "KV said no" and "KV is broken" must not collapse into each
 * other: `absent` rejects (a code we never minted, or one whose window lapsed, buys
 * nothing), while `unknown` fails OPEN — consistent with the burn and rate-limit
 * policies, so a KV outage degrades the limit rather than black-holing every session.
 */
async function codeIssuedStatus(code: string, env: Env): Promise<'issued' | 'absent' | 'unknown'> {
  const kv = rateLimitBinding(env)
  if (kv === undefined) return 'unknown'

  try {
    return (await kv.get(`issued:${code}`)) !== null ? 'issued' : 'absent'
  } catch {
    return 'unknown'
  }
}

/**
 * Per-session fetch quota for TURN credentials.
 * Even if an attacker uses multiple IPs to request credentials for a valid session code,
 * the total number of TURN fetches for that code is strictly capped.
 */
async function isSessionTurnQuotaExceeded(code: string, env: Env): Promise<boolean> {
  const kv = rateLimitBinding(env)
  if (kv === undefined) return false

  const key = `turn_count:${code}`
  try {
    const stored = await kv.get(key)
    const previous = stored === null ? 0 : Number(stored)
    const count = (Number.isFinite(previous) ? previous : 0) + 1

    if (count > MAX_TURN_REQUESTS_PER_SESSION) {
      return true
    }

    await kv.put(key, String(count), { expirationTtl: ISSUED_CODE_KV_TTL_SECONDS })
    return false
  } catch {
    return false
  }
}

/**
 * Retrieves cached TURN credentials for a session from KV.
 */
async function getCachedTurnCredentials(code: string, env: Env): Promise<TurnCredentials | null> {
  const kv = rateLimitBinding(env)
  if (kv === undefined) return null

  try {
    const raw = await kv.get(`turn_cred:${code}`)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).iceServers) &&
      Array.isArray((parsed as Record<string, unknown>).urls) &&
      typeof (parsed as Record<string, unknown>).username === 'string' &&
      typeof (parsed as Record<string, unknown>).credential === 'string'
    ) {
      return parsed as TurnCredentials
    }
    return null
  } catch {
    return null
  }
}

/**
 * Stores minted TURN credentials in KV for the lifetime of the session.
 */
async function setCachedTurnCredentials(
  code: string,
  credentials: TurnCredentials,
  ttlSeconds: number,
  env: Env,
): Promise<void> {
  const kv = rateLimitBinding(env)
  if (kv === undefined) return

  try {
    await kv.put(`turn_cred:${code}`, JSON.stringify(credentials), {
      expirationTtl: Math.max(60, ttlSeconds),
    })
  } catch {
    // Fail open: failure to cache in KV must not fail the request
  }
}

/**
 * Sliding-window limiter backed by Workers KV (PLAN.md §13, D10).
 *
 * The expirationTtl is reapplied on every write because KV drops a key's expiry when
 * it is overwritten without one.
 *
 * A KV failure degrades to "rate limiting disabled" (false) rather than propagating.
 * That is a DELIBERATE fail-open choice for availability: the only cost is a missing
 * limit, while a thrown KV error would escape the fetch handler and 500 requests.
 */
async function isRateLimited(
  request: Request,
  env: Env,
  prefix: 'new' | 'turn' | 'join',
  cap: number,
): Promise<boolean> {
  const kv = rateLimitBinding(env)
  if (kv === undefined) return false

  const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const key = `${prefix}:${clientIp}`

  try {
    const stored = await kv.get(key)
    const previous = stored === null ? 0 : Number(stored)
    const attempts = (Number.isFinite(previous) ? previous : 0) + 1

    if (attempts > cap) return true

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
  return clampTurnTtl(parsed)
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

/**
 * Builds a JSON response. Hardening headers are already on `headers` — see the comment
 * in `fetch`, where they are merged once per request.
 */
function json(body: unknown, status: number, headers: Headers): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

/**
 * A copy of `headers` with the CSP removed.
 *
 * Browsers silently discard CSP on a 101 upgrade and some reject the handshake outright,
 * so the 426 upgrade challenge must not carry it. The WebSocket tunnel itself is protected
 * by the app-layer E2EE, not by a document policy.
 */
function withoutCsp(headers: Headers): Headers {
  const copy = new Headers(headers)
  copy.delete('Content-Security-Policy')
  return copy
}

/** The §17 policy, with `connect-src` supplied per request. */
function cspDirectives(connectSrc: string): string {
  return `default-src 'self'; connect-src ${connectSrc}; worker-src 'self'`
}

/**
 * Returns security hardening headers (PLAN.md §16 Phase 8, §17).
 *
 * Content-Security-Policy is omitted on WebSocket upgrade responses (101) and the
 * 426 upgrade challenge, as browsers silently discard CSP on 101 and some reject the
 * handshake. It is included on all standard non-upgrade JSON responses and OPTIONS.
 */
function securityHeaders(options: { connectSrc: string }): Headers {
  const headers = new Headers()
  headers.set('Content-Security-Policy', cspDirectives(options.connectSrc))
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  return headers
}

/** Merges security headers after CORS headers so CORS values are preserved. */
function mergeHeaders(baseHeaders: Headers, security: Headers): Headers {
  const merged = new Headers(baseHeaders)
  for (const [key, value] of security.entries()) {
    merged.set(key, value)
  }
  return merged
}

/**
 * Sec-Fetch-* check for browser requests to /session/new and /session/:code/turn.
 * Accepts: Sec-Fetch-Mode: cors AND Sec-Fetch-Site: cross-site (or same-origin/same-site in local dev).
 * Rejects other modes (e.g. 'navigate', 'no-cors') with 403.
 * Missing headers pass through (non-browser clients, curl, Postman).
 */
function isValidBrowserFetch(request: Request): boolean {
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

import { describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => {
  class DurableObject {
    constructor(public ctx: unknown, public env: unknown) {}
  }
  return { DurableObject }
})

import worker from './index'

/** A well-formed code from the Phase 1 alphabet, reused by the route tests. */
const VALID_CODE = '23456789'

/*
 * The §17 policy as it ships now that connect-src is DERIVED from ALLOWED_ORIGINS
 * (cspConnectSrc in index.ts): the origins permitted to call this API are exactly the
 * origins whose documents must be allowed to reach it, including the ws:// form of the
 * WebSocket upgrade. Hardcoding `wss://*.workers.dev` would have rotted the moment the
 * app moved onto a custom domain — the header would still ship, and would then block the
 * one connection it exists to permit.
 */
const DEFAULT_CSP =
  "default-src 'self'; connect-src 'self' http://localhost:5173 ws://localhost:5173 https://turn.cloudflare.com; worker-src 'self'"

/**
 * A Map-backed KV stand-in.
 *
 * The previous stub returned null for every `get` and had `put` overwrite one shared
 * counter, which silently conflated unrelated keys. That was harmless while only the
 * rate limiter used KV; it became a false test the moment a code carried three kinds
 * of record (`new:<ip>`, `issued:<code>`, `burned:<code>`), because a stub that cannot
 * distinguish keys reports behaviour the real binding would never produce.
 */
function createKvStore(initial?: Record<string, string>): {
  kv: KVNamespace
  store: Map<string, string>
} {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  } as unknown as KVNamespace
  return { kv, store }
}

function createMemoryKv(initial?: Record<string, string>): KVNamespace {
  return createKvStore(initial).kv
}

/** Seeding that makes VALID_CODE look freshly issued, for the credential-route tests. */
function issuedKv(): KVNamespace {
  return createMemoryKv({ [`issued:${VALID_CODE}`]: '1' })
}

function createMockEnv(
  overrides?: Partial<Env> & { kvSeed?: Record<string, string> },
): Env {
  const { kvSeed, ...envOverrides } = overrides ?? {}

  const doFetchMock = vi.fn(async (_request: Request | string) => {
    return new Response(null, { status: 204 })
  })

  const sessionNamespace = {
    idFromName: vi.fn((name: string) => ({ toString: () => name } as DurableObjectId)),
    get: vi.fn((_id: DurableObjectId) => ({
      fetch: doFetchMock,
    } as unknown as DurableObjectStub)),
  } as unknown as DurableObjectNamespace

  return {
    SESSION: sessionNamespace,
    SESSION_TTL_SECONDS: '300',
    TURN_TTL_SECONDS: '3600',
    RATE_LIMIT: createMemoryKv(kvSeed),
    ...envOverrides,
  }
}

describe('worker security hardening & routes', () => {
  describe('GET /session/new', () => {
    it('returns { code } only (NO turnCredentials field in response)', async () => {
      const env = createMockEnv({
        TURN_KEY_ID: 'fake-id',
        TURN_KEY_SECRET: 'fake-secret',
      })
      const req = new Request('https://worker.internal/session/new')
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(200)
      const data = (await res.json()) as Record<string, unknown>
      expect(data['code']).toBeDefined()
      expect(typeof data['code']).toBe('string')
      expect(data['turnCredentials']).toBeUndefined()
    })

    it('is rate-limited (cap 10 per 60s window) and records the issued marker', async () => {
      const { kv, store } = createKvStore()
      const env = createMockEnv({ RATE_LIMIT: kv })
      const makeReq = () =>
        new Request('https://worker.internal/session/new', {
          headers: { 'CF-Connecting-IP': '198.51.100.1' },
        })

      const codes: string[] = []
      for (let i = 1; i <= 10; i++) {
        const res = await worker.fetch(makeReq(), env)
        expect(res.status).toBe(200)
        const data = (await res.json()) as { code: string }
        codes.push(data.code)
      }

      // 11th request hits 429
      const res11 = await worker.fetch(makeReq(), env)
      expect(res11.status).toBe(429)
      const err = (await res11.json()) as { error: string }
      expect(err.error).toBe('Rate limit exceeded')

      // D10: every minted code carries an issued marker, because that marker is what
      // lets /session/:code/turn tell a real session from a well-formed guess. Each
      // code must get its own key — one shared key would make the gate meaningless.
      const issuedKeys = [...store.keys()].filter((key) => key.startsWith('issued:'))
      expect(issuedKeys).toHaveLength(10)
      for (const code of codes) {
        expect(store.get(`issued:${code}`)).toBe('1')
      }
      // The rejected 11th attempt leaves the counter at 10, not 11: the limiter returns
      // early once the cap is passed without writing, so a hammering client cannot push
      // its own window forward and extend the lockout.
      expect(store.get('new:198.51.100.1')).toBe('10')
    })

    it('checks Sec-Fetch-Mode: navigate -> 403', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/session/new', {
        headers: {
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
        },
      })
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(403)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Forbidden')
    })

    it('checks Sec-Fetch-Mode: no-cors -> 403', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/session/new', {
        headers: {
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'cross-site',
        },
      })
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(403)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Forbidden')
    })

    it('checks Sec-Fetch-Mode: cors -> proceeds normally (200)', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/session/new', {
        headers: {
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
        },
      })
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(200)
      const data = (await res.json()) as { code: string }
      expect(data.code).toBeDefined()
    })
  })

  describe('GET /session/:code/turn', () => {
    const validCode = VALID_CODE

    it('validates session code format (400 on invalid code)', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/session/invalid!code/turn')
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(400)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Invalid session code')
    })

    it('checks Sec-Fetch-Mode: navigate -> 403', async () => {
      const env = createMockEnv()
      const req = new Request(`https://worker.internal/session/${validCode}/turn`, {
        headers: {
          'Sec-Fetch-Mode': 'navigate',
        },
      })
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(403)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Forbidden')
    })

    it('rejects a burned code with 410 before fetching credentials', async () => {
      const env = createMockEnv({
        RATE_LIMIT: {
          get: vi.fn(async (key: string) => {
            if (key === `burned:${validCode}`) return '1'
            return null
          }),
          put: vi.fn().mockResolvedValue(undefined),
        } as unknown as KVNamespace,
      })
      const req = new Request(`https://worker.internal/session/${validCode}/turn`)
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(410)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Session already paired or expired')
    })

    it('mints nothing for a code that was never issued (404), and never calls Cloudflare', async () => {
      // D10/P1: a well-formed code is not the same as a code this worker handed out.
      // Without the issued-marker gate, any 8-character string from the alphabet — and
      // especially one whose session expired without pairing, which is never marked
      // burned — would buy live relay credentials on the operator's bill.
      const originalFetch = globalThis.fetch
      const mockFetch = vi.fn(async () => new Response('{}', { status: 201 }))
      globalThis.fetch = mockFetch as unknown as typeof fetch

      try {
        const env = createMockEnv({
          RATE_LIMIT: createMemoryKv(),
          TURN_KEY_ID: 'my-turn-key',
          TURN_KEY_SECRET: 'my-secret',
        })
        const req = new Request(`https://worker.internal/session/${validCode}/turn`)
        const res = await worker.fetch(req, env)

        expect(res.status).toBe(404)
        const data = (await res.json()) as { error: string }
        expect(data.error).toBe('Session not found')
        expect(mockFetch).not.toHaveBeenCalled()
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('returns 503 when TURN credentials are unavailable (no keys configured)', async () => {
      const env = createMockEnv({
        RATE_LIMIT: issuedKv(),
        TURN_KEY_ID: undefined,
        TURN_KEY_SECRET: undefined,
      })
      const req = new Request(`https://worker.internal/session/${validCode}/turn`)
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(503)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('TURN unavailable')
    })

    it('returns credentials bundle and urls on success', async () => {
      const originalFetch = globalThis.fetch
      const mockFetch = vi.fn(async () => {
        const body = {
          iceServers: {
            urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'],
            username: 'opaque-user-hex',
            credential: 'opaque-cred-hex',
          },
        }
        return new Response(JSON.stringify(body), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      })
      globalThis.fetch = mockFetch as unknown as typeof fetch

      try {
        const env = createMockEnv({
          RATE_LIMIT: issuedKv(),
          TURN_KEY_ID: 'my-turn-key',
          TURN_KEY_SECRET: 'my-secret',
        })
        const req = new Request(`https://worker.internal/session/${validCode}/turn`)
        const res = await worker.fetch(req, env)

        expect(res.status).toBe(200)
        const data = (await res.json()) as {
          iceServers: string[]
          urls: string[]
          username: string
          credential: string
        }
        expect(data.username).toBe('opaque-user-hex')
        expect(data.credential).toBe('opaque-cred-hex')
        expect(data.urls).toEqual(['turn:turn.cloudflare.com:3478?transport=udp'])
        expect(data.iceServers).toEqual(data.urls)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('is rate-limited (cap 8 per 60s window per IP)', async () => {
      const initialSeeds: Record<string, string> = {}
      const alphabet = '23456789ABC'
      for (let i = 0; i < 9; i++) {
        initialSeeds[`issued:2345678${alphabet[i]}`] = '1'
      }
      const env = createMockEnv({ RATE_LIMIT: createMemoryKv(initialSeeds) })
      const makeReq = (code: string) =>
        new Request(`https://worker.internal/session/${code}/turn`, {
          headers: { 'CF-Connecting-IP': '198.51.100.2' },
        })

      for (let i = 0; i < 8; i++) {
        const res = await worker.fetch(makeReq(`2345678${alphabet[i]}`), env)
        expect(res.status).toBe(503) // keys not set -> 503, but not rate limited yet
      }

      // 9th request from same IP hits 429
      const res9 = await worker.fetch(makeReq(`2345678${alphabet[8]}`), env)
      expect(res9.status).toBe(429)
      const err = (await res9.json()) as { error: string }
      expect(err.error).toBe('Rate limit exceeded')
    })

    it('enforces per-session quota (max 4 TURN credential requests per session code)', async () => {
      const env = createMockEnv({ RATE_LIMIT: issuedKv() })
      const makeReq = (ip: string) =>
        new Request(`https://worker.internal/session/${validCode}/turn`, {
          headers: { 'CF-Connecting-IP': ip },
        })

      // 4 different IPs query the same session code
      for (let i = 1; i <= 4; i++) {
        const res = await worker.fetch(makeReq(`198.51.100.${i + 10}`), env)
        expect(res.status).toBe(503) // passed quota and rate limits (keys not set -> 503)
      }

      // 5th request for this session code fails with session quota exceeded
      const res5 = await worker.fetch(makeReq('198.51.100.99'), env)
      expect(res5.status).toBe(429)
      const err = (await res5.json()) as { error: string }
      expect(err.error).toBe('Session TURN quota exceeded')
    })

    it('caches TURN credentials in KV and serves cached credentials without calling Cloudflare API again', async () => {
      const originalFetch = globalThis.fetch
      const cfFetchMock = vi.fn(async () => {
        const body = {
          iceServers: {
            urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
            username: 'cached-user',
            credential: 'cached-cred',
          },
        }
        return new Response(JSON.stringify(body), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      })

      const { kv, store } = createKvStore({ [`issued:${validCode}`]: '1' })
      const env = createMockEnv({
        TURN_KEY_ID: 'test-key-id',
        TURN_KEY_SECRET: 'test-key-secret',
        RATE_LIMIT: kv,
      })

      globalThis.fetch = cfFetchMock as unknown as typeof fetch

      try {
        // Request 1: hits Cloudflare API and caches in KV
        const res1 = await worker.fetch(
          new Request(`https://worker.internal/session/${validCode}/turn`, {
            headers: { 'CF-Connecting-IP': '10.0.0.1' },
          }),
          env,
        )
        expect(res1.status).toBe(200)
        expect(cfFetchMock).toHaveBeenCalledTimes(1)
        expect(store.has(`turn_cred:${validCode}`)).toBe(true)

        // Request 2 (e.g. from peer guest device with different IP): served from KV cache
        const res2 = await worker.fetch(
          new Request(`https://worker.internal/session/${validCode}/turn`, {
            headers: { 'CF-Connecting-IP': '10.0.0.2' },
          }),
          env,
        )
        expect(res2.status).toBe(200)
        const data2 = (await res2.json()) as { username: string; credential: string }
        expect(data2.username).toBe('cached-user')
        expect(data2.credential).toBe('cached-cred')
        // Cloudflare API was NOT called again
        expect(cfFetchMock).toHaveBeenCalledTimes(1)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('GET /session/:code/ws', () => {
    const validCode = '23456789'

    it('rejects a burned code with 410 before DO lookup', async () => {
      const doFetch = vi.fn()
      const env = createMockEnv({
        SESSION: {
          idFromName: vi.fn(),
          get: vi.fn(() => ({ fetch: doFetch } as unknown as DurableObjectStub)),
        } as unknown as DurableObjectNamespace,
        RATE_LIMIT: {
          get: vi.fn(async (key: string) => {
            if (key === `burned:${validCode}`) return '1'
            return null
          }),
          put: vi.fn().mockResolvedValue(undefined),
        } as unknown as KVNamespace,
      })

      const req = new Request(`https://worker.internal/session/${validCode}/ws`, {
        headers: {
          Upgrade: 'websocket',
          'Sec-Fetch-Mode': 'websocket',
        },
      })
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(410)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Session already paired or expired')
      expect(doFetch).not.toHaveBeenCalled()
    })

    it('Sec-Fetch-Mode: cors (non-websocket) -> 403', async () => {
      const env = createMockEnv()
      const req = new Request(`https://worker.internal/session/${validCode}/ws`, {
        headers: {
          'Sec-Fetch-Mode': 'cors',
        },
      })
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(403)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Forbidden')
    })

    it('Sec-Fetch-Mode: websocket -> proceeds (returns 426 when no Upgrade header)', async () => {
      const env = createMockEnv()
      const req = new Request(`https://worker.internal/session/${validCode}/ws`, {
        headers: {
          'Sec-Fetch-Mode': 'websocket',
        },
      })
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(426)
    })

    it('rate limits join attempts (cap 10 per 60s)', async () => {
      let count = 0
      const kv = {
        get: vi.fn(async (key: string) => {
          if (key.startsWith('burned:')) return null
          return count > 0 ? String(count) : null
        }),
        put: vi.fn(async (_key: string, val: string) => {
          count = Number(val)
        }),
      } as unknown as KVNamespace

      const env = createMockEnv({ RATE_LIMIT: kv })
      const makeReq = () =>
        new Request(`https://worker.internal/session/${validCode}/ws`, {
          headers: {
            Upgrade: 'websocket',
            'CF-Connecting-IP': '198.51.100.3',
          },
        })

      for (let i = 1; i <= 10; i++) {
        const res = await worker.fetch(makeReq(), env)
        expect(res.status).toBe(204) // mock DO returns 204
      }

      // 11th request hits 429
      const res11 = await worker.fetch(makeReq(), env)
      expect(res11.status).toBe(429)
      const err = (await res11.json()) as { error: string }
      expect(err.error).toBe('Rate limit exceeded')
    })
  })

  describe('Security headers on responses', () => {
    it('JSON response includes X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy, and CSP', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/session/new')
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(200)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
      expect(res.headers.get('Content-Security-Policy')).toBe(DEFAULT_CSP)
    })

    it('GET /session/:code/turn includes security headers', async () => {
      const env = createMockEnv({ RATE_LIMIT: issuedKv() })
      const req = new Request('https://worker.internal/session/23456789/turn')
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(503)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
      expect(res.headers.get('Content-Security-Policy')).toBe(DEFAULT_CSP)
    })

    it('OPTIONS preflight response includes security headers including CSP', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/session/new', { method: 'OPTIONS' })
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(204)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
      expect(res.headers.get('Content-Security-Policy')).toBe(DEFAULT_CSP)
    })

    it('derives connect-src from ALLOWED_ORIGINS, including the wss: form', async () => {
      // The whole point of deriving it: a deployment that moves onto a custom domain
      // changes one variable and the policy follows. This is the regression guard
      // against someone reintroducing a hardcoded workers.dev literal.
      const env = createMockEnv({
        ALLOWED_ORIGINS: 'https://qrbit.example.com, https://qrbit.pages.dev',
      })
      const res = await worker.fetch(
        new Request('https://worker.internal/session/new', {
          headers: { Origin: 'https://qrbit.example.com' },
        }),
        env,
      )

      const csp = res.headers.get('Content-Security-Policy') ?? ''
      expect(csp).toContain("connect-src 'self'")
      expect(csp).toContain('https://qrbit.example.com')
      expect(csp).toContain('wss://qrbit.example.com')
      expect(csp).toContain('https://qrbit.pages.dev')
      expect(csp).toContain('wss://qrbit.pages.dev')
      expect(csp).toContain('https://turn.cloudflare.com')
      expect(csp).not.toContain('*.workers.dev')
      // CORS still reflects only the allowlisted origin that asked.
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://qrbit.example.com')
    })

    it('rejects requests with unauthorized Origin header with 403 Forbidden origin', async () => {
      const env = createMockEnv({
        ALLOWED_ORIGINS: 'https://qrbit.example.com',
      })
      const res = await worker.fetch(
        new Request('https://worker.internal/session/new', {
          headers: { Origin: 'https://malicious-attacker.com' },
        }),
        env,
      )
      expect(res.status).toBe(403)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Forbidden origin')
    })

    it('WebSocket upgrade challenge (426) does NOT include Content-Security-Policy', async () => {
      const env = createMockEnv()
      const validCode = '23456789'
      const req = new Request(`https://worker.internal/session/${validCode}/ws`)
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(426)
      expect(res.headers.get('Content-Security-Policy')).toBeNull()
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    })

    it('404 Not Found response includes security headers', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/unknown-path')
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(404)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Content-Security-Policy')).toBe(DEFAULT_CSP)
    })
  })

  describe('KV fail-open availability', () => {
    const validCode = '23456789'

    it('fails open when KV throws during rate limit or burn checks on /session/new', async () => {
      const throwingKv = {
        get: vi.fn(async () => {
          throw new Error('KV network fault')
        }),
        put: vi.fn(async () => {
          throw new Error('KV network fault')
        }),
      } as unknown as KVNamespace

      const env = createMockEnv({ RATE_LIMIT: throwingKv })
      const req = new Request('https://worker.internal/session/new')
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(200)
    })

    it('fails open when KV throws on /session/:code/turn', async () => {
      const throwingKv = {
        get: vi.fn(async () => {
          throw new Error('KV network fault')
        }),
        put: vi.fn(async () => {
          throw new Error('KV network fault')
        }),
      } as unknown as KVNamespace

      const env = createMockEnv({ RATE_LIMIT: throwingKv })
      const req = new Request(`https://worker.internal/session/${validCode}/turn`)
      const res = await worker.fetch(req, env)

      // Key not set so 503 from TURN mint, but KV failure didn't 500
      expect(res.status).toBe(503)
    })

    it('fails open when KV throws on /session/:code/ws', async () => {
      const throwingKv = {
        get: vi.fn(async () => {
          throw new Error('KV network fault')
        }),
        put: vi.fn(async () => {
          throw new Error('KV network fault')
        }),
      } as unknown as KVNamespace

      const env = createMockEnv({ RATE_LIMIT: throwingKv })
      const req = new Request(`https://worker.internal/session/${validCode}/ws`)
      const res = await worker.fetch(req, env)

      // Burn check passed, proceeds to Upgrade check which returns 426
      expect(res.status).toBe(426)
    })
  })
})

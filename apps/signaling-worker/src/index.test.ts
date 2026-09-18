import { describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => {
  class DurableObject {
    constructor(public ctx: unknown, public env: unknown) {}
  }
  return { DurableObject }
})

import worker from './index'

function createMockEnv(overrides?: Partial<Env>): Env {
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
    RATE_LIMIT: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    ...overrides,
  }
}

describe('worker security hardening', () => {
  describe('GET /session/new Sec-Fetch-* checks', () => {
    it('GET /session/new with Sec-Fetch-Mode: navigate -> 403', async () => {
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

    it('GET /session/new with Sec-Fetch-Mode: no-cors -> 403', async () => {
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

    it('GET /session/new with Sec-Fetch-Mode: cors -> proceeds normally (200)', async () => {
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

    it('GET /session/new without Sec-Fetch-Mode -> proceeds normally', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/session/new')
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(200)
      const data = (await res.json()) as { code: string }
      expect(data.code).toBeDefined()
    })
  })

  describe('GET /session/:code/ws Sec-Fetch-* checks', () => {
    const validCode = '23456789'

    it('GET /session/:code/ws with Sec-Fetch-Mode: cors (non-websocket) -> 403', async () => {
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

    it('GET /session/:code/ws with Sec-Fetch-Mode: websocket -> proceeds (returns 426 when no Upgrade header)', async () => {
      const env = createMockEnv()
      const req = new Request(`https://worker.internal/session/${validCode}/ws`, {
        headers: {
          'Sec-Fetch-Mode': 'websocket',
        },
      })
      const res = await worker.fetch(req, env)
      // Sec-Fetch check passed, proceeds to Upgrade check which fails with 426
      expect(res.status).toBe(426)
    })

    it('GET /session/:code/ws without Sec-Fetch-Mode -> proceeds', async () => {
      const env = createMockEnv()
      const req = new Request(`https://worker.internal/session/${validCode}/ws`)
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(426)
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
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; connect-src wss://*.workers.dev https://turn.cloudflare.com; worker-src 'self'",
      )
    })

    it('OPTIONS preflight response includes security headers including CSP', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/session/new', { method: 'OPTIONS' })
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(204)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; connect-src wss://*.workers.dev https://turn.cloudflare.com; worker-src 'self'",
      )
    })

    it('WebSocket upgrade response (426 / upgrade challenge) does NOT include Content-Security-Policy', async () => {
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

    it('WebSocket upgrade response (101 from DO) does NOT include Content-Security-Policy', async () => {
      const validCode = '23456789'
      const mockWsResponse = {
        status: 101,
        headers: new Headers(),
      } as unknown as Response

      const env = createMockEnv({
        SESSION: {
          idFromName: vi.fn((name: string) => ({ toString: () => name } as DurableObjectId)),
          get: vi.fn((_id: DurableObjectId) => ({
            fetch: vi.fn().mockResolvedValue(mockWsResponse),
          } as unknown as DurableObjectStub)),
        } as unknown as DurableObjectNamespace,
      })

      const req = new Request(`https://worker.internal/session/${validCode}/ws`, {
        headers: {
          Upgrade: 'websocket',
          'Sec-Fetch-Mode': 'websocket',
        },
      })
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(101)
      expect(res.headers.get('Content-Security-Policy')).toBeNull()
    })

    it('404 Not Found response includes security headers', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/unknown-path')
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(404)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; connect-src wss://*.workers.dev https://turn.cloudflare.com; worker-src 'self'",
      )
    })

    it('400 Invalid session code response includes security headers', async () => {
      const env = createMockEnv()
      const req = new Request('https://worker.internal/session/invalid!code/ws')
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(400)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; connect-src wss://*.workers.dev https://turn.cloudflare.com; worker-src 'self'",
      )
    })

    it('503 Session unavailable response includes security headers', async () => {
      const env = createMockEnv({
        SESSION: {
          idFromName: vi.fn((name: string) => ({ toString: () => name } as DurableObjectId)),
          get: vi.fn((_id: DurableObjectId) => ({
            fetch: vi.fn().mockRejectedValue(new Error('DO offline')),
          } as unknown as DurableObjectStub)),
        } as unknown as DurableObjectNamespace,
      })
      const req = new Request('https://worker.internal/session/new')
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(503)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; connect-src wss://*.workers.dev https://turn.cloudflare.com; worker-src 'self'",
      )
    })

    it('preserves CORS allowlist headers alongside security headers', async () => {
      const env = createMockEnv({ ALLOWED_ORIGINS: 'http://localhost:5173' })
      const req = new Request('https://worker.internal/session/new', {
        headers: {
          Origin: 'http://localhost:5173',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
      })
      const res = await worker.fetch(req, env)

      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
      expect(res.headers.get('Vary')).toBe('Origin')
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; connect-src wss://*.workers.dev https://turn.cloudflare.com; worker-src 'self'",
      )
    })
  })
})

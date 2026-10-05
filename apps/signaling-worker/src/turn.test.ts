import { describe, expect, it, vi } from 'vitest'

import {
  clampTurnTtl,
  DEFAULT_TURN_TTL_SECONDS,
  generateTurnCredentials,
  MAX_TURN_TTL_SECONDS,
  MIN_TURN_TTL_SECONDS,
} from './turn'

const KEY_ID = 'test-cf-turn-key-id'
const SECRET = 'test-cf-turn-secret'
const SESSION_CODE = '23456789'

function createSuccessMockFetch(urls: string[] = [
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turns:turn.cloudflare.com:443?transport=tcp',
  'turn:turn.cloudflare.com:53?transport=udp',
]): typeof fetch {
  return vi.fn<typeof fetch>(async () => {
    const body = {
      iceServers: {
        urls,
        username: 'opaque-cf-username-hex-123',
        credential: 'opaque-cf-credential-hex-456',
      },
    }
    return new Response(JSON.stringify(body), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

describe('clampTurnTtl', () => {
  it('returns DEFAULT_TURN_TTL_SECONDS (600) when undefined or not finite', () => {
    expect(clampTurnTtl(undefined)).toBe(DEFAULT_TURN_TTL_SECONDS)
    expect(clampTurnTtl(Number.NaN)).toBe(DEFAULT_TURN_TTL_SECONDS)
    expect(clampTurnTtl(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TURN_TTL_SECONDS)
    expect(clampTurnTtl(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_TURN_TTL_SECONDS)
  })

  it('clamps values below MIN_TURN_TTL_SECONDS (1) to 1', () => {
    expect(clampTurnTtl(0)).toBe(MIN_TURN_TTL_SECONDS)
    expect(clampTurnTtl(-100)).toBe(MIN_TURN_TTL_SECONDS)
  })

  it('clamps values above MAX_TURN_TTL_SECONDS (172800) to 172800', () => {
    expect(clampTurnTtl(200_000)).toBe(MAX_TURN_TTL_SECONDS)
    expect(clampTurnTtl(999_999)).toBe(MAX_TURN_TTL_SECONDS)
  })

  it('floors fractional numbers', () => {
    expect(clampTurnTtl(120.7)).toBe(120)
  })

  it('preserves valid in-range integer TTLs', () => {
    expect(clampTurnTtl(600)).toBe(600)
    expect(clampTurnTtl(3600)).toBe(3600)
    expect(clampTurnTtl(1)).toBe(1)
    expect(clampTurnTtl(172800)).toBe(172800)
  })
})

describe('generateTurnCredentials', () => {
  it('success path returns urls/username/credential and filters port-53 URLs', async () => {
    const mockFetch = createSuccessMockFetch()
    const result = await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, mockFetch)

    expect(result).not.toBeNull()
    expect(result?.username).toBe('opaque-cf-username-hex-123')
    expect(result?.credential).toBe('opaque-cf-credential-hex-456')
    expect(result?.urls).toEqual([
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ])
    expect(result?.iceServers).toEqual(result?.urls)
  })

  it('filters a bare port-53 URL but keeps 5349, which shares the ":53" prefix', async () => {
    // The original substring test looked for ':53?', so `turn:host:53` (no query
    // string) slipped through. Broadening the match risks the opposite error —
    // 5349 is the standards-compliant TURNS port and must survive — so this pins both.
    const mockFetch = createSuccessMockFetch([
      'turn:turn.cloudflare.com:53',
      'turn:turn.cloudflare.com:53/',
      'turn:turn.cloudflare.com:53?transport=udp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'turn:turn.cloudflare.com:3478?transport=udp',
    ])
    const result = await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, mockFetch)

    expect(result?.urls).toEqual([
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'turn:turn.cloudflare.com:3478?transport=udp',
    ])
  })

  it('sends the correct URL with the key ID', async () => {
    const mockFetch = createSuccessMockFetch()
    await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, mockFetch)

    expect(mockFetch).toHaveBeenCalledOnce()
    const calledUrl = vi.mocked(mockFetch).mock.calls[0]?.[0]
    expect(calledUrl).toBe(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate`,
    )
  })

  it('sends the Authorization Bearer header with the secret and Content-Type', async () => {
    const mockFetch = createSuccessMockFetch()
    await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, mockFetch)

    const init = vi.mocked(mockFetch).mock.calls[0]?.[1]
    const headers = init?.headers as Record<string, string>
    expect(headers?.['Authorization']).toBe(`Bearer ${SECRET}`)
    expect(headers?.['Content-Type']).toBe('application/json')
  })

  it('sends clamped ttl and customIdentifier containing the session code in the body', async () => {
    const mockFetch = createSuccessMockFetch()
    await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 300, mockFetch)

    const init = vi.mocked(mockFetch).mock.calls[0]?.[1]
    const rawBody = init?.body
    expect(typeof rawBody).toBe('string')
    const body = JSON.parse(rawBody as string) as { ttl: number; customIdentifier: string }

    expect(body.ttl).toBe(300)
    expect(body.customIdentifier).toContain(SESSION_CODE)
    expect(body.customIdentifier).toBe(`qrbit:${SESSION_CODE}`)
    expect(body.customIdentifier.length).toBeLessThanOrEqual(128)
  })

  it('clamps TTL to 1..172800 in the request body', async () => {
    const mockFetch = createSuccessMockFetch()
    await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 999_999, mockFetch)

    const init = vi.mocked(mockFetch).mock.calls[0]?.[1]
    const body = JSON.parse(init?.body as string) as { ttl: number }
    expect(body.ttl).toBe(172800)
  })

  it('supports response where iceServers is an array of objects', async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      const body = {
        iceServers: [
          {
            urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
            username: 'array-user',
            credential: 'array-cred',
          },
        ],
      }
      return new Response(JSON.stringify(body), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const result = await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, mockFetch)
    expect(result).not.toBeNull()
    expect(result?.username).toBe('array-user')
    expect(result?.credential).toBe('array-cred')
    expect(result?.urls).toEqual(['turns:turn.cloudflare.com:443?transport=tcp'])
  })

  it('supports response where iceServers array has STUN first then TURN with credentials', async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      const body = {
        iceServers: [
          {
            urls: ['stun:stun.cloudflare.com:3478'],
          },
          {
            urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
            username: 'turn-user-from-array',
            credential: 'turn-cred-from-array',
          },
        ],
      }
      return new Response(JSON.stringify(body), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const result = await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, mockFetch)
    expect(result).not.toBeNull()
    expect(result?.username).toBe('turn-user-from-array')
    expect(result?.credential).toBe('turn-cred-from-array')
    expect(result?.urls).toEqual(['turns:turn.cloudflare.com:443?transport=tcp'])
  })

  it('returns null when key ID is missing or blank', async () => {
    const mockFetch = createSuccessMockFetch()
    expect(await generateTurnCredentials(undefined, SECRET, SESSION_CODE, 600, mockFetch)).toBeNull()
    expect(await generateTurnCredentials('', SECRET, SESSION_CODE, 600, mockFetch)).toBeNull()
    expect(await generateTurnCredentials('   ', SECRET, SESSION_CODE, 600, mockFetch)).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns null when secret is missing or blank', async () => {
    const mockFetch = createSuccessMockFetch()
    expect(await generateTurnCredentials(KEY_ID, undefined, SESSION_CODE, 600, mockFetch)).toBeNull()
    expect(await generateTurnCredentials(KEY_ID, '', SESSION_CODE, 600, mockFetch)).toBeNull()
    expect(await generateTurnCredentials(KEY_ID, '   ', SESSION_CODE, 600, mockFetch)).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns null on non-2xx HTTP responses', async () => {
    const mockFetch401 = vi.fn<typeof fetch>(async () => {
      return new Response('Unauthorized', { status: 401 })
    })
    expect(await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, mockFetch401)).toBeNull()

    const mockFetch500 = vi.fn<typeof fetch>(async () => {
      return new Response('Internal Server Error', { status: 500 })
    })
    expect(await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, mockFetch500)).toBeNull()
  })

  it('returns null on malformed body responses', async () => {
    const nonJsonFetch = vi.fn<typeof fetch>(async () => {
      return new Response('not a json', { status: 201 })
    })
    expect(await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, nonJsonFetch)).toBeNull()

    const missingIceServersFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({}), { status: 201 })
    })
    expect(
      await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, missingIceServersFetch),
    ).toBeNull()

    const missingUrlsFetch = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({ iceServers: { username: 'u', credential: 'c' } }),
        { status: 201 },
      )
    })
    expect(
      await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, missingUrlsFetch),
    ).toBeNull()

    const emptyUsernameFetch = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({ iceServers: { urls: ['turn:x'], username: '', credential: 'c' } }),
        { status: 201 },
      )
    })
    expect(
      await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, emptyUsernameFetch),
    ).toBeNull()
  })

  it('returns null and never rejects when fetch throws', async () => {
    const throwingFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('Network failure')
    })
    const result = await generateTurnCredentials(KEY_ID, SECRET, SESSION_CODE, 600, throwingFetch)
    expect(result).toBeNull()
  })
})

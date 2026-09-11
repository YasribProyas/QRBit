/**
 * Unit tests for the runtime configuration helpers (PLAN.md §18).
 *
 * Expectations are written against the exported constants rather than hard-coded
 * localhost values, so a VITE_ environment override at test time cannot make them
 * assert the wrong thing.
 */

import {
  APP_URL,
  SIGNALING_HTTP_URL,
  SIGNALING_WS_URL,
  buildNewSessionUrl,
  buildSessionUrl,
  toHttpBase,
} from './config'

describe('toHttpBase', () => {
  it('maps ws to http and wss to https, preserving host and port', () => {
    expect(toHttpBase('ws://localhost:8787')).toBe('http://localhost:8787')
    expect(toHttpBase('wss://signaling.example.workers.dev')).toBe(
      'https://signaling.example.workers.dev',
    )
  })

  it('only rewrites the leading scheme', () => {
    expect(toHttpBase('wss://example.com/ws?next=ws://y')).toBe('https://example.com/ws?next=ws://y')
    expect(toHttpBase('https://example.com')).toBe('https://example.com')
  })
})

describe('signaling endpoint construction', () => {
  it('derives the HTTP base from the WebSocket base so the two cannot disagree', () => {
    expect(SIGNALING_HTTP_URL).toBe(toHttpBase(SIGNALING_WS_URL))
  })

  it('strips trailing slashes from the configured WebSocket base', () => {
    expect(SIGNALING_WS_URL.endsWith('/')).toBe(false)
  })

  it('builds the session-creation URL against the derived HTTP base', () => {
    expect(buildNewSessionUrl()).toBe(`${SIGNALING_HTTP_URL}/session/new`)
  })
})

describe('buildSessionUrl', () => {
  it('encodes the session code into the full URL a QR reader opens', () => {
    expect(buildSessionUrl('A7X3K9P2')).toBe(`${APP_URL}/session?code=A7X3K9P2`)
  })

  it('percent-encodes the code so it cannot break the URL', () => {
    expect(buildSessionUrl('a b/c')).toBe(`${APP_URL}/session?code=${encodeURIComponent('a b/c')}`)
  })

  it('strips trailing slashes from the app origin', () => {
    expect(APP_URL.endsWith('/')).toBe(false)
  })
})

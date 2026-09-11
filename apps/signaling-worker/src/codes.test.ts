import { describe, expect, it } from 'vitest'

import {
  SESSION_CODE_ALPHABET,
  SESSION_CODE_LENGTH,
  generateSessionCode,
  isValidSessionCode,
} from './codes'

describe('SESSION_CODE_ALPHABET', () => {
  it('holds 30 symbols: 36 alphanumerics minus the 6 ambiguous ones', () => {
    expect(SESSION_CODE_ALPHABET.length).toBe(30)
    expect(new Set(SESSION_CODE_ALPHABET).size).toBe(30)
  })

  it('omits every character that is ambiguous when read aloud or typed by hand', () => {
    // PLAN.md §8 keeps manual code entry as the fallback when a scan is impossible.
    for (const ambiguous of ['0', '1', 'I', 'L', 'O', 'U']) {
      expect(SESSION_CODE_ALPHABET).not.toContain(ambiguous)
    }
  })

  it('does not divide 256, which is why generation must reject a biased tail', () => {
    // Guards the invariant that UNBIASED_BYTE_CEILING exists for. If the alphabet
    // ever became a power of two, the rejection step would be dead code.
    expect(256 % SESSION_CODE_ALPHABET.length).not.toBe(0)
  })
})

describe('generateSessionCode', () => {
  it('produces an exact-length code', () => {
    expect(generateSessionCode()).toHaveLength(SESSION_CODE_LENGTH)
  })

  it('only ever emits alphabet characters', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateSessionCode()
      for (const character of code) {
        expect(SESSION_CODE_ALPHABET).toContain(character)
      }
    }
  })

  it('can reach every symbol in the alphabet', () => {
    // Guards against an off-by-one or ceiling mistake that would silently make part
    // of the alphabet unreachable and cut the effective entropy.
    const seen = new Set<string>()
    for (let i = 0; i < 400; i += 1) {
      for (const character of generateSessionCode()) {
        seen.add(character)
      }
    }
    expect(seen.size).toBe(SESSION_CODE_ALPHABET.length)
  })

  it('does not repeat across many draws', () => {
    const codes = new Set<string>()
    const draws = 2000
    for (let i = 0; i < draws; i += 1) {
      codes.add(generateSessionCode())
    }
    // 8 chars over a 32-symbol alphabet is 40 bits of entropy, so a collision in
    // 2000 draws is vanishingly unlikely; a repeat means the CSPRNG is not being
    // drawn from per call.
    expect(codes.size).toBe(draws)
  })

  it('is accepted by its own validator', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isValidSessionCode(generateSessionCode())).toBe(true)
    }
  })
})

describe('isValidSessionCode', () => {
  it('rejects codes of the wrong length', () => {
    const valid = generateSessionCode()
    expect(isValidSessionCode(valid.slice(0, 7))).toBe(false)
    expect(isValidSessionCode(`${valid}${valid}`)).toBe(false)
    expect(isValidSessionCode('')).toBe(false)
  })

  it('rejects lowercase, which strict server-side validation must not normalise', () => {
    expect(isValidSessionCode('abcdefgh')).toBe(false)
    expect(isValidSessionCode(generateSessionCode().toLowerCase())).toBe(false)
  })

  it('rejects the ambiguous characters kept out of the alphabet', () => {
    for (const ambiguous of ['0', '1', 'I', 'L', 'O', 'U']) {
      expect(isValidSessionCode(`2345678${ambiguous}`)).toBe(false)
    }
  })

  it('rejects surrounding whitespace rather than trimming it', () => {
    const valid = generateSessionCode()
    expect(isValidSessionCode(` ${valid} `)).toBe(false)
    expect(isValidSessionCode(`${valid}\n`)).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isValidSessionCode(null)).toBe(false)
    expect(isValidSessionCode(undefined)).toBe(false)
    expect(isValidSessionCode(12345678)).toBe(false)
    expect(isValidSessionCode({})).toBe(false)
    expect(isValidSessionCode([])).toBe(false)
    expect(isValidSessionCode(['23456789'])).toBe(false)
  })
})

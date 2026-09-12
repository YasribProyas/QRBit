/**
 * Tests for the safety phrase mapping (PLAN.md §11.6, §8 Phase 2 mock).
 *
 * The phrase is what stops an active MITM during pairing, so the mapping must be
 * deterministic, cover the whole byte range, and be pure — nothing here may
 * depend on time, locale or randomness.
 */

import { describe, expect, it } from 'vitest'

import { bytesToPhrase, PHRASE_WORD_COUNT } from './safetyPhrase'
import { WORDLIST, WORDLIST_LENGTH } from './wordlist'

describe('bytesToPhrase', () => {
  it('returns three uppercase words', () => {
    const phrase = bytesToPhrase(new Uint8Array([0, 128, 255]))
    expect(phrase).toHaveLength(PHRASE_WORD_COUNT)
    for (const word of phrase) {
      expect(word).toMatch(/^[A-Z]{3,8}$/)
    }
  })

  it('maps each byte to WORDLIST[byte] and uppercases it', () => {
    expect(bytesToPhrase(new Uint8Array([0, 1, 2]))).toEqual([
      (WORDLIST[0] ?? '').toUpperCase(),
      (WORDLIST[1] ?? '').toUpperCase(),
      (WORDLIST[2] ?? '').toUpperCase(),
    ])
    expect(bytesToPhrase(new Uint8Array([0, 0, 0]))).toEqual([
      (WORDLIST[0] ?? '').toUpperCase(),
      (WORDLIST[0] ?? '').toUpperCase(),
      (WORDLIST[0] ?? '').toUpperCase(),
    ])
  })

  it('handles the byte-range boundaries', () => {
    const lowest = bytesToPhrase(new Uint8Array([0, 0, 0]))
    const highest = bytesToPhrase(new Uint8Array([255, 255, 255]))
    for (const word of [...lowest, ...highest]) {
      expect(WORDLIST.map((entry) => entry.toUpperCase())).toContain(word)
    }
    expect(highest[0]).toBe((WORDLIST[WORDLIST_LENGTH - 1] ?? '').toUpperCase())
    expect(lowest[0]).toBe((WORDLIST[0] ?? '').toUpperCase())
  })

  it('is deterministic and order-sensitive', () => {
    const bytes = new Uint8Array([17, 200, 3])
    expect(bytesToPhrase(bytes)).toEqual(bytesToPhrase(new Uint8Array([17, 200, 3])))
    expect(bytesToPhrase(bytes)).not.toEqual(bytesToPhrase(new Uint8Array([200, 17, 3])))
  })

  it('ignores bytes past the third', () => {
    const short = bytesToPhrase(new Uint8Array([9, 9, 9]))
    const long = bytesToPhrase(new Uint8Array([9, 9, 9, 44, 55, 66]))
    expect(long).toEqual(short)
  })

  it('uses only the first 3 bytes when given full HKDF phrase output', () => {
    // deriveSafetyPhraseBytes() currently returns exactly 3 bytes; this pins the
    // contract that extra bytes are not consumed.
    expect(bytesToPhrase(new Uint8Array([WORDLIST_LENGTH - 1, 0, 1, 2]))).toEqual(
      bytesToPhrase(new Uint8Array([WORDLIST_LENGTH - 1, 0, 1])),
    )
  })

  it('throws when given fewer than three bytes', () => {
    expect(() => bytesToPhrase(new Uint8Array([]))).toThrow(/at least 3 bytes/)
    expect(() => bytesToPhrase(new Uint8Array([7]))).toThrow(/at least 3 bytes/)
    expect(() => bytesToPhrase(new Uint8Array([7, 8]))).toThrow(/at least 3 bytes/)
  })
})

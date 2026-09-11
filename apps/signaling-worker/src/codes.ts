/**
 * Session code generation and validation (PLAN.md §13, §17).
 *
 * The code is the only secret standing between a stranger and a pairing attempt,
 * so it is generated from a CSPRNG and validated strictly on the server before it
 * is ever used to address a Durable Object.
 */

/**
 * Code alphabet: the 36 alphanumeric characters minus the six that are trivially
 * confused with each other (0, 1, I, L, O, U), so a code read aloud or typed by hand
 * cannot be mistaken for a lookalike — the manual-entry fallback in PLAN.md §8
 * depends on that.
 *
 * Note this is 30 symbols, not 32: excluding those six from 36 cannot yield a power
 * of two. 30 does not divide 256, so reducing a random byte modulo 30 would make the
 * first 16 symbols measurably more likely than the rest. generateSessionCode rejects
 * the biased tail of the byte range rather than accepting that skew.
 */
export const SESSION_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

export const SESSION_CODE_LENGTH = 8

/**
 * Bytes at or above this value are discarded. 240 is the largest multiple of 30 that
 * fits in a byte, so each symbol maps to exactly 8 of the 240 accepted values.
 */
const UNBIASED_BYTE_CEILING = 256 - (256 % SESSION_CODE_ALPHABET.length)

/** Generates a fresh 8-character session code using the platform CSPRNG. */
export function generateSessionCode(): string {
  let code = ''

  // The rejection rate is 16/256 (6.25%), so this almost always completes in one pass.
  while (code.length < SESSION_CODE_LENGTH) {
    const bytes = new Uint8Array(SESSION_CODE_LENGTH)
    crypto.getRandomValues(bytes)

    for (const byte of bytes) {
      if (byte >= UNBIASED_BYTE_CEILING) continue

      // charAt never returns undefined, which keeps this safe under
      // noUncheckedIndexedAccess without a non-null assertion.
      code += SESSION_CODE_ALPHABET.charAt(byte % SESSION_CODE_ALPHABET.length)

      if (code.length === SESSION_CODE_LENGTH) break
    }
  }

  return code
}

/**
 * Strict server-side validation (PLAN.md §17). Accepts only an exact-length string
 * composed solely of alphabet characters: no lower-casing, no trimming, no
 * normalisation. Anything else is rejected before a Durable Object lookup happens.
 */
export function isValidSessionCode(code: unknown): code is string {
  if (typeof code !== 'string') return false
  if (code.length !== SESSION_CODE_LENGTH) return false

  for (const character of code) {
    if (!SESSION_CODE_ALPHABET.includes(character)) return false
  }
  return true
}

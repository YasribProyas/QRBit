/**
 * Safety phrase (PLAN.md §11.6 and §2 "active MITM during pairing").
 *
 * The phrase is a human-verifiable digest of the ECDH shared secret: after
 * `deriveSafetyPhraseBytes()` produces HKDF output for info `qrdrop-phrase-v1`,
 * this module maps one byte per word onto the 256-word list. Both devices derive
 * the same bytes from the same shared secret and session id, so the same three
 * words appear on both screens. A MITM who terminated ECDH on each side would
 * produce two different secrets, hence two different phrases, and the users
 * would abort before sending anything.
 *
 * The phrase is only ~24 bits of the secret and is *not* a key: it is a display
 * value that exists to be compared by two humans. Never use these words as key
 * material and never derive keys from them.
 */

import { WORDLIST } from './wordlist'

/** Words shown per phrase; one byte of HKDF output each. */
export const PHRASE_WORD_COUNT = 3

function phraseWord(bytes: Uint8Array, offset: number): string {
  const index = bytes[offset]
  if (index === undefined) {
    throw new Error(`bytesToPhrase: missing byte at offset ${offset}`)
  }
  const word = WORDLIST[index]
  if (word === undefined) {
    throw new Error(`bytesToPhrase: byte ${index} is outside the ${WORDLIST.length}-word list`)
  }
  return word.toUpperCase()
}

/**
 * Maps the first 3 bytes of `bytes` to three uppercase words (PLAN.md §8 mock
 * shows `RIVER COPPER EIGHT`). Deterministic: the same bytes always yield the
 * same phrase.
 *
 * @throws if fewer than 3 bytes are supplied — a short input would silently
 * repeat or truncate words and weaken the comparison.
 */
export function bytesToPhrase(bytes: Uint8Array): [string, string, string] {
  if (bytes.length < PHRASE_WORD_COUNT) {
    throw new Error(
      `bytesToPhrase: need at least ${PHRASE_WORD_COUNT} bytes, got ${bytes.length}`,
    )
  }
  return [phraseWord(bytes, 0), phraseWord(bytes, 1), phraseWord(bytes, 2)]
}

/**
 * Tests for `lib/byteSize.ts` — the one place a byte count becomes display text.
 *
 * `fileSizeText`'s job is the negative case: saying there IS no size, because every caller that
 * instead fills the gap with a plausible string is how an attachment block ended up labelled
 * `2.4 MB` with no file behind it.
 */

import { describe, expect, it } from 'vitest'

import { formatByteSize, fileSizeText } from './byteSize'

describe('formatByteSize', () => {
  it('formats a measured byte count in binary units', () => {
    expect(formatByteSize(0)).toBe('0 B')
    expect(formatByteSize(5)).toBe('5 B')
    expect(formatByteSize(1023)).toBe('1023 B')
    expect(formatByteSize(1024)).toBe('1.0 KiB')
    expect(formatByteSize(20_000)).toBe('19.5 KiB')
    expect(formatByteSize(3 * 1024 * 1024)).toBe('3.0 MiB')
    expect(formatByteSize(64 * 1024 * 1024)).toBe('64.0 MiB')
    expect(formatByteSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GiB')
  })
})

describe('fileSizeText', () => {
  it('formats a number as the size it measures', () => {
    expect(fileSizeText(12)).toBe('12 B')
    // A zero-byte file is a real file, and it has a real size.
    expect(fileSizeText(0)).toBe('0 B')
  })

  it('shows a stored label as it was stored, rather than rewriting it into a number', () => {
    expect(fileSizeText('24.8 KB')).toBe('24.8 KB')
  })

  it('says there is no size when nothing measured one', () => {
    expect(fileSizeText(undefined)).toBe(null)
    expect(fileSizeText('')).toBe(null)
    expect(fileSizeText('   ')).toBe(null)
    expect(fileSizeText(-1)).toBe(null)
    expect(fileSizeText(Number.NaN)).toBe(null)
  })
})

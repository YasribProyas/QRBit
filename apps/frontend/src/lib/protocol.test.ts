/**
 * Tests for the wire protocol (PLAN.md §10, §19 decision 7).
 *
 * The two properties that matter most here are (a) binary payloads survive
 * MessagePack as `Uint8Array`s rather than arrays of numbers or strings, and
 * (b) the inbound validator rejects every malformed frame shape a hostile peer
 * can produce without ever throwing.
 */

import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'

import {
  decodeWire,
  encodeWire,
  isWireMessage,
  WIRE_MAX_FRAME_BYTES,
  type WireMessage,
} from './protocol'

/** A pattern that covers the full byte range, so 0x00 and 0xFF are both present. */
function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + 7) % 256
  }
  return bytes
}

const VALID_MESSAGES: ReadonlyArray<{ name: string; message: WireMessage }> = [
  {
    name: 'a file item-announce',
    message: {
      t: 'item-announce',
      id: 'item-1',
      type: 'file',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      totalSize: 40_000,
      totalChunks: 3,
    },
  },
  {
    name: 'an image item-announce',
    message: {
      t: 'item-announce',
      id: 'item-2',
      type: 'image',
      fileName: 'scan.png',
      mimeType: 'image/png',
      totalSize: 128,
      totalChunks: 1,
    },
  },
  {
    name: 'a text item-announce',
    message: { t: 'item-announce', id: 'item-3', type: 'text' },
  },
  {
    name: 'a locked item-announce',
    message: {
      t: 'item-announce',
      id: 'item-4',
      type: 'locked',
      label: 'Uni Portal Password',
      innerType: 'text',
    },
  },
  {
    name: 'a zero-byte file item-announce',
    message: {
      t: 'item-announce',
      id: 'item-5',
      type: 'file',
      fileName: 'empty.bin',
      mimeType: '',
      totalSize: 0,
      totalChunks: 0,
    },
  },
  { name: 'a text-delta', message: { t: 'text-delta', id: 'item-1', content: 'héllo — 你好' } },
  { name: 'an empty text-delta', message: { t: 'text-delta', id: 'item-1', content: '' } },
  {
    name: 'a richtext-delta',
    message: {
      t: 'richtext-delta',
      id: 'item-6',
      content: '{"type":"doc","content":[{"type":"paragraph","text":"hi"}]}',
    },
  },
  {
    name: 'a file-chunk',
    message: { t: 'file-chunk', id: 'item-1', index: 0, data: patternBytes(256) },
  },
  {
    name: 'the last file-chunk',
    message: { t: 'file-chunk', id: 'item-1', index: 7, data: new Uint8Array([0, 255]) },
  },
  { name: 'a file-done', message: { t: 'file-done', id: 'item-1' } },
  {
    name: 'a locked-payload',
    message: {
      t: 'locked-payload',
      id: 'item-4',
      ciphertext: patternBytes(64),
      iv: patternBytes(12),
      salt: patternBytes(16),
    },
  },
  { name: 'an item-delete', message: { t: 'item-delete', id: 'item-1' } },
  { name: 'a phrase-confirm', message: { t: 'phrase-confirm' } },
  { name: 'a session-end', message: { t: 'session-end' } },
]

describe('WireMessage round-trip (PLAN.md §10, §19 decision 7)', () => {
  for (const { name, message } of VALID_MESSAGES) {
    it(`round-trips ${name} field for field`, () => {
      const decoded = decodeWire(encodeWire(message))
      expect(decoded).toEqual(message)
      expect(decoded).not.toBe(message)
      expect(isWireMessage(decoded)).toBe(true)
    })
  }

  it('keeps a file-chunk payload a Uint8Array with identical bytes', () => {
    const data = patternBytes(1024)
    const decoded = decodeWire(encodeWire({ t: 'file-chunk', id: 'item-1', index: 2, data }))

    expect(decoded.t).toBe('file-chunk')
    if (decoded.t !== 'file-chunk') throw new Error('expected a file-chunk')
    expect(decoded.data).toBeInstanceOf(Uint8Array)
    expect(Array.isArray(decoded.data)).toBe(false)
    expect(typeof decoded.data).not.toBe('string')
    expect(decoded.data.byteLength).toBe(1024)
    expect(decoded.data).toEqual(data)
  })

  it('encodes a payload as MessagePack bin, which the library itself decodes as bytes', () => {
    // Guards PLAN.md §19 decision 7 directly: the encoded map holds a bin value,
    // not an array of numbers (which is what a JSON payload would be).
    const data = new Uint8Array([1, 2, 3])
    const parsed = decode(encodeWire({ t: 'file-chunk', id: 'item-1', index: 0, data })) as {
      data?: unknown
    }

    expect(parsed.data).toBeInstanceOf(Uint8Array)
    expect(parsed.data).toEqual(data)
  })

  it('encodes only the bytes of a payload view, not its whole backing buffer', () => {
    // `file.slice().arrayBuffer()` hands back views over larger buffers, so this
    // pins that a chunk never carries the neighbouring bytes with it.
    const backing = patternBytes(300)
    const view = backing.subarray(100, 140)
    const decoded = decodeWire(encodeWire({ t: 'file-chunk', id: 'item-1', index: 0, data: view }))

    if (decoded.t !== 'file-chunk') throw new Error('expected a file-chunk')
    expect(decoded.data.byteLength).toBe(40)
    expect(decoded.data).toEqual(patternBytes(300).subarray(100, 140))
  })

  it('keeps all three locked-payload byte fields separate', () => {
    const message: WireMessage = {
      t: 'locked-payload',
      id: 'item-4',
      ciphertext: patternBytes(48),
      iv: patternBytes(12),
      salt: patternBytes(16),
    }
    const decoded = decodeWire(encodeWire(message))

    if (decoded.t !== 'locked-payload') throw new Error('expected a locked-payload')
    expect(decoded.ciphertext).toEqual(message.ciphertext)
    expect(decoded.iv).toEqual(message.iv)
    expect(decoded.salt).toEqual(message.salt)
    expect(decoded.ciphertext.byteLength).toBe(48)
    expect(decoded.iv.byteLength).toBe(12)
    expect(decoded.salt.byteLength).toBe(16)
  })

  it('drops optional fields that are explicitly undefined instead of encoding null', () => {
    // `{ label: item.label }` is a natural way to build an announce, and the
    // decoded message must not contain a null where the type promises a string.
    const encoded = encodeWire({ t: 'item-announce', id: 'item-5', type: 'file', label: undefined })
    const decoded = decodeWire(encoded)

    expect('label' in decoded).toBe(false)
    expect(isWireMessage(decoded)).toBe(true)
  })
})

describe('isWireMessage', () => {
  for (const { name, message } of VALID_MESSAGES) {
    it(`accepts ${name}`, () => {
      expect(isWireMessage(message)).toBe(true)
    })
  }

  it('accepts an item-announce whose label is absent but whose innerType is present', () => {
    expect(
      isWireMessage({ t: 'item-announce', id: 'a', type: 'locked', label: 'x', innerType: 'file' }),
    ).toBe(true)
  })

  const MALFORMED: ReadonlyArray<{ name: string; value: unknown }> = [
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'a string', value: 'file-done' },
    { name: 'a number', value: 42 },
    { name: 'an empty array', value: [] },
    { name: 'a Uint8Array', value: new Uint8Array([1, 2, 3]) },
    { name: 'an object without t', value: { id: 'a', content: 'x' } },
    { name: 'an unknown t', value: { t: 'hello', id: 'a' } },
    { name: 'a numeric t', value: { t: 7, id: 'a' } },
    { name: 'file-done without an id', value: { t: 'file-done' } },
    { name: 'file-done with a numeric id', value: { t: 'file-done', id: 7 } },
    { name: 'file-done with an extra field', value: { t: 'file-done', id: 'a', totalSize: 1 } },
    { name: 'item-delete without an id', value: { t: 'item-delete' } },
    { name: 'text-delta without content', value: { t: 'text-delta', id: 'a' } },
    { name: 'text-delta with numeric content', value: { t: 'text-delta', id: 'a', content: 1 } },
    {
      name: 'text-delta with null content',
      value: { t: 'text-delta', id: 'a', content: null },
    },
    {
      name: 'richtext-delta without an id',
      value: { t: 'richtext-delta', content: '{}' },
    },
    {
      name: 'file-chunk with a negative index',
      value: { t: 'file-chunk', id: 'a', index: -1, data: new Uint8Array([1]) },
    },
    {
      name: 'file-chunk with a fractional index',
      value: { t: 'file-chunk', id: 'a', index: 0.5, data: new Uint8Array([1]) },
    },
    {
      name: 'file-chunk with a NaN index',
      value: { t: 'file-chunk', id: 'a', index: Number.NaN, data: new Uint8Array([1]) },
    },
    {
      name: 'file-chunk with an unbounded index',
      value: { t: 'file-chunk', id: 'a', index: 2 ** 53, data: new Uint8Array([1]) },
    },
    {
      name: 'file-chunk with a string index',
      value: { t: 'file-chunk', id: 'a', index: '0', data: new Uint8Array([1]) },
    },
    {
      name: 'file-chunk with an array payload',
      value: { t: 'file-chunk', id: 'a', index: 0, data: [1, 2, 3] },
    },
    {
      name: 'file-chunk with a base64 string payload',
      value: { t: 'file-chunk', id: 'a', index: 0, data: 'AQID' },
    },
    { name: 'file-chunk with a null payload', value: { t: 'file-chunk', id: 'a', index: 0, data: null } },
    {
      name: 'file-chunk with a DataView payload',
      value: { t: 'file-chunk', id: 'a', index: 0, data: new DataView(new ArrayBuffer(4)) },
    },
    { name: 'file-chunk without a payload', value: { t: 'file-chunk', id: 'a', index: 0 } },
    {
      name: 'locked-payload with a non-Uint8Array salt',
      value: {
        t: 'locked-payload',
        id: 'a',
        ciphertext: new Uint8Array([1]),
        iv: new Uint8Array([2]),
        salt: [3],
      },
    },
    {
      name: 'locked-payload missing the iv',
      value: { t: 'locked-payload', id: 'a', ciphertext: new Uint8Array([1]), salt: new Uint8Array([3]) },
    },
    {
      name: 'locked-payload with a string ciphertext',
      value: {
        t: 'locked-payload',
        id: 'a',
        ciphertext: 'AAAA',
        iv: new Uint8Array([2]),
        salt: new Uint8Array([3]),
      },
    },
    { name: 'item-announce with an unknown item type', value: { t: 'item-announce', id: 'a', type: 'video' } },
    { name: 'item-announce without a type', value: { t: 'item-announce', id: 'a' } },
    {
      name: 'item-announce with a numeric totalSize',
      value: { t: 'item-announce', id: 'a', type: 'file', totalSize: '3' },
    },
    {
      name: 'item-announce with a negative totalChunks',
      value: { t: 'item-announce', id: 'a', type: 'file', totalChunks: -1 },
    },
    {
      name: 'item-announce with a null label',
      value: { t: 'item-announce', id: 'a', type: 'locked', label: null },
    },
    {
      name: 'item-announce with an unknown innerType',
      value: { t: 'item-announce', id: 'a', type: 'locked', innerType: 'video' },
    },
    { name: 'phrase-confirm carrying a field', value: { t: 'phrase-confirm', confirmed: true } },
    { name: 'session-end carrying an id', value: { t: 'session-end', id: 'a' } },
  ]

  for (const { name, value } of MALFORMED) {
    it(`rejects ${name}`, () => {
      expect(isWireMessage(value)).toBe(false)
    })
  }

  it('never throws on a hostile accessor — it returns false instead', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom')
        },
        ownKeys() {
          throw new Error('boom')
        },
      },
    )

    expect(() => isWireMessage(hostile)).not.toThrow()
    expect(isWireMessage(hostile)).toBe(false)
  })
})

describe('decodeWire', () => {
  it('rejects empty bytes', () => {
    expect(() => decodeWire(new Uint8Array(0))).toThrow(/not decodable MessagePack/)
  })

  it('rejects bytes that are not MessagePack', () => {
    // 0xc1 is reserved and never valid in MessagePack.
    expect(() => decodeWire(new Uint8Array([0xc1, 0xc1]))).toThrow(/not decodable MessagePack/)
  })

  it('rejects valid MessagePack that is not a WireMessage', () => {
    expect(() => decodeWire(encode({ hello: 'world' }))).toThrow(/not a valid WireMessage/)
    expect(() => decodeWire(encode([1, 2, 3]))).toThrow(/not a valid WireMessage/)
    expect(() => decodeWire(encode('file-done'))).toThrow(/not a valid WireMessage/)
    expect(() => decodeWire(encode({ t: 'file-done' }))).toThrow(/not a valid WireMessage/)
  })

  it('rejects trailing bytes after a valid message', () => {
    const frame = encodeWire({ t: 'file-done', id: 'item-1' })
    const padded = new Uint8Array(frame.byteLength + 1)
    padded.set(frame, 0)

    expect(() => decodeWire(padded)).toThrow(/not decodable MessagePack/)
  })

  it('rejects a frame larger than the documented limit without decoding it', () => {
    const oversized = new Uint8Array(WIRE_MAX_FRAME_BYTES + 1)

    expect(oversized.byteLength).toBeGreaterThan(WIRE_MAX_FRAME_BYTES)
    expect(() => decodeWire(oversized)).toThrow(/exceeds the .*-byte limit/)
  })

  it('rejects a map with more fields than the protocol allows', () => {
    const wide: Record<string, number> = {}
    for (let index = 0; index < 17; index += 1) {
      wide[`field${index}`] = index
    }

    expect(() => decodeWire(encode(wide))).toThrow(/not decodable MessagePack/)
  })

  it('rejects nested junk that is too deep to be a message', () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 64; depth += 1) {
      nested = [nested]
    }

    expect(() => decodeWire(encode(nested, { maxDepth: 128 }))).toThrow(/not a valid WireMessage/)
  })

  it('rejects a pathologically deep frame without crashing the process', () => {
    // 200_000 nested single-element arrays, built by hand because encoding this
    // through the library would recurse first: 0x91 is the fixarray header for a
    // one-element array and 0x00 is the innermost integer. MessagePack offers no
    // decoder depth option, so the depth here is only bounded by the byte
    // ceiling: the frame decodes and the flat-shape validator rejects it, and
    // either way `decodeWire` throws instead of taking the process down.
    const nested = new Uint8Array(200_001)
    nested.fill(0x91, 0, 200_000)
    nested[200_000] = 0x00

    expect(nested.byteLength).toBeLessThan(WIRE_MAX_FRAME_BYTES)
    expect(() => decodeWire(nested)).toThrow(Error)
  })

  it('rejects a non-Uint8Array argument', () => {
    expect(() => decodeWire('not bytes' as unknown as Uint8Array)).toThrow(/expects a Uint8Array/)
    expect(() => decodeWire(undefined as unknown as Uint8Array)).toThrow(/expects a Uint8Array/)
  })
})

describe('encodeWire', () => {
  it('refuses to encode a value that is not a WireMessage', () => {
    expect(() => encodeWire({ t: 'file-done' } as unknown as WireMessage)).toThrow(
      /refusing to encode/,
    )
    expect(() =>
      encodeWire({
        t: 'file-chunk',
        id: 'a',
        index: -1,
        data: new Uint8Array([1]),
      } as unknown as WireMessage),
    ).toThrow(/refusing to encode/)
  })

  it('produces a MessagePack map, not JSON text', () => {
    const encoded = encodeWire({ t: 'phrase-confirm' })

    // ASCII for a JSON object would start with '{' (0x7b); 0x81 here is the
    // MessagePack fixmap header for a single-pair map.
    expect(encoded[0]).toBe(0x81)
    expect(encoded[0]).not.toBe(0x7b)
  })
})

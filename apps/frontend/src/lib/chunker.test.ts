/**
 * Tests for file chunking and reassembly (PLAN.md §12).
 *
 * The contract under test: `chunkFile` always emits a well-formed
 * announce → chunks → done sequence for any file size (including zero), and
 * `FileAssembler` rebuilds the exact original bytes no matter what order the
 * chunks arrive in or how many duplicates the peer sends.
 */

import { describe, expect, it } from 'vitest'

import { CHUNK_SIZE, chunkFile, FileAssembler } from './chunker'
import { isWireMessage, type WireMessage } from './protocol'

type AnnounceMessage = Extract<WireMessage, { t: 'item-announce' }>
type ChunkMessage = Extract<WireMessage, { t: 'file-chunk' }>

/** A pattern that covers the full byte range, so a truncation or shift shows up. */
function patternBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + 7) % 256
  }
  return bytes
}

function makeFile(bytes: Uint8Array<ArrayBuffer>, name: string, mimeType: string): File {
  return new File([bytes], name, { type: mimeType })
}

async function collect(id: string, file: File): Promise<WireMessage[]> {
  const messages: WireMessage[] = []
  for await (const message of chunkFile(id, file)) {
    messages.push(message)
  }
  return messages
}

function expectAnnounce(messages: readonly WireMessage[]): AnnounceMessage {
  const first = messages[0]
  if (!first || first.t !== 'item-announce') throw new Error('expected an item-announce first')
  return first
}

function chunkMessages(messages: readonly WireMessage[]): ChunkMessage[] {
  return messages.filter((message): message is ChunkMessage => message.t === 'file-chunk')
}

describe('chunkFile', () => {
  it('announces, then sends every chunk in order, then signals done', async () => {
    const bytes = patternBytes(CHUNK_SIZE * 2)
    const messages = await collect('item-1', makeFile(bytes, 'photo.bin', 'application/octet-stream'))

    expect(messages).toHaveLength(4)
    expect(messages.map((message) => message.t)).toEqual([
      'item-announce',
      'file-chunk',
      'file-chunk',
      'file-done',
    ])
    expect(expectAnnounce(messages)).toEqual({
      t: 'item-announce',
      id: 'item-1',
      type: 'file',
      fileName: 'photo.bin',
      mimeType: 'application/octet-stream',
      totalSize: CHUNK_SIZE * 2,
      totalChunks: 2,
    })

    const chunks = chunkMessages(messages)
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1])
    expect(chunks.map((chunk) => chunk.data.byteLength)).toEqual([CHUNK_SIZE, CHUNK_SIZE])
    expect(chunks[0]?.data).toEqual(bytes.subarray(0, CHUNK_SIZE))
    expect(chunks[1]?.data).toEqual(bytes.subarray(CHUNK_SIZE, CHUNK_SIZE * 2))

    expect(messages[3]).toEqual({ t: 'file-done', id: 'item-1' })
  })

  it('sends a short final chunk when the size is not a multiple of CHUNK_SIZE', async () => {
    const bytes = patternBytes(CHUNK_SIZE + 7)
    const messages = await collect('item-2', makeFile(bytes, 'notes.txt', 'text/plain'))

    expect(expectAnnounce(messages)).toMatchObject({
      id: 'item-2',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      totalSize: CHUNK_SIZE + 7,
      totalChunks: 2,
    })

    const chunks = chunkMessages(messages)
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1])
    expect(chunks.map((chunk) => chunk.data.byteLength)).toEqual([CHUNK_SIZE, 7])
    expect(chunks[1]?.data).toEqual(bytes.subarray(CHUNK_SIZE))
  })

  it('produces a valid sequence for a zero-byte file: announce with zero chunks, then done', async () => {
    const messages = await collect('item-3', makeFile(new Uint8Array(0), 'empty.bin', ''))

    expect(messages).toHaveLength(2)
    expect(expectAnnounce(messages)).toMatchObject({ totalSize: 0, totalChunks: 0 })
    expect(chunkMessages(messages)).toEqual([])
    expect(messages[1]).toEqual({ t: 'file-done', id: 'item-3' })
  })

  it('announces an image type for image mime types and a file type otherwise', async () => {
    const png = await collect('img-1', makeFile(patternBytes(4), 'scan.png', 'image/png'))
    const unknown = await collect('file-1', makeFile(patternBytes(4), 'data.bin', ''))

    expect(expectAnnounce(png)).toMatchObject({ type: 'image', totalChunks: 1 })
    expect(expectAnnounce(unknown)).toMatchObject({ type: 'file', totalChunks: 1 })
  })

  it('emits only frames the wire validator accepts', async () => {
    const messages = await collect('item-4', makeFile(patternBytes(CHUNK_SIZE + 1), 'a.bin', 'x/y'))

    expect(messages.length).toBeGreaterThan(0)
    for (const message of messages) {
      expect(isWireMessage(message)).toBe(true)
    }
  })

  it('yields one chunk of exactly CHUNK_SIZE for a single-chunk file', async () => {
    const messages = await collect('item-5', makeFile(patternBytes(CHUNK_SIZE), 'exact.bin', 'x/y'))

    expect(expectAnnounce(messages)).toMatchObject({ totalChunks: 1 })
    expect(chunkMessages(messages).map((chunk) => chunk.data.byteLength)).toEqual([CHUNK_SIZE])
  })
})

describe('FileAssembler', () => {
  it('reports nothing complete before any chunk arrives', () => {
    const assembler = new FileAssembler()

    expect(assembler.chunkCount()).toBe(0)
    expect(assembler.has(0)).toBe(false)
    expect(assembler.isComplete(0)).toBe(true)
    expect(assembler.isComplete(3)).toBe(false)
    expect(assembler.isComplete(-1)).toBe(false)
  })

  it('tracks arrival with has() and chunkCount()', () => {
    const assembler = new FileAssembler()
    assembler.addChunk(1, new Uint8Array([9]))

    expect(assembler.has(1)).toBe(true)
    expect(assembler.has(0)).toBe(false)
    expect(assembler.chunkCount()).toBe(1)
  })

  it('accepts out-of-order chunks and still reports completeness', () => {
    const assembler = new FileAssembler()
    assembler.addChunk(2, new Uint8Array([3]))
    assembler.addChunk(0, new Uint8Array([1]))
    assembler.addChunk(1, new Uint8Array([2]))

    expect(assembler.chunkCount()).toBe(3)
    expect(assembler.isComplete(3)).toBe(true)
    expect(assembler.isComplete(4)).toBe(false)
  })

  it('ignores duplicate chunks so a replay cannot rewrite received bytes', () => {
    const assembler = new FileAssembler()
    assembler.addChunk(0, new Uint8Array([1, 2]))
    assembler.addChunk(0, new Uint8Array([9, 9, 9]))
    assembler.addChunk(1, new Uint8Array([3]))

    expect(assembler.chunkCount()).toBe(2)
    expect(assembler.isComplete(2)).toBe(true)
  })

  it('ignores indices that are not non-negative integers without corrupting state', () => {
    const assembler = new FileAssembler()
    assembler.addChunk(0, new Uint8Array([1]))
    assembler.addChunk(-1, new Uint8Array([2]))
    assembler.addChunk(1.5, new Uint8Array([3]))
    assembler.addChunk(Number.NaN, new Uint8Array([4]))

    expect(assembler.chunkCount()).toBe(1)
    expect(assembler.has(-1)).toBe(false)
    expect(assembler.isComplete(1)).toBe(true)
  })

  it('treats an extra index beyond the announced total as harmless', () => {
    const assembler = new FileAssembler()
    assembler.addChunk(0, new Uint8Array([1]))
    assembler.addChunk(5, new Uint8Array([6]))

    expect(assembler.isComplete(1)).toBe(true)
  })

  it('refuses to assemble a transfer with a hole', () => {
    const assembler = new FileAssembler()
    assembler.addChunk(0, new Uint8Array([1]))
    assembler.addChunk(2, new Uint8Array([3]))

    expect(assembler.isComplete(3)).toBe(false)
    expect(() => assembler.assemble('application/octet-stream')).toThrow(/chunk 1 of 2 is missing/)
  })

  it('refuses to assemble a transfer that has not started', () => {
    const assembler = new FileAssembler()
    assembler.addChunk(3, new Uint8Array([4]))

    expect(() => assembler.assemble('application/octet-stream')).toThrow(/chunk 0 of 1 is missing/)
  })

  it('assembles an empty blob for a zero-chunk file', async () => {
    const assembler = new FileAssembler()
    const blob = assembler.assemble('text/plain')

    expect(blob.size).toBe(0)
    expect(blob.type).toBe('text/plain')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(0))
  })

  it('publishes the contiguous prefix instead of throwing on a hole', async () => {
    const assembler = new FileAssembler()
    assembler.addChunk(0, new Uint8Array([1, 2]))
    assembler.addChunk(2, new Uint8Array([5]))
    assembler.addChunk(5, new Uint8Array([6]))

    // `assemble()` refuses the hole; the progressive preview stops at it instead.
    expect(() => assembler.assemble('application/octet-stream')).toThrow(/chunk 1 of 3 is missing/)
    const prefix = assembler.assemblePrefix('application/octet-stream')
    expect(prefix.size).toBe(2)
    expect(prefix.type).toBe('application/octet-stream')
    expect(new Uint8Array(await prefix.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
  })

  it('returns an empty blob when nothing contiguous from index 0 is present', async () => {
    const assembler = new FileAssembler()

    expect(assembler.assemblePrefix('image/png').size).toBe(0)

    // A chunk from the middle of the file is not a prefix: showing those bytes as the
    // start of the image is worse than showing nothing.
    assembler.addChunk(3, new Uint8Array([4]))
    expect(assembler.assemblePrefix('image/png').size).toBe(0)

    // Out-of-order arrival resumes the prefix as soon as its head lands.
    assembler.addChunk(0, new Uint8Array([1, 2]))
    expect(assembler.assemblePrefix('image/png').size).toBe(2)
    expect(new Uint8Array(await assembler.assemblePrefix('image/png').arrayBuffer())).toEqual(
      new Uint8Array([1, 2]),
    )
  })

  it('grows the prefix as the run arrives, always the original bytes from the start', async () => {
    const original = patternBytes(CHUNK_SIZE * 2 + 11)
    const file = makeFile(original, 'photo.png', 'image/png')
    const assembler = new FileAssembler()
    const sizes: number[] = []

    for await (const message of chunkFile('item-11', file)) {
      if (message.t !== 'file-chunk') continue
      assembler.addChunk(message.index, message.data)

      const prefix = assembler.assemblePrefix('image/png')
      sizes.push(prefix.size)
      expect(prefix.type).toBe('image/png')
      expect(new Uint8Array(await prefix.arrayBuffer())).toEqual(original.subarray(0, prefix.size))
    }

    expect(sizes).toEqual([CHUNK_SIZE, CHUNK_SIZE * 2, original.byteLength])
  })

  it('reproduces the original bytes from out-of-order chunks', async () => {
    const assembler = new FileAssembler()
    assembler.addChunk(2, new Uint8Array([7, 7, 7]))
    assembler.addChunk(0, new Uint8Array([1, 2]))
    assembler.addChunk(1, new Uint8Array([3, 4, 5]))

    const blob = assembler.assemble('application/octet-stream')
    expect(blob.size).toBe(8)
    expect(blob.type).toBe('application/octet-stream')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 7, 7, 7]),
    )
  })

  it('reproduces the exact bytes of a chunked file, over 80 KiB and not a chunk multiple', async () => {
    // End-to-end inside this lane: the real chunker's output fed to the real
    // assembler, with a size that is not a multiple of CHUNK_SIZE.
    const original = patternBytes(CHUNK_SIZE * 5 + 123)
    const file = makeFile(original, 'payload.bin', 'application/octet-stream')
    const assembler = new FileAssembler()
    let announcedTotal = -1
    let doneId: string | null = null

    for await (const message of chunkFile('item-9', file)) {
      if (message.t === 'item-announce') {
        announcedTotal = message.totalChunks ?? -1
      } else if (message.t === 'file-chunk') {
        assembler.addChunk(message.index, message.data)
      } else if (message.t === 'file-done') {
        doneId = message.id
      }
    }

    expect(announcedTotal).toBe(6)
    expect(doneId).toBe('item-9')
    expect(assembler.chunkCount()).toBe(6)
    expect(assembler.isComplete(announcedTotal)).toBe(true)

    const blob = assembler.assemble('application/octet-stream')
    expect(blob.size).toBe(original.byteLength)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original)
  })

  it('reproduces the exact bytes of a zero-byte file', async () => {
    const file = makeFile(new Uint8Array(0), 'empty.bin', '')
    const assembler = new FileAssembler()
    let announcedTotal = -1

    for await (const message of chunkFile('item-10', file)) {
      if (message.t === 'item-announce') {
        announcedTotal = message.totalChunks ?? -1
      } else if (message.t === 'file-chunk') {
        assembler.addChunk(message.index, message.data)
      }
    }

    expect(announcedTotal).toBe(0)
    expect(assembler.isComplete(announcedTotal)).toBe(true)
    expect(assembler.assemble('').size).toBe(0)
  })
})

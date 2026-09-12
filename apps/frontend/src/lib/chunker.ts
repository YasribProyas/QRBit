/**
 * File chunking (PLAN.md §12) — the sender side splits a `File` into
 * `file-chunk` frames bounded by `CHUNK_SIZE`, the receiver side reassembles the
 * bytes into a `Blob`.
 *
 * Pure library code: no crypto, no DOM APIs beyond `File`/`Blob`, no hooks. The
 * chunk memory held by `FileAssembler` lives in a `Map` for the lifetime of the
 * item only — session data never touches IndexedDB, the Cache API or
 * localStorage (AGENTS.md).
 */

import type { ItemType, WireMessage } from './protocol'

/**
 * PLAN.md §12. 16 KiB: large enough that the per-frame overhead disappears,
 * small enough that a frame fits comfortably in a single DataChannel message.
 */
export const CHUNK_SIZE = 16 * 1024

const IMAGE_MIME_PREFIX = 'image/'

/**
 * The `item-announce.type` for a chunked file.
 *
 * PLAN.md §9 gives `ImageItem` and `FileItem` identical transfer fields and
 * PLAN.md §16 sends images through "the file pipeline", so the MIME type is the
 * only thing that distinguishes them. Anything without an `image/*` type —
 * including an empty `File.type`, which browsers leave blank for unknown
 * extensions — is announced as `'file'`.
 */
function announceTypeFor(mimeType: string): ItemType {
  return mimeType.startsWith(IMAGE_MIME_PREFIX) ? 'image' : 'file'
}

/**
 * Streams one file as `item-announce` → `file-chunk` × N → `file-done`
 * (PLAN.md §12).
 *
 * `CHUNK_SIZE` is the maximum slice size, so a file whose size is an exact
 * multiple of `CHUNK_SIZE` produces exactly `size / CHUNK_SIZE` chunks and a
 * zero-byte file produces none — the announce then carries `totalChunks: 0` and
 * the sequence is still well formed. Chunks are read one at a time and yielded in
 * index order, so the whole file is never in memory on the sender at once.
 *
 * A failed read (`File.arrayBuffer()` rejecting, e.g. the file changed on disk)
 * propagates out of the generator; callers mark the item as errored and stop.
 */
export async function* chunkFile(id: string, file: File): AsyncGenerator<WireMessage> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  yield {
    t: 'item-announce',
    id,
    type: announceTypeFor(file.type),
    fileName: file.name,
    mimeType: file.type,
    totalSize: file.size,
    totalChunks,
  }

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * CHUNK_SIZE
    const buffer = await file.slice(start, start + CHUNK_SIZE).arrayBuffer()
    yield { t: 'file-chunk', id, index, data: new Uint8Array(buffer) }
  }

  yield { t: 'file-done', id }
}

/**
 * Concatenates chunk views into one `Blob` in the order given.
 *
 * One allocation for the whole run, filled chunk by chunk: a fresh `Blob` per
 * chunk would copy the same bytes again and double peak memory.
 */
function blobFromChunks(chunks: readonly Uint8Array[], mimeType: string): Blob {
  let totalBytes = 0
  for (const chunk of chunks) {
    totalBytes += chunk.byteLength
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new Blob([bytes], { type: mimeType })
}

/**
 * Reassembles the chunks of one file (PLAN.md §12).
 *
 * Chunks are stored by index and nothing else is tracked, so arrival order does
 * not matter: a DataChannel message can be re-sent or re-ordered by a hostile
 * peer, and the assembler's state stays consistent either way.
 *
 * Memory lives only in the `Map` — the caller drops the assembler when the item
 * completes or errors, and the chunks become garbage with it.
 */
export class FileAssembler {
  private readonly chunks = new Map<number, Uint8Array>()

  /**
   * Stores one chunk.
   *
   * Out-of-order chunks are fine, a duplicate index is ignored (the first copy
   * wins, so a replayed chunk cannot rewrite what was already received), and an
   * index that is not a non-negative safe integer is dropped — inbound frames are
   * already schema-checked by `isWireMessage`, so that last case is defence in
   * depth rather than a reachable path.
   *
   * A chunk is kept by reference instead of copied: it arrives as the `data` of a
   * freshly decoded frame that nothing else holds, and this map is the only
   * consumer. The map therefore owns at most one copy of the file's bytes.
   */
  addChunk(index: number, data: Uint8Array): void {
    if (!Number.isSafeInteger(index) || index < 0) return
    if (this.chunks.has(index)) return
    this.chunks.set(index, data)
  }

  /** Whether the chunk at `index` has already arrived. */
  has(index: number): boolean {
    return this.chunks.has(index)
  }

  /** How many distinct chunks are held. */
  chunkCount(): number {
    return this.chunks.size
  }

  /**
   * Whether chunks `0 … totalChunks - 1` have all arrived.
   *
   * `totalChunks` comes from the announce (PLAN.md §9), so this — not
   * `assemble()` — is what the receiver uses to decide a transfer is done. A
   * zero-byte file is complete at zero chunks.
   */
  isComplete(totalChunks: number): boolean {
    if (!Number.isSafeInteger(totalChunks) || totalChunks < 0) return false
    for (let index = 0; index < totalChunks; index += 1) {
      if (!this.chunks.has(index)) return false
    }
    return true
  }

  /**
   * Concatenates the held chunks in index order into a `Blob`.
   *
   * Throws when the held chunks are not a gap-free run `0 … count - 1`: an
   * incomplete transfer must never be assembled into a silently truncated file.
   * The declared total is not known here (PLAN.md §12 gives `assemble` no total
   * parameter), so this is a density check rather than a completeness check — a
   * caller that has received nothing at all must gate on `isComplete(0)` itself
   * to tell a zero-byte file apart from a transfer that never started.
   */
  assemble(mimeType: string): Blob {
    const count = this.chunks.size
    const ordered: Uint8Array[] = []
    for (let index = 0; index < count; index += 1) {
      const chunk = this.chunks.get(index)
      if (chunk === undefined) {
        throw new Error(`chunker: cannot assemble — chunk ${index} of ${count} is missing`)
      }
      ordered.push(chunk)
    }

    return blobFromChunks(ordered, mimeType)
  }

  /**
   * Concatenates the contiguous run of chunks that starts at index 0 into a
   * `Blob` — the bytes the receiver already holds, in order (PLAN.md §9's
   * progressive reveal).
   *
   * Unlike `assemble()` this never throws: the run simply stops at the first
   * missing index, so a hole or a chunk that has not arrived yet truncates the
   * preview instead of failing it. With no chunk 0 the result is an empty Blob,
   * which is what an item that has not started shows.
   *
   * The cost is the bytes held so far, and the caller decides how often to pay it
   * (the receive path publishes at most once per 10% — see `writeProgress`).
   */
  assemblePrefix(mimeType: string): Blob {
    const ordered: Uint8Array[] = []
    for (let index = 0; ; index += 1) {
      const chunk = this.chunks.get(index)
      if (chunk === undefined) break
      ordered.push(chunk)
    }

    return blobFromChunks(ordered, mimeType)
  }
}

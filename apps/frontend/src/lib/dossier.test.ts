/**
 * Tests for the dossier send path (`lib/dossier.ts`).
 *
 * These exist because the code they replace passed 1000+ green tests while fabricating data.
 * `fileBlocksToLibraryItems` used to invent bytes for any `image`/`fileAttachment` block that
 * had none — `new Blob([new Uint8Array(100)])` — and the tests never covered those blocks at
 * all, because every one of them asserted that the happy path produced an item. So the shape
 * here is deliberate (ORCHESTRATION D15's testing lesson): assertions of ABSENCE, and each
 * guard checked against the old behaviour by re-reading what the assertion would have seen.
 *
 * What fails against the shipped code, and must not fail now:
 *   - a block with no file rejects instead of emitting 100 null bytes named `data_export.bin`;
 *   - no `Blob` at all is constructed by a refused conversion (proved with a tracking `Blob`,
 *     because "the fabrication is unreachable" is a claim about a constructor, not a string);
 *   - a locked attachment travels as ciphertext of ITS OWN bytes, not as a plaintext image item
 *     and not as the literal `'secret'`;
 *   - a size on screen or in a preview is a measured number, never `'2.4 MB'`.
 *
 * `fake-indexeddb` stands in for the browser (as in `library.test.ts`), so this file runs in
 * the default node environment. Each case starts from an empty database.
 */

import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  describeSendFailure,
  DossierSendError,
  fileBlocksToLibraryItems,
  findUnsendableBlocks,
  getFirstBlockPreview,
  sessionItemsToLibraryFile,
} from './dossier'
import { closeLibraryDatabase, getFile, ROOT_FOLDER_ID, saveFile } from './library'
import type { FileBlock, LibraryFile, LibraryImageItem, LibraryLockedItem } from './library'
import { decryptItem, LOCKED_ITEM_MAX_PLAINTEXT_BYTES } from './crypto'
import type { FileItem } from '../store/sessionStore'

/** The database name `lib/library.ts` opens. Pinned so a rename cannot hide a stale store. */
const DB_NAME = 'qrbit-library'

/**
 * Recognisable bytes. Values cycle, so a 100-byte run of zeros — the payload the old code
 * fabricated — cannot equal this at any length, and a truncated copy cannot pass either.
 */
function bytes(length: number): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * 37 + 11) % 251
  }
  return value
}

async function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

function dossier(blocks: FileBlock[]): LibraryFile {
  return {
    id: 'file-under-test',
    folderId: ROOT_FOLDER_ID,
    name: 'Dossier under test',
    createdAt: 1,
    updatedAt: 1,
    blocks,
  }
}

/**
 * An attachment block, with or without bytes.
 *
 * A block with no file carries NO `fileName` either — that is what the editor makes now, and a
 * fixture that named a file nobody chose would be asserting against a smaller lie than the one
 * this file replaced.
 */
function imageBlock(blob?: Blob): FileBlock {
  return {
    id: 'b-image',
    type: 'image',
    ...(blob === undefined
      ? {}
      : { blob, fileName: 'rig.png', mimeType: blob.type, fileSize: blob.size }),
  }
}

function attachmentBlock(blob?: Blob): FileBlock {
  return {
    id: 'b-file',
    type: 'fileAttachment',
    ...(blob === undefined
      ? {}
      : { blob, fileName: 'export.csv', mimeType: blob.type, fileSize: blob.size }),
  }
}

function heading(id: string, content: string): FileBlock {
  return { id, type: 'heading', content }
}

async function freshDatabase(): Promise<void> {
  await closeLibraryDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => {
      resolve()
    }
    request.onerror = () => {
      reject(request.error ?? new Error('deleteDatabase failed'))
    }
  })
}

beforeEach(freshDatabase)
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fileBlocksToLibraryItems — a block with no file is invalid, not sendable', () => {
  it('refuses an image block that has no Blob, and names the block', async () => {
    const error = await fileBlocksToLibraryItems(dossier([imageBlock()])).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DossierSendError)
    const failure = error as DossierSendError
    expect(failure.message).toContain('has no attachment data')
    expect(failure.blockId).toBe('b-image')
    expect(failure.blockType).toBe('image')
    expect(failure.reason).toBe('attachment-missing')
  })

  it('refuses a fileAttachment block that has no Blob', async () => {
    await expect(fileBlocksToLibraryItems(dossier([attachmentBlock()]))).rejects.toThrow(
      /dossier: block b-file has no attachment data/,
    )
  })

  it('constructs no Blob at all on the way to refusing', async () => {
    /*
     * The absence assertion. The old code reached this exact case and called `new Blob(...)`
     * with 100 zero bytes; anything that still fabricates must trip this, because the stub
     * records every construction in the process.
     */
    const constructed: BlobPart[][] = []

    class TrackingBlob extends Blob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts ?? [], options)
        constructed.push(parts ?? [])
      }
    }

    vi.stubGlobal('Blob', TrackingBlob)

    await expect(
      fileBlocksToLibraryItems(dossier([imageBlock(), attachmentBlock()])),
    ).rejects.toBeInstanceOf(DossierSendError)

    expect(constructed).toHaveLength(0)
  })

  it('refuses the whole dossier when one block of several has no bytes', async () => {
    // All-or-nothing: a dossier must not go out with its real blocks and one invented one,
    // which is what a per-item `continue` would have produced instead of a rejection.
    const file = dossier([
      heading('b-1', 'Alpha'),
      attachmentBlock(),
      heading('b-2', 'Bravo'),
    ])

    await expect(fileBlocksToLibraryItems(file)).rejects.toBeInstanceOf(DossierSendError)
  })

  it('still converts a dossier whose blocks need no bytes, so the guard above can fail', async () => {
    const items = await fileBlocksToLibraryItems(
      dossier([heading('b-1', 'Alpha'), { id: 'b-2', type: 'richText', content: 'Notes' }]),
    )

    expect(items).toHaveLength(2)
    expect(items.map((item) => item.id)).toEqual(['b-1', 'b-2'])
  })

  it('collects the same refusals without throwing, for a caller that must show them', () => {
    const failures = findUnsendableBlocks(
      dossier([heading('b-1', 'Alpha'), imageBlock(), attachmentBlock()]),
    )

    expect(failures).toHaveLength(2)
    expect(failures.map((failure) => failure.blockId)).toEqual(['b-image', 'b-file'])
    expect(describeSendFailure(failures[0])).toContain('no file chosen yet')
    expect(findUnsendableBlocks(dossier([heading('b-1', 'Alpha')]))).toEqual([])
  })
})

describe('a chosen file survives the path the app actually takes', () => {
  it('carries the same bytes and the real size through saveFile and getFile', async () => {
    const source = bytes(4096)
    const blob = new Blob([source], { type: 'image/png' })
    const file = dossier([imageBlock(blob), attachmentBlock(new Blob([bytes(77)], { type: 'text/csv' }))])

    await saveFile(file)
    const reread = await getFile(file.id)
    if (reread === undefined) throw new Error('test bug: the dossier did not come back')

    // The Blob is still a Blob after the structured clone, and still the same bytes: this is
    // what makes the editor's draft safe to hold and re-read.
    const rereadImage = reread.blocks[0]
    if (!(rereadImage?.blob instanceof Blob)) throw new Error('test bug: the blob did not round-trip')
    expect(rereadImage.blob.type).toBe('image/png')
    expect(rereadImage.blob.size).toBe(4096)
    expect(await readBytes(rereadImage.blob)).toEqual(source)

    const items = await fileBlocksToLibraryItems(reread)
    expect(items).toHaveLength(2)

    const image = items[0]
    if (image?.type !== 'image') throw new Error('test bug: the image item is not an image item')
    expect(image.name).toBe('rig.png')
    expect(image.mimeType).toBe('image/png')
    expect(image.size).toBe(4096)
    expect(await readBytes(image.blob)).toEqual(source)

    const attached = items[1]
    if (attached?.type !== 'file') throw new Error('test bug: the attachment item is not a file item')
    expect(attached.name).toBe('export.csv')
    expect(attached.size).toBe(77)
    expect(await readBytes(attached.blob)).toEqual(bytes(77))
  })

  it('reports a size measured from the bytes, not a stored label', async () => {
    // A block that carries a real 12-byte file alongside a stale `fileSize` string still sends
    // 12 bytes: `size` is `blob.size`, read off the payload, and nothing reads the string.
    const blob = new Blob([bytes(12)], { type: 'application/octet-stream' })
    const items = await fileBlocksToLibraryItems(
      dossier([{ id: 'b-file', type: 'fileAttachment', fileName: 'thing.bin', fileSize: '14.2 MB', blob }]),
    )

    const item = items[0]
    if (item?.type !== 'file') throw new Error('test bug: expected a file item')
    expect(item.size).toBe(12)
  })

  it('falls back to the blob type when the block announced none', async () => {
    const blob = new Blob([bytes(8)], { type: 'image/jpeg' })
    const items = await fileBlocksToLibraryItems(dossier([{ id: 'b-image', type: 'image', blob }]))

    const item = items[0]
    if (item?.type !== 'image') throw new Error('test bug: expected an image item')
    expect(item.mimeType).toBe('image/jpeg')
  })
})

describe('the size shown to a person comes from the bytes', () => {
  it('previews an attachment with its measured size and its real filename', () => {
    const blob = new Blob([bytes(1_048_588)], { type: 'image/png' })
    const preview = getFirstBlockPreview(dossier([imageBlock(blob)]))

    expect(preview).toContain('rig.png')
    expect(preview).toContain('1.0 MiB')
    // The literals this file replaced. Asserted absent, because a preview that says both is
    // still the one the user could not tell was lying.
    expect(preview).not.toContain('2.4 MB')
    expect(preview).not.toContain('412 KB')
    expect(preview).not.toContain('attachment.png')
  })

  it('previews a block with no file as having no file', () => {
    expect(getFirstBlockPreview(dossier([attachmentBlock()]))).toContain('no file chosen')
    expect(getFirstBlockPreview(dossier([imageBlock()]))).not.toContain('attachment_photo.png')
    expect(getFirstBlockPreview(dossier([imageBlock()]))).not.toContain('Telemetry capture')
  })
})

describe('locked blocks — D6, and ciphertext only', () => {
  function lockedBlock(overrides: Partial<FileBlock> = {}): FileBlock {
    return {
      id: 'b-locked',
      type: 'locked',
      label: 'Cluster key',
      content: 'sys_x94#kK99!Alpha2',
      password: 'correct horse',
      isLocked: true,
      ...overrides,
    }
  }

  it('encrypts the file a locked attachment holds, and stores nothing but the tuple', async () => {
    const payload = bytes(512)
    const blob = new Blob([payload], { type: 'application/octet-stream' })
    const items = await fileBlocksToLibraryItems(
      dossier([lockedBlock({ blob, password: 'sentry-4' })]),
    )

    const item = items[0]
    if (item?.type !== 'locked') throw new Error('test bug: expected a locked item')

    expect(item.innerType).toBe('file')
    expect('blob' in item).toBe(false)
    expect('content' in item).toBe(false)
    expect('size' in item).toBe(false)

    // Ciphertext only: nothing on the item is the payload, and decrypting with the password the
    // user set is the only way the bytes come back — identical.
    const decrypted = await decryptItem('sentry-4', item.salt, item.iv, item.ciphertext)
    expect(decrypted).toEqual(payload)
  })

  it('does not send an image block the user locked as a plaintext image item', async () => {
    /*
     * The branch order was `image`, then `fileAttachment`, then locked — so ticking "Lock this
     * entity with password" on an image row changed nothing about what left the device: the
     * bytes went out as an ordinary image item and the tuple went nowhere. A locked block is
     * now checked first, whichever type it is.
     */
    const blob = new Blob([bytes(256)], { type: 'image/png' })
    const items = await fileBlocksToLibraryItems(
      dossier([{ id: 'b-image', type: 'image', fileName: 'key.png', blob, isLocked: true, password: 'locked-down' }]),
    )

    const item = items[0]
    if (item?.type !== 'locked') throw new Error('test bug: a locked image must travel as a locked item')
    expect('blob' in item).toBe(false)
    expect(await decryptItem('locked-down', item.salt, item.iv, item.ciphertext)).toEqual(bytes(256))
  })

  it('refuses a locked payload over D6 cap, before encrypting anything', async () => {
    const oversized = new Blob([bytes(LOCKED_ITEM_MAX_PLAINTEXT_BYTES + 1)], {
      type: 'application/octet-stream',
    })

    const error = await fileBlocksToLibraryItems(
      dossier([lockedBlock({ content: undefined, blob: oversized })]),
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DossierSendError)
    expect((error as DossierSendError).reason).toBe('locked-too-large')
    expect(describeSendFailure(error)).toContain('3.0 MiB')

    // The same refusal is available before a Send is attempted, without any crypto.
    expect(findUnsendableBlocks(dossier([lockedBlock({ content: undefined, blob: oversized })]))).toHaveLength(1)
  })

  it('refuses to encrypt nothing, instead of shipping the literal "secret"', async () => {
    const error = await fileBlocksToLibraryItems(
      dossier([lockedBlock({ content: undefined, value: undefined })]),
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DossierSendError)
    expect((error as DossierSendError).reason).toBe('locked-content-missing')
  })

  it('refuses to lock under a password nobody set', async () => {
    // The old code encrypted with `block.password || 'pass'`: the item leaves the device locked
    // under a password from the source, which the receiver could guess and the sender never chose.
    const error = await fileBlocksToLibraryItems(
      dossier([lockedBlock({ password: undefined })]),
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DossierSendError)
    expect((error as DossierSendError).reason).toBe('locked-password-missing')
  })

  it('sends a stored tuple byte-for-byte and never re-encrypts it (D9)', async () => {
    const ciphertext = bytes(64)
    const iv = bytes(12)
    const salt = bytes(16)
    const items = await fileBlocksToLibraryItems(
      dossier([
        lockedBlock({
          content: undefined,
          password: undefined,
          lockedData: { ciphertext, iv, salt, innerType: 'fileAttachment' },
        }),
      ]),
    )

    const item = items[0]
    if (item?.type !== 'locked') throw new Error('test bug: expected a locked item')
    expect(item.ciphertext).toBe(ciphertext)
    expect(item.iv).toBe(iv)
    expect(item.salt).toBe(salt)
    expect(item.innerType).toBe('file')
  })
})

describe('sessionItemsToLibraryFile — a received file keeps the bytes that arrived', () => {
  function receivedFile(blob: Blob): FileItem {
    return {
      id: 's-1',
      type: 'file',
      status: 'complete',
      createdAt: 1,
      fileName: 'telemetry.csv',
      mimeType: 'text/csv',
      totalSize: blob.size,
      totalChunks: 2,
      progress: 100,
      blob,
    }
  }

  it('records the size as the byte count that arrived, not a rounded KB string', () => {
    const blob = new Blob([bytes(20_000)], { type: 'text/csv' })
    const file = sessionItemsToLibraryFile('Incoming', ROOT_FOLDER_ID, [receivedFile(blob)])

    const block = file.blocks[0]
    if (block === undefined) throw new Error('test bug: no block was built')
    expect(block.fileSize).toBe(20_000)
    expect(typeof block.fileSize).toBe('number')
    expect(block.blob).toBe(blob)
    expect(getFirstBlockPreview(file)).toContain('19.5 KiB')
  })
})

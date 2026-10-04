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
 *     and not as the literal `'secret'`; and no locked block of ANY type — heading, key/value,
 *     note — travels as its own plaintext either;
 *   - encryption happens in the editor (`encryptBlockPayload`), never on the send path, so a
 *     block that was never encrypted is refused rather than locked under a guessed password;
 *   - a size on screen or in a preview is a measured number, never `'2.4 MB'`.
 *
 * `fake-indexeddb` stands in for the browser (as in `library.test.ts`), so this file runs in
 * the default node environment. Each case starts from an empty database.
 */

import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  describeSendFailure,
  deserializeDossierBlocks,
  DossierSendError,
  encryptBlockPayload,
  fileBlocksToLibraryItems,
  findUnsendableBlocks,
  getFirstBlockPreview,
  serializeDossierBlocks,
  sessionItemsToLibraryFile,
} from './dossier'
import {
  closeLibraryDatabase,
  getFile,
  isProtectedBlock,
  lockedTupleOf,
  ROOT_FOLDER_ID,
  saveFile,
} from './library'
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
  /**
   * A locked block as the editor's draft holds one: a payload, the lock flag, and — once locked —
   * the tuple the payload was encrypted into.
   *
   * It carries NO `password` field, and that is the point. `FileBlock.password` was the defect
   * this lane removed: the secret and the key that opened it sat in the same IndexedDB record, so
   * the send path could "encrypt" on the way out with a password the record had already given
   * away. Encryption now happens in the editor (`encryptBlockPayload`, the row's Lock dialog and
   * the Save prompt), and the only thing this module will carry is the tuple that came out of it.
   */
  function lockedBlock(overrides: Partial<FileBlock> = {}): FileBlock {
    return {
      id: 'b-locked',
      type: 'locked',
      label: 'Cluster key',
      content: 'krnl-7742-rotor-alt',
      isLocked: true,
      ...overrides,
    }
  }

  /**
   * The editor's lock step, run for a test the way `BlockItem` and `FileEditView` run it: encrypt
   * the block's own payload, put the tuple on `lockedData`, leave the draft's plaintext where it
   * is (in memory, never on the wire and never in the record).
   */
  async function lock(block: FileBlock, password: string): Promise<FileBlock> {
    const lockedData = await encryptBlockPayload(block, password)
    return { ...block, isLocked: true, isUnlocked: false, lockedData }
  }

  it('encrypts the file a locked attachment holds, and sends nothing but the tuple', async () => {
    const payload = bytes(512)
    const blob = new Blob([payload], { type: 'application/octet-stream' })
    const block = await lock(lockedBlock({ content: undefined, blob }), 'sentry-4')

    // The encryption happened in the editor, not here: this is the tuple that gets stored, and
    // it names the bytes it was made from.
    if (block.lockedData?.innerType !== 'fileAttachment') {
      throw new Error('test bug: locking a block that holds a file did not record a file payload')
    }

    const items = await fileBlocksToLibraryItems(dossier([block]))

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
     * The branch order was `image`, then `fileAttachment`, then locked — so locking an image row
     * changed nothing about what left the device: the bytes went out as an ordinary image item and
     * the tuple went nowhere. A locked block is now matched before either attachment branch.
     */
    const payload = bytes(256)
    const blob = new Blob([payload], { type: 'image/png' })
    const block = await lock(
      { id: 'b-image', type: 'image', fileName: 'key.png', blob, isLocked: true },
      'locked-down',
    )

    const items = await fileBlocksToLibraryItems(dossier([block]))
    expect(items).toHaveLength(1)

    const item = items[0]
    if (item?.type !== 'locked') {
      throw new Error(`test bug: a locked image travelled as a "${item?.type}" item`)
    }
    expect(item.type).not.toBe('image')
    expect('blob' in item).toBe(false)
    expect('size' in item).toBe(false)
    expect(await decryptItem('locked-down', item.salt, item.iv, item.ciphertext)).toEqual(payload)
  })

  it('does not send a locked shortText or rich-text block as its own plaintext either', async () => {
    /*
     * The same branch-order defect, one type over. `heading`, `shortText` and `richText` were all
     * matched before the locked branch, and the lock dialog is on every row — so locking a
     * key/value field and pressing Send used to put `Label: the-secret` on the wire as an ordinary
     * text item while the ciphertext sat unused. The locked branch has to come first, whatever the
     * block type is, and the draft's plaintext must not be able to overrule the tuple.
     */
    const secret = 'bastion-root-keyphrase'
    const shortText = await lock(
      { id: 'b-pair', type: 'shortText', label: 'Bastion key', value: secret, isLocked: true },
      'pair-pw',
    )
    const note = await lock(
      { id: 'b-note', type: 'richText', content: secret, isLocked: true },
      'note-pw',
    )
    const title = await lock(
      { id: 'b-head', type: 'heading', content: secret, isLocked: true },
      'head-pw',
    )

    const items = await fileBlocksToLibraryItems(dossier([shortText, note, title]))
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.type)).toEqual(['locked', 'locked', 'locked'])

    // Nothing that left the device is the plaintext, and each item opens only with its own
    // password. `JSON.stringify` of the whole payload is the absence assertion: the secret has to
    // be nowhere in what goes out, not merely absent from the field the branch used to write.
    const wire = JSON.stringify(items)
    expect(wire).not.toContain(secret)
    expect(wire).not.toContain('Bastion key: ')
    expect(wire).not.toContain('# ')
    for (const [index, password] of (['pair-pw', 'note-pw', 'head-pw'] as const).entries()) {
      const item = items[index]
      if (item === undefined || item.type !== 'locked') throw new Error('test bug: expected a locked item')
      const decrypted = await decryptItem(password, item.salt, item.iv, item.ciphertext)
      expect(new TextDecoder().decode(decrypted)).toBe(secret)
    }
  })

  it('refuses a locked payload over D6 cap, before encrypting anything', async () => {
    const oversized = new Blob([bytes(LOCKED_ITEM_MAX_PLAINTEXT_BYTES + 1)], {
      type: 'application/octet-stream',
    })
    const block = lockedBlock({ content: undefined, blob: oversized })

    /*
     * Two gates, both reached, and the size one first. `fileBlocksToLibraryItems` cannot encrypt
     * at all now (a block holds no password), so an oversized payload with no tuple is refused for
     * being too big rather than for being unencrypted — the measurement beats the missing-key
     * complaint, which is the order the editor's own message depends on.
     */
    const error = await fileBlocksToLibraryItems(dossier([block])).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DossierSendError)
    expect((error as DossierSendError).reason).toBe('locked-too-large')
    expect(describeSendFailure(error)).toContain('3.0 MiB')

    // The same refusal is available before a Send is attempted, without any crypto.
    expect(findUnsendableBlocks(dossier([block]))).toHaveLength(1)

    // And the editor's encrypt step refuses it too, before a key is derived: D6 is one number
    // enforced on both sides of the tuple, not a check the UI hopes the caller ran.
    const refused = await encryptBlockPayload(block, 'sentry-4').catch((cause: unknown) => cause)
    expect(refused).toBeInstanceOf(DossierSendError)
    expect((refused as DossierSendError).reason).toBe('locked-too-large')
  })

  it('refuses to encrypt nothing, instead of shipping the literal "secret"', async () => {
    const empty = lockedBlock({ content: undefined, value: undefined })

    const error = await fileBlocksToLibraryItems(dossier([empty])).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DossierSendError)
    expect((error as DossierSendError).reason).toBe('locked-content-missing')

    // Same reason from the encrypt side: there is nothing there, so no ciphertext is made and no
    // block that looks protected exists afterwards.
    const refused = await encryptBlockPayload(empty, 'sentry-4').catch((cause: unknown) => cause)
    expect(refused).toBeInstanceOf(DossierSendError)
    expect((refused as DossierSendError).reason).toBe('locked-content-missing')
  })

  it('refuses a locked block that was never encrypted, and will not choose a password for it', async () => {
    /*
     * The old code encrypted with `block.password || 'pass'` on the send path: the item left the
     * device locked under a password from the source, which the receiver could guess and the
     * sender never chose. With no `password` field on a block there is nothing to default and
     * nothing to read, so a locked block holding plaintext is simply unsendable — and an empty
     * password is refused by the encrypt step before PBKDF2 runs at all.
     */
    const neverEncrypted = lockedBlock()
    expect(neverEncrypted.lockedData).toBeUndefined()

    const error = await fileBlocksToLibraryItems(
      dossier([neverEncrypted]),
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DossierSendError)
    expect((error as DossierSendError).reason).toBe('locked-password-missing')
    expect(describeSendFailure(error)).toContain('not encrypted yet')

    // No item was produced, so nothing went out "encrypted" under a password nobody set.
    expect(findUnsendableBlocks(dossier([neverEncrypted]))).toHaveLength(1)

    const blank = await encryptBlockPayload(neverEncrypted, '').catch((cause: unknown) => cause)
    expect(blank).toBeInstanceOf(DossierSendError)
    expect((blank as DossierSendError).reason).toBe('locked-password-missing')

    /*
     * Whitespace-only is not a password. `BlockItem`'s lock dialog already refused it via
     * `.trim()`; the chokepoint only refused `''`, so the SAVE PROMPT would still happily mint a
     * tuple under "   " — a field that looks filled, 600k PBKDF2 rounds over spaces, and a secret
     * the user will never unlock again. Both paths must agree or the guard is decorative.
     */
    for (const onlySpaces of ['   ', '\t', '\n ']) {
      const refusal = await encryptBlockPayload(lockedBlock(), onlySpaces).catch(
        (cause: unknown) => cause,
      )
      expect(refusal, `password ${JSON.stringify(onlySpaces)} must be refused`).toBeInstanceOf(
        DossierSendError,
      )
      expect((refusal as DossierSendError).reason).toBe('locked-password-missing')
    }

    // A password that CONTAINS spaces is legitimate and must be used VERBATIM: trimming here
    // would change the derived key and make a real passphrase impossible to retype.
    const spaced = await encryptBlockPayload(lockedBlock(), '  correct horse battery staple  ')
    expect(spaced.iv.byteLength).toBe(12)
    expect(spaced.salt.byteLength).toBe(16)
  })

  it('decides the three locked refusals in one fixed order', () => {
    /*
     * Pinned because the message the user reads is chosen from this order, and because a reorder
     * would turn "your payload is over the cap" into "go set a password" for a block that can
     * never be encrypted at any length. No tuple: content first, then size, then the fact that
     * nothing encrypted it. A real tuple: only the frame bound can refuse it.
     */
    const reasonOf = (block: FileBlock): string | undefined =>
      findUnsendableBlocks(dossier([block]))[0]?.reason

    expect(reasonOf(lockedBlock({ content: undefined, value: undefined }))).toBe(
      'locked-content-missing',
    )
    expect(
      reasonOf(
        lockedBlock({
          content: undefined,
          blob: new Blob([bytes(LOCKED_ITEM_MAX_PLAINTEXT_BYTES + 1)]),
        }),
      ),
    ).toBe('locked-too-large')
    expect(reasonOf(lockedBlock())).toBe('locked-password-missing')
    expect(
      reasonOf(
        lockedBlock({
          content: undefined,
          lockedData: { ciphertext: bytes(64), iv: bytes(12), salt: bytes(16) },
        }),
      ),
    ).toBeUndefined()
    expect(
      reasonOf(
        lockedBlock({
          content: undefined,
          lockedData: {
            ciphertext: bytes(LOCKED_ITEM_MAX_PLAINTEXT_BYTES + 17),
            iv: bytes(12),
            salt: bytes(16),
          },
        }),
      ),
    ).toBe('locked-too-large')
  })

  it('sends a stored tuple byte-for-byte and never re-encrypts it (D9)', async () => {
    const ciphertext = bytes(64)
    const iv = bytes(12)
    const salt = bytes(16)
    const items = await fileBlocksToLibraryItems(
      dossier([
        lockedBlock({
          // Plaintext still sitting in the draft beside a real tuple: the tuple travels, this
          // does not, and there is no password here with which to re-encrypt anything.
          content: 'draft-plaintext-that-must-not-travel',
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
    expect('content' in item).toBe(false)
    expect(JSON.stringify(items)).not.toContain('draft-plaintext-that-must-not-travel')
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

describe('serializeDossierBlocks and deserializeDossierBlocks — binary and locked data round-trip', () => {
  it('preserves image and file attachment Blobs across serialize and deserialize', async () => {
    const rawImageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
    const imageBlob = new Blob([rawImageBytes], { type: 'image/png' })

    const rawFileBytes = new Uint8Array([10, 20, 30, 40, 50])
    const fileBlob = new Blob([rawFileBytes], { type: 'application/octet-stream' })

    const blocks: FileBlock[] = [
      {
        id: 'b-img',
        type: 'image',
        fileName: 'photo.png',
        fileSize: imageBlob.size,
        mimeType: 'image/png',
        blob: imageBlob,
      },
      {
        id: 'b-doc',
        type: 'fileAttachment',
        fileName: 'report.bin',
        fileSize: fileBlob.size,
        mimeType: 'application/octet-stream',
        blob: fileBlob,
      },
      {
        id: 'b-txt',
        type: 'shortText',
        label: 'Subject',
        value: 'Confidential Report',
      },
    ]

    const json = await serializeDossierBlocks(blocks)
    expect(typeof json).toBe('string')
    expect(json).not.toContain('[object Object]')

    const restored = deserializeDossierBlocks(json)
    expect(restored).toHaveLength(3)

    const restoredImg = restored[0]
    expect(restoredImg?.type).toBe('image')
    expect(restoredImg?.fileName).toBe('photo.png')
    expect(restoredImg?.blob).toBeInstanceOf(Blob)
    expect(restoredImg?.blob?.size).toBe(imageBlob.size)
    expect(restoredImg?.blob?.type).toBe('image/png')
    const imgBytes = new Uint8Array(await restoredImg!.blob!.arrayBuffer())
    expect(imgBytes).toEqual(rawImageBytes)

    const restoredDoc = restored[1]
    expect(restoredDoc?.type).toBe('fileAttachment')
    expect(restoredDoc?.fileName).toBe('report.bin')
    expect(restoredDoc?.blob).toBeInstanceOf(Blob)
    expect(restoredDoc?.blob?.size).toBe(fileBlob.size)
    const docBytes = new Uint8Array(await restoredDoc!.blob!.arrayBuffer())
    expect(docBytes).toEqual(rawFileBytes)

    const restoredTxt = restored[2]
    expect(restoredTxt?.type).toBe('shortText')
    expect(restoredTxt?.value).toBe('Confidential Report')
  })

  it('preserves individually locked blocks without leaking in-memory revealed content', async () => {
    const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    const iv = new Uint8Array(12).fill(7)
    const salt = new Uint8Array(16).fill(9)

    const lockedBlock: FileBlock = {
      id: 'b-locked',
      type: 'locked',
      label: 'API Key',
      isLocked: true,
      lockedData: {
        ciphertext,
        iv,
        salt,
        innerType: 'shortText',
      },
      // In-memory revealed content that should NOT be serialized
      content: 'super-secret-api-key-12345',
      value: 'super-secret-api-key-12345',
      isUnlocked: true,
    }

    const json = await serializeDossierBlocks([lockedBlock])
    // The revealed plaintext MUST NOT appear in the serialized JSON
    expect(json).not.toContain('super-secret-api-key-12345')

    const restored = deserializeDossierBlocks(json)
    expect(restored).toHaveLength(1)

    const restoredBlock = restored[0]!
    expect(restoredBlock.id).toBe('b-locked')
    expect(restoredBlock.isLocked).toBe(true)
    expect(isProtectedBlock(restoredBlock)).toBe(true)
    expect(restoredBlock.content).toBeFalsy()
    expect(restoredBlock.isUnlocked).toBeFalsy()

    const tuple = lockedTupleOf(restoredBlock)
    expect(tuple).not.toBeNull()
    expect(tuple?.ciphertext).toEqual(ciphertext)
    expect(tuple?.iv).toEqual(iv)
    expect(tuple?.salt).toEqual(salt)
  })
})


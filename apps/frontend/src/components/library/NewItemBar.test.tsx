/** @vitest-environment jsdom */
/**
 * Offline creation tests for the library's new-item bar (PLAN.md §6.1, §6.2, §6.4).
 *
 * These run against the REAL library database: `fake-indexeddb` stands in for
 * IndexedDB, the bar writes through `libraryStore.saveItem`, and the assertions read
 * the stored rows back out of `lib/library.ts` rather than trusting the bar's own
 * state. That is the only way to pin the thing this bar exists for — an item created
 * with nothing connected is still there afterwards.
 *
 * Because `lib/library.ts` refuses an item whose folder does not exist
 * (`requireFolder`), every test creates the folder it targets first. That is also
 * what makes "it landed in the folder currently open, not at root" a real assertion.
 *
 * The locked case is the one with a security contract to hold: only the
 * `{ ciphertext, iv, salt }` tuple may reach the database (PLAN.md §6.2, §19.3), the
 * plaintext must be provably absent from the stored row, the tuple must still decrypt
 * with the typed password, and D6's cap must refuse oversized content.
 */
import 'fake-indexeddb/auto'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NewItemBar } from './NewItemBar'
import type { NewItemBarProps } from './NewItemBar'
import {
  closeLibraryDatabase,
  getItemsInFolder,
  saveFolder,
  ROOT_FOLDER_ID,
} from '../../lib/library'
import type {
  LibraryFileItem,
  LibraryImageItem,
  LibraryItem,
  LibraryLockedItem,
  LibraryRichTextItem,
  LibraryTextItem,
} from '../../lib/library'
import { decryptItem } from '../../lib/crypto'
import { parseRichTextContent } from '../session/items/RichTextItem'
import { useLibraryStore } from '../../store/libraryStore'

const DB_NAME = 'qrbit-library'

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter =
    input instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(input, value)

  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * Lets a promise chain started by an event handler settle inside `act`.
 *
 * The file pickers read the `File` asynchronously (`File.arrayBuffer()`), so the state
 * update that opens the name step lands after the change event returns — and in jsdom
 * that read is a task, not a microtask, hence the real `setTimeout` ticks.
 */
async function flush(ticks = 3): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < ticks; tick += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
    }
  })
}

/**
 * Waits for an asynchronous effect of a click — a `File` read, PBKDF2 at 600k
 * iterations (PLAN.md §19 decision 9), an IndexedDB write — without pinning the test to
 * a duration. Fails the test rather than hanging it.
 */
async function waitFor(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    if (await done()) return
    if (Date.now() > deadline) throw new Error(`test bug: timed out waiting for ${what}`)
    await flush(1)
  }
}

/** Waits until one §6.1 row is actually in IndexedDB in `folderId`. */
async function waitForItem(folderId: string, name: string): Promise<void> {
  await waitFor(`"${name}" in "${folderId}"`, async () => {
    const rows = await getItemsInFolder(folderId)
    return rows.some((row) => row.name === name)
  })
}

async function pick(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

async function submitForm(element: HTMLElement): Promise<void> {
  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush()
}

function bySelector<T extends HTMLElement>(element: HTMLElement, selector: string): T {
  const node = element.querySelector<T>(selector)
  if (node === null) throw new Error(`test bug: nothing matches ${selector}`)
  return node
}

function buttonByAriaLabel(element: HTMLElement, label: string): HTMLButtonElement {
  return bySelector<HTMLButtonElement>(element, `button[aria-label="${label}"]`)
}

/** The Cancel of whichever modal is open — those buttons are labelled by their text. */
function buttonNamed(element: HTMLElement, text: string): HTMLButtonElement {
  for (const candidate of element.querySelectorAll<HTMLButtonElement>('button')) {
    if (candidate.textContent?.trim() === text) return candidate
  }
  throw new Error(`test bug: no button reading "${text}"`)
}

function inputNamed(element: HTMLElement, label: string): HTMLInputElement {
  return bySelector<HTMLInputElement>(element, `input[aria-label="${label}"]`)
}

function textAreaNamed(element: HTMLElement, label: string): HTMLTextAreaElement {
  return bySelector<HTMLTextAreaElement>(element, `textarea[aria-label="${label}"]`)
}

function hiddenPicker(element: HTMLElement, selector: string): HTMLInputElement {
  return bySelector<HTMLInputElement>(element, selector)
}

function editorOf(element: HTMLElement): Editor {
  const dom = element.querySelector('.ProseMirror')
  const editor = (dom as (HTMLElement & { editor?: Editor }) | null)?.editor
  if (!(editor instanceof Editor)) throw new Error('test bug: Tiptap did not mount an editor')
  return editor
}

async function freshDatabase(): Promise<void> {
  await closeLibraryDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked by open connection'))
  })
}

/**
 * Creates a folder with a known id.
 *
 * `saveFolder` is the library layer's own id-preserving write (PLAN.md §14 uses it for
 * import), so the bar's target folder exists and `requireFolder` cannot be the reason a
 * save fails. `getItemsInFolder` then reads exactly what the bar wrote there.
 */
async function ensureFolder(id: string, name: string, parentId: string | null = null): Promise<void> {
  await saveFolder({
    id,
    name,
    parentId,
    createdAt: Date.parse('2024-01-01T00:00:00Z'),
    updatedAt: Date.parse('2024-01-01T00:00:00Z'),
  })
}

function renderBar(props: Partial<NewItemBarProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const root: Root = createRoot(element)

  const fullProps: NewItemBarProps = {
    currentFolderId: null,
    currentFolderName: 'Root',
    ...props,
  }

  act(() => {
    root.render(<NewItemBar {...fullProps} />)
  })

  const harness: Harness = {
    element,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      element.remove()
    },
  }

  openHarnesses.push(harness)
  return harness
}

describe('NewItemBar', () => {
  beforeEach(async () => {
    ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
    document.body.innerHTML = ''
    useLibraryStore.setState({
      folders: [],
      items: [],
      loading: false,
      error: null,
    })
    await freshDatabase()
  })

  afterEach(async () => {
    for (const harness of openHarnesses) {
      harness.unmount()
    }
    openHarnesses.length = 0
    await closeLibraryDatabase()
    ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  })

  it('mirrors AddItemBar buttons and iconography, and says it saves rather than sends', () => {
    const { element } = renderBar()

    expect(buttonByAriaLabel(element, 'Add text item').textContent?.trim()).toBe('T')
    expect(buttonByAriaLabel(element, 'Add rich text item').textContent?.trim()).toBe('¶')
    expect(buttonByAriaLabel(element, 'Add images').textContent?.trim()).toBe('🖼')
    expect(buttonByAriaLabel(element, 'Add files').textContent?.trim()).toBe('📎')
    expect(buttonByAriaLabel(element, 'Add locked item').textContent?.trim()).toBe('🔒')

    const hints = [...element.querySelectorAll('.add-item-bar__hint')].map(
      (hint) => hint.textContent ?? '',
    )
    // The difference from the in-session bar has to be readable, not inferred.
    expect(hints[0]).toContain('Saved items are stored in your library on this device')
    expect(hints[0]).toContain('nothing is sent')
    // PLAN.md §6.2 / §19.3: the no-recovery caveat is a line of the UI, not a comment.
    expect(hints.join(' ')).toContain('no recovery')
    expect(element.textContent).not.toContain('Send')
  })

  it('creating a text item writes a LibraryTextItem that survives a reload from IDB', async () => {
    await ensureFolder('folder-1', 'MyFolder')
    const { element } = renderBar({ currentFolderId: 'folder-1', currentFolderName: 'MyFolder' })

    click(buttonByAriaLabel(element, 'Add text item'))

    typeInto(inputNamed(element, 'Name'), 'Offline Notes')
    typeInto(inputNamed(element, 'Text item'), 'Testing text note persistence')

    await submitForm(element)
    await waitForItem('folder-1', 'Offline Notes')

    // Reload the store from IDB to prove persistence, not local state.
    await useLibraryStore.getState().refresh()
    const stored = useLibraryStore
      .getState()
      .items.find((item) => item.name === 'Offline Notes') as LibraryTextItem | undefined

    expect(stored).toBeDefined()
    expect(stored?.type).toBe('text')
    expect(stored?.name).toBe('Offline Notes')
    expect(stored?.content).toBe('Testing text note persistence')
    expect(stored?.folderId).toBe('folder-1')
    expect(typeof stored?.createdAt).toBe('number')
    expect(typeof stored?.updatedAt).toBe('number')

    // And read it straight from IndexedDB, past the store, on a second connection.
    await closeLibraryDatabase()
    const directItems = await getItemsInFolder('folder-1')
    expect(directItems.map((item) => item.name)).toEqual(['Offline Notes'])
    expect((directItems[0] as LibraryTextItem).content).toBe('Testing text note persistence')
  })

  it('richtext round-trips to the same Tiptap JSON shape the session renderer expects', async () => {
    await ensureFolder('folder-rt', 'RichFolder')
    const { element } = renderBar({ currentFolderId: 'folder-rt', currentFolderName: 'RichFolder' })

    click(buttonByAriaLabel(element, 'Add rich text item'))

    typeInto(inputNamed(element, 'Name'), 'Rich Doc')

    const editor = editorOf(element)
    act(() => {
      editor.commands.insertContent('Rich text body content')
    })

    await submitForm(element)
    await waitForItem('folder-rt', 'Rich Doc')

    await useLibraryStore.getState().refresh()
    const stored = useLibraryStore
      .getState()
      .items.find((item) => item.name === 'Rich Doc') as LibraryRichTextItem | undefined

    expect(stored).toBeDefined()
    expect(stored?.type).toBe('richtext')
    // §6.1: `content` is the Tiptap JSON STRING, so an imported item and a locally
    // authored one preview identically.
    expect(typeof stored?.content).toBe('string')

    const parsed = parseRichTextContent(stored?.content ?? '')
    expect(parsed).toBeDefined()
    expect(parsed?.type).toBe('doc')
    expect(stored?.content).toContain('Rich text body content')
  })

  it('an image and a file store a Blob with correct mimeType and size, and the name defaults to the filename', async () => {
    await ensureFolder('folder-media', 'Media')

    /*
     * The save seam records the §6.1 row and still writes it, so one test pins both
     * halves. Checking the BYTES on the object handed to `libraryStore.saveItem` is
     * deliberate: jsdom's `Blob` is not structured-cloneable by `fake-indexeddb`, so a
     * blob read back in THIS environment always comes up empty (the layer notices and
     * flags the row `corrupt`) while a real browser stores the bytes. Byte-exact Blob
     * persistence through IndexedDB is pinned where the platform clone works, in
     * `lib/library.test.ts`'s node-environment "bytes and blobs through IndexedDB".
     */
    const written: LibraryItem[] = []
    const { element } = renderBar({
      currentFolderId: 'folder-media',
      onSaveItem: async (item: LibraryItem): Promise<void> => {
        written.push(item)
        await useLibraryStore.getState().saveItem(item)
      },
    })

    const imageInput = hiddenPicker(element, '.add-item-bar__image-input')
    const imageFile = new File(['fake-png-bytes-1234'], 'snapshot.png', { type: 'image/png' })
    await pick(imageInput, [imageFile])

    // The name step opens once the File has been read ("default the item name to the
    // filename, editable before save").
    await waitFor('the image name step', () => element.querySelector('input[aria-label="Name"]') !== null)
    const imageNameInput = inputNamed(element, 'Name')
    expect(imageNameInput.value).toBe('snapshot.png')
    typeInto(imageNameInput, 'Edited Snapshot Name.png')
    await submitForm(element)
    await waitForItem('folder-media', 'Edited Snapshot Name.png')

    const fileInput = hiddenPicker(element, '.add-item-bar__file-input')
    const docFile = new File(['doc-binary-content-5678'], 'spec.pdf', { type: 'application/pdf' })
    await pick(fileInput, [docFile])

    await waitFor('the file name step', () => element.querySelector('input[aria-label="Name"]') !== null)
    expect(inputNamed(element, 'Name').value).toBe('spec.pdf')
    await submitForm(element)
    await waitForItem('folder-media', 'spec.pdf')

    // 1. What the bar built: a real Blob carrying the picked bytes.
    const imageDraft = written[0] as LibraryImageItem
    const fileDraft = written[1] as LibraryFileItem

    expect(imageDraft.type).toBe('image')
    expect(imageDraft.blob).toBeInstanceOf(Blob)
    expect(imageDraft.mimeType).toBe('image/png')
    expect(imageDraft.size).toBe(imageFile.size)
    expect(imageDraft.blob.size).toBe(imageFile.size)
    expect(await imageDraft.blob.text()).toBe('fake-png-bytes-1234')

    expect(fileDraft.type).toBe('file')
    expect(fileDraft.mimeType).toBe('application/pdf')
    expect(fileDraft.size).toBe(docFile.size)
    expect(await fileDraft.blob.text()).toBe('doc-binary-content-5678')

    // 2. What actually reached IndexedDB in the folder the bar was pointed at.
    await closeLibraryDatabase()
    const stored = await getItemsInFolder('folder-media')
    const imageItem = stored.find((item) => item.name === 'Edited Snapshot Name.png') as
      | LibraryImageItem
      | undefined
    const fileItem = stored.find((item) => item.name === 'spec.pdf') as LibraryFileItem | undefined

    expect(imageItem).toBeDefined()
    expect(imageItem?.type).toBe('image')
    expect(imageItem?.mimeType).toBe('image/png')
    expect(imageItem?.size).toBe(imageFile.size)
    expect(imageItem?.blob).toBeInstanceOf(Blob)

    expect(fileItem).toBeDefined()
    expect(fileItem?.type).toBe('file')
    expect(fileItem?.mimeType).toBe('application/pdf')
    expect(fileItem?.size).toBe(docFile.size)
    expect('blob' in (fileItem ?? ({} as object))).toBe(true)
  })

  it('the locked path stores ONLY the ciphertext tuple, and the tuple still decrypts', async () => {
    await ensureFolder('folder-locked', 'Secrets')
    const { element } = renderBar({ currentFolderId: 'folder-locked' })

    click(buttonByAriaLabel(element, 'Add locked item'))

    const SECRET_TEXT = 'extremely-sensitive-credential-9988'
    const PASSWORD = 'correct-horse-battery-staple'

    typeInto(inputNamed(element, 'Label'), 'Server Credentials')
    // D7: the password is typed twice, and the compose step states there is no recovery.
    expect(element.textContent).toContain('no recovery')
    typeInto(inputNamed(element, 'Password'), PASSWORD)
    typeInto(inputNamed(element, 'Confirm password'), PASSWORD)
    typeInto(textAreaNamed(element, 'Secret text'), SECRET_TEXT)

    await submitForm(element)

    // Encryption is PBKDF2 at 600k iterations, so the write is genuinely async.
    await waitForItem('folder-locked', 'Server Credentials')

    await closeLibraryDatabase()
    const items = await getItemsInFolder('folder-locked')
    const stored = items.find((item) => item.name === 'Server Credentials') as
      | LibraryLockedItem
      | undefined

    expect(stored).toBeDefined()
    if (stored === undefined) return
    expect(stored.type).toBe('locked')
    expect(stored.label).toBe('Server Credentials')
    expect(stored.innerType).toBe('text')
    expect(stored.ciphertext).toBeInstanceOf(Uint8Array)
    expect(stored.iv).toBeInstanceOf(Uint8Array)
    expect(stored.iv.byteLength).toBe(12)
    expect(stored.salt).toBeInstanceOf(Uint8Array)
    expect(stored.salt.byteLength).toBe(16)

    // The plaintext is provably absent from the stored row (§6.2, §19.3).
    expect(JSON.stringify(stored)).not.toContain(SECRET_TEXT)
    expect(Object.keys(stored).sort()).toEqual(
      ['ciphertext', 'createdAt', 'folderId', 'id', 'innerType', 'iv', 'label', 'name', 'salt', 'type', 'updatedAt'],
    )
    const secretBytes = new TextEncoder().encode(SECRET_TEXT)
    expect(Array.from(stored.ciphertext.slice(0, secretBytes.byteLength))).not.toEqual(
      Array.from(secretBytes),
    )

    const decrypted = await decryptItem(PASSWORD, stored.salt, stored.iv, stored.ciphertext)
    expect(new TextDecoder().decode(decrypted)).toBe(SECRET_TEXT)
  })

  it('honours D6: content over the locked cap is refused and nothing is stored', async () => {
    await ensureFolder('folder-d6', 'Capped')
    const { element } = renderBar({ currentFolderId: 'folder-d6', maxLockedFileBytes: 64 })

    click(buttonByAriaLabel(element, 'Add locked item'))

    typeInto(inputNamed(element, 'Label'), 'Too big')
    typeInto(inputNamed(element, 'Password'), 'horse')
    typeInto(inputNamed(element, 'Confirm password'), 'horse')
    typeInto(textAreaNamed(element, 'Secret text'), 'x'.repeat(65))

    await submitForm(element)

    expect(element.querySelector('.locked-compose__error')?.textContent).toContain('too large')
    await closeLibraryDatabase()
    expect(await getItemsInFolder('folder-d6')).toHaveLength(0)
  })

  it('a cancelled compose writes nothing', async () => {
    await ensureFolder('folder-cancel', 'Cancel')
    const { element } = renderBar({ currentFolderId: 'folder-cancel' })

    // Text: cancel out of the modal after typing.
    click(buttonByAriaLabel(element, 'Add text item'))
    typeInto(inputNamed(element, 'Name'), 'Will be cancelled')
    click(buttonNamed(element, 'Cancel'))
    await flush()

    // Locked: the same, through the reused session modal.
    click(buttonByAriaLabel(element, 'Add locked item'))
    typeInto(inputNamed(element, 'Label'), 'Will not be stored')
    typeInto(inputNamed(element, 'Password'), 'unwritten')
    typeInto(inputNamed(element, 'Confirm password'), 'unwritten')
    typeInto(textAreaNamed(element, 'Secret text'), 'never saved')
    click(buttonNamed(element, 'Cancel'))
    await flush()

    expect(element.querySelector('.locked-compose')).toBe(null)

    // Image: picking the file only opens the name step, so cancelling there must not
    // write the row the read already prepared.
    await pick(hiddenPicker(element, '.add-item-bar__image-input'), [
      new File(['bytes-never-kept'], 'ghost.png', { type: 'image/png' }),
    ])
    expect(element.querySelector('input[aria-label="Name"]')).not.toBe(null)
    click(buttonNamed(element, 'Cancel'))
    await flush()

    await closeLibraryDatabase()
    expect(await getItemsInFolder('folder-cancel')).toHaveLength(0)
    expect(useLibraryStore.getState().error).toBe(null)
    // Every modal is gone, so the bar is usable again.
    expect(element.querySelector('form')).toBe(null)
  })

  it('items land in the folder currently open, not at root', async () => {
    await ensureFolder('deep-subfolder-123', 'Deep', 'folder-1')
    await ensureFolder('folder-1', 'Shallow')
    const { element } = renderBar({ currentFolderId: 'deep-subfolder-123' })

    click(buttonByAriaLabel(element, 'Add text item'))
    typeInto(inputNamed(element, 'Name'), 'Scoped Item')
    typeInto(inputNamed(element, 'Text item'), 'Scoped Content')
    await submitForm(element)
    await waitForItem('deep-subfolder-123', 'Scoped Item')

    await closeLibraryDatabase()
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(0)

    const folderItems = await getItemsInFolder('deep-subfolder-123')
    expect(folderItems).toHaveLength(1)
    expect(folderItems[0]?.folderId).toBe('deep-subfolder-123')
    // The parent folder is untouched either: "currently open" is the deepest selection.
    expect(await getItemsInFolder('folder-1')).toHaveLength(0)
  })

  it('reports a save failure instead of pretending the item exists', async () => {
    // No `ensureFolder`: the library layer refuses an item whose folder has no row.
    const saveItem = vi
      .spyOn(useLibraryStore.getState(), 'saveItem')
      .mockRejectedValue(new Error('Quota exceeded'))
    const { element } = renderBar({ currentFolderId: 'missing-folder' })

    click(buttonByAriaLabel(element, 'Add text item'))
    typeInto(inputNamed(element, 'Name'), 'Doomed note')
    await submitForm(element)

    expect(saveItem).toHaveBeenCalledTimes(1)
    expect(element.textContent).toContain('Quota exceeded')
    saveItem.mockRestore()
  })
})

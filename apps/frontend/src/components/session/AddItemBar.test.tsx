/** @vitest-environment jsdom */
/**
 * AddItemBar tests (PLAN.md §9 — "Add item bar (sender only)", §16 Phases 3, 4 and 5).
 *
 * The bar is a thin adapter: each control calls one items-API method and nothing
 * else, so these tests use a stand-in for the API (plain mock functions) and assert
 * the calls. The stand-in is the same shape `useSession` implements, which keeps the
 * test honest about the contract without needing a session.
 *
 * Scope rules are pinned here too, because "not built yet" is easy to regress in the
 * other direction: the "Add locked item" control must open the Phase 4 compose modal (and
 * call `addLockedItem`, never the other add methods directly), and "Send from library" must
 * open the Phase 5 library sheet, whose taps go to `sendLibraryItem` — the compose modal and
 * the other add methods stay untouched by it.
 *
 * The sheet is the one part of this component that reads the library store, so the
 * Phase 5 tests seed a real (fake-indexeddb) library and let the sheet load it. That is
 * the actual boundary: the bar asks the store for folders and items and hands items
 * back to the session; it never touches the IndexedDB layer itself.
 */

import 'fake-indexeddb/auto'

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AddItemBar } from './AddItemBar'
import type { AddItemBarProps } from './AddItemBar'
import type { LockedItemInput } from './LockedItemComposeModal'
import { closeLibraryDatabase, createFolder, saveItem } from '../../lib/library'
import type { LibraryItem } from '../../lib/library'
import { useLibraryStore } from '../../store/libraryStore'

const DB_NAME = 'qrbit-library'

function makeApi(): AddItemBarProps['api'] {
  return {
    addTextItem: vi.fn((): string => 'text-id'),
    addRichTextItem: vi.fn((): string => 'rich-id'),
    addFileItem: vi.fn((): string => 'file-id'),
    addLockedItem: vi.fn(async (_input: LockedItemInput): Promise<string> => 'locked-id'),
    sendLibraryItem: vi.fn(),
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderBar(api: AddItemBarProps['api'], maxLockedFileBytes?: number): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(createElement(AddItemBar, { api, maxLockedFileBytes }))
  })

  container = element
  root = created
  return element
}

function button(element: HTMLElement, label: string): HTMLButtonElement {
  for (const candidate of element.querySelectorAll('button')) {
    if (candidate.getAttribute('aria-label') === label) return candidate
  }
  throw new Error(`test bug: no button labelled ${label}`)
}

function input(element: HTMLElement, selector: string): HTMLInputElement {
  const node = element.querySelector(selector)
  if (!(node instanceof HTMLInputElement)) throw new Error(`test bug: no input matching ${selector}`)
  return node
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** jsdom has no real file picker, so the selection is injected as a FileList-shaped value. */
function pick(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/**
 * Types into a controlled React field.
 *
 * The value goes in through the prototype's setter because React keeps its own
 * `value` tracker on the element: assigning `value` directly updates that tracker,
 * and React then treats the resulting event as a no-op.
 */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(field, value)

  act(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function field(element: HTMLElement, selector: string): HTMLInputElement {
  const node = element.querySelector(selector)
  if (!(node instanceof HTMLInputElement)) throw new Error(`test bug: nothing matching ${selector}`)
  return node
}

beforeEach(async () => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
  useLibraryStore.setState({ folders: [], items: [], loading: false, error: null })
  await freshLibraryDatabase()
})

/**
 * An empty library per test.
 *
 * The library layer caches its connection, and a `deleteDatabase` cannot proceed while
 * one is open, so the cache is closed first (the same isolation `lib/library.test.ts`
 * uses).
 */
async function freshLibraryDatabase(): Promise<void> {
  await closeLibraryDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'))
  })
}

/** Puts one text item in the library the sheet will read, and loads the store. */
async function seedLibrary(name: string, folderId: string): Promise<LibraryItem> {
  const now = Date.now()
  const item: LibraryItem = {
    id: globalThis.crypto.randomUUID(),
    folderId,
    name,
    type: 'text',
    createdAt: now,
    updatedAt: now,
    content: `content of ${name}`,
  }
  await saveItem(item)
  await useLibraryStore.getState().refresh()
  return item
}

/**
 * Puts one locked item in the library, for the rows that have to say "Locked" in words.
 *
 * The byte widths are `lib/library.ts`'s (§6.1: a 12-byte IV, a 16-byte salt) and the payload
 * is opaque here — the sheet never decrypts, it only lists, so these bytes are never read.
 */
async function seedLockedLibrary(name: string, folderId: string): Promise<LibraryItem> {
  const now = Date.now()
  const item: LibraryItem = {
    id: globalThis.crypto.randomUUID(),
    folderId,
    name,
    type: 'locked',
    createdAt: now,
    updatedAt: now,
    label: name,
    innerType: 'text',
    ciphertext: new Uint8Array(32),
    iv: new Uint8Array(12),
    salt: new Uint8Array(16),
  }
  await saveItem(item)
  await useLibraryStore.getState().refresh()
  return item
}

/**
 * The characters `lib/itemType.ts` used to hand back as type marks — pilcrow, pencil,
 * framed picture, paperclip, lock — as escapes, so this file does not contain the glyphs it
 * forbids. A row's type is a drawn glyph plus a word now; any of these in a rendered sheet
 * means the icon system went back to being a Unicode stand-in.
 */
const RETIRED_GLYPHS = ['\u00B6', '\u270E', '\u{1F5BC}', '\u{1F4CE}', '\u{1F512}']

/** The sheet's row for one item name, keyed by the button the tap goes through. */
function sheetRow(element: HTMLElement, name: string): HTMLElement {
  for (const row of element.querySelectorAll<HTMLElement>('.library-modal__item')) {
    if (row.querySelector('.library-send__item')?.textContent === name) return row
  }
  throw new Error(`test bug: no sheet row for ${name}`)
}

/** What one sheet row says about its item's type: the word, and the glyph beside it. */
function sheetRowMark(element: HTMLElement, name: string): { word: string; glyph: string } {
  const mark = sheetRow(element, name).querySelector<HTMLElement>('.library-item__icon')
  if (mark === null) throw new Error(`test bug: no type mark on the row for ${name}`)

  return { word: mark.textContent ?? '', glyph: mark.querySelector('svg')?.getAttribute('aria-hidden') ?? 'missing' }
}

/** The sheet's refresh runs on mount; this lets its promise land. */
/** The sheet's refresh runs on mount; this lets its promise land. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/**
 * Polls until the sheet has listed `count` items.
 *
 * The sheet's own refresh is a chain of fake-indexeddb round trips and it shows a loading
 * line while they are in flight; how many ticks that takes depends on the machine, so the
 * tests wait for the rows instead of counting ticks.
 */
async function waitForRows(element: HTMLElement, count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (element.querySelectorAll('.library-send__item').length === count) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
  }
  throw new Error(`timed out waiting for ${count} library rows`)
}

afterEach(async () => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  await closeLibraryDatabase()
})

describe('AddItemBar — text and rich text (PLAN.md §9)', () => {
  it('adds an empty text item from the "Add text item" control', () => {
    const api = makeApi()
    const element = renderBar(api)

    click(button(element, 'Add text item'))

    expect(api.addTextItem).toHaveBeenCalledTimes(1)
    expect(api.addTextItem).toHaveBeenCalledWith()
    expect(api.addRichTextItem).not.toHaveBeenCalled()
    expect(api.addFileItem).not.toHaveBeenCalled()
  })

  it('adds an empty rich-text item from the "Add rich text item" control', () => {
    const api = makeApi()
    const element = renderBar(api)

    click(button(element, 'Add rich text item'))

    expect(api.addRichTextItem).toHaveBeenCalledTimes(1)
    expect(api.addTextItem).not.toHaveBeenCalled()
  })
})

describe('AddItemBar — images and files (PLAN.md §9, §16 Phase 3)', () => {
  it('opens the image picker rather than sending anything itself', () => {
    const api = makeApi()
    const element = renderBar(api)
    const imageInput = input(element, '.add-item-bar__image-input')
    const clicked = vi.spyOn(imageInput, 'click')

    click(button(element, 'Add images'))

    expect(clicked).toHaveBeenCalledTimes(1)
    expect(api.addFileItem).not.toHaveBeenCalled()
  })

  it('offers multi-select image choosing, and one item per selected file', () => {
    const api = makeApi()
    const element = renderBar(api)
    const imageInput = input(element, '.add-item-bar__image-input')

    expect(imageInput.accept).toBe('image/*')
    expect(imageInput.multiple).toBe(true)

    const files = [
      new File(['a'], 'one.png', { type: 'image/png' }),
      new File(['b'], 'two.png', { type: 'image/png' }),
      new File(['c'], 'three.jpg', { type: 'image/jpeg' }),
    ]
    pick(imageInput, files)

    expect(api.addFileItem).toHaveBeenCalledTimes(3)
    expect(api.addFileItem).toHaveBeenNthCalledWith(1, files[0])
    expect(api.addFileItem).toHaveBeenNthCalledWith(3, files[2])
  })

  it('sends every file chosen through "Add files" as its own item', () => {
    const api = makeApi()
    const element = renderBar(api)
    const fileInput = input(element, '.add-item-bar__file-input')

    expect(fileInput.multiple).toBe(true)

    const files = [new File(['a'], 'notes.txt'), new File(['b'], 'archive.zip')]
    pick(fileInput, files)

    expect(api.addFileItem).toHaveBeenCalledTimes(2)
    expect(api.addFileItem).toHaveBeenNthCalledWith(2, files[1])
  })

  it('ignores an empty selection', () => {
    const api = makeApi()
    const element = renderBar(api)

    pick(input(element, '.add-item-bar__file-input'), [])

    expect(api.addFileItem).not.toHaveBeenCalled()
  })
})

describe('AddItemBar — locked items (PLAN.md §16 Phase 4)', () => {
  it('opens the locked compose modal instead of sending anything itself', () => {
    const api = makeApi()
    const element = renderBar(api)
    const locked = button(element, 'Add locked item')

    expect(locked.disabled).toBe(false)
    expect(element.textContent).not.toContain('Phase 4')
    expect(element.querySelector('.locked-compose')).toBe(null)

    click(locked)

    expect(element.querySelector('.locked-compose')).not.toBe(null)
    expect(api.addTextItem).not.toHaveBeenCalled()
    expect(api.addRichTextItem).not.toHaveBeenCalled()
    expect(api.addFileItem).not.toHaveBeenCalled()
    expect(api.addLockedItem).not.toHaveBeenCalled()
  })

  it('forwards what the modal collected to addLockedItem, then closes it', async () => {
    const api = makeApi()
    const element = renderBar(api)

    click(button(element, 'Add locked item'))
    typeInto(field(element, '.locked-compose__label-input'), 'Uni portal password')
    typeInto(field(element, '.locked-compose__password'), 'hunter2')
    typeInto(field(element, '.locked-compose__confirm-password'), 'hunter2')

    const form = element.querySelector('form')
    if (form === null) throw new Error('test bug: no form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(api.addLockedItem).toHaveBeenCalledWith({
      label: 'Uni portal password',
      innerType: 'text',
      content: '',
      password: 'hunter2',
    })
    expect(element.querySelector('.locked-compose')).toBe(null)
  })

  it('closes the modal again when it is cancelled', () => {
    const element = renderBar(makeApi())

    click(button(element, 'Add locked item'))
    const cancel = element.querySelector('.locked-compose__cancel')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('test bug: no cancel button')
    click(cancel)

    expect(element.querySelector('.locked-compose')).toBe(null)
  })

  it('hands the caller’s D6 cap to the compose modal instead of its own default', () => {
    // The page passes `LOCKED_ITEM_MAX_PLAINTEXT_BYTES` from `lib/crypto.ts`; the bar
    // must forward whatever it is given, or the one owner of that number is bypassed.
    const element = renderBar(makeApi(), 1024)

    click(button(element, 'Add locked item'))
    click(field(element, '.locked-compose__type-radio[value="file"]'))
    pick(field(element, '.locked-compose__file'), [
      new File(['x'.repeat(2048)], 'two-kib.bin'),
    ])

    // Two KiB is well under the modal's own 3 MiB default, so this message can only
    // come from the forwarded cap.
    expect(element.querySelector('.locked-compose__error')?.textContent).toContain(
      'at most 1024 bytes',
    )
  })
})

describe('AddItemBar — the from-library sheet (PLAN.md §9, §16 Phase 5, D8)', () => {
  it('opens the Phase 5 library sheet from "Send from library"', async () => {
    const api = makeApi()
    await seedLibrary('Portal password', 'root')
    const element = renderBar(api)

    const library = button(element, 'Send from library')
    expect(library.disabled).toBe(false)
    expect(element.querySelector('.library-modal--send')).toBe(null)

    click(library)
    await settle()

    expect(element.querySelector('.library-modal--send')).not.toBe(null)
    expect(element.textContent).toContain('Send from library')
    await waitForRows(element, 1)
    // Opening the sheet sends nothing by itself.
    expect(api.sendLibraryItem).not.toHaveBeenCalled()
    expect(api.addTextItem).not.toHaveBeenCalled()
    expect(api.addFileItem).not.toHaveBeenCalled()
  })

  it('names each row’s type with a word beside a drawn glyph, never a Unicode mark', async () => {
    const api = makeApi()
    await seedLibrary('Loose note', 'root')
    await seedLockedLibrary('Portal password', 'root')
    const element = renderBar(api)

    click(button(element, 'Send from library'))
    await waitForRows(element, 2)

    // The two rows differ by a word a user reads and an AT hears, not by a pictograph.
    expect(sheetRowMark(element, 'Loose note')).toEqual({ word: 'Text', glyph: 'true' })
    expect(sheetRowMark(element, 'Portal password')).toEqual({ word: 'Locked', glyph: 'true' })

    const sheet = element.querySelector('.library-modal--send')?.textContent ?? ''
    for (const glyph of RETIRED_GLYPHS) {
      expect(sheet).not.toContain(glyph)
    }
  })

  it('lists the library’s items and sends one per tap, without closing', async () => {
    const api = makeApi()
    const first = await seedLibrary('Portal password', 'root')
    const second = await seedLibrary('Thesis draft', 'root')
    const element = renderBar(api)

    click(button(element, 'Send from library'))
    await settle()

    const rows = () => [...element.querySelectorAll<HTMLButtonElement>('.library-send__item')]
    await waitForRows(element, 2)
    expect(rows().map((row) => row.textContent)).toEqual(['Thesis draft', 'Portal password'])

    click(rows()[0] as HTMLButtonElement)
    expect(api.sendLibraryItem).toHaveBeenCalledTimes(1)
    expect(api.sendLibraryItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: second.id, name: 'Thesis draft' }),
    )

    // Multi-tap: the sheet stays open, the first row is marked, and the second item goes.
    expect(element.querySelector('.library-modal--send')).not.toBe(null)
    expect(element.textContent).toContain('Sent')

    click(rows()[1] as HTMLButtonElement)
    expect(api.sendLibraryItem).toHaveBeenCalledTimes(2)
    expect(api.sendLibraryItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: first.id, name: 'Portal password' }),
    )
  })

  it('navigates folders, and sends the item of the folder it is looking at', async () => {
    const api = makeApi()
    await seedLibrary('Loose note', 'root')
    const folder = await createFolder('Uni Stuff', null)
    const inFolder = await seedLibrary('Portal password', folder.id)
    const element = renderBar(api)

    click(button(element, 'Send from library'))
    await settle()

    // The root is what the sheet opens on.
    await waitForRows(element, 1)
    expect(element.textContent).toContain('Loose note')

    const folderOption = [...element.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (option) => option.textContent?.includes('Uni Stuff') === true,
    )
    if (!folderOption) throw new Error('test bug: no folder option for Uni Stuff')
    click(folderOption)

    const rows = [...element.querySelectorAll<HTMLButtonElement>('.library-send__item')]
    expect(rows.map((row) => row.textContent)).toEqual(['Portal password'])

    click(rows[0] as HTMLButtonElement)
    expect(api.sendLibraryItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: inFolder.id, folderId: folder.id }),
    )
  })

  it('closes the sheet from Done', async () => {
    await seedLibrary('Portal password', 'root')
    const element = renderBar(makeApi())

    click(button(element, 'Send from library'))
    await settle()

    const done = element.querySelector<HTMLButtonElement>('.library-modal__done')
    if (!done) throw new Error('test bug: no Done button')
    click(done)

    expect(element.querySelector('.library-modal--send')).toBe(null)
  })

  it('reports a failed send in the sheet instead of losing it', async () => {
    const api = makeApi()
    ;(api.sendLibraryItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('this locked item is larger than the 3 MiB a locked item may carry')
    })
    await seedLibrary('Portal password', 'root')
    const element = renderBar(api)

    click(button(element, 'Send from library'))
    await settle()
    await waitForRows(element, 1)
    click(element.querySelector<HTMLButtonElement>('.library-send__item') as HTMLButtonElement)

    expect(element.querySelector('.library-modal__error')?.textContent).toContain('3 MiB')
    // The failure is this row's, not the session's: the sheet stays usable.
    expect(element.querySelector('.library-modal--send')).not.toBe(null)
  })
})

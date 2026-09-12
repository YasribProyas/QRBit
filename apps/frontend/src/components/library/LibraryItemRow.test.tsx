/** @vitest-environment jsdom */
/**
 * Library item row tests (PLAN.md §6.4, §16 Phase 5).
 *
 * The row is the whole item experience: the type icon and lock badge, the relative
 * timestamp, the `···` menu, the inline preview, and — for a locked item — the
 * password prompt and reveal.
 *
 * The unlock tests use the REAL PLAN.md §11.4 crypto: the fixture is encrypted with
 * `encryptItem` and opened through the row's `decryptItem` path, so the wrong-password
 * branch is a real GCM tag failure rather than a stubbed boolean. That makes the
 * ~300ms PBKDF2 part of the test on purpose: the spinner has to be up while it runs,
 * because a dead button is exactly what §19 decision 9 exists to avoid.
 *
 * jsdom's `crypto` has `getRandomValues` but no `subtle`, so the file installs Node's
 * Web Crypto — the same API the browser exposes — before the fixtures are built.
 */

import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { Editor } from '@tiptap/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { LibraryItemRow, LONG_PRESS_MS, formatRelativeTime } from './LibraryItemRow'
import type {
  LibraryFileItem,
  LibraryImageItem,
  LibraryItem,
  LibraryItemRowProps,
  LibraryLockedItem,
  LibraryRichTextItem,
  LibraryTextItem,
} from './LibraryItemRow'
import type { LibraryFolder } from './FolderNode'
import { encryptItem } from '../../lib/crypto'

const folders: LibraryFolder[] = [
  { id: 'f1', name: 'Uni Stuff', parentId: null, createdAt: 1, updatedAt: 1 },
  { id: 'f2', name: 'Work', parentId: null, createdAt: 1, updatedAt: 1 },
]

const BASE = { id: 'i1', folderId: 'f1', name: 'Note', createdAt: 1, updatedAt: 1 }

function textItem(overrides: Partial<LibraryTextItem> = {}): LibraryTextItem {
  return { ...BASE, type: 'text', content: 'hello', ...overrides }
}

function richTextItem(overrides: Partial<LibraryRichTextItem> = {}): LibraryRichTextItem {
  return { ...BASE, type: 'richtext', content: docWith('rich text body'), ...overrides }
}

function imageItem(overrides: Partial<LibraryImageItem> = {}): LibraryImageItem {
  return {
    ...BASE,
    type: 'image',
    name: 'holiday.png',
    blob: new Blob(['png-bytes'], { type: 'image/png' }),
    mimeType: 'image/png',
    size: 9,
    ...overrides,
  }
}

function fileItem(overrides: Partial<LibraryFileItem> = {}): LibraryFileItem {
  return {
    ...BASE,
    type: 'file',
    name: 'thesis.pdf',
    blob: new Blob(['pdf-bytes'], { type: 'application/pdf' }),
    mimeType: 'application/pdf',
    size: 9,
    ...overrides,
  }
}

let secretText!: { ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }
let secretFile!: { ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }
let secretRich!: { ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }

const LOCKED_PASSWORD = 'hunter2'

function lockedTextItem(overrides: Partial<LibraryLockedItem> = {}): LibraryLockedItem {
  return {
    ...BASE,
    type: 'locked',
    name: 'Portal password',
    label: 'Portal password',
    innerType: 'text',
    ciphertext: secretText.ciphertext,
    iv: secretText.iv,
    salt: secretText.salt,
    ...overrides,
  }
}

/** A minimal Tiptap document containing exactly `text`. */
function docWith(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
}

const callbacks = () => ({
  onToggleSelected: vi.fn(),
  onEnterSelectionMode: vi.fn(),
  onOpenMenu: vi.fn(),
  onRename: vi.fn(),
  onMove: vi.fn(),
  onDelete: vi.fn(),
  onSend: vi.fn(),
})

type Callbacks = ReturnType<typeof callbacks>

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function mount(render: () => ReactElement): Harness {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  act(() => {
    root.render(render())
  })

  const harness: Harness = {
    element: host,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      host.remove()
    },
  }

  openHarnesses.push(harness)
  return harness
}

function renderRow(
  item: LibraryItem,
  overrides: Partial<LibraryItemRowProps> = {},
): { harness: Harness; callbacks: Callbacks } {
  const spies = callbacks()
  const props: LibraryItemRowProps = {
    item,
    folders,
    selectionMode: false,
    selected: false,
    ...spies,
    ...overrides,
  }

  return {
    harness: mount(() => createElement('ul', null, createElement(LibraryItemRow, props))),
    callbacks: spies,
  }
}

function renderRows(items: LibraryItem[]): Harness {
  const spies = callbacks()
  return mount(() =>
    createElement(
      'ul',
      null,
      items.map((item) =>
        createElement(LibraryItemRow, {
          key: item.id,
          item,
          folders,
          selectionMode: false,
          selected: false,
          ...spies,
        }),
      ),
    ),
  )
}

function bySelector<T extends Element>(
  element: HTMLElement,
  selector: string,
  constructor: new () => T,
): T {
  const node = element.querySelector(selector)
  if (!(node instanceof constructor)) throw new Error(`test bug: nothing matching ${selector}`)
  return node
}

function button(element: HTMLElement, selector: string): HTMLButtonElement {
  return bySelector(element, selector, HTMLButtonElement)
}

function nameButton(element: HTMLElement): HTMLButtonElement {
  return button(element, '.library-item__name')
}

function checkbox(element: HTMLElement): HTMLInputElement {
  return bySelector(element, '.library-item__checkbox', HTMLInputElement)
}

function click(element: HTMLElement, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(field, value)

  act(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submitForm(element: HTMLElement): void {
  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function menuItem(element: HTMLElement, label: string): HTMLButtonElement {
  for (const item of element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
    if (item.textContent === label) return item
  }
  throw new Error(`test bug: no menu item labelled ${label}`)
}

function openMenu(element: HTMLElement): void {
  click(button(element, '.library-item__menu-toggle'))
}

/** The menu item is inside the row's menu panel; the panel is rebuilt after opening. */
function choose(element: HTMLElement, label: string): void {
  openMenu(element)
  click(menuItem(element, label))
}

function passwordInput(element: HTMLElement): HTMLInputElement {
  return bySelector(element, '.unlock-modal__password', HTMLInputElement)
}

/** Long enough for real PBKDF2 (PLAN.md §19 decision 9) and a few React flushes. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  throw new Error(`test bug: timed out waiting for ${what}`)
}

/** Taps the row (which opens the password prompt for a locked item) and submits `password`. */
function attemptUnlock(element: HTMLElement, password: string): void {
  click(nameButton(element))
  typeInto(passwordInput(element), password)
  submitForm(element)
}

function editorOf(element: HTMLElement): Editor {
  const dom = element.querySelector('.ProseMirror')
  const editor = (dom as (HTMLElement & { editor?: Editor }) | null)?.editor
  if (!(editor instanceof Editor)) throw new Error('test bug: Tiptap did not mount an editor')
  return editor
}

let urlCounter = 0
const createObjectURL = vi.fn((_source: Blob | MediaSource): string => {
  urlCounter += 1
  return `blob:qrdrop/${urlCounter}`
})
const revokeObjectURL = vi.fn()
const previousCreateObjectURL = URL.createObjectURL
const previousRevokeObjectURL = URL.revokeObjectURL

beforeAll(async () => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

  const encoder = new TextEncoder()
  secretText = await encryptItem(LOCKED_PASSWORD, encoder.encode('the portal password'))
  secretFile = await encryptItem(LOCKED_PASSWORD, encoder.encode('one time codes'))
  secretRich = await encryptItem(LOCKED_PASSWORD, encoder.encode(docWith('the secret document')))
})

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  urlCounter = 0
  vi.clearAllMocks()
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
})

afterEach(() => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }

  URL.createObjectURL = previousCreateObjectURL
  URL.revokeObjectURL = previousRevokeObjectURL
  document.body.innerHTML = ''
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('formatRelativeTime (PLAN.md §6.4)', () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0)

  it('switches units from seconds up to months without a locale', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d ago')
    expect(formatRelativeTime(now - 14 * 86_400_000, now)).toBe('2w ago')
    expect(formatRelativeTime(now - 90 * 86_400_000, now)).toBe('3mo ago')
  })

  it('reads a timestamp in the future as "just now" rather than a negative age', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now')
  })
})

describe('LibraryItemRow — identity', () => {
  it('renders the §6.4 type icon for every type, and the lock badge only for a locked item', () => {
    const { element } = renderRows([
      textItem(),
      richTextItem(),
      imageItem(),
      fileItem(),
      lockedTextItem(),
    ])

    const rows = [...element.querySelectorAll('.library-item')]
    expect(rows.map((row) => row.querySelector('.library-item__icon')?.textContent)).toEqual([
      '¶',
      '✎',
      '🖼',
      '📎',
      '🔒',
    ])
    expect(rows.filter((row) => row.querySelector('.library-item__lock-badge') !== null)).toHaveLength(1)
    expect(rows[4]?.querySelector('.library-item__lock-badge')?.textContent).toBe('Locked')
  })

  it('shows the name and how long ago it changed', () => {
    const { harness } = renderRow(
      textItem({ name: 'Thesis draft', updatedAt: Date.now() - 2 * 3_600_000 }),
    )

    expect(nameButton(harness.element).textContent).toBe('Thesis draft')
    expect(harness.element.querySelector('.library-item__updated')?.textContent).toBe('2h ago')
  })
})

describe('LibraryItemRow — the ··· menu (PLAN.md §6.4)', () => {
  it('opens the menu and tells the browser, which leaves multi-select', () => {
    const { harness, callbacks: spies } = renderRow(textItem())

    openMenu(harness.element)

    expect(harness.element.querySelector('.library-item__menu')).not.toBe(null)
    expect(spies.onOpenMenu).toHaveBeenCalledTimes(1)
  })

  it('renames inline through the menu', () => {
    const { harness, callbacks: spies } = renderRow(textItem())

    choose(harness.element, 'Rename')

    const input = bySelector(harness.element, '.library-item__rename-input', HTMLInputElement)
    expect(input.value).toBe('Note')

    typeInto(input, '  Portal password  ')
    submitForm(harness.element)

    expect(spies.onRename).toHaveBeenCalledWith('i1', 'Portal password')
    expect(harness.element.querySelector('.library-item__rename-input')).toBe(null)
  })

  it('moves into a picked folder, and to Root with null', () => {
    const { harness, callbacks: spies } = renderRow(textItem())

    choose(harness.element, 'Move')

    const options = [...harness.element.querySelectorAll<HTMLButtonElement>('.folder-picker__option')]
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      '📁 Root',
      '📁 Uni Stuff',
      '📁 Work',
    ])

    const uni = options[1]
    const root = options[0]
    if (uni === undefined || root === undefined) throw new Error('test bug: missing options')

    click(uni)
    expect(spies.onMove).toHaveBeenLastCalledWith('i1', 'f1')
    expect(harness.element.querySelector('.folder-picker')).toBe(null)

    choose(harness.element, 'Move')
    const reopened = [...harness.element.querySelectorAll<HTMLButtonElement>('.folder-picker__option')]
    const rootAgain = reopened[0]
    if (rootAgain === undefined) throw new Error('test bug: missing options')
    click(rootAgain)

    expect(spies.onMove).toHaveBeenLastCalledWith('i1', null)
  })

  it('marks Root as the current choice for an item that lives at the root', () => {
    // A root item's own `folderId` is the library layer's root sentinel ('root'), which
    // names no folder: the picker has to read it as Root or nothing is checked at all.
    const { harness } = renderRow(textItem({ folderId: 'root' }))

    choose(harness.element, 'Move')

    const options = [...harness.element.querySelectorAll<HTMLButtonElement>('.folder-picker__option')]
    const root = options[0]
    const uni = options[1]
    if (root === undefined || uni === undefined) throw new Error('test bug: missing options')

    expect(root.getAttribute('aria-checked')).toBe('true')
    expect(uni.getAttribute('aria-checked')).toBe('false')
  })

  it('sends and deletes from the menu', () => {
    const { harness, callbacks: spies } = renderRow(textItem())

    choose(harness.element, 'Send')
    expect(spies.onSend).toHaveBeenCalledWith('i1')

    choose(harness.element, 'Delete')
    expect(spies.onDelete).toHaveBeenCalledWith('i1')
  })
})

describe('LibraryItemRow — inline preview (PLAN.md §6.4)', () => {
  it('shows text on tap and folds it away on the next tap', () => {
    const { harness } = renderRow(textItem({ content: 'the portal password' }))

    expect(harness.element.querySelector('.library-item__text')).toBe(null)

    click(nameButton(harness.element))
    expect(harness.element.querySelector('.library-item__text')?.textContent).toBe(
      'the portal password',
    )

    click(nameButton(harness.element))
    expect(harness.element.querySelector('.library-item__text')).toBe(null)
  })

  it('says so when a note is empty instead of rendering a blank box', () => {
    const { harness } = renderRow(textItem({ content: '   ' }))

    click(nameButton(harness.element))

    expect(harness.element.querySelector('.library-item__placeholder')?.textContent).toBe(
      'This note is empty.',
    )
  })

  it('previews rich text in a read-only editor', () => {
    const { harness } = renderRow(richTextItem({ content: docWith('a rich note') }))

    click(nameButton(harness.element))

    expect(harness.element.textContent).toContain('a rich note')
    expect(editorOf(harness.element).isEditable).toBe(false)
  })

  it('previews an image through an object URL and revokes it on unmount', () => {
    const item = imageItem()
    const { harness } = renderRow(item)

    expect(createObjectURL).not.toHaveBeenCalled()

    click(nameButton(harness.element))

    const image = bySelector(harness.element, '.library-item__thumbnail', HTMLImageElement)
    expect(image.getAttribute('src')).toBe('blob:qrdrop/1')
    expect(image.getAttribute('alt')).toBe('holiday.png')
    expect(createObjectURL).toHaveBeenCalledWith(item.blob)

    harness.unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrdrop/1')
  })

  it('offers a file download through an object URL, revoked when the row folds', () => {
    const item = fileItem()
    const { harness } = renderRow(item)

    click(nameButton(harness.element))

    const link = bySelector(harness.element, '.library-item__download', HTMLAnchorElement)
    expect(link.getAttribute('href')).toBe('blob:qrdrop/1')
    expect(link.getAttribute('download')).toBe('thesis.pdf')

    click(nameButton(harness.element))

    expect(harness.element.querySelector('.library-item__download')).toBe(null)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrdrop/1')
  })
})

describe('LibraryItemRow — locked items (PLAN.md §6.4, §11.4, §17)', () => {
  it('offers no plaintext and asks for the password on tap', () => {
    const { harness } = renderRow(lockedTextItem())

    expect(harness.element.querySelector('.library-item__preview')).toBe(null)
    expect(harness.element.querySelector('input[type="password"]')).toBe(null)

    click(nameButton(harness.element))

    expect(passwordInput(harness.element)).not.toBe(null)
    expect(harness.element.querySelector('.unlock-modal__title')?.textContent).toContain(
      'Portal password',
    )
  })

  it('reveals the text with the right password, and re-hides it on "Lock again"', async () => {
    const { harness } = renderRow(lockedTextItem())

    click(nameButton(harness.element))
    typeInto(passwordInput(harness.element), LOCKED_PASSWORD)
    submitForm(harness.element)

    // The ~300ms PBKDF2 must be visible as work, not as a dead dialog.
    expect(harness.element.querySelector('.spinner')).not.toBe(null)

    await waitFor(
      () => harness.element.querySelector('.library-item__text') !== null,
      'the decrypted text',
    )

    expect(harness.element.querySelector('.library-item__text')?.textContent).toBe(
      'the portal password',
    )
    // The prompt is gone: the item is open.
    expect(harness.element.querySelector('input[type="password"]')).toBe(null)

    click(button(harness.element, '.library-item__lock-again'))

    expect(harness.element.querySelector('.library-item__text')).toBe(null)
    expect(harness.element.querySelector('.library-item__lock-again')).toBe(null)
    expect(harness.element.querySelector('.library-item__lock-badge')).not.toBe(null)
  })

  it('reports a wrong password, clears the field and stays locked', async () => {
    const { harness } = renderRow(lockedTextItem())

    attemptUnlock(harness.element, 'not the password')

    await waitFor(
      () => harness.element.querySelector('.unlock-modal__error') !== null,
      'the wrong-password error',
    )

    const error = harness.element.querySelector('.unlock-modal__error')
    expect(error?.getAttribute('data-error-kind')).toBe('wrong-password')
    expect(error?.textContent).toBe('That password is not correct.')
    expect(passwordInput(harness.element).value).toBe('')
    expect(harness.element.querySelector('.library-item__text')).toBe(null)
  })

  it('reveals an unlocked file as a download named after the item, revoked on re-lock', async () => {
    const { harness } = renderRow(
      lockedTextItem({ name: 'Recovery codes', innerType: 'file', ...secretFile }),
    )

    attemptUnlock(harness.element, LOCKED_PASSWORD)

    await waitFor(
      () => harness.element.querySelector('.library-item__download') !== null,
      'the unlocked file',
    )

    const link = bySelector(harness.element, '.library-item__download', HTMLAnchorElement)
    expect(link.getAttribute('download')).toBe('Recovery codes')

    click(button(harness.element, '.library-item__lock-again'))

    expect(harness.element.querySelector('.library-item__download')).toBe(null)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrdrop/1')
  })

  it('renders an unlocked richtext payload read-only', async () => {
    const { harness } = renderRow(
      lockedTextItem({ name: 'Secret doc', innerType: 'richtext', ...secretRich }),
    )

    attemptUnlock(harness.element, LOCKED_PASSWORD)

    await waitFor(
      () => harness.element.querySelector('.ProseMirror') !== null,
      'the unlocked rich text',
    )

    expect(harness.element.textContent).toContain('the secret document')
    expect(editorOf(harness.element).isEditable).toBe(false)
  })
})

describe('LibraryItemRow — multi-select (PLAN.md §6.4)', () => {
  it('shows a checked checkbox in selection mode and toggles instead of previewing', () => {
    const { harness, callbacks: spies } = renderRow(textItem(), { selectionMode: true, selected: true })

    expect(checkbox(harness.element).checked).toBe(true)

    click(nameButton(harness.element))

    expect(spies.onToggleSelected).toHaveBeenCalledWith('i1')
    // A preview must not open while the row is being picked.
    expect(harness.element.querySelector('.library-item__text')).toBe(null)
  })

  it('enters selection mode on a long press, and swallows the click that ends it', () => {
    vi.useFakeTimers()
    try {
      const { harness, callbacks: spies } = renderRow(textItem())

      act(() => {
        harness.element
          .querySelector('.library-item__row')
          ?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      })
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS + 50)
      })

      expect(spies.onEnterSelectionMode).toHaveBeenCalledWith('i1')

      // The click the browser fires when the finger lifts must not toggle it back off.
      click(nameButton(harness.element), { shiftKey: false })
      expect(spies.onToggleSelected).not.toHaveBeenCalled()
      expect(spies.onEnterSelectionMode).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a short press as a tap, not as a selection gesture', () => {
    vi.useFakeTimers()
    try {
      const { harness, callbacks: spies } = renderRow(textItem({ content: 'note body' }))

      act(() => {
        harness.element
          .querySelector('.library-item__row')
          ?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      })
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS - 100)
      })
      act(() => {
        harness.element
          .querySelector('.library-item__row')
          ?.dispatchEvent(new Event('pointerup', { bubbles: true }))
      })
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS + 100)
      })

      expect(spies.onEnterSelectionMode).not.toHaveBeenCalled()

      click(nameButton(harness.element))

      expect(spies.onToggleSelected).not.toHaveBeenCalled()
      expect(harness.element.querySelector('.library-item__text')?.textContent).toBe('note body')
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts shift-click and right-click as the desktop route in', () => {
    const { harness, callbacks: spies } = renderRow(textItem())

    click(nameButton(harness.element), { shiftKey: true })
    expect(spies.onEnterSelectionMode).toHaveBeenCalledWith('i1')

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      harness.element.querySelector('.library-item__row')?.dispatchEvent(contextMenu)
    })

    expect(contextMenu.defaultPrevented).toBe(true)
    expect(spies.onEnterSelectionMode).toHaveBeenCalledTimes(2)
  })
})

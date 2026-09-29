/** @vitest-environment jsdom */
/**
 * Settings page tests (PLAN.md §14, §16 Phase 7; DESIGN.md's Settings contract).
 *
 * **What is pinned, and why these are the right things to pin.** The page's job is to route
 * four things correctly, and each test below asserts the *outcome* rather than the markup:
 *
 *   1. Export Library opens the §14 dialog and Cancel closes it — the dialog is a child of
 *      this page's state, not of the page's layout.
 *   2. A chosen file is checked before it is trusted (the extension by name, then the real
 *      four-byte header through `isEncryptedExport`), and **nothing reaches the library until
 *      the Import press**. Choosing a file is not importing it.
 *   3. The import that does happen is the same call with the same arguments as before the
 *      restyle: `importLibrary(file, { password })`, followed by a re-read of the store rather
 *      than a guess at the new counts.
 *   4. The theme control on this page changes the computed scheme — the attribute every
 *      `--qrbit-*` token reads — and is therefore not inert.
 *
 * **Why the harness mounts the real provider chain.** `WithMantine` (which `AppLayout` uses)
 * falls back to `defaultColorScheme="dark"` and no colour-scheme manager when it finds no
 * provider above it, so a bare mount would test a configuration no shipped screen runs with.
 * The provider here is the one `main.tsx` mounts — same theme, same manager, same
 * `defaultColorScheme="auto"` — plus the same `useThemeSchemeAttribute()` mirror, because
 * that mirror is what makes check 4 observable at all.
 *
 * The store and `lib/export.ts` are mocked: IndexedDB is `library.test.ts`'s subject, and the
 * file format is `export.test.ts`'s.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Settings } from './Settings'
import { importLibrary, isEncryptedExport } from '../lib/export'
import {
  qrbitCssVariablesResolver,
  THEME_STORAGE_KEY,
  theme,
  themeColorSchemeManager,
  useThemeSchemeAttribute,
} from '../theme'

const store = vi.hoisted(() => ({
  folders: [
    { id: 'f1', name: 'Uni Stuff', parentId: null, createdAt: 1, updatedAt: 1 },
    { id: 'f2', name: 'Work', parentId: 'f1', createdAt: 2, updatedAt: 2 },
  ],
  items: [
    {
      id: 'i1',
      folderId: 'root',
      name: 'note',
      type: 'text',
      createdAt: 1,
      updatedAt: 1,
      content: 'hello',
    },
    {
      id: 'i2',
      folderId: 'root',
      name: 'photo.png',
      type: 'image',
      createdAt: 1,
      updatedAt: 1,
      blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 2048,
    },
    {
      id: 'i3',
      folderId: 'f1',
      name: 'thesis.pdf',
      type: 'file',
      createdAt: 1,
      updatedAt: 1,
      blob: new Blob([new Uint8Array(8)], { type: 'application/pdf' }),
      mimeType: 'application/pdf',
      size: 1024,
    },
  ],
  files: [
    { id: 'd1', folderId: 'root', name: 'Thesis', blocks: [], createdAt: 1, updatedAt: 1 },
    { id: 'd2', folderId: 'f1', name: 'Receipts', blocks: [], createdAt: 1, updatedAt: 1 },
  ],
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  // The library's whole destructive surface. The page must never touch any of it: there is
  // no clear-library capability, and a restyle must not invent one.
  deleteFolder: vi.fn(),
  deleteItem: vi.fn(),
  deleteFile: vi.fn(),
  saveItem: vi.fn(),
  saveFile: vi.fn(),
  createFile: vi.fn(),
}))

vi.mock('../store/libraryStore', () => ({
  useLibraryStore: (selector: (state: typeof store) => unknown) => selector(store),
}))

vi.mock('../lib/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/export')>()
  return { ...actual, importLibrary: vi.fn(), isEncryptedExport: vi.fn() }
})

const importLibraryMock = vi.mocked(importLibrary)
const isEncryptedExportMock = vi.mocked(isEncryptedExport)

/** The one mirror `main.tsx` mounts, standing in for `<ThemedApp>` here. */
function SchemeSync() {
  useThemeSchemeAttribute()
  return null
}

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function mount(): Harness {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  act(() => {
    // The page links back to Home and hosts the theme control, so it needs a router and the
    // provider chain `main.tsx` gives it.
    root.render(
      createElement(
        MantineProvider,
        {
          theme,
          colorSchemeManager: themeColorSchemeManager,
          defaultColorScheme: 'auto',
          cssVariablesResolver: qrbitCssVariablesResolver,
          env: 'test',
        },
        createElement(SchemeSync),
        createElement(
          MemoryRouter,
          { initialEntries: ['/settings'] },
          createElement(Settings),
        ),
      ),
    )
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

/** The rendered page, plus the portal Mantine's `<Modal>` renders the export dialog into. */
function screen(): HTMLElement {
  return document.body
}

function buttonByText(text: string): HTMLButtonElement {
  for (const node of screen().querySelectorAll('button')) {
    if (node.textContent?.trim() === text) return node as HTMLButtonElement
  }
  throw new Error(`test bug: no button labelled "${text}"`)
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/**
 * A measurement row's value, read the way a visitor reads it: find the label, take the
 * number on the right. Asserting the pair (not the whole page's text) is what stops a
 * reordered or duplicated count from passing.
 */
function measure(label: string): string {
  const row = [...screen().querySelectorAll('.settings__measure')].find((node) =>
    node.textContent?.startsWith(label),
  )
  if (row === undefined) throw new Error(`test bug: no measurement row for "${label}"`)
  const value = row.lastElementChild?.textContent ?? ''
  return value.trim()
}

function passwordField(): HTMLInputElement {
  const input = screen().querySelector('.settings__import-password input')
  if (!(input instanceof HTMLInputElement)) throw new Error('test bug: no import password field')
  return input
}

/** Whether the page is asking for a password at all. */
function asksForPassword(): boolean {
  return screen().querySelector('.settings__import-password') !== null
}

/** Sets a controlled input's value the way a keystroke would (React 19). */
function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(field, value)

  act(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** jsdom has no real file picker, so the selection is injected as a FileList-shaped value. */
async function pickFile(file: File): Promise<void> {
  const input = screen().querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('test bug: no file input')
  Object.defineProperty(input, 'files', { value: [file], configurable: true })

  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  // The page reads the file's header to decide about the password field.
  await act(async () => {})
}

function themeToggle(): HTMLButtonElement {
  const button = screen().querySelector<HTMLButtonElement>('button[aria-label^="Color scheme"]')
  if (button === null) throw new Error('test bug: no theme control in Settings')
  return button
}

function storedPreference(): string | null {
  return window.localStorage.getItem(THEME_STORAGE_KEY)
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
  store.error = null
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-mantine-color-scheme')
  isEncryptedExportMock.mockResolvedValue(false)
  importLibraryMock.mockResolvedValue({ imported: 0, errors: [] })
})

afterEach(() => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  document.body.innerHTML = ''
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-mantine-color-scheme')
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  vi.restoreAllMocks()
})

describe('Settings — the library it reports', () => {
  it('renders the counts and the byte total the store holds, and asks the store to re-read them', () => {
    mount()

    expect(measure('Folders')).toBe('2')
    expect(measure('Dossiers')).toBe('2')
    expect(measure('Items')).toBe('3')
    // Only image and file items hold bytes: 2048 + 1024 = 3072.
    expect(measure('Image and file data in items')).toBe('3.0 KiB')
    // The page shows what IndexedDB holds, so it asks the store to re-read it.
    expect(store.refresh).toHaveBeenCalledTimes(1)
  })

  it('names the store failure beside the numbers it could not read', () => {
    store.error = 'IndexedDB is not available in this browser'
    mount()

    expect(screen().querySelector('[role="alert"]')?.textContent).toContain(
      'IndexedDB is not available',
    )
  })
})

describe('Settings — appearance', () => {
  it('changes the computed scheme, not just its own icon', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const harness = mount()

    // Light at rest: both the mirror and Mantine agree.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(themeToggle().getAttribute('aria-label')).toContain('Light')

    click(themeToggle())

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark')
    expect(storedPreference()).toBe('dark')
    expect(harness.element.textContent).toContain('Colour scheme')

    click(themeToggle())

    // System, with the OS (mocked as light) deciding — and the attribute following it.
    expect(storedPreference()).toBe('auto')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('Settings — chrome', () => {
  it('keeps /settings reachable from the header, and keeps the scanner out of it', () => {
    const harness = mount()
    const header = harness.element.querySelector('header')
    if (header === null) throw new Error('test bug: the page has no header')

    const settings = header.querySelector<HTMLAnchorElement>('.app-header__settings')
    if (settings === null) throw new Error('test bug: the header has no Settings control')
    expect(settings.getAttribute('href')).toBe('/settings')

    // ORCHESTRATION D16 behaviour change 1: pairing actions live in the QR panel, not here.
    const labels = [...header.querySelectorAll('button')].map((node) => node.textContent ?? '')
    expect(labels.some((label) => label.includes('Scan'))).toBe(false)
    expect(labels.some((label) => label.includes('Code'))).toBe(false)
  })

  it('is built from Mantine controls, so every one of them is a real button or input', () => {
    const harness = mount()

    // No hand-rolled control with the legacy `.button` class survives on this page: every
    // one of them is a Mantine Button, ActionIcon, FileInput or PasswordInput now.
    const raw = [...harness.element.querySelectorAll('button')].filter(
      (node) => node.className.split(' ').includes('button') === true,
    )
    expect(raw).toHaveLength(0)

    // The destructive-looking affordances are labelled by what they cost, not by an icon.
    expect(harness.element.textContent).toContain('Export library')
    expect(harness.element.textContent).toContain('Import file')
  })
})

describe('Settings — import', () => {
  it('opens the export dialog from Export library and closes it from Cancel', () => {
    const harness = mount()

    expect(screen().querySelector('[role="dialog"]')).toBe(null)

    click(buttonByText('Export library'))

    const dialog = screen().querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Export library')
    expect(dialog?.textContent).toContain('Nothing is uploaded')

    click(buttonByText('Cancel'))

    expect(screen().querySelector('[role="dialog"]')).toBe(null)
    // The dialog is dismissed, not swallowed: the page underneath is still the page.
    expect(harness.element.textContent).toContain('What is kept, and where')
  })

  it('refuses a file that is not a .qrbit export, and asks the library for nothing', async () => {
    const harness = mount()

    await pickFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }))

    expect(harness.element.textContent).toContain('That is not a .qrbit file.')
    expect(asksForPassword()).toBe(false)
    // Nothing to import, so there is no Import button and no header to read.
    expect(importLibraryMock).not.toHaveBeenCalled()
    expect(isEncryptedExportMock).not.toHaveBeenCalled()
    expect(() => buttonByText('Import into library')).toThrow()
  })

  it('does not write anything to the library when a file is only chosen', async () => {
    const harness = mount()

    await pickFile(new File(['{"version":1}'], 'plain.qrbit'))

    expect(importLibraryMock).not.toHaveBeenCalled()
    expect(store.saveItem).not.toHaveBeenCalled()
    expect(store.saveFile).not.toHaveBeenCalled()
    expect(store.createFile).not.toHaveBeenCalled()
    expect(store.deleteItem).not.toHaveBeenCalled()
    expect(store.deleteFile).not.toHaveBeenCalled()
    expect(store.deleteFolder).not.toHaveBeenCalled()
    expect(harness.element.textContent).toContain('plain.qrbit')
  })

  it('asks for a password only for an encrypted export, then imports with the same call shape', async () => {
    isEncryptedExportMock.mockResolvedValue(true)
    importLibraryMock.mockResolvedValue({ imported: 2, errors: [] })
    const harness = mount()

    await pickFile(new File(['QRDE…'], 'backup.qrbit'))

    expect(isEncryptedExportMock).toHaveBeenCalledTimes(1)
    expect(asksForPassword()).toBe(true)
    const importButton = buttonByText('Import into library')
    expect(importButton.disabled).toBe(true)

    typeInto(passwordField(), 'a password')
    expect(importButton.disabled).toBe(false)

    click(importButton)
    await act(async () => {})

    expect(importLibraryMock).toHaveBeenCalledWith(expect.any(File), { password: 'a password' })
    expect(harness.element.textContent).toContain('Imported 2 items.')
    // The stats are re-read after the merge rather than guessed at.
    expect(store.refresh).toHaveBeenCalledTimes(2)
  })

  it('imports a plain JSON export with no password at all', async () => {
    importLibraryMock.mockResolvedValue({ imported: 1, errors: [] })
    const harness = mount()

    await pickFile(new File(['{"version":1}'], 'plain.qrbit'))

    expect(asksForPassword()).toBe(false)

    click(buttonByText('Import into library'))
    await act(async () => {})

    expect(importLibraryMock).toHaveBeenCalledWith(expect.any(File), { password: undefined })
    expect(harness.element.textContent).toContain('Imported 1 item.')
  })

  it('reports a refused import inline and lists the items it could not store', async () => {
    importLibraryMock.mockResolvedValue({
      imported: 1,
      errors: ['Could not import "broken": "content" is missing or is not a string'],
    })
    const harness = mount()

    await pickFile(new File(['{"version":1}'], 'partial.qrbit'))
    click(buttonByText('Import into library'))
    await act(async () => {})

    expect(harness.element.textContent).toContain('Imported 1 item.')
    expect(harness.element.textContent).toContain('Could not import "broken"')

    // A file that cannot be opened at all says so, with the export layer's own words.
    importLibraryMock.mockRejectedValue(new Error('Wrong password or corrupted file'))
    await pickFile(new File(['QRDE…'], 'later.qrbit'))
    click(buttonByText('Import into library'))
    await act(async () => {})

    const alert = screen().querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Import failed: Wrong password or corrupted file')
  })
})

/** @vitest-environment jsdom */
/**
 * Settings page tests (PLAN.md §14, §16 Phase 7).
 *
 * The page's job is to route three things correctly: Export Library opens the §14
 * dialog, a chosen file is checked before it is trusted (`.qrdrop` by name, and its
 * four-byte header decides whether a password is needed), and the library stats are
 * whatever the store currently holds.
 *
 * The store is mocked — IndexedDB is `library.test.ts`'s subject — and so is
 * `lib/export.ts`, so the page can be tested without a real export file.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Settings } from './Settings'
import { importLibrary, isEncryptedExport } from '../lib/export'

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
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
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
    // The page links back to Home, so it needs a router around it.
    root.render(
      <MemoryRouter initialEntries={['/settings']}>
        <Settings />
      </MemoryRouter>,
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

function buttonByText(element: HTMLElement, text: string): HTMLButtonElement {
  for (const node of element.querySelectorAll('button')) {
    if (node.textContent?.trim() === text) return node
  }
  throw new Error(`test bug: no button labelled "${text}"`)
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function fileInput(element: HTMLElement): HTMLInputElement {
  const input = element.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('test bug: no file input')
  return input
}

function passwordField(element: HTMLElement): HTMLInputElement {
  const input = element.querySelector('[aria-label="Import password"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('test bug: no import password field')
  return input
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
async function pickFile(element: HTMLElement, file: File): Promise<void> {
  const input = fileInput(element)
  Object.defineProperty(input, 'files', { value: [file], configurable: true })

  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  // The page reads the file's header to decide about the password field.
  await act(async () => {})
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
  store.error = null
  isEncryptedExportMock.mockResolvedValue(false)
  importLibraryMock.mockResolvedValue({ imported: 0, errors: [] })
})

afterEach(() => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  document.body.innerHTML = ''
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  vi.restoreAllMocks()
})

describe('Settings', () => {
  it('renders the library stats from the store', () => {
    const harness = mount()

    const text = harness.element.textContent ?? ''
    expect(text).toContain('Folders: 2')
    expect(text).toContain('Items: 3')
    // Only image and file items hold bytes: 2048 + 1024 = 3072.
    expect(text).toContain('File and image data: 3.0 KiB')
    // The page shows what IndexedDB holds, so it asks the store to re-read it.
    expect(store.refresh).toHaveBeenCalled()
  })

  it('opens the export dialog from Export Library and closes it from Cancel', () => {
    const harness = mount()

    expect(harness.element.querySelector('[role="dialog"]')).toBe(null)

    click(buttonByText(harness.element, 'Export Library'))

    const dialog = harness.element.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Export library')

    click(buttonByText(harness.element, 'Cancel'))

    expect(harness.element.querySelector('[role="dialog"]')).toBe(null)
  })

  it('refuses a file that is not a .qrbit export, and asks the library for nothing', async () => {
    const harness = mount()

    await pickFile(harness.element, new File(['hello'], 'notes.txt', { type: 'text/plain' }))

    expect(harness.element.textContent).toContain('That is not a .qrbit file.')
    expect(harness.element.querySelector('[aria-label="Import password"]')).toBe(null)
    // Nothing to import, so there is no Import button and no header to read.
    expect(importLibraryMock).not.toHaveBeenCalled()
    expect(isEncryptedExportMock).not.toHaveBeenCalled()
    expect(() => buttonByText(harness.element, 'Import')).toThrow()
  })

  it('asks for a password only for an encrypted export, then imports it', async () => {
    isEncryptedExportMock.mockResolvedValue(true)
    importLibraryMock.mockResolvedValue({ imported: 2, errors: [] })
    const harness = mount()

    await pickFile(harness.element, new File(['QRBE…'], 'backup.qrbit'))

    expect(isEncryptedExportMock).toHaveBeenCalledTimes(1)
    const importButton = buttonByText(harness.element, 'Import')
    expect(importButton.disabled).toBe(true)

    typeInto(passwordField(harness.element), 'a password')
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

    await pickFile(harness.element, new File(['{"version":1}'], 'plain.qrbit'))

    expect(harness.element.querySelector('[aria-label="Import password"]')).toBe(null)

    click(buttonByText(harness.element, 'Import'))
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

    await pickFile(harness.element, new File(['{"version":1}'], 'partial.qrbit'))
    click(buttonByText(harness.element, 'Import'))
    await act(async () => {})

    expect(harness.element.textContent).toContain('Imported 1 item.')
    expect(harness.element.textContent).toContain('Could not import "broken"')

    // A file that cannot be opened at all says so, with the export layer's own words.
    importLibraryMock.mockRejectedValue(new Error('Wrong password or corrupted file'))
    await pickFile(harness.element, new File(['QRBE…'], 'later.qrbit'))
    click(buttonByText(harness.element, 'Import'))
    await act(async () => {})

    const alert = harness.element.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Import failed: Wrong password or corrupted file')
  })
})

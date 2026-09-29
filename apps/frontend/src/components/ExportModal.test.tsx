/** @vitest-environment jsdom */
/**
 * Export dialog tests (PLAN.md §14, §16 Phase 7).
 *
 * The dialog decides three things and hands the rest to `lib/export.ts`: which scope to
 * export, whether to encrypt, and with what password. These tests pin those decisions — the
 * password pair that must match before Export enables, the two scopes, the download the user
 * actually gets, and the two failure rules from the spec (an inline error, and a dialog that
 * stays open so the export can be retried). They are deliberately about the *calls and the
 * consequences*, not about which component rendered them: the restyle moved this file from a
 * hand-rolled overlay panel to Mantine's `<Modal>`, and every assertion below survived that.
 *
 * **Why the harness mounts a provider.** The dialog is a Mantine `<Modal>`, which renders its
 * content through a Portal into `document.body` and reads its colours, radius and shadow from
 * the theme. So `dialog()` searches the document, and the provider is `theme` from
 * `theme.ts` — the same object `main.tsx` passes — rather than `WithMantine`, whose fallback
 * provider pins `defaultColorScheme="dark"` and carries no colour-scheme manager, a
 * configuration no shipped screen runs with.
 *
 * `exportLibrary` is mocked: the file format is `export.test.ts`'s subject, and this file must
 * not need IndexedDB to test a form.
 */

import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExportModal } from './ExportModal'
import type { ExportModalProps } from './ExportModal'
import { exportLibrary, suggestExportFilename } from '../lib/export'
import { theme } from '../theme'

vi.mock('../lib/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/export')>()
  // `suggestExportFilename` stays real: the name the user gets is part of the spec.
  return { ...actual, exportLibrary: vi.fn() }
})

const exportLibraryMock = vi.mocked(exportLibrary)

const EXPORTED_BLOB = new Blob(['{"version":1}'], { type: 'application/json' })

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function mount(element: ReactElement): Harness {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  act(() => {
    root.render(createElement(MantineProvider, { theme, env: 'test' }, element))
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

function renderModal(overrides: Partial<ExportModalProps> = {}): Harness {
  return mount(createElement(ExportModal, { onClose: vi.fn(), ...overrides }))
}

/**
 * The dialog lives in a portal, so it is not inside the harness' host. `renderModal` twice in
 * one test is a thing these tests do (a caller with a selection and a caller without), so the
 * newest dialog is the subject, and every selector below is searched inside it.
 */
function dialog(): HTMLElement {
  const nodes = document.body.querySelectorAll('[role="dialog"]')
  const node = nodes[nodes.length - 1]
  if (!(node instanceof HTMLElement)) throw new Error('test bug: no dialog rendered')
  return node
}

function inDialog<T extends Element>(selector: string, constructor: new () => T): T {
  const node = dialog().querySelector(selector)
  if (!(node instanceof constructor)) throw new Error(`test bug: nothing matching ${selector}`)
  return node
}

function buttonByText(text: string): HTMLButtonElement {
  for (const node of dialog().querySelectorAll('button')) {
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
 * Mantine's password-visibility toggle fires on `mousedown` and prevents the default so the
 * button cannot steal focus out of the field — which is the behaviour a real press produces,
 * so that is the event the test dispatches.
 */
function press(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
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

/** Submitting awaits the export, so the microtask after it has to be flushed too. */
async function submitForm(): Promise<void> {
  const form = dialog().querySelector('form')
  if (form === null) throw new Error('test bug: no form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

function encryptSwitch(): HTMLInputElement {
  return inDialog('input[type="checkbox"]', HTMLInputElement)
}

function passwordField(): HTMLInputElement {
  return inDialog('[aria-label="Password"]', HTMLInputElement)
}

function confirmField(): HTMLInputElement {
  return inDialog('[aria-label="Confirm password"]', HTMLInputElement)
}

function scopeLabels(): string[] {
  return [...dialog().querySelectorAll('input[type="radio"]')].map((input) => {
    const label = dialog().querySelector(`label[for="${input.id}"]`)
    return label?.textContent ?? ''
  })
}

/** Records the `download` name of every anchor the modal clicks, instead of navigating. */
function spyOnAnchorClicks(): string[] {
  const downloads: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ): void {
    downloads.push(this.download)
  })
  return downloads
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:qrbit-export'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
  exportLibraryMock.mockResolvedValue(EXPORTED_BLOB)
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

describe('ExportModal', () => {
  it('offers the whole library, and offers the selection only when the caller reports one', () => {
    renderModal()
    expect(scopeLabels()).toEqual(['The whole library'])

    renderModal({ selectedFolderIds: ['f1'], selectedItemCount: 3 })
    expect(scopeLabels()).toEqual(['The whole library', 'The selected folders (3 items)'])
  })

  it('asks for a password twice only when the file is to be encrypted', () => {
    renderModal()

    expect(document.body.querySelector('[aria-label="Password"]')).toBe(null)
    expect(buttonByText('Export').disabled).toBe(false)

    click(encryptSwitch())

    expect(passwordField().type).toBe('password')
    expect(confirmField().type).toBe('password')
    // Empty, then mismatched, then correct — the §14 "both must match" rule.
    expect(buttonByText('Export').disabled).toBe(true)

    typeInto(passwordField(), 'correct horse battery staple')
    expect(buttonByText('Export').disabled).toBe(true)

    typeInto(confirmField(), 'correct horse battery stapl')
    expect(buttonByText('Export').disabled).toBe(true)
    expect(dialog().textContent).toContain('The two passwords do not match.')

    typeInto(confirmField(), 'correct horse battery staple')
    expect(buttonByText('Export').disabled).toBe(false)

    // Turning encryption back off takes the fields (and the typed password) away.
    click(encryptSwitch())
    expect(document.body.querySelector('[aria-label="Password"]')).toBe(null)
    expect(buttonByText('Export').disabled).toBe(false)
  })

  it('reveals and re-hides both password fields from one toggle', () => {
    renderModal()
    click(encryptSwitch())

    const toggle = inDialog('[aria-label="Toggle password visibility"]', HTMLButtonElement)
    press(toggle)
    expect(passwordField().type).toBe('text')
    // One switch governs both fields, so a confirm field cannot be read while the first is
    // hidden — the reason the old dialog had exactly one toggle.
    expect(confirmField().type).toBe('text')

    press(inDialog('[aria-label="Toggle password visibility"]', HTMLButtonElement))
    expect(passwordField().type).toBe('password')
    expect(confirmField().type).toBe('password')
  })

  it('closes on Escape without exporting anything', () => {
    const onClose = vi.fn()
    renderModal({ onClose })

    // On an element inside the dialog, so the event has a real target as it reaches the
    // dialog's own capture handler the way a keystroke's would.
    act(() => {
      dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(exportLibraryMock).not.toHaveBeenCalled()
  })

  it('cannot be dismissed while the export is running', async () => {
    let release: ((blob: Blob) => void) | null = null
    exportLibraryMock.mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          release = resolve
        }),
    )
    const onClose = vi.fn()
    renderModal({ onClose })

    await submitForm()

    click(buttonByText('Cancel'))
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      release?.(EXPORTED_BLOB)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('exports everything by default and downloads it under the §14 name', async () => {
    const downloads = spyOnAnchorClicks()
    const onClose = vi.fn()
    renderModal({ onClose, selectedFolderIds: ['f1'], selectedItemCount: 2 })

    await submitForm()

    expect(exportLibraryMock).toHaveBeenCalledWith('all', { encrypt: false, password: undefined })
    expect(URL.createObjectURL).toHaveBeenCalledWith(EXPORTED_BLOB)
    expect(downloads).toEqual([suggestExportFilename(new Date())])
    expect(downloads[0]).toMatch(/^qrbit-export-\d{4}-\d{2}-\d{2}\.qrbit$/)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('exports the selected folders with the password when that scope is chosen', async () => {
    const downloads = spyOnAnchorClicks()
    renderModal({ selectedFolderIds: ['f1', 'f2'], selectedItemCount: 4 })

    click(inDialog('input[value="selected"]', HTMLInputElement))
    click(encryptSwitch())
    typeInto(passwordField(), 'a password')
    typeInto(confirmField(), 'a password')

    await submitForm()

    expect(exportLibraryMock).toHaveBeenCalledWith(['f1', 'f2'], {
      encrypt: true,
      password: 'a password',
    })
    expect(downloads).toHaveLength(1)
  })

  it('says Exporting… while the export runs, and cannot be submitted twice', async () => {
    let release: ((blob: Blob) => void) | null = null
    exportLibraryMock.mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          release = resolve
        }),
    )
    renderModal()

    // Dispatched on its own so the pending export can be observed before it settles.
    const form = dialog().querySelector('form')
    if (form === null) throw new Error('test bug: no form')
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {})

    expect(buttonByText('Exporting…').textContent).toBe('Exporting…')
    expect(buttonByText('Exporting…').disabled).toBe(true)
    expect(buttonByText('Cancel').disabled).toBe(true)

    await submitForm()

    expect(exportLibraryMock).toHaveBeenCalledTimes(1)
    expect(buttonByText('Exporting…').textContent).toBe('Exporting…')

    await act(async () => {
      release?.(EXPORTED_BLOB)
    })

    expect(exportLibraryMock).toHaveBeenCalledTimes(1)
  })

  it('shows a failed export inline and leaves the dialog open to retry', async () => {
    exportLibraryMock.mockRejectedValue(new Error('quota exceeded'))
    const onClose = vi.fn()
    renderModal({ onClose })

    await submitForm()

    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      'Could not export the library (quota exceeded).',
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(buttonByText('Export').disabled).toBe(false)

    exportLibraryMock.mockResolvedValue(EXPORTED_BLOB)
    await submitForm()

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

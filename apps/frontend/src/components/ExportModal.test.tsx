/** @vitest-environment jsdom */
/**
 * Export dialog tests (PLAN.md §14, §16 Phase 7).
 *
 * The dialog decides three things and hands the rest to `lib/export.ts`: which
 * scope to export, whether to encrypt, and with what password. These tests pin those
 * decisions — the password pair that must match before Export enables, the two
 * scopes, the download the user actually gets, and the two failure rules from the
 * spec (an inline error, and a modal that stays open so the export can be retried).
 *
 * `exportLibrary` is mocked: the file format is `export.test.ts`'s subject, and
 * this file must not need IndexedDB to test a form.
 */

import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExportModal } from './ExportModal'
import type { ExportModalProps } from './ExportModal'
import { exportLibrary, suggestExportFilename } from '../lib/export'

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
    root.render(element)
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

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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
async function submitForm(element: HTMLElement): Promise<void> {
  const form = element.querySelector('form')
  if (form === null) throw new Error('test bug: no form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

function submitButton(element: HTMLElement): HTMLButtonElement {
  return button(element, '.library-modal__export')
}

function encryptCheckbox(element: HTMLElement): HTMLInputElement {
  return bySelector(element, 'input[type="checkbox"]', HTMLInputElement)
}

function passwordField(element: HTMLElement): HTMLInputElement {
  return bySelector(element, '[aria-label="Password"]', HTMLInputElement)
}

function confirmField(element: HTMLElement): HTMLInputElement {
  return bySelector(element, '[aria-label="Confirm password"]', HTMLInputElement)
}

function scopeLabels(element: HTMLElement): string[] {
  return [...element.querySelectorAll('fieldset label')].map((label) => label.textContent ?? '')
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
    value: vi.fn(() => 'blob:qrdrop-export'),
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
  it('offers All, and offers Selected only when the caller reports a selection', () => {
    const empty = renderModal()
    expect(scopeLabels(empty.element)).toEqual(['All'])

    const withSelection = renderModal({ selectedFolderIds: ['f1'], selectedItemCount: 3 })
    expect(scopeLabels(withSelection.element)).toEqual(['All', 'Selected (3 items)'])
  })

  it('asks for a password twice only when the file is to be encrypted', () => {
    const harness = renderModal()

    expect(harness.element.querySelector('[aria-label="Password"]')).toBe(null)
    expect(submitButton(harness.element).disabled).toBe(false)

    click(encryptCheckbox(harness.element))

    expect(passwordField(harness.element).type).toBe('password')
    expect(confirmField(harness.element).type).toBe('password')
    // Empty, then mismatched, then correct — the §14 "both must match" rule.
    expect(submitButton(harness.element).disabled).toBe(true)

    typeInto(passwordField(harness.element), 'correct horse battery staple')
    expect(submitButton(harness.element).disabled).toBe(true)

    typeInto(confirmField(harness.element), 'correct horse battery stapl')
    expect(submitButton(harness.element).disabled).toBe(true)
    expect(harness.element.textContent).toContain('The two passwords do not match.')

    typeInto(confirmField(harness.element), 'correct horse battery staple')
    expect(submitButton(harness.element).disabled).toBe(false)

    // Turning encryption back off takes the fields (and the typed password) away.
    click(encryptCheckbox(harness.element))
    expect(harness.element.querySelector('[aria-label="Password"]')).toBe(null)
    expect(submitButton(harness.element).disabled).toBe(false)
  })

  it('reveals and re-hides both password fields from one toggle', () => {
    const harness = renderModal()
    click(encryptCheckbox(harness.element))

    const toggle = button(harness.element, '.library-modal__reveal')
    expect(toggle.textContent).toBe('Show')

    click(toggle)
    expect(passwordField(harness.element).type).toBe('text')
    expect(confirmField(harness.element).type).toBe('text')
    expect(toggle.textContent).toBe('Hide')

    click(toggle)
    expect(passwordField(harness.element).type).toBe('password')
  })

  it('exports everything by default and downloads it under the §14 name', async () => {
    const downloads = spyOnAnchorClicks()
    const onClose = vi.fn()
    const harness = renderModal({ onClose, selectedFolderIds: ['f1'], selectedItemCount: 2 })

    await submitForm(harness.element)

    expect(exportLibraryMock).toHaveBeenCalledWith('all', { encrypt: false, password: undefined })
    expect(URL.createObjectURL).toHaveBeenCalledWith(EXPORTED_BLOB)
    expect(downloads).toEqual([suggestExportFilename(new Date())])
    expect(downloads[0]).toMatch(/^qrdrop-export-\d{4}-\d{2}-\d{2}\.qrdrop$/)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('exports the selected folders with the password when that scope is chosen', async () => {
    const downloads = spyOnAnchorClicks()
    const harness = renderModal({ selectedFolderIds: ['f1', 'f2'], selectedItemCount: 4 })

    click(bySelector(harness.element, 'input[value="selected"]', HTMLInputElement))
    click(encryptCheckbox(harness.element))
    typeInto(passwordField(harness.element), 'a password')
    typeInto(confirmField(harness.element), 'a password')

    await submitForm(harness.element)

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
    const harness = renderModal()

    // Dispatched on its own so the pending export can be observed before it settles.
    const form = harness.element.querySelector('form')
    if (form === null) throw new Error('test bug: no form')
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {})

    expect(submitButton(harness.element).textContent).toBe('Exporting…')
    expect(submitButton(harness.element).disabled).toBe(true)
    expect(button(harness.element, '.library-modal__cancel').disabled).toBe(true)

    await submitForm(harness.element)

    expect(exportLibraryMock).toHaveBeenCalledTimes(1)
    expect(submitButton(harness.element).textContent).toBe('Exporting…')

    await act(async () => {
      release?.(EXPORTED_BLOB)
    })

    expect(exportLibraryMock).toHaveBeenCalledTimes(1)
  })

  it('shows a failed export inline and leaves the modal open to retry', async () => {
    exportLibraryMock.mockRejectedValue(new Error('quota exceeded'))
    const onClose = vi.fn()
    const harness = renderModal({ onClose })

    await submitForm(harness.element)

    expect(harness.element.querySelector('.library-modal__error')?.textContent).toBe(
      'Could not export the library (quota exceeded).',
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(submitButton(harness.element).disabled).toBe(false)

    exportLibraryMock.mockResolvedValue(EXPORTED_BLOB)
    await submitForm(harness.element)

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

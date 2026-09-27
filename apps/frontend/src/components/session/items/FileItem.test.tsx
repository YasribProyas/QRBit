/** @vitest-environment jsdom */
/**
 * FileItem tests (PLAN.md §9: "Filename + progress ring" → "download button on
 * complete").
 *
 * Object URLs are the one resource this component owns, so the tests check the
 * whole lifecycle: created from the assembled Blob, replaced when the Blob changes,
 * and revoked on unmount (which is also what an item removal looks like). jsdom
 * implements neither `URL.createObjectURL` nor `URL.revokeObjectURL`, so both are
 * stubbed here and their call counts are the assertion.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileItem } from './FileItem'
import type { FileItemViewProps } from './FileItem'
import type { FileItem as FileItemModel } from '../../../store/sessionStore'

function makeItem(overrides: Partial<FileItemModel> = {}): FileItemModel {
  return {
    id: 'file-1',
    type: 'file',
    status: 'transferring',
    createdAt: 1,
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    totalSize: 2048,
    totalChunks: 2,
    progress: 50,
    ...overrides,
  }
}

let urlCounter = 0
const createObjectURL = vi.fn((_source: Blob | MediaSource): string => {
  urlCounter += 1
  return `blob:qrbit/${urlCounter}`
})
const revokeObjectURL = vi.fn()
const previousCreateObjectURL = URL.createObjectURL
const previousRevokeObjectURL = URL.revokeObjectURL

interface Harness {
  element: HTMLDivElement
  update: (next: Partial<FileItemViewProps>) => void
  unmount: () => void
}

const openHarnesses: Harness[] = []

function renderItem(overrides: Partial<FileItemViewProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const created: Root = createRoot(element)

  let props: FileItemViewProps = { item: makeItem(), ...overrides }

  act(() => {
    created.render(createElement(FileItem, props))
  })

  const harness: Harness = {
    element,
    update: (next) => {
      props = { ...props, ...next }
      act(() => {
        created.render(createElement(FileItem, props))
      })
    },
    unmount: () => {
      act(() => {
        created.unmount()
      })
      element.remove()
    },
  }

  openHarnesses.push(harness)
  return harness
}

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
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('FileItem while transferring (PLAN.md §9)', () => {
  it('shows the filename and a progress ring, and offers no download yet', () => {
    const { element } = renderItem({ item: makeItem({ progress: 40 }) })

    expect(element.textContent).toContain('report.pdf')
    const ring = element.querySelector('.progress-ring')
    expect(ring?.getAttribute('aria-valuenow')).toBe('40')
    expect(element.textContent).toContain('40%')
    expect(element.querySelector('a')).toBe(null)
  })

  it('reports progress without creating any object URL', () => {
    const { update } = renderItem({ item: makeItem({ progress: 25 }) })

    expect(createObjectURL).not.toHaveBeenCalled()

    update({ item: makeItem({ progress: 75 }) })

    expect(createObjectURL).not.toHaveBeenCalled()
  })
})

describe('FileItem on complete (PLAN.md §9)', () => {
  it('turns the progress ring into a download link for the assembled blob', () => {
    const { element } = renderItem({
      item: makeItem({ status: 'complete', progress: 100, blob: new Blob(['pdf']) }),
    })

    const link = element.querySelector('a')
    expect(link?.getAttribute('download')).toBe('report.pdf')
    expect(link?.getAttribute('href')).toBe('blob:qrbit/1')
    expect(element.querySelector('.progress-ring')).toBe(null)
  })

  it('revokes the download URL when the item goes away', () => {
    const { element, unmount } = renderItem({
      item: makeItem({ status: 'complete', progress: 100, blob: new Blob(['pdf']) }),
    })

    expect(element.querySelector('a')?.getAttribute('href')).toBe('blob:qrbit/1')
    expect(revokeObjectURL).not.toHaveBeenCalled()

    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrbit/1')
  })

  it('rebuilds the URL for a new blob and revokes the one it replaces', () => {
    const { element, update } = renderItem({
      item: makeItem({ status: 'complete', blob: new Blob(['first']) }),
    })

    update({ item: makeItem({ status: 'complete', blob: new Blob(['second']) }) })

    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrbit/1')
    expect(element.querySelector('a')?.getAttribute('href')).toBe('blob:qrbit/2')
  })
})

describe('FileItem failures (PLAN.md §9 status model)', () => {
  it('says so when the transfer errored', () => {
    const { element } = renderItem({ item: makeItem({ status: 'error', progress: 12 }) })

    expect(element.textContent).toContain('The file transfer failed.')
    expect(element.querySelector('a')).toBe(null)
  })
})

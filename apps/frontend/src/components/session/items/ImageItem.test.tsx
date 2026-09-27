/** @vitest-environment jsdom */
/**
 * ImageItem tests (PLAN.md §9: "Thumbnail + progress ring" on the sender,
 * "progressive reveal as chunks arrive" on the receiver).
 *
 * Two things are worth pinning here. First, the preview must be driven by the item's
 * Blob and released properly — jsdom has no `URL.createObjectURL`, so the stub's
 * call log is the evidence. Second, the progressive reveal is *bounded*: a large
 * image arrives as tens of thousands of chunks (PLAN.md §12), and rebuilding the
 * preview and the <img> for each of them would melt the decoder, so at most
 * MAX_PREVIEW_STEPS previews are built while the item is in flight. The completed
 * blob always refreshes, whatever the count.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ImageItem, MAX_PREVIEW_STEPS } from './ImageItem'
import type { ImageItemViewProps } from './ImageItem'
import type { ImageItem as ImageItemModel } from '../../../store/sessionStore'

function makeItem(overrides: Partial<ImageItemModel> = {}): ImageItemModel {
  return {
    id: 'image-1',
    type: 'image',
    status: 'transferring',
    createdAt: 1,
    fileName: 'holiday.jpg',
    mimeType: 'image/jpeg',
    totalSize: 4096,
    totalChunks: 4,
    progress: 25,
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
  update: (next: Partial<ImageItemViewProps>) => void
  unmount: () => void
}

const openHarnesses: Harness[] = []

function renderItem(overrides: Partial<ImageItemViewProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const created: Root = createRoot(element)

  let props: ImageItemViewProps = { item: makeItem(), ...overrides }

  act(() => {
    created.render(createElement(ImageItem, props))
  })

  const harness: Harness = {
    element,
    update: (next) => {
      props = { ...props, ...next }
      act(() => {
        created.render(createElement(ImageItem, props))
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

function previewSrc(element: HTMLElement): string | null | undefined {
  return element.querySelector('img')?.getAttribute('src')
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

describe('ImageItem (PLAN.md §9)', () => {
  it('shows the filename and waits for bytes when there is no blob yet', () => {
    const { element } = renderItem({ item: makeItem({ progress: 0 }) })

    expect(element.textContent).toContain('holiday.jpg')
    expect(element.querySelector('img')).toBe(null)
    expect(element.textContent).toContain('Waiting for the first bytes…')
    expect(element.querySelector('.progress-ring')?.getAttribute('aria-valuenow')).toBe('0')
  })

  it('previews the partial blob while the transfer is still running', () => {
    const { element } = renderItem({ item: makeItem({ blob: new Blob(['half']), progress: 60 }) })

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(previewSrc(element)).toBe('blob:qrbit/1')
    expect(element.querySelector('img')?.getAttribute('alt')).toBe('holiday.jpg')
    expect(element.querySelector('.progress-ring')?.getAttribute('aria-valuenow')).toBe('60')
  })

  it('drops the progress ring and keeps the assembled image once complete', () => {
    const { element, update } = renderItem({ item: makeItem({ blob: new Blob(['half']), progress: 50 }) })

    update({ item: makeItem({ status: 'complete', blob: new Blob(['all of it']), progress: 100 }) })

    expect(element.querySelector('.progress-ring')).toBe(null)
    expect(previewSrc(element)).toBe('blob:qrbit/2')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrbit/1')
  })

  it('bounds the progressive reveal while a large image streams in', () => {
    const { element, update } = renderItem({ item: makeItem({ blob: new Blob(['0']), progress: 1 }) })

    for (let step = 1; step < MAX_PREVIEW_STEPS * 2; step += 1) {
      update({ item: makeItem({ blob: new Blob([`${step}`]), progress: step }) })
    }

    expect(createObjectURL).toHaveBeenCalledTimes(MAX_PREVIEW_STEPS)

    // The completed blob is never held back by the cap.
    update({ item: makeItem({ status: 'complete', blob: new Blob(['final']), progress: 100 }) })

    expect(createObjectURL).toHaveBeenCalledTimes(MAX_PREVIEW_STEPS + 1)
    expect(previewSrc(element)).toBe(`blob:qrbit/${MAX_PREVIEW_STEPS + 1}`)
    expect(revokeObjectURL).toHaveBeenCalledTimes(MAX_PREVIEW_STEPS)
  })

  it('uses the URL the transport published instead of building a second one', () => {
    const { element, unmount } = renderItem({
      item: makeItem({ objectURL: 'blob:qrbit/published', blob: new Blob(['half']) }),
    })

    expect(createObjectURL).not.toHaveBeenCalled()
    expect(previewSrc(element)).toBe('blob:qrbit/published')

    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrbit/published')
  })

  it('revokes the preview it built when the item goes away', () => {
    const { unmount } = renderItem({ item: makeItem({ blob: new Blob(['half']) }) })

    expect(revokeObjectURL).not.toHaveBeenCalled()

    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrbit/1')
  })

  it('says so when the transfer errored', () => {
    const { element } = renderItem({ item: makeItem({ status: 'error', progress: 12 }) })

    expect(element.textContent).toContain('The image transfer failed.')
  })
})

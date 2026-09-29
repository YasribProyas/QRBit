/** @vitest-environment jsdom */
/**
 * QRDisplay tests (PLAN.md §3, §7, §16 Phase 6).
 *
 * jsdom ships no canvas rasteriser, so `getContext('2d')` is stubbed with a recording
 * context. That is not a shortcut: the assertions can then be about the *pixels* the
 * renderer produced (black modules, a white quiet zone, a bitmap sized for the screen)
 * rather than about the options object we passed it.
 *
 * The `qrcode` call itself is still a spy, because what the panel encodes is the whole
 * point (PLAN.md §3): the full `https://<app>/session?code=...` URL, never the bare code.
 */

import { toCanvas } from 'qrcode'
import type { QRCodeRenderersOptions } from 'qrcode'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { APP_URL, buildSessionUrl } from '../config'
import { QRDisplay } from './QRDisplay'
import type { QRDisplayProps } from './QRDisplay'

// `spy: true` keeps the real renderer and records the call, so the options and the URL
// under test are the ones the component actually uses.
vi.mock('qrcode', { spy: true })

/** The subset of `CanvasRenderingContext2D` the renderer touches, plus what it blitted. */
interface RecordingContext {
  /** Context methods in call order — evidence that a draw reached the canvas. */
  calls: string[]
  /** The bitmaps the renderer filled and blitted, one per draw. */
  rendered: ImageData[]
  createImageData(width: number, height: number): ImageData
  clearRect(x: number, y: number, width: number, height: number): void
  putImageData(image: ImageData, dx: number, dy: number): void
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let recording: RecordingContext | null = null
let getContext: MockInstance | null = null
let consoleError: MockInstance | null = null

function createRecordingContext(): RecordingContext {
  const calls: string[] = []
  const rendered: ImageData[] = []

  return {
    calls,
    rendered,
    createImageData(width, height) {
      calls.push(`createImageData(${width}x${height})`)
      const data = new Uint8ClampedArray(width * height * 4)
      return { width, height, data } as unknown as ImageData
    },
    clearRect(x, y, width, height) {
      calls.push(`clearRect(${x},${y},${width}x${height})`)
    },
    putImageData(image, dx, dy) {
      calls.push(`putImageData(${dx},${dy})`)
      rendered.push(image)
    },
  }
}

/**
 * Installs the recording context (or `null`, to stand in for a browser that cannot
 * rasterise a canvas at all) on every canvas jsdom creates.
 */
function stubCanvasContext(rendering: RecordingContext | null): void {
  getContext?.mockRestore()
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as MockInstance
  getContext.mockImplementation(() => rendering as unknown as CanvasRenderingContext2D)
}

/** The `qrcode` spy, viewed through a signature this test can drive — the real one is overloaded. */
function renderer(): MockInstance {
  return vi.mocked(toCanvas) as unknown as MockInstance
}

/** The arguments of the nth renderer call, in the shape this component calls it. */
function draw(index = 0): { canvas: HTMLCanvasElement; text: string; options: QRCodeRenderersOptions } {
  const call = renderer().mock.calls[index]
  if (call === undefined) throw new Error(`test bug: the renderer was not called ${index + 1} time(s)`)
  const [canvas, text, options] = call as unknown as [HTMLCanvasElement, string, QRCodeRenderersOptions]
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('test bug: the first argument was not a canvas')
  return { canvas, text, options }
}

function deferred(): Deferred {
  let settle: ((value: undefined) => void) | undefined
  let fail: ((error: unknown) => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  return {
    promise,
    resolve: () => settle?.(undefined),
    reject: (error) => fail?.(error),
  }
}

/** Lets the renderer's promise, React's work queue and every following microtask run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

function renderQR(props: QRDisplayProps): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(createElement(QRDisplay, props))
  })

  container = element
  root = created
  return element
}

function rerenderQR(props: QRDisplayProps): void {
  act(() => {
    root?.render(createElement(QRDisplay, props))
  })
}

function unmount(): void {
  const mounted = root
  root = null
  if (mounted === null) return
  act(() => {
    mounted.unmount()
  })
}

function query(element: HTMLElement, selector: string): HTMLElement {
  const node = element.querySelector(selector)
  if (!(node instanceof HTMLElement)) throw new Error(`test bug: nothing matched ${selector}`)
  return node
}

function canvasOf(element: HTMLElement): HTMLCanvasElement {
  const node = element.querySelector('canvas')
  if (!(node instanceof HTMLCanvasElement)) throw new Error('test bug: the canvas did not render')
  return node
}

/** The fallback URL text, which only exists when generation failed. */
function fallbackUrl(element: HTMLElement): string | null {
  const node = element.querySelector('.qr__frame code')
  return node === null ? null : node.textContent
}

/** The manual-entry value printed next to the QR, present whatever the QR did. */
function manualEntry(element: HTMLElement): string {
  return query(element, '.qr__caption code').textContent ?? ''
}

/** The stub installed for this test; fails loudly if a test forgot that it needs one. */
function recordingContext(): RecordingContext {
  if (recording === null) throw new Error('test bug: no recording context was installed')
  return recording
}

function drawing(recorded: RecordingContext): ImageData {
  const image = recorded.rendered[0]
  if (image === undefined) throw new Error('test bug: the renderer blitted no bitmap')
  return image
}

function byte(data: Uint8ClampedArray, index: number): number {
  const value = data[index]
  if (value === undefined) throw new Error(`test bug: no pixel byte at ${index}`)
  return value
}

/** The colour of one pixel, as `r,g,b,a`. */
function pixelAt(image: ImageData, x: number, y: number): string {
  const offset = (y * image.width + x) * 4
  return [
    byte(image.data, offset),
    byte(image.data, offset + 1),
    byte(image.data, offset + 2),
    byte(image.data, offset + 3),
  ].join(',')
}

/** Every colour that appears in one row, which is how polarity and the quiet zone are read. */
function rowColors(image: ImageData, y: number): Set<string> {
  const colors = new Set<string>()
  for (let x = 0; x < image.width; x += 1) {
    colors.add(pixelAt(image, x, y))
  }
  return colors
}

/** Every colour in the whole bitmap: a QR uses exactly two. */
function allColors(image: ImageData): Set<string> {
  const colors = new Set<string>()
  for (let y = 0; y < image.height; y += 1) {
    for (const color of rowColors(image, y)) {
      colors.add(color)
    }
  }
  return colors
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
  recording = createRecordingContext()
  stubCanvasContext(recording)
  renderer().mockClear()
})

afterEach(() => {
  unmount()
  container?.remove()
  container = null
  getContext?.mockRestore()
  getContext = null
  consoleError?.mockRestore()
  consoleError = null
  recording = null
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('QRDisplay — what the code encodes (PLAN.md §3, §16 Phase 6)', () => {
  it('encodes the full session URL, never the bare code', async () => {
    const element = renderQR({ code: 'A7X3K9P2' })
    await settle()

    const { text } = draw()
    expect(text).toBe(`${APP_URL}/session?code=A7X3K9P2`)
    expect(text).toContain(APP_URL)
    expect(text).toContain('?code=A7X3K9P2')
    expect(text).not.toBe('A7X3K9P2')

    // The draw targeted the canvas that is actually on screen.
    expect(draw().canvas).toBe(canvasOf(element))
  })

  it('encodes a URL the caller already built', async () => {
    const element = renderQR({ url: buildSessionUrl('QQ11WW22') })
    await settle()

    expect(draw().text).toBe(buildSessionUrl('QQ11WW22'))
    expect(canvasOf(element).style.display).toBe('block')
  })
})

describe('QRDisplay — a code a phone camera can read (PLAN.md §16 Phase 6)', () => {
  it('draws black modules on a white panel with a quiet zone', async () => {
    renderQR({ code: 'A7X3K9P2' })
    await settle()

    const image = drawing(recordingContext())

    // Two colours, and the polarity a scanner expects: the background is pure white and the
    // modules are pure black. An inverted code (light modules on dark) would fail here.
    expect(allColors(image)).toEqual(new Set(['255,255,255,255', '0,0,0,255']))
    // The quiet zone: the top row is entirely light, so the symbol never touches the edge.
    expect(rowColors(image, 0)).toEqual(new Set(['255,255,255,255']))
    // And it reached the canvas: the bitmap was filled, the canvas cleared, then blitted.
    expect(recordingContext().calls.map((call) => call.split('(')[0])).toEqual([
      'createImageData',
      'clearRect',
      'putImageData',
    ])
  })

  it('asks the renderer for M-or-better correction and the spec quiet zone', async () => {
    renderQR({ code: 'A7X3K9P2' })
    await settle()

    const { options } = draw()
    expect(options.errorCorrectionLevel).toBe('M')
    expect(options.margin).toBeGreaterThanOrEqual(4)
    /*
     * The palette is never overridden, which is how the symbol keeps one fixed module/field
     * pair in both schemes: `qrcode` falls back to its documented default — pure black modules
     * on a pure white field — and the pixel assertions above are what pin the result. Naming
     * the two colours here would put a hex in a component, which DESIGN.md forbids, and taking
     * them from a `--qrbit-*` surface token would invert them under `[data-theme='dark']`.
     * The renderer normalises the options object in place, so `color` arrives here present but
     * empty rather than absent.
     */
    expect(options.color).toEqual({})
  })

  it('rasterises above the CSS size on a high-density screen', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })

    renderQR({ code: 'A7X3K9P2', size: 200 })
    await settle()

    // 200 CSS pixels on a 2× screen means a 400-pixel bitmap, so the modules stay sharp
    // instead of being upscaled by the browser.
    expect(draw().options.width).toBe(400)
    expect(draw().canvas.style.width).toBe('100%')
  })
})

describe('QRDisplay — the fallbacks that keep pairing possible (PLAN.md §16 Phase 6)', () => {
  it('prints the URL as text when the renderer fails', async () => {
    renderer().mockRejectedValueOnce(new Error('renderer exploded'))
    const url = buildSessionUrl('A7X3K9P2')

    const element = renderQR({ url })
    await settle()

    expect(fallbackUrl(element)).toBe(url)
    expect(canvasOf(element).style.display).toBe('none')
    expect(element.textContent).toContain('QR unavailable')
    // The manual path is still there, so the code can be typed on the other device.
    expect(manualEntry(element)).toBe('A7X3K9P2')
  })

  it('prints the URL as text when the browser has no 2D canvas context', async () => {
    stubCanvasContext(null)
    const url = buildSessionUrl('A7X3K9P2')

    const element = renderQR({ url })
    await settle()

    expect(renderer()).not.toHaveBeenCalled()
    expect(fallbackUrl(element)).toBe(url)
    expect(canvasOf(element).style.display).toBe('none')
  })

  it('shows a placeholder while the code is still being generated', () => {
    const pending = deferred()
    renderer().mockImplementationOnce(() => pending.promise)

    const element = renderQR({ code: 'A7X3K9P2' })

    // Nothing to scan yet, and no half-drawn code on screen either.
    expect(element.textContent).toContain('Generating QR…')
    expect(canvasOf(element).style.display).toBe('none')
  })

  it('keeps the raw code legible for manual entry', async () => {
    const element = renderQR({ code: 'A7X3K9P2' })
    await settle()

    expect(manualEntry(element)).toBe('A7X3K9P2')
    expect(canvasOf(element).style.display).toBe('block')
  })
})

describe('QRDisplay — accessibility (PLAN.md §16 Phase 6)', () => {
  it('names the canvas for assistive technology', async () => {
    const element = renderQR({ code: 'A7X3K9P2' })
    await settle()

    const canvas = canvasOf(element)
    expect(canvas.getAttribute('role')).toBe('img')
    expect(canvas.getAttribute('aria-label')).toBe('QR code pairing for session A7X3K9P2')
  })

  it('offers the enlarge and refresh controls from PLAN.md §7', () => {
    const onRefresh = vi.fn()
    const element = renderQR({ code: 'A7X3K9P2', onRefresh })

    const enlarge = query(element, 'button[aria-pressed]')
    expect(enlarge.textContent).toBe('Enlarge QR')

    act(() => {
      enlarge.click()
    })
    expect(enlarge.getAttribute('aria-pressed')).toBe('true')
    expect(enlarge.textContent).toBe('Shrink QR')

    act(() => {
      query(element, '.qr__actions button:last-child').click()
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('shows no refresh control when the caller owns no refresh action', () => {
    const element = renderQR({ code: 'A7X3K9P2' })

    expect(element.querySelectorAll('.qr__actions button')).toHaveLength(1)
  })
})

describe('QRDisplay — lifecycle', () => {
  it('ignores a draw that finishes after its URL changed', async () => {
    const stale = deferred()
    renderer().mockImplementationOnce(() => stale.promise)

    const element = renderQR({ url: buildSessionUrl('AAAAAAAA') })
    rerenderQR({ url: buildSessionUrl('BBBBBBBB') })
    await settle()
    expect(canvasOf(element).style.display).toBe('block')

    // The abandoned draw now fails: it must not drag the panel into the fallback, which
    // would show the *old* URL and hide the fresh code.
    await act(async () => {
      stale.reject(new Error('stale draw failed'))
      await Promise.resolve()
    })

    expect(canvasOf(element).style.display).toBe('block')
    expect(fallbackUrl(element)).toBeNull()
    expect(manualEntry(element)).toBe('BBBBBBBB')
  })

  it('touches nothing after unmount, whatever the in-flight draw does', async () => {
    // React 19 no longer warns about an update on an unmounted root, so the observable
    // failure here is an unhandled rejection or an error thrown by the continuation.
    consoleError = vi.spyOn(console, 'error') as unknown as MockInstance
    consoleError.mockImplementation(() => undefined)

    const pending = deferred()
    renderer().mockImplementationOnce(() => pending.promise)

    renderQR({ code: 'A7X3K9P2' })
    unmount()

    await act(async () => {
      pending.reject(new Error('rejected after unmount'))
      await Promise.resolve()
    })

    expect(consoleError).not.toHaveBeenCalled()
  })

  it('clears the canvas before each draw, so a refresh cannot leave the old code behind', async () => {
    renderQR({ code: 'A7X3K9P2' })
    await settle()
    rerenderQR({ code: 'BBBBBBBB' })
    await settle()

    expect(renderer().mock.calls).toHaveLength(2)
    expect(draw(1).text).toBe(buildSessionUrl('BBBBBBBB'))
    expect(recordingContext().calls.filter((call) => call.startsWith('clearRect'))).toHaveLength(2)
  })
})

/**
 * Tests for the QR detection seam (PLAN.md §16 Phase 6, §19 decision 11).
 *
 * Two things here are load-bearing:
 *
 *   1. PAYLOAD VALIDATION. A camera decodes whatever is in front of it, and the value
 *      it produces decides whether the app navigates somewhere. `parseSessionCode` is
 *      the only gate, so it is tested hardest: origin, path, and the exact Phase 1 code
 *      format, with everything else rejected.
 *   2. FALLBACK WIRING. `html5-qrcode` is mocked, because the point is not the library's
 *      own scanning (that is its job, and it needs a camera and a real browser) but that
 *      we drive it correctly: rear camera, QR only, decodes forwarded to `onDecode`, and
 *      the camera handed back on `stop`.
 *
 * The native path needs no mock: a fake `globalThis.BarcodeDetector` is enough, which is
 * exactly how a browser supplies one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APP_URL, buildSessionUrl } from '../config'
import {
  createHtml5QrcodeSource,
  createNativeDetector,
  isBarcodeDetectorAvailable,
  parseSessionCode,
} from './barcode'
import type { BarcodeSource } from './barcode'

// ---------------------------------------------------------------------------
// html5-qrcode stand-in
// ---------------------------------------------------------------------------

/** Calls the mocked library received, recorded for assertions. */
const library = vi.hoisted(() => ({
  constructed: vi.fn((_elementId: string, _config: unknown) => undefined),
  start: vi.fn(async (_camera: unknown, _config: unknown, _onSuccess: unknown, _onError: unknown) => null),
  stop: vi.fn(async () => undefined),
}))

vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class {
    constructor(elementId: string, config: unknown) {
      library.constructed(elementId, config)
    }

    start(camera: unknown, config: unknown, onSuccess: unknown, onError: unknown): Promise<unknown> {
      return library.start(camera, config, onSuccess, onError)
    }

    stop(): Promise<void> {
      return library.stop()
    }
  },
  Html5QrcodeSupportedFormats: { QR_CODE: 'qr_code' },
}))

/** Calls the success callback the source handed the library, as the library would. */
function libraryDecodes(payload: string): void {
  const call = library.start.mock.calls[0]
  if (call === undefined) throw new Error('test bug: the library was never started')
  const onSuccess = call[2] as (decodedText: string) => void
  onSuccess(payload)
}

/**
 * A stand-in for the container element. `createHtml5QrcodeSource` only reads and writes
 * its `id`, and the library itself is mocked, so a real `<div>` (and a DOM) is not needed.
 */
function fakeSurface(id = ''): HTMLElement {
  return { id } as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  Reflect.deleteProperty(globalThis, 'BarcodeDetector')
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'BarcodeDetector')
})

// ---------------------------------------------------------------------------
// Native path
// ---------------------------------------------------------------------------

describe('isBarcodeDetectorAvailable (PLAN.md §19 decision 11)', () => {
  it('is false where the browser has no BarcodeDetector', () => {
    expect(isBarcodeDetectorAvailable()).toBe(false)
  })

  it('is true when the browser provides one, and false for a non-constructor value', () => {
    Reflect.set(globalThis, 'BarcodeDetector', class {})
    expect(isBarcodeDetectorAvailable()).toBe(true)

    // A property that exists but is not callable cannot be `new`ed; treating it as
    // available would fail later, inside the detection loop, instead of here.
    Reflect.set(globalThis, 'BarcodeDetector', undefined)
    expect(isBarcodeDetectorAvailable()).toBe(false)
  })
})

describe('createNativeDetector', () => {
  it('throws where the browser has no BarcodeDetector', () => {
    expect(() => createNativeDetector()).toThrow(/BarcodeDetector/)
  })

  it('asks for QR codes only and forwards detections', async () => {
    const detections = [{ rawValue: 'hello' }]
    const detect = vi.fn(async (_source: CanvasImageSource) => detections)
    const constructor = vi.fn(function BarcodeDetector(this: unknown, _options?: unknown) {
      return { detect }
    })
    Reflect.set(globalThis, 'BarcodeDetector', constructor)

    const detector = createNativeDetector()

    expect(constructor).toHaveBeenCalledWith({ formats: ['qr_code'] })
    await expect(detector.detect({} as HTMLVideoElement)).resolves.toEqual(detections)
    expect(detect).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Fallback path
// ---------------------------------------------------------------------------

describe('createHtml5QrcodeSource — the html5-qrcode fallback', () => {
  it('starts the rear camera for QR codes only, and forwards decodes', async () => {
    const source = createHtml5QrcodeSource()
    const onDecode = vi.fn()
    source.onDecode = onDecode

    await source.start(fakeSurface('stage'))

    expect(library.constructed).toHaveBeenCalledTimes(1)
    const constructed = library.constructed.mock.calls[0]
    expect(constructed?.[0]).toBe('stage')
    expect(constructed?.[1]).toEqual({
      formatsToSupport: ['qr_code'],
      useBarCodeDetectorIfSupported: false,
      verbose: false,
    })

    const call = library.start.mock.calls[0]
    expect(call?.[0]).toEqual({ facingMode: 'environment' })
    expect(call?.[1]).toEqual({ fps: 10 })

    // The library reports each decode through the callback it was given.
    libraryDecodes('https://example.test/payload')
    expect(onDecode).toHaveBeenCalledWith('https://example.test/payload')
  })

  it('names an unnamed container, because the library resolves it by id', async () => {
    const surface = fakeSurface('')
    await createHtml5QrcodeSource().start(surface)

    expect(surface.id).toMatch(/^qrbit-qr-surface-/)
    expect(library.constructed.mock.calls[0]?.[0]).toBe(surface.id)
  })

  it('stops the library camera and is safe before a start', async () => {
    const source: BarcodeSource = createHtml5QrcodeSource()

    source.stop()
    expect(library.stop).not.toHaveBeenCalled()

    await source.start(fakeSurface())
    source.stop()

    expect(library.stop).toHaveBeenCalledTimes(1)
  })

  it('surfaces a library start failure to the caller', async () => {
    library.start.mockRejectedValueOnce('Error getting userMedia, error = NotAllowedError: Permission denied')

    await expect(createHtml5QrcodeSource().start(fakeSurface())).rejects.toContain('NotAllowedError')
  })
})

// ---------------------------------------------------------------------------
// Payload validation (PLAN.md §3, §8, §16 Phase 6)
// ---------------------------------------------------------------------------

describe('parseSessionCode', () => {
  it('accepts the session URL this app builds', () => {
    expect(parseSessionCode(buildSessionUrl('A7X3K9P2'))).toBe('A7X3K9P2')
  })

  it('accepts any origin passed in, as an origin or a full URL', () => {
    const url = 'https://qrbit.example/session?code=23456789'

    expect(parseSessionCode(url, 'https://qrbit.example')).toBe('23456789')
    expect(parseSessionCode(url, 'https://qrbit.example/')).toBe('23456789')
    expect(parseSessionCode(url, APP_URL)).toBe(null)
  })

  it('rejects a payload from another origin', () => {
    const other = buildSessionUrl('A7X3K9P2').replace('http://localhost:5173', 'https://evil.example')

    expect(parseSessionCode(other)).toBe(null)
  })

  it('rejects a payload that is not the session path', () => {
    expect(parseSessionCode('http://localhost:5173/session/extra?code=A7X3K9P2')).toBe(null)
    expect(parseSessionCode('http://localhost:5173/library?code=A7X3K9P2')).toBe(null)
    expect(parseSessionCode('http://localhost:5173/?code=A7X3K9P2')).toBe(null)
  })

  it('rejects a malformed or missing code', () => {
    expect(parseSessionCode('http://localhost:5173/session')).toBe(null)
    expect(parseSessionCode('http://localhost:5173/session?code=')).toBe(null)
    expect(parseSessionCode('http://localhost:5173/session?code=A7X3K9P')).toBe(null)
    expect(parseSessionCode('http://localhost:5173/session?code=A7X3K9P23')).toBe(null)
    // The alphabet's excluded glyphs: 0, 1, I, O, L, U.
    expect(parseSessionCode('http://localhost:5173/session?code=A7X3K9P0')).toBe(null)
    expect(parseSessionCode('http://localhost:5173/session?code=A7X3K9PI')).toBe(null)
    // The worker issues uppercase codes and does not normalise, so case is not folded.
    expect(parseSessionCode('http://localhost:5173/session?code=a7x3k9p2')).toBe(null)
  })

  it('rejects anything that is not a URL at all', () => {
    expect(parseSessionCode('')).toBe(null)
    expect(parseSessionCode('A7X3K9P2')).toBe(null)
    expect(parseSessionCode('QRBit session A7X3K9P2')).toBe(null)
    expect(parseSessionCode('{"code":"A7X3K9P2"}')).toBe(null)
  })

  it('tolerates surrounding whitespace, which scanners sometimes add', () => {
    expect(parseSessionCode(`  ${buildSessionUrl('A7X3K9P2')}\n`)).toBe('A7X3K9P2')
  })
})

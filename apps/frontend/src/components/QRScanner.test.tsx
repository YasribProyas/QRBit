/** @vitest-environment jsdom */
/**
 * QRScanner tests (PLAN.md §7 Flow A, §16 Phase 6, §19 decision 11, §17).
 *
 * jsdom has no camera, no `BarcodeDetector`, no `getUserMedia` and no playing video, so
 * every test injects what the component would otherwise get from the browser: the
 * camera (`navigator.mediaDevices.getUserMedia`), the detector, and the fallback
 * source. That is the point of the injection seams — the privacy-critical part of this
 * component is what it does around the camera, and that is testable headlessly.
 *
 * The tests are organised around the three things that can go wrong:
 *
 *   - the wrong detection path (decision 11: native first, fallback only without it),
 *   - an unusable camera (denied, absent, or no scanner at all), reported with the
 *     advice that matches the cause,
 *   - a camera left running — the one failure with a real-world cost. Every exit is
 *     pinned: a successful scan, a payload that must NOT end scanning, cancel, unmount,
 *     and a cancel that lands while the camera is still being opened.
 *
 * jsdom ships no renderer and this repo has no rendering library, so React's own `act` +
 * `createRoot` are used, as in the other component tests.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { buildSessionUrl } from '../config'
import * as barcode from '../lib/barcode'
import type { BarcodeDetectorLike, BarcodeSource } from '../lib/barcode'
import { QRScanner } from './QRScanner'
import type { QRScannerProps } from './QRScanner'

const SESSION_CODE = 'A7X3K9P2'
const SESSION_URL = buildSessionUrl(SESSION_CODE)

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

/**
 * Renders the overlay.
 *
 * Unless a test says otherwise the NATIVE path is the one under test, with the camera
 * injected through `navigator.mediaDevices` and detection through a silent fake. Tests
 * of the fallback override both `isNativeDetectorAvailable` and `sourceFactory`.
 */
function renderScanner(overrides: Partial<QRScannerProps> = {}): Harness {
  const element = document.createElement('div')
  document.body.append(element)
  const created: Root = createRoot(element)

  const props: QRScannerProps = {
    onScan: vi.fn(),
    onCancel: vi.fn(),
    isNativeDetectorAvailable: () => true,
    detectorFactory: silentDetector,
    ...overrides,
  }

  act(() => {
    created.render(createElement(QRScanner, props))
  })

  const harness: Harness = {
    element,
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

/** Lets every pending promise and timer callback settle, inside `act`. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function videoOf(element: HTMLElement): HTMLVideoElement {
  const video = element.querySelector('video')
  if (!(video instanceof HTMLVideoElement)) throw new Error('test bug: no video element')
  return video
}

function errorTextOf(element: HTMLElement): string {
  const error = element.querySelector('.qr-scanner__error')
  if (error === null) throw new Error('test bug: no error state is rendered')
  return error.textContent ?? ''
}

function clickCancel(element: HTMLElement): void {
  const button = element.querySelector('.qr-scanner__cancel')
  if (!(button instanceof HTMLButtonElement)) throw new Error('test bug: no cancel button')

  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function detectCalls(detector: BarcodeDetectorLike): number {
  return (detector.detect as ReturnType<typeof vi.fn>).mock.calls.length
}

// ---------------------------------------------------------------------------
// Stand-ins for the browser's camera and decoders
// ---------------------------------------------------------------------------

function fakeTrack(): MediaStreamTrack {
  // jsdom implements neither MediaStream nor MediaStreamTrack; only `stop` is used.
  const track: Partial<MediaStreamTrack> = { stop: vi.fn() }
  return track as MediaStreamTrack
}

function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  const stream: Partial<MediaStream> = { getTracks: () => tracks }
  return stream as MediaStream
}

/** Installs a `navigator.mediaDevices`; jsdom has none, which is where the tests start. */
function stubCamera(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  const spy = vi.fn(getUserMedia)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: spy } })
  return spy
}

function fakeDetector(rawValues: readonly string[] = []): BarcodeDetectorLike {
  return { detect: vi.fn(async () => rawValues.map((rawValue) => ({ rawValue }))) }
}

/** A detector that never decodes anything, for tests that do not scan. */
function silentDetector(): BarcodeDetectorLike {
  return fakeDetector([])
}

interface FakeSource extends BarcodeSource {
  start: Mock<(surface: HTMLElement) => Promise<void>>
  stop: Mock<() => void>
}

function fakeSource(start: (surface: HTMLElement) => Promise<void> = async () => undefined): FakeSource {
  return { start: vi.fn(start), stop: vi.fn(), onDecode: undefined }
}

/** Drives a fallback source's decode callback the way the library would. */
function sourceDecodes(source: FakeSource, payload: string): void {
  act(() => {
    source.onDecode?.(payload)
  })
}

/** A promise whose settlement the test controls, for races against a slow camera. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settleDeferred: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    settleDeferred = resolve
  })
  return { promise, resolve: settleDeferred }
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
})

afterEach(() => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  // Restore, not merely clear: one test spies on the barcode module, and a lingering
  // spy would silently supply the next test's detector.
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'mediaDevices')
  Reflect.deleteProperty(globalThis, 'BarcodeDetector')
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

// ---------------------------------------------------------------------------
// Camera surface (PLAN.md §16 Phase 6)
// ---------------------------------------------------------------------------

describe('QRScanner — the camera surface', () => {
  it('renders a muted, inline-playable video: nothing else may autoplay', async () => {
    stubCamera(() => Promise.resolve(fakeStream([fakeTrack()])))
    const { element } = renderScanner()
    await settle()

    const video = videoOf(element)
    expect(video.muted).toBe(true)
    expect(video.playsInline).toBe(true)
    expect(video.hasAttribute('autoplay')).toBe(true)
    expect(element.querySelector('.qr-scanner__viewfinder')).not.toBe(null)
    expect(element.querySelector('.qr-scanner')?.getAttribute('role')).toBe('dialog')
  })

  it('asks for the REAR camera and shows the stream in the video', async () => {
    const stream = fakeStream([fakeTrack()])
    const getUserMedia = stubCamera(() => Promise.resolve(stream))
    const { element } = renderScanner()
    await settle()

    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' } })
    expect(videoOf(element).srcObject).toBe(stream)
  })

  it('leaves the camera to the fallback library instead of opening a second one', async () => {
    const getUserMedia = stubCamera(() => Promise.resolve(fakeStream([fakeTrack()])))
    const source = fakeSource()
    const { element } = renderScanner({
      isNativeDetectorAvailable: () => false,
      sourceFactory: () => source,
    })
    await settle()

    expect(source.start).toHaveBeenCalledTimes(1)
    expect(source.start.mock.calls[0]?.[0]).toBe(element.querySelector('.qr-scanner__surface'))
    // Two getUserMedia calls would fight over the device and usually lose the second.
    expect(getUserMedia).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Path selection (PLAN.md §19 decision 11)
// ---------------------------------------------------------------------------

describe('QRScanner — which detection path runs (PLAN.md §19 decision 11)', () => {
  it('prefers the native BarcodeDetector when the browser has one', async () => {
    const createNativeDetector = vi.spyOn(barcode, 'createNativeDetector').mockReturnValue(silentDetector())
    const sourceFactory = vi.fn((): BarcodeSource => fakeSource())
    stubCamera(() => Promise.resolve(fakeStream([fakeTrack()])))

    renderScanner({ detectorFactory: undefined, sourceFactory })
    await settle()

    expect(createNativeDetector).toHaveBeenCalledTimes(1)
    expect(sourceFactory).not.toHaveBeenCalled()
  })

  it('uses the browser\'s own BarcodeDetector through the real feature check and wrapper', async () => {
    const detect = vi.fn(async (_source: CanvasImageSource) => [] as Array<{ rawValue: string }>)
    const Detector = class {
      detect = detect
    }
    Reflect.set(globalThis, 'BarcodeDetector', Detector)
    stubCamera(() => Promise.resolve(fakeStream([fakeTrack()])))

    // No injections at all: the component's own defaults must pick the native path.
    renderScanner({ isNativeDetectorAvailable: undefined, detectorFactory: undefined })
    await settle()

    await vi.waitFor(() => {
      expect(detect).toHaveBeenCalled()
    })
  })

  it('falls back to html5-qrcode when the native detector is missing', async () => {
    const detector = silentDetector()
    const source = fakeSource()

    renderScanner({
      isNativeDetectorAvailable: () => false,
      detectorFactory: () => detector,
      sourceFactory: () => source,
    })
    await settle()

    expect(source.start).toHaveBeenCalledTimes(1)
    expect(detector.detect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// An unusable camera
// ---------------------------------------------------------------------------

describe('QRScanner — camera failures (PLAN.md §16 Phase 6)', () => {
  it('explains a denied permission and how to undo it', async () => {
    stubCamera(() => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')))
    const onScan = vi.fn()
    const { element } = renderScanner({ onScan })
    await settle()

    const text = errorTextOf(element)
    expect(text).toContain('Camera access is blocked')
    expect(text).toContain('Allow camera access')
    expect(element.querySelector('.qr-scanner__error')?.getAttribute('role')).toBe('alert')
    expect(onScan).not.toHaveBeenCalled()
  })

  it('reports a device with no camera at all', async () => {
    stubCamera(() => Promise.reject(new DOMException('Requested device not found', 'NotFoundError')))
    const { element } = renderScanner()
    await settle()

    expect(errorTextOf(element)).toContain('No camera found')
  })

  it('classifies the fallback library\'s wrapped string errors too', async () => {
    const source = fakeSource(() =>
      Promise.reject('Error getting userMedia, error = NotFoundError: Requested device not found'),
    )
    const { element } = renderScanner({
      isNativeDetectorAvailable: () => false,
      sourceFactory: () => source,
    })
    await settle()

    expect(errorTextOf(element)).toContain('No camera found')
  })

  it('reports a browser where neither path can start', async () => {
    const source = fakeSource(() => Promise.reject('Camera streaming not supported by the browser.'))
    const { element } = renderScanner({
      isNativeDetectorAvailable: () => false,
      sourceFactory: () => source,
    })
    await settle()

    const text = errorTextOf(element)
    expect(text).toContain('Scanning is not available here')
    expect(text).toContain('type the 8-character code')
  })

  it('reports the unavailable state through the REAL dynamically imported fallback', async () => {
    // No sourceFactory: this runs the installed html5-qrcode against a browser with no
    // mediaDevices at all, which is exactly what its own start() reports as unsupported.
    const { element } = renderScanner({ isNativeDetectorAvailable: () => false })

    await vi.waitFor(() => {
      expect(errorTextOf(element)).toContain('Scanning is not available here')
    })
  })

  it('keeps scanning when a frame cannot be read', async () => {
    stubCamera(() => Promise.resolve(fakeStream([fakeTrack()])))
    const detector: BarcodeDetectorLike = { detect: vi.fn(async () => Promise.reject(new Error('no frame'))) }
    const { element } = renderScanner({ detectorFactory: () => detector })
    await settle()

    // A rejected frame is not a failure: the loop must keep asking for the next one.
    await vi.waitFor(() => {
      expect(detectCalls(detector)).toBeGreaterThan(1)
    })
    expect(element.querySelector('.qr-scanner__error')).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

describe('QRScanner — a decoded payload (PLAN.md §7 Flow A, §16 Phase 6)', () => {
  it('hands the caller the CODE, once, and gives the camera back', async () => {
    const onScan = vi.fn()
    const source = fakeSource()
    renderScanner({ isNativeDetectorAvailable: () => false, sourceFactory: () => source, onScan })
    await settle()

    sourceDecodes(source, SESSION_URL)

    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith(SESSION_CODE)
    expect(source.stop).toHaveBeenCalledTimes(1)

    // A later frame with the same code must not scan again.
    sourceDecodes(source, SESSION_URL)
    expect(onScan).toHaveBeenCalledTimes(1)
  })

  it('ignores QR codes that are not QRDrop session URLs, and keeps scanning', async () => {
    const onScan = vi.fn()
    const source = fakeSource()
    renderScanner({ isNativeDetectorAvailable: () => false, sourceFactory: () => source, onScan })
    await settle()

    // Right shape, another origin: a camera sees whatever is held in front of it, so
    // anything that is not this app's own session URL must be ignored.
    sourceDecodes(source, 'https://evil.example/session?code=A7X3K9P2')
    sourceDecodes(source, `https://evil.example/base?to=${encodeURIComponent(SESSION_URL)}`)
    sourceDecodes(source, 'http://localhost:5173/library?code=A7X3K9P2')
    sourceDecodes(source, 'not a url at all')

    expect(onScan).not.toHaveBeenCalled()
    expect(source.stop).not.toHaveBeenCalled()

    // Still scanning: a real code arriving next is honoured.
    sourceDecodes(source, SESSION_URL)
    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith(SESSION_CODE)
  })

  it('drives the native poll loop and stops the camera on a successful scan', async () => {
    const tracks = [fakeTrack(), fakeTrack()]
    stubCamera(() => Promise.resolve(fakeStream(tracks)))
    const onScan = vi.fn()
    // The fake detector decodes on every frame: the component must still scan once.
    const detector = fakeDetector([SESSION_URL])
    renderScanner({ detectorFactory: () => detector, onScan })
    await settle()

    await vi.waitFor(() => {
      expect(onScan).toHaveBeenCalledTimes(1)
    })

    expect(onScan).toHaveBeenCalledWith(SESSION_CODE)
    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalledTimes(1)
    }

    // The loop stopped with the camera: no further detections after the scan.
    const detectionsAtScan = detectCalls(detector)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(detectCalls(detector)).toBe(detectionsAtScan)
    expect(onScan).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Teardown: no camera may survive any exit (PLAN.md §17)
// ---------------------------------------------------------------------------

describe('QRScanner — teardown (PLAN.md §17: no leaked camera)', () => {
  it('cancels: the caller is told and the camera is stopped', async () => {
    const tracks = [fakeTrack()]
    stubCamera(() => Promise.resolve(fakeStream(tracks)))
    const onCancel = vi.fn()
    const { element } = renderScanner({ onCancel })
    await settle()

    clickCancel(element)

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1)
  })

  it('stops every track when the overlay unmounts', async () => {
    const tracks = [fakeTrack(), fakeTrack()]
    stubCamera(() => Promise.resolve(fakeStream(tracks)))
    const detector = silentDetector()
    const { unmount } = renderScanner({ detectorFactory: () => detector })
    await settle()

    unmount()

    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalledTimes(1)
    }

    const detectionsAtUnmount = detectCalls(detector)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(detectCalls(detector)).toBe(detectionsAtUnmount)
  })

  it('stops the fallback source on cancel', async () => {
    const source = fakeSource()
    const onCancel = vi.fn()
    const { element } = renderScanner({
      isNativeDetectorAvailable: () => false,
      sourceFactory: () => source,
      onCancel,
    })
    await settle()

    clickCancel(element)

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(source.stop).toHaveBeenCalledTimes(1)
  })

  it('returns a camera that arrives after the overlay was closed', async () => {
    const tracks = [fakeTrack()]
    const pending = deferred()
    stubCamera(() => pending.promise.then(() => fakeStream(tracks)))
    const onScan = vi.fn()
    const { unmount } = renderScanner({ onScan })
    await settle()

    // The user dismissed the overlay while the permission prompt was still up.
    unmount()
    pending.resolve()
    await settle()

    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1)
    expect(onScan).not.toHaveBeenCalled()
  })

  it('stops a fallback source whose start resolves after the overlay was closed', async () => {
    const pending = deferred()
    const source = fakeSource(async (_surface: HTMLElement) => pending.promise)
    const { unmount } = renderScanner({
      isNativeDetectorAvailable: () => false,
      sourceFactory: () => source,
    })
    await settle()
    expect(source.start).toHaveBeenCalledTimes(1)

    unmount()
    expect(source.stop).not.toHaveBeenCalled()

    pending.resolve()
    await settle()

    expect(source.stop).toHaveBeenCalledTimes(1)
  })
})

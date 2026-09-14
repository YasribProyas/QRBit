/**
 * QR detection seam (PLAN.md §16 Phase 6, §19 decision 11).
 *
 * Two strategies sit behind one small interface so that `QRScanner.tsx` — and every
 * test of it — can run without a camera, a decoder or a browser:
 *
 *   - NATIVE: `BarcodeDetector` (Chrome/Android). Decision 11 puts it first because it
 *     is hardware-accelerated, cheaper on battery, and needs no download. It exposes a
 *     per-frame `detect(source)`, so the caller owns the camera and the polling loop
 *     (`createNativeDetector`).
 *   - FALLBACK: `html5-qrcode` for Safari and older browsers. It owns its own camera,
 *     its own scan loop and its own <video> surface, and hands decoded payloads back
 *     through `BarcodeSource.onDecode` (`createHtml5QrcodeSource`).
 *
 * The library is imported DYNAMICALLY: it drags in a ZXing build, and a browser with a
 * native detector must never pay for that. Vite splits the dynamic import into its own
 * chunk, so the fallback is fetched only by browsers that take that branch.
 *
 * This module holds no state and touches no camera of its own; lifecycle (including
 * stopping every camera track) belongs to the component that mounts a source.
 *
 * The session-URL validation lives here too, because it is the decoder's counterpart:
 * a camera can decode anything, and only a QRDrop session URL may become a navigation.
 */

import { APP_URL } from '../config'

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * The one method the scanner needs from a native `BarcodeDetector`. Declared
 * structurally so tests can hand in a plain object and so this module does not depend
 * on a DOM lib that may or may not declare `BarcodeDetector`.
 */
export interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
}

/**
 * A self-driving scan source: it opens its own camera, runs its own decode loop and
 * pushes every decoded payload through `onDecode`.
 *
 * `start` receives the container element the source may render its camera surface
 * into. For the html5-qrcode fallback that is a plain container, not a bare <video>:
 * the library creates and appends its own video element, so nesting it inside a video
 * element of ours would render nothing.
 */
export interface BarcodeSource {
  start(surface: HTMLElement): Promise<void>
  /** Stops the scan loop and the camera. Safe when `start` never ran. */
  stop(): void
  /**
   * Decoded payloads, in arrival order. The caller sets this before `start`; the
   * source keeps scanning regardless of what the caller does with a payload.
   */
  onDecode?: (rawValue: string) => void
}

/** Structural view of the native constructor, for browsers that declare it as a value. */
interface BarcodeDetectorConstructor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike
}

// ---------------------------------------------------------------------------
// Native path
// ---------------------------------------------------------------------------

/**
 * The native detector, or `undefined` where the browser has none.
 *
 * `'BarcodeDetector' in globalThis` would also be true for a property that was set to
 * `undefined`; requiring a function is that check plus the guarantee that `new` works.
 */
function nativeDetectorConstructor(): BarcodeDetectorConstructor | undefined {
  const fromGlobal: unknown = Reflect.get(globalThis, 'BarcodeDetector')
  return typeof fromGlobal === 'function' ? (fromGlobal as BarcodeDetectorConstructor) : undefined
}

/** PLAN.md §19 decision 11: prefer the native detector when the browser has one. */
export function isBarcodeDetectorAvailable(): boolean {
  return nativeDetectorConstructor() !== undefined
}

/**
 * Wraps `globalThis.BarcodeDetector` as a {@link BarcodeDetectorLike}.
 *
 * QR only: the scanner's job is a QRDrop session URL, and narrowing the formats lets
 * the implementation skip work on the other symbologies.
 */
export function createNativeDetector(): BarcodeDetectorLike {
  const Detector = nativeDetectorConstructor()
  if (Detector === undefined) {
    throw new Error('BarcodeDetector is not available in this browser')
  }
  return new Detector({ formats: ['qr_code'] })
}

// ---------------------------------------------------------------------------
// Fallback path
// ---------------------------------------------------------------------------

/** Ids for containers the caller did not name; html5-qrcode only accepts an id. */
let generatedSurfaceIds = 0

/** html5-qrcode's constructor resolves the element by id, so the container needs one. */
function ensureElementId(surface: HTMLElement): string {
  if (surface.id !== '') return surface.id
  generatedSurfaceIds += 1
  const id = `qrdrop-qr-surface-${generatedSurfaceIds}`
  surface.id = id
  return id
}

/**
 * The `html5-qrcode` fallback (PLAN.md §19 decision 11: Safari and older browsers).
 *
 * The library owns the camera here: its own `getUserMedia` with the same rear-camera
 * constraint the native path uses, and its own decode loop. That is why the scanner
 * runs exactly one of the two paths — never both — or two cameras would open at once,
 * and on mobile the second request usually fails with `NotReadableError`.
 *
 * Teardown: `Html5Qrcode.stop()` closes the rendered camera, which stops every video
 * track (`jsdom`-free fact, see html5-qrcode's `camera/core-impl.js` `close()`), and
 * removes its own video element from the container.
 */
export function createHtml5QrcodeSource(): BarcodeSource {
  let scanner: Html5QrcodeInstance | null = null

  const source: BarcodeSource = {
    onDecode: undefined,

    async start(surface: HTMLElement): Promise<void> {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode')
      const instance = new Html5Qrcode(ensureElementId(surface), {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        // We only reach this path when the native detector is missing; do not let the
        // library re-check for it and pick a different decoder than we expect.
        useBarCodeDetectorIfSupported: false,
        verbose: false,
      })
      // Assigned before `start` resolves so a `stop()` racing the start still tears the
      // camera down: html5-qrcode rejects such a stop(), which the caller's `void`
      // catch absorbs (see `stop` below).
      scanner = instance
      await instance.start(
        // Rear camera, same constraint as the native path: the peer's QR is on a screen
        // in front of this device, not behind it.
        { facingMode: 'environment' },
        { fps: 10 },
        (decodedText: string) => {
          source.onDecode?.(decodedText)
        },
        // Per-frame "no code in this frame" reports arrive here. They are the normal
        // case while the user is still aiming, so there is nothing to do with them.
        () => undefined,
      )
    },

    stop(): void {
      const instance = scanner
      scanner = null
      if (instance === null) return
      // `Html5Qrcode.stop()` rejects when it was never actually scanning (a start that
      // failed, or a stop racing one). The camera tracks are already closed in that
      // case, and there is nothing the caller could do about a teardown rejection.
      void instance.stop().catch(() => undefined)
    },
  }

  return source
}

/** The slice of `Html5Qrcode` this module uses; the class itself is imported lazily. */
interface Html5QrcodeInstance {
  start(
    camera: MediaTrackConstraints,
    config: { fps: number },
    onSuccess: (decodedText: string) => void,
    onError: () => void,
  ): Promise<unknown>
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// Payload validation (PLAN.md §3, §8, §16 Phase 6)
// ---------------------------------------------------------------------------

/** The only path a scan may act on (PLAN.md §8: `/session?code=XXXXXXXX`). */
const SESSION_PATH = '/session'

/**
 * The Phase 1 session-code alphabet, mirrored from `apps/signaling-worker/src/codes.ts`
 * (`SESSION_CODE_ALPHABET`). The frontend does not depend on the worker package, so the
 * alphabet is restated here — 30 symbols, with the glyphs that get misread by eye
 * (0, 1, I, L, O, U) left out.
 */
const SESSION_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

/** `SESSION_CODE_LENGTH` in the worker's `codes.ts`. */
const SESSION_CODE_LENGTH = 8

/** A well-formed session code: 8 characters, all from the alphabet, exactly as issued. */
function isSessionCode(value: string): boolean {
  if (value.length !== SESSION_CODE_LENGTH) return false
  for (const character of value) {
    if (!SESSION_CODE_ALPHABET.includes(character)) return false
  }
  return true
}

/**
 * The session code inside a scanned payload, or `null` if the payload is not a QRDrop
 * session URL.
 *
 * A camera can decode anything — a shop poster, another app's QR — so a scanned value
 * is untrusted input (PLAN.md §16 Phase 6: "do not navigate on arbitrary URLs"). Only a
 * URL that (a) is on this app's own origin, (b) targets `/session`, and (c) carries a
 * well-formed Phase 1 code is accepted; everything else is ignored and scanning
 * continues.
 *
 * The code is returned VERBATIM: the worker issues codes from the uppercase alphabet
 * and does not normalise a lookup, so folding case here could send a code the worker
 * will never find.
 *
 * @param rawValue the decoded QR payload
 * @param appUrl this app's origin (an origin or a full URL) — `config.APP_URL` by default
 */
export function parseSessionCode(rawValue: string, appUrl: string = APP_URL): string | null {
  let scanned: URL
  let ownOrigin: string
  try {
    scanned = new URL(rawValue.trim())
    ownOrigin = new URL(appUrl).origin
  } catch {
    return null
  }

  if (scanned.origin !== ownOrigin) return null
  if (scanned.pathname !== SESSION_PATH) return null

  const code = scanned.searchParams.get('code')
  if (code === null || !isSessionCode(code)) return null

  return code
}

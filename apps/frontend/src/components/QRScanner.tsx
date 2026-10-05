/**
 * QR scanner overlay (PLAN.md §7 Flow A, §8, §16 Phase 6, §19 decision 11).
 *
 * This is the device that reads a PEER's session QR: the code it finds becomes
 * `/session?code=XXXXXXXX`, which opens the session as the guest (PLAN.md §8). The
 * component therefore has no router and no notion of what a scan means — it reports the
 * code through `onScan` and lets the caller decide (Home's "Scan & Send" queue, or a
 * plain join).
 *
 * Detection has two mutually exclusive paths, never both at once:
 *
 *   NATIVE (PLAN.md §19 decision 11) — the browser has `BarcodeDetector`. This component
 *   opens the rear camera itself and polls `detect(video)` a few times a second.
 *
 *   FALLBACK — no `BarcodeDetector` (Safari and older browsers), so `html5-qrcode` runs
 *   the camera and the scan loop for us and reports payloads through `onDecode`. The
 *   library is dynamically imported, so the native path never downloads it.
 *
 * Cameras are a scarce resource: every exit — a successful scan, cancel, a failed start
 * and unmount — stops every track, stops the loop, and stops the fallback source. A
 * camera left running is a privacy bug, not a leak that shows up in a profile.
 *
 * The copy this component renders is the whole error story for the user: a permission
 * prompt they dismissed, a device with no camera, and a browser where neither path
 * could start all need different instructions ("fix the permission" vs "close the other
 * app" vs "just open the link"), and the wrong one sends them hunting for a problem
 * they do not have.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { Button, Stack, Text, Title } from '@mantine/core'
import { IconX } from '@tabler/icons-react'

import {
  createHtml5QrcodeSource,
  createNativeDetector,
  isBarcodeDetectorAvailable,
  parseSessionCode,
} from '../lib/barcode'
import type { BarcodeDetectorLike, BarcodeSource } from '../lib/barcode'
import { ManualCodeEntry } from './ManualCodeEntry'
import { WithMantine } from './common/WithMantine'

/**
 * The rear camera: the peer's QR is on a screen held in front of this device, so the
 * world-facing camera is the only useful one (PLAN.md §16 Phase 6).
 */
const CAMERA_CONSTRAINTS: MediaStreamConstraints = { video: { facingMode: 'environment' } }

/**
 * How often the native path reads a frame. ~8 times a second is comfortably enough to
 * catch a code held up to the camera and cheap enough not to warm the phone, which is
 * the reason decision 11 prefers the native detector in the first place.
 */
const DETECT_INTERVAL_MS = 120

/** Which detection strategy this mount uses; decided once, before any camera opens. */
type ScannerKind = 'native' | 'fallback'

/** Why the scanner cannot continue, as the three situations that need different advice. */
export type ScannerFailureKind = 'permission-denied' | 'no-camera' | 'unavailable'

interface ScannerFailureCopy {
  title: string
  message: string
  /** The "how to fix it" line; every failure here is recoverable some way. */
  hint: string
}

const FAILURE_COPY: Readonly<Record<ScannerFailureKind, ScannerFailureCopy>> = {
  'permission-denied': {
    title: 'Camera access is blocked',
    message: 'QRward needs the camera to read a code.',
    hint:
      'Allow camera access for this site, then open the scanner again: tap the lock or ⓘ icon in the address bar → Permissions → Camera → Allow. On iOS, use Settings → Safari → Camera.',
  },
  'no-camera': {
    title: 'No camera found',
    message: 'This device has no camera the browser can use.',
    hint: 'If another app is using the camera, close it and open the scanner again.',
  },
  unavailable: {
    title: 'Scanning is not available here',
    message: 'This browser has no QR scanner QRward can use.',
    hint:
      'You can still pair: open the session link on the other device, or type the 8-character code by hand.',
  },
}

/**
 * `DOMException.name` values for a blocked camera.
 *
 * `NotAllowedError` is the ordinary "user said no" and the one browsers report when a
 * policy blocked it without asking.
 */
const PERMISSION_FAILURES = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError']

/**
 * `DOMException.name` values for a camera that is not there to be used.
 *
 * `NotReadableError` is the "another app has it" case and `OverconstrainedError` the
 * "this device cannot do the requested camera" case — both are answered by the same
 * advice as a missing camera.
 */
const CAMERA_UNAVAILABLE_FAILURES = [
  'NotFoundError',
  'DevicesNotFoundError',
  'NotReadableError',
  'OverconstrainedError',
]

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return ''
  const { name } = error as { name?: unknown }
  return typeof name === 'string' ? name : ''
}

/**
 * Maps a camera-start failure onto the copy that can actually help.
 *
 * Two shapes arrive here: `getUserMedia` rejects with a `DOMException`, and the
 * html5-qrcode fallback rejects with a STRING that wraps the original (`"Error getting
 * userMedia, error = NotAllowedError: Permission denied"`). Matching on the name and on
 * the rendered text covers both without guessing at either one's internals.
 */
export function classifyCameraFailure(error: unknown): ScannerFailureKind {
  const text = `${errorName(error)} ${String(error)}`
  if (PERMISSION_FAILURES.some((name) => text.includes(name))) return 'permission-denied'
  if (CAMERA_UNAVAILABLE_FAILURES.some((name) => text.includes(name))) return 'no-camera'
  return 'unavailable'
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

export interface QRScannerProps {
  /**
   * A decoded QRBit payload, reduced to the session CODE (never the URL). Called at
   * most once per mount, after the camera has been stopped.
   */
  onScan: (code: string) => void
  /** The user dismissed the scanner. */
  onCancel: () => void
  /**
   * Injection seam for tests: whether the native `BarcodeDetector` path should be used.
   * Defaults to the real feature check.
   */
  isNativeDetectorAvailable?: () => boolean
  /** Injection seam for tests: the native detector. Defaults to `BarcodeDetector`. */
  detectorFactory?: () => BarcodeDetectorLike
  /** Injection seam for tests: the fallback source. Defaults to `html5-qrcode`. */
  sourceFactory?: () => BarcodeSource
}

// Geometry and the few colours that carry meaning here. The `qr-scanner__*` class names are
// behaviour and test hooks (styles.css has no rules for them), so the appearance of this
// surface lives with the component that owns it.
//
// Every colour is a token, because the surface has to be legible in both schemes: the scrim is
// the page colour at 85% (so it darkens with a dark page and lifts with a light one), the
// letterbox behind the video is the sunken surface, and the aim frame is signal blue — the one
// hue that means *put the thing here* (DESIGN.md, "The Meaningful Colour Rule").
const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--qrbit-space-lg)',
  background: 'color-mix(in srgb, var(--qrbit-canvas) 85%, transparent)',
}

const PANEL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--qrbit-space-md)',
  width: 'min(100%, 420px)',
  // A dialog genuinely floats above the page, so it is the one place the sheet shadow is
  // allowed (DESIGN.md, "The Floating Only Rule"); in the dark scheme that token is the
  // hairline, not a shadow.
  padding: 'var(--qrbit-space-lg)',
  background: 'var(--qrbit-raised)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-lg)',
  boxShadow: 'var(--qrbit-shadow-sheet)',
}

const STAGE_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '1 / 1',
  overflow: 'hidden',
  borderRadius: 'var(--qrbit-radius-md)',
  background: 'var(--qrbit-sunken)',
}

/** The camera surface: the native <video>, or the container html5-qrcode fills. */
const SURFACE_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
}

const VIEWFINDER_STYLE: CSSProperties = {
  position: 'absolute',
  inset: '18%',
  border: '2px solid var(--qrbit-signal)',
  borderRadius: 'var(--qrbit-radius-md)',
  boxShadow: '0 0 12px color-mix(in srgb, var(--qrbit-signal) 40%, transparent)',
  pointerEvents: 'none',
}

/**
 * The one authored moment on this surface: the sweep line (`scanSweep` in styles.css, which
 * also stops it under `prefers-reduced-motion`). It is the only moving thing here and it
 * means "reading frames", so it is a gradient across the aim band rather than a glowing
 * laser — a zero-blur coloured halo is decoration, not depth.
 */
const SWEEP_STYLE: CSSProperties = {
  position: 'absolute',
  left: '18%',
  right: '18%',
  top: 0,
  height: 2,
  background:
    'linear-gradient(to right, transparent, var(--qrbit-border-strong), transparent)',
  pointerEvents: 'none',
}

/** The live scanner session, as one idempotent teardown the UI can call. */
type StopScanning = () => void

export function QRScanner({
  onScan,
  onCancel,
  isNativeDetectorAvailable: isNativeAvailable,
  detectorFactory,
  sourceFactory,
}: QRScannerProps): JSX.Element {
  const titleId = useId()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  // Decided once per mount, before any camera opens: the two paths are mutually
  // exclusive by construction, so no device can ever be asked for two cameras.
  const [kind] = useState<ScannerKind>(() =>
    (isNativeAvailable ?? isBarcodeDetectorAvailable)() ? 'native' : 'fallback',
  )
  const [failure, setFailure] = useState<ScannerFailureKind | null>(null)
  const [showManualEntry, setShowManualEntry] = useState(false)

  const stopScanningRef = useRef<StopScanning | null>(null)

  // The caller's callbacks are read through refs, so an inline arrow prop (a new
  // function identity per render, which is what pages pass) cannot restart the camera.
  // These are declared before the camera effect: on mount they run first.
  const onScanRef = useRef(onScan)
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onScanRef.current = onScan
    onCancelRef.current = onCancel
  })

  useEffect(() => {
    /** No further payloads, no further scanning. */
    let stopped = false
    /** Every resource has been handed back; makes teardown idempotent. */
    let released = false
    let timer: ReturnType<typeof setInterval> | null = null
    let stream: MediaStream | null = null
    let detector: BarcodeDetectorLike | null = null
    /** One `detect` at a time: a slow frame must not queue up behind the interval. */
    let detecting = false

    let source: BarcodeSource | null = null
    /** True once `start` resolved, which is when the source actually holds a camera. */
    let sourceStarted = false

    const release = (): void => {
      if (released) return
      released = true

      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      if (sourceStarted && source !== null) {
        const active = source
        source = null
        active.stop()
      }
      if (stream !== null) {
        const active = stream
        stream = null
        stopTracks(active)
      }
      detector = null
    }

    const stop = (): void => {
      stopped = true
      release()
    }

    const fail = (reason: ScannerFailureKind): void => {
      if (stopped) return
      stop()
      setFailure(reason)
    }

    const handlePayload = (rawValue: string): void => {
      if (stopped) return
      // Not a QRBit session URL: keep scanning. A camera sees whatever is in front of
      // it, and only our own session URLs may become a navigation (PLAN.md §16 Phase 6).
      const code = parseSessionCode(rawValue)
      if (code === null) return
      stop()
      onScanRef.current(code)
    }

    const poll = (): void => {
      const video = videoRef.current
      if (stopped || detecting || detector === null || video === null) return
      detecting = true
      void detector.detect(video).then(
        (results) => {
          detecting = false
          for (const result of results) handlePayload(result.rawValue)
        },
        () => {
          // A frame the detector could not read (the camera is still warming up, or the
          // frame had no code in it) is ordinary, not a failure: keep polling.
          detecting = false
        },
      )
    }

    const start = async (): Promise<void> => {
      if (kind === 'native') {
        const media = navigator.mediaDevices
        if (media === undefined) {
          fail('unavailable')
          return
        }

        let requested: MediaStream
        try {
          requested = await media.getUserMedia(CAMERA_CONSTRAINTS)
        } catch (error: unknown) {
          fail(classifyCameraFailure(error))
          return
        }

        // Cancelled while the permission prompt was up: hand the camera straight back.
        if (stopped) {
          stopTracks(requested)
          return
        }
        stream = requested

        const video = videoRef.current
        if (video === null) {
          fail('unavailable')
          return
        }
        video.srcObject = requested

        let nativeDetector: BarcodeDetectorLike
        try {
          nativeDetector = (detectorFactory ?? createNativeDetector)()
        } catch {
          fail('unavailable')
          return
        }
        detector = nativeDetector
        timer = setInterval(poll, DETECT_INTERVAL_MS)
        return
      }

      const surface = surfaceRef.current
      if (surface === null) {
        fail('unavailable')
        return
      }

      const created = (sourceFactory ?? createHtml5QrcodeSource)()
      source = created
      created.onDecode = handlePayload

      try {
        await created.start(surface)
      } catch (error: unknown) {
        fail(classifyCameraFailure(error))
        return
      }

      sourceStarted = true
      if (stopped) {
        // The overlay was closed while the library was still opening its camera: the
        // teardown that already ran could not stop a source that had not started yet.
        created.stop()
        source = null
      }
    }

    void start()
    stopScanningRef.current = stop

    return () => {
      stop()
      stopScanningRef.current = null
    }
  }, [kind, detectorFactory, sourceFactory])

  const handleCancel = (): void => {
    stopScanningRef.current?.()
    onCancelRef.current()
  }

  return (
    <WithMantine>
      <div
        className="qr-scanner"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={OVERLAY_STYLE}
      >
        <div className="qr-scanner__panel" style={PANEL_STYLE}>
          <Title order={2} id={titleId} className="qr-scanner__title">
            Scan a QRward code
          </Title>

          {failure === null ? (
            <>
              <div className="qr-scanner__stage" style={STAGE_STYLE}>
                {kind === 'native' ? (
                  // muted + playsinline: without them the browser refuses to autoplay the
                  // stream and shows a black rectangle instead (PLAN.md §16 Phase 6).
                  <video
                    className="qr-scanner__video"
                    ref={videoRef}
                    style={SURFACE_STYLE}
                    autoPlay
                    muted
                    playsInline
                  />
                ) : (
                  // The fallback's own container, and NOTHING else may live inside it:
                  // html5-qrcode empties its container on start (`element.innerHTML = ""`),
                  // so a React-managed node in there is deleted behind React's back and the
                  // next commit fails to unmount it. The viewfinder stays outside.
                  <div className="qr-scanner__surface" ref={surfaceRef} style={SURFACE_STYLE} />
                )}
                {/* Sweep and viewfinder are siblings of the camera surface, never children. */}
                <div className="qr-scanner__sweep animate-scan-sweep" style={SWEEP_STYLE} aria-hidden="true" />
                <div className="qr-scanner__viewfinder" style={VIEWFINDER_STYLE} aria-hidden="true" />
              </div>

              {showManualEntry ? (
                <div
                  className="qr-scanner__manual-entry"
                  style={{
                    borderTop: '1px solid var(--qrbit-border)',
                    paddingTop: 'var(--qrbit-space-sm)',
                  }}
                >
                  <ManualCodeEntry
                    onSubmit={(code) => {
                      stopScanningRef.current?.()
                      onScanRef.current(code)
                    }}
                  />
                </div>
              ) : (
                <Button
                  variant="subtle"
                  size="xs"
                  color="dimmed"
                  onClick={() => setShowManualEntry(true)}
                >
                  Enter code manually instead
                </Button>
              )}
            </>
          ) : (
            <>
              <div className="qr-scanner__error" role="alert">
                <Stack gap="xs">
                  <Text className="qrbit-text-title" c="danger" component="p">
                    {FAILURE_COPY[failure].title}
                  </Text>
                  <Text className="qrbit-text-body" component="p">
                    {FAILURE_COPY[failure].message}
                  </Text>
                  {/* The recovery, named: every failure here has one, and they are not the same. */}
                  <Text className="qrbit-text-body-secondary" c="dimmed" component="p">
                    {FAILURE_COPY[failure].hint}
                  </Text>
                </Stack>
              </div>

              <div
                className="qr-scanner__manual-fallback"
                style={{
                  borderTop: '1px solid var(--qrbit-border)',
                  paddingTop: 'var(--qrbit-space-sm)',
                }}
              >
                <Text size="sm" fw={500} c="var(--qrbit-ink)" mb="xs">
                  Enter 8-character code manually:
                </Text>
                <ManualCodeEntry
                  onSubmit={(code) => {
                    stopScanningRef.current?.()
                    onScanRef.current(code)
                  }}
                />
              </div>
            </>
          )}

          <Button
            className="qr-scanner__cancel tactile-btn"
            variant="default"
            size="md"
            w="100%"
            leftSection={<IconX size={16} aria-hidden="true" />}
            onClick={handleCancel}
          >
            Stop scanning
          </Button>
        </div>
      </div>
    </WithMantine>
  )
}

/**
 * This device's session QR panel (PLAN.md §3, §7, §16 Phase 6).
 *
 * Scanning this code is how a session starts, so what it encodes is the FULL session URL
 * built by `config.ts` — `https://<app>/session?code=XXXXXXXX`. A bare code would leave
 * the scanning camera app nothing to open (PLAN.md §3). Callers may hand over either an
 * already-built `url` (Home's call shape) or a `code` to build one from; never both, so
 * the code shown for manual entry cannot disagree with the code that was encoded.
 *
 * Three things make the result scannable by a phone at arm's length, and they are the
 * reason this is more than one line of `toCanvas`:
 *
 *   - Dark modules on a light panel. The app theme is dark, so the canvas paints its own
 *     light background and the renderer is given the QR palette explicitly; an inverted
 *     code is unreadable to most scanners.
 *   - A quiet zone, which the renderer draws from `margin` and which is pinned to the QR
 *     spec's four modules.
 *   - A bitmap at the device pixel ratio, so the modules stay crisp when the canvas is
 *     laid out at CSS size on a phone.
 *
 * A QR that will not draw must never block pairing, so the panel degrades along the path
 * Phase 1 already shipped: the raw code stays legible as text for manual entry at all
 * times (`/session?code=...` typed by hand), and a failed generation additionally prints
 * the whole URL for hand-copying.
 */

import { toCanvas } from 'qrcode'
import { useEffect, useRef, useState } from 'react'

import { APP_URL, buildSessionUrl } from '../config'

/** Where the session URL comes from: one of the two, never both. */
type SessionSource = { url: string; code?: undefined } | { url?: undefined; code: string }

export type QRDisplayProps = SessionSource & {
  /** Rendered width of the code in CSS pixels. */
  size?: number
  caption?: string
  /**
   * Asks for a fresh session code (PLAN.md §7's "tap to refresh"). Starting a session is
   * the caller's job, so the control only exists when a callback is supplied.
   */
  onRefresh?: () => void
}

/** Default rendered size. Matches the frame's inner width (styles.css: 18rem less padding). */
const DEFAULT_SIZE = 256

/**
 * The error-correction floor for a screen-to-camera scan: the redundancy buys back a
 * reflection or a slightly soft focus, and level M still keeps a session URL at 29 modules
 * (version 3), which is roughly 7 pixels per module at the default size.
 */
const QR_ERROR_CORRECTION_LEVEL = 'M'

/** The QR spec's quiet zone, in modules. The renderer's default, pinned so it cannot drift. */
const QR_QUIET_ZONE_MODULES = 4

/** The QR palette. `qrcode` parses RGBA hex, so the alpha byte is explicit. */
const QR_DARK_MODULES = '#000000ff'
const QR_LIGHT_MODULES = '#ffffffff'

/** The same light colour as CSS: painted behind the canvas, so the panel is light even before the draw. */
const QR_LIGHT_PANEL = QR_LIGHT_MODULES.slice(0, 7)

/**
 * PLAN.md §7's "enlarge": twice the rendered size, capped so the code still fits a laptop
 * panel instead of swallowing the library below it.
 */
const ENLARGED_SCALE = 2
const ENLARGED_MAX_SIZE = 512

/**
 * Rendering above this ratio costs bitmap memory without adding detail a camera can use.
 */
const MAX_PIXEL_RATIO = 3

type GenerationStatus = 'generating' | 'ready' | 'error'

/**
 * The session code inside a session URL, or `null` when the URL carries none.
 *
 * Derived from the URL rather than taken from a second prop, so the code offered for manual
 * entry is always the code that was encoded.
 */
function sessionCodeFrom(url: string): string | null {
  try {
    const code = new URL(url, APP_URL).searchParams.get('code')
    return code === null || code.trim() === '' ? null : code
  } catch {
    return null
  }
}

/** The URL to encode and the code to print, from whichever source the caller supplied. */
function resolveSource(source: SessionSource): { url: string; code: string | null } {
  if (source.url !== undefined) {
    return { url: source.url, code: sessionCodeFrom(source.url) }
  }
  return { url: buildSessionUrl(source.code), code: source.code }
}

/**
 * The canvas bitmap size in device pixels.
 *
 * The canvas is laid out in CSS pixels but rasterised in its own pixel grid, so a bitmap
 * rendered at one pixel per CSS pixel is upscaled (and blurred) on any modern phone. The
 * ratio is clamped because past 3× the extra pixels are invisible to a camera.
 */
function bitmapSize(cssSize: number): number {
  const ratio = window.devicePixelRatio
  const usable = Number.isFinite(ratio) && ratio > 1 ? Math.min(ratio, MAX_PIXEL_RATIO) : 1
  return Math.round(cssSize * usable)
}

export function QRDisplay(props: QRDisplayProps) {
  const { caption = 'Scan this to send files here', size = DEFAULT_SIZE, onRefresh } = props
  const { url, code } = resolveSource(props)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState<GenerationStatus>('generating')
  const [enlarged, setEnlarged] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return undefined

    let cancelled = false
    setStatus('generating')

    /*
     * A code that will not draw is a normal outcome, not a crash: a browser with canvas
     * disabled, a test environment without a renderer, or a renderer failure all land here
     * and all must leave the manual fallback on screen. The 2D context is checked first
     * because the renderer dereferences it without a guard, which would otherwise surface
     * as an unhelpful TypeError from inside the library.
     */
    const draw = async (): Promise<void> => {
      try {
        if (canvas.getContext('2d') === null) {
          if (!cancelled) setStatus('error')
          return
        }

        await toCanvas(canvas, url, {
          errorCorrectionLevel: QR_ERROR_CORRECTION_LEVEL,
          margin: QR_QUIET_ZONE_MODULES,
          width: bitmapSize(size),
          color: { dark: QR_DARK_MODULES, light: QR_LIGHT_MODULES },
        })

        if (!cancelled) setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      } finally {
        /*
         * The renderer writes the bitmap's pixel size into `canvas.style`, which would
         * outrank this element's CSS size. Take the sizing back after every draw, whether
         * it succeeded or not.
         */
        canvas.style.width = '100%'
        canvas.style.height = 'auto'
      }
    }

    void draw()

    // Unmount, a new URL, or a new size: whatever is in flight is stale and must not reach
    // state, which is also what keeps React from being updated after unmount.
    return () => {
      cancelled = true
    }
  }, [url, size])

  const ariaLabel = code === null ? `QR code pairing for ${url}` : `QR code pairing for session ${code}`

  return (
    <div className="qr">
      <div className="qr__frame" style={enlarged ? { maxWidth: '100%' } : undefined}>
        {status === 'generating' ? (
          <span className="qr__placeholder-label" role="status">
            Generating QR…
          </span>
        ) : null}
        {status === 'error' ? (
          <>
            <span className="qr__placeholder-label">QR unavailable</span>
            <code className="qr__url">{url}</code>
          </>
        ) : null}
        <canvas
          ref={canvasRef}
          className="qr__canvas"
          role="img"
          aria-label={ariaLabel}
          style={{
            // Kept mounted so the draw always has a canvas to target; hidden until it holds
            // something worth showing, so a half-drawn code is never on screen.
            display: status === 'ready' ? 'block' : 'none',
            width: '100%',
            height: 'auto',
            maxWidth: `${enlarged ? Math.min(size * ENLARGED_SCALE, ENLARGED_MAX_SIZE) : size}px`,
            background: QR_LIGHT_PANEL,
          }}
        />
      </div>
      <p className="qr__caption">{caption}</p>
      {/* PLAN.md §16 Phase 6's manual fallback: the code is always readable, QR or not. */}
      <p className="qr__caption">
        Manual entry: <code className="qr__url">{code ?? url}</code>
      </p>
      <div className="qr__actions">
        <button
          type="button"
          className="button button--link"
          aria-pressed={enlarged}
          onClick={() => {
            setEnlarged((current) => !current)
          }}
        >
          {enlarged ? 'Shrink QR' : 'Enlarge QR'}
        </button>
        {onRefresh ? (
          <button type="button" className="button button--link" onClick={onRefresh}>
            New code
          </button>
        ) : null}
      </div>
    </div>
  )
}

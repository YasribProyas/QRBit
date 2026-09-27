/**
 * This device's session QR panel (PLAN.md §3, §7, §16 Phase 6).
 *
 * Upgraded with Mantine UI: sleek presentation card, large high-contrast canvas,
 * and fullscreen projection modal on enlarge for easy scanning across rooms or displays.
 */

import { toCanvas } from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { Modal } from '@mantine/core'
import { APP_URL, buildSessionUrl } from '../config'
import { WithMantine } from './common/WithMantine'

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
  const fullscreenCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState<GenerationStatus>('generating')
  const [enlarged, setEnlarged] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return undefined

    let cancelled = false
    setStatus('generating')

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
          color: {
            dark: QR_DARK_MODULES,
            light: QR_LIGHT_MODULES,
          },
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

    return () => {
      cancelled = true
    }
  }, [url, size])

  // Draw fullscreen canvas when enlarged modal is opened
  useEffect(() => {
    if (!enlarged) return
    const fsCanvas = fullscreenCanvasRef.current
    if (!fsCanvas || fsCanvas.getContext('2d') === null) return

    void toCanvas(fsCanvas, url, {
      errorCorrectionLevel: QR_ERROR_CORRECTION_LEVEL,
      margin: QR_QUIET_ZONE_MODULES,
      width: 480,
      color: {
        dark: QR_DARK_MODULES,
        light: QR_LIGHT_MODULES,
      },
    }).catch(() => {})
  }, [enlarged, url])

  const ariaLabel = code === null ? `QR code pairing for ${url}` : `QR code pairing for session ${code}`

  return (
    <WithMantine>
      <div className="qr">
        <div
          className="qr__frame"
          style={{
            ...(enlarged ? { maxWidth: '100%' } : {}),
            position: 'relative',
          }}
        >
          {/* Optical alignment ticks at 4 corners */}
          <div style={{ position: 'absolute', top: '6px', left: '6px', width: '10px', height: '10px', borderTop: '2px solid #1D4ED8', borderLeft: '2px solid #1D4ED8', pointerEvents: 'none', zIndex: 2 }} />
          <div style={{ position: 'absolute', top: '6px', right: '6px', width: '10px', height: '10px', borderTop: '2px solid #1D4ED8', borderRight: '2px solid #1D4ED8', pointerEvents: 'none', zIndex: 2 }} />
          <div style={{ position: 'absolute', bottom: '6px', left: '6px', width: '10px', height: '10px', borderBottom: '2px solid #1D4ED8', borderLeft: '2px solid #1D4ED8', pointerEvents: 'none', zIndex: 2 }} />
          <div style={{ position: 'absolute', bottom: '6px', right: '6px', width: '10px', height: '10px', borderBottom: '2px solid #1D4ED8', borderRight: '2px solid #1D4ED8', pointerEvents: 'none', zIndex: 2 }} />

          {/* Center reticle crosshair guides */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)', height: '1px', background: 'rgba(29, 78, 216, 0.12)', pointerEvents: 'none', zIndex: 2 }} />
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '1px', background: 'rgba(29, 78, 216, 0.12)', pointerEvents: 'none', zIndex: 2 }} />

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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginTop: '8px', marginBottom: '2px', fontSize: '12px', fontWeight: 600, color: '#0F766E' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10B981', display: 'inline-block' }} />
          <span>Beacon Ready · P2P Telemetry</span>
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

        {/* Fullscreen Enlarge Modal for easy scanning across rooms or on desktop */}
        <Modal
          opened={enlarged}
          onClose={() => setEnlarged(false)}
          fullScreen
          title="Session QR Code"
          styles={{
            header: { background: '#121316', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' },
            body: {
              background: '#0a0b0e',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 'calc(100vh - 60px)',
              padding: '2rem',
            },
          }}
        >
          <div
            style={{
              background: '#ffffff',
              padding: '1.5rem',
              borderRadius: '16px',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.9)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <canvas
              ref={fullscreenCanvasRef}
              style={{
                width: 'min(70vh, 80vw, 480px)',
                height: 'min(70vh, 80vw, 480px)',
                display: 'block',
              }}
            />
          </div>
          {code ? (
            <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
              <p style={{ color: '#909296', margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>
                Session Code
              </p>
              <code
                style={{
                  fontSize: '2.25rem',
                  fontWeight: 700,
                  letterSpacing: '0.22em',
                  fontFamily: 'monospace',
                  color: '#4ade80',
                }}
              >
                {code}
              </code>
            </div>
          ) : null}
          <button
            type="button"
            className="button"
            style={{ marginTop: '2rem', width: 'auto', padding: '0.75rem 2.5rem' }}
            onClick={() => setEnlarged(false)}
          >
            Close Fullscreen
          </button>
        </Modal>
      </div>
    </WithMantine>
  )
}

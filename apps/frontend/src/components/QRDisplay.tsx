/**
 * This device's session QR panel (PLAN.md §3, §7, §16 Phase 6).
 *
 * The drawing settings — quiet zone, error correction, device-pixel sizing — are shared with
 * the home pairing panel through `qrSurface.ts`, and the palette is deliberately not stated
 * here: the symbol has to be dark modules on a light field in BOTH schemes, because a scanner
 * measures luminance and every surface token in `styles.css` flips under `[data-theme]`. The
 * renderer's documented black/white pair supplies it, and `QRDisplay.test.tsx` pins the result
 * at the pixels. What the panel adds on top is a fixed light plate
 * (`--qrbit-signal-subtle`, defined once at `:root` and never redefined for dark) so the code
 * never sits on an inverted background, and an enlarge treatment that is a real Mantine
 * `Button` — reachable by tap and by keyboard, `aria-pressed` so the state is announced.
 *
 * The URL is always printed as text, whether the code drew or not: a QR that cannot be scanned
 * must still be typable, and a code that is only a picture is a code that can fail silently.
 */

import { toCanvas } from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Button, Group, Modal, Stack, Text, Title } from '@mantine/core'
import { IconArrowsMaximize, IconRefresh, IconX } from '@tabler/icons-react'
import { APP_URL, buildSessionUrl } from '../config'
import { WithMantine } from './common/WithMantine'
import { qrRenderOptions, releaseCanvasSizing } from './qrSurface'

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

/**
 * The resting size: the top of DESIGN.md's 195–240px band for the pairing panel, which is the
 * largest code that still fits the frame's inner width (18rem less padding) and stays readable
 * at arm's length.
 */
const DEFAULT_SIZE = 240

/** The plate behind the code: light in both schemes, for the reason given at the top. */
const WELL_STYLE = {
  background: 'var(--qrbit-signal-subtle)',
  borderRadius: 'var(--qrbit-radius-md)',
} as const

/** The corner reticles, one per corner, on the code's own well. */
const RETICLE_STYLE = {
  position: 'absolute',
  width: 'var(--qrbit-space-md)',
  height: 'var(--qrbit-space-md)',
  borderStyle: 'solid',
  borderColor: 'var(--qrbit-signal)',
  pointerEvents: 'none',
} as const

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

        await toCanvas(canvas, url, qrRenderOptions(size))

        if (!cancelled) setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      } finally {
        /*
         * The renderer writes the bitmap's pixel size into `canvas.style`, which would
         * outrank this element's CSS size. Take the sizing back after every draw, whether
         * it succeeded or not.
         */
        releaseCanvasSizing(canvas)
      }
    }

    void draw()

    return () => {
      cancelled = true
    }
  }, [url, size])

  /*
   * The enlarged code is a second canvas, drawn when the projection opens: a modal that
   * renders an empty box would be worse than no enlargement at all, and sizing the hidden
   * resting canvas to 480px would spend memory on pixels nobody is looking at.
   */
  useEffect(() => {
    if (!enlarged) return undefined
    const fullscreen = fullscreenCanvasRef.current
    if (fullscreen === null || fullscreen.getContext('2d') === null) return undefined

    let cancelled = false

    const draw = async (): Promise<void> => {
      try {
        await toCanvas(fullscreen, url, qrRenderOptions(480))
      } catch {
        // Nothing to project: the resting code and the printed URL still pair, and the
        // panel has no second error surface to light up.
      } finally {
        if (!cancelled) releaseCanvasSizing(fullscreen)
      }
    }

    void draw()

    return () => {
      cancelled = true
    }
  }, [enlarged, url])

  const ariaLabel = code === null ? `QR code pairing for ${url}` : `QR code pairing for session ${code}`

  return (
    <WithMantine>
      <div className="qr">
        <div
          className="qr__frame relative"
          style={{
            ...WELL_STYLE,
            padding: 'var(--qrbit-space-lg)',
            // `styles.css` still frames this box with the Phase-1 dashed placeholder border.
            // The code lives here now, so the division is a real 1px hairline (DESIGN.md,
            // "Panels and Rows"); the colour stays the token the stylesheet already picks.
            borderStyle: 'solid',
          }}
        >
          <span
            aria-hidden="true"
            style={{ ...RETICLE_STYLE, top: 'var(--qrbit-space-sm)', left: 'var(--qrbit-space-sm)', borderTopWidth: 2, borderLeftWidth: 2 }}
          />
          <span
            aria-hidden="true"
            style={{ ...RETICLE_STYLE, top: 'var(--qrbit-space-sm)', right: 'var(--qrbit-space-sm)', borderTopWidth: 2, borderRightWidth: 2 }}
          />
          <span
            aria-hidden="true"
            style={{ ...RETICLE_STYLE, bottom: 'var(--qrbit-space-sm)', left: 'var(--qrbit-space-sm)', borderBottomWidth: 2, borderLeftWidth: 2 }}
          />
          <span
            aria-hidden="true"
            style={{ ...RETICLE_STYLE, bottom: 'var(--qrbit-space-sm)', right: 'var(--qrbit-space-sm)', borderBottomWidth: 2, borderRightWidth: 2 }}
          />

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
              maxWidth: `${size}px`,
            }}
          />
        </div>

        <p className="qr__caption">{caption}</p>
        {/* PLAN.md §16 Phase 6's manual fallback: the code is always readable, QR or not. */}
        <p className="qr__caption">
          Manual entry: <code className="qr__url">{code ?? url}</code>
        </p>
        <Group
          className="qr__actions"
          justify="center"
          gap="xs"
          wrap="wrap"
          mt="xs"
        >
          <Button
            variant="subtle"
            size="sm"
            aria-pressed={enlarged}
            leftSection={<IconArrowsMaximize size={16} aria-hidden="true" />}
            onClick={() => {
              setEnlarged((current) => !current)
            }}
          >
            {enlarged ? 'Shrink QR' : 'Enlarge QR'}
          </Button>
          {onRefresh ? (
            <Button
              variant="subtle"
              size="sm"
              leftSection={<IconRefresh size={16} aria-hidden="true" />}
              onClick={onRefresh}
            >
              New code
            </Button>
          ) : null}
        </Group>

        {/* PLAN §7's "enlarge": the same code, projected for a phone across the room. */}
        <Modal
          opened={enlarged}
          onClose={() => setEnlarged(false)}
          fullScreen
          title="Scan this from the other device"
          styles={{
            content: { background: 'var(--qrbit-canvas)' },
            header: { background: 'var(--qrbit-raised)' },
            body: {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--qrbit-space-xl)',
              minHeight: 'calc(100vh - 60px)',
              padding: 'var(--qrbit-space-xxl)',
            },
          }}
        >
          <div
            className="qr__projected grid place-items-center"
            style={{ ...WELL_STYLE, padding: 'var(--qrbit-space-lg)' }}
          >
            <canvas
              ref={fullscreenCanvasRef}
              role="img"
              aria-label={ariaLabel}
              className="block"
              style={{
                width: 'min(70vh, 80vw, 480px)',
                height: 'min(70vh, 80vw, 480px)',
                maxWidth: '100%',
              }}
            />
          </div>
          {code ? (
            <Stack gap="xs" align="center">
              <Title order={3} className="qrbit-text-title" c="dimmed">
                Session code
              </Title>
              {/* styles.css's `.code` is the session-code primitive: mono, 24px, tracked. */}
              <code className="code">{code}</code>
            </Stack>
          ) : null}
          <Button
            variant="default"
            size="sm"
            leftSection={<IconX size={16} aria-hidden="true" />}
            onClick={() => setEnlarged(false)}
          >
            Close fullscreen
          </Button>
        </Modal>
      </div>
    </WithMantine>
  )
}

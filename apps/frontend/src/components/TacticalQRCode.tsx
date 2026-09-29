/**
 * The code a peer scans, drawn on the pairing panel (PLAN.md §7; ORCHESTRATION D13, D15).
 *
 * Two rules drive this component.
 *
 * 1. **It never draws a code the host has not joined.** There is no default `pairingCode`:
 *    the previous revision shipped one (`QRB-884-219`, a code no worker ever issued) and a
 *    `qrbit://` payload no device can open, so an unmounted panel displayed a scannable lie.
 *    `HomeView` mounts this only once a session code exists, which is D15's point in time.
 * 2. **Everything it paints is luminance-first.** Dark modules on a light field, a
 *    four-module quiet zone, a bitmap sized for the screen, and nothing overlapping the
 *    symbol: the old centred badge sat on real modules, the old crosshairs ran a tint across
 *    them, and the old one-module margin starved the finder patterns. The reticle corners
 *    are the panel's geometry (`HomeView`), not the code's furniture.
 *
 * The shared drawing settings are in `qrSurface.ts`; the colours are left to the renderer's
 * documented black-on-white default, for the reason recorded there.
 */

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { toCanvas } from 'qrcode'
import { ActionIcon, Button, Group, Loader, Stack, Text } from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconCopy, IconRefresh } from '@tabler/icons-react'

import { buildSessionUrl } from '../config'
import { WithMantine } from './common/WithMantine'
import { qrRenderOptions, releaseCanvasSizing } from './qrSurface'

export interface TacticalQRCodeProps {
  /**
   * The session code this device joined as host. Optional and with no default: a code this
   * component invented could only ever be scanned into a session nobody is waiting on.
   */
  pairingCode?: string
  /** A session URL supplied by the caller, which takes precedence over `pairingCode`. */
  sessionUrl?: string
  /** Starts a fresh session. The control appears only when the caller owns that action. */
  onRegenerate?: () => void
  /** Rendered width in CSS pixels. DESIGN.md's resting band for the pairing panel is 195–240. */
  size?: number
  /** Show the caption, the code as text and the code's own controls under the symbol. */
  showLabel?: boolean
  /** Hide the copy/regenerate controls: the caller renders the code without them. */
  interactive?: boolean
}

/** Which of the three states the surface is in; `error` always keeps the code typeable. */
type DrawState = 'drawing' | 'ready' | 'error'

/**
 * The light plate behind the code.
 *
 * `--qrbit-signal-subtle` is the one documented surface that does NOT flip under
 * `[data-theme='dark']`, so the well stays light on a near-black page instead of inverting
 * with the panel behind it (`--qrbit-raised` does exactly that, which is why it is not used
 * here). The symbol itself brings its own white quiet zone.
 */
const WELL_STYLE = {
  background: 'var(--qrbit-signal-subtle)',
  borderRadius: 'var(--qrbit-radius-md)',
  padding: 'var(--qrbit-space-md)',
} as const

/** Which of the three copy states the control is in — the code is always on screen anyway. */
type CopyState = 'idle' | 'copied' | 'blocked'

/**
 * What the copy control says it did. The blocked wording names the recovery, because the
 * code is printed next to the button and can be selected and copied by hand.
 */
const COPY_LABEL: Record<CopyState, string> = {
  idle: 'Copy the session link',
  copied: 'Session link copied',
  blocked: 'This browser blocked the copy — select the code and copy it yourself',
}

export function TacticalQRCode({
  pairingCode,
  sessionUrl,
  onRegenerate,
  size = 220,
  showLabel = true,
  interactive = true,
}: TacticalQRCodeProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [state, setState] = useState<DrawState>('drawing')
  const [copy, setCopy] = useState<CopyState>('idle')

  /** The URL the symbol carries — a real session URL, or nothing. */
  const payload = sessionUrl ?? (pairingCode ? buildSessionUrl(pairingCode) : null)
  const code = pairingCode ?? null

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || payload === null) return undefined

    // A browser (or a jsdom harness) without a 2D context cannot rasterise at all: go
    // straight to the text fallback instead of rejecting inside the renderer.
    if (canvas.getContext('2d') === null) {
      setState('error')
      return undefined
    }

    let cancelled = false
    setState('drawing')

    void toCanvas(canvas, payload, qrRenderOptions(size)).then(
      () => {
        releaseCanvasSizing(canvas)
        if (!cancelled) setState('ready')
      },
      () => {
        releaseCanvasSizing(canvas)
        if (!cancelled) setState('error')
      },
    )

    return () => {
      cancelled = true
    }
  }, [payload, size])

  /*
   * The confirmation is a state with a duration, not a latched switch: it clears itself so
   * the next copy reads as a copy rather than as the previous one.
   */
  useEffect(() => {
    if (copy === 'idle') return undefined
    const timer = window.setTimeout(() => setCopy('idle'), 1400)
    return () => window.clearTimeout(timer)
  }, [copy])

  const handleCopy = (): void => {
    if (payload === null) return
    // A browser with no clipboard API, or one that refuses the write, is answered with the
    // truth rather than a checkmark: the code stays on screen to copy by hand.
    const clipboard: Clipboard | undefined = navigator.clipboard
    if (clipboard === undefined) {
      setCopy('blocked')
      return
    }
    clipboard.writeText(payload).then(
      () => setCopy('copied'),
      () => setCopy('blocked'),
    )
  }

  /*
   * No code, nothing to draw. This is the branch that used to render a fabricated one
   * (`QRB-884-219`), which scanned into a session no worker had ever issued.
   */
  if (payload === null) {
    return (
      <WithMantine>
        <Text className="qrbit-text-body-secondary" c="dimmed" ta="center">
          No session code yet — this device has not joined one.
        </Text>
      </WithMantine>
    )
  }

  return (
    <WithMantine>
      <Stack align="center" gap="md" className="tactical-qr">
        <div className="tactical-qr__well" style={WELL_STYLE}>
          {/* The frame reserves the code's square so the panel does not jump when it lands. */}
          <div
            className="relative grid place-items-center"
            style={{ width: size, maxWidth: '100%', aspectRatio: '1 / 1' }}
          >
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={
                code === null ? `QR code pairing for ${payload}` : `QR code pairing for session ${code}`
              }
              className="absolute inset-0"
              style={{
                // Mounted always so a draw always has a target; hidden until it holds
                // something worth scanning, so a half-drawn code is never on screen.
                display: state === 'ready' ? 'block' : 'none',
                width: '100%',
                height: '100%',
              }}
            />
            {state === 'drawing' ? (
              <Group gap="xs" wrap="nowrap" role="status" aria-live="polite">
                <Loader size="sm" />
                <Text className="qrbit-text-body-secondary" c="dimmed">
                  Drawing code…
                </Text>
              </Group>
            ) : null}
            {state === 'error' ? (
              <Text className="qrbit-text-body-secondary" c="danger" ta="center" w="min(100%, 22ch)">
                This browser cannot draw the code. Use the text below.
              </Text>
            ) : null}
          </div>
        </div>

        {showLabel ? (
          <Stack align="center" gap="xs" className="tactical-qr__label">
            <Text className="qrbit-text-body-secondary" c="dimmed" ta="center" maw="34ch">
              Scan this with the other device’s camera, or open the link it carries.
            </Text>

            <Group justify="center" gap="xs" wrap="wrap">
              {/* The code is data a user may read back or type, so it is set as data. */}
              <Text className="qrbit-text-data" component="span">
                {code ?? payload}
              </Text>

              {interactive ? (
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  aria-label={COPY_LABEL[copy]}
                  onClick={handleCopy}
                >
                  {copy === 'copied' ? (
                    <IconCheck size={18} aria-hidden="true" />
                  ) : copy === 'blocked' ? (
                    <IconAlertTriangle size={18} aria-hidden="true" />
                  ) : (
                    <IconCopy size={18} aria-hidden="true" />
                  )}
                </ActionIcon>
              ) : null}

              {interactive && onRegenerate ? (
                <Button
                  variant="default"
                  size="sm"
                  leftSection={<IconRefresh size={16} aria-hidden="true" />}
                  onClick={onRegenerate}
                >
                  New code
                </Button>
              ) : null}
            </Group>
          </Stack>
        ) : null}
      </Stack>
    </WithMantine>
  )
}

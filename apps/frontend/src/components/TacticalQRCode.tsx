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
 *
 * ## The code line and the link row
 *
 * Under the symbol are two statements of the same fact, at two sizes. The first is the code
 * alone: eight characters, on a line of its own, because that is the string a user reads ALOUD
 * ("does your other screen say A7X3K9P2?") and the one they type into the field under the panel's
 * hairline if the camera will not start. It used to be gone entirely — the code survived only as
 * the tail of a URL — which is a regression for a product whose primary verification step is
 * saying eight characters out loud.
 *
 * The second is one line: the link a peer opens, and the control that puts the FULL version of it
 * on the clipboard. The previous revision printed the whole URL as a wrapped grey paragraph, which
 * took three lines on a phone and buried the session code in the middle of it. The row therefore
 * clips the *front* of the URL (the origin, which the user has no way to verify anyway) and never
 * clips the end (`?code=…`, the part a user reads back against the code on the other screen). The
 * anchor's own text is the complete URL, so assistive tech, the page-level assertion in
 * `Home.test.tsx` and a paste into another app all still see the whole thing — clipping here is a
 * rendering decision, not a data one. It cannot be selected by hand, though: `styles.css` sets
 * `user-select: none` on every `a`, which is why the blocked state points at the typed field
 * rather than at the link.
 *
 * The copy control is the panel's one icon-only affordance, so it takes DESIGN.md's icon-only
 * row: `<ActionIcon variant="subtle">`, transparent fill, Ink Secondary glyph, 44px because a
 * thumb hits it. It was that same documented variant that shipped invisible in the light scheme,
 * and the reason was never the component: Mantine delivers `cssVariablesResolver`'s output as an
 * inline `<style data-mantine-styles>`, which this app's own `style-src 'self'` refuses, so the
 * variable map never arrived and every control colour chain fell through to the white at the end
 * of Mantine's static sheet — white glyph, white panel. That is fixed at the bridge (375df54:
 * `applyThemeCssVariables` delivers the same map through the CSSOM, and
 * `qrbitVariantColorResolver` points a neutral `subtle` control at `--mantine-color-dimmed`,
 * which *is* DESIGN.md's Ink Secondary). Nothing here states a colour inline, because the
 * component's job is to name the documented variant and let the bridge own the value.
 *
 * Clipboard failure is a state, not an exception: `navigator.clipboard` is absent on insecure
 * origins and `writeText` rejects when the document is not focused, so the control says
 * *blocked* and points at the typed fallback rather than showing a checkmark that never happened.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { toCanvas } from 'qrcode'
import { ActionIcon, Group, Loader, Stack, Text } from '@mantine/core'
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
  /** Show the link row — the address the symbol carries, and the controls under it. */
  showLabel?: boolean
  /** Hide the copy/regenerate controls: the caller renders the link without them. */
  interactive?: boolean
}

/** Which of the three states the surface is in; `error` always keeps the code typeable. */
type DrawState = 'drawing' | 'ready' | 'error'

/**
 * The light plate behind the code.
 *
 * `--qrbit-signal-subtle` is the one documented surface that does NOT flip under
 * `[data-theme='dark']`, so the plate stays light on a near-black page instead of inverting
 * with the panel behind it (`--qrbit-raised` does exactly that, which is why it is not used
 * here — DESIGN.md's "Raised well" cannot be honoured literally in the dark scheme, because a
 * scanner reads luminance: see this lane's report). The symbol brings its own white quiet zone.
 */
const WELL_STYLE = {
  background: 'var(--qrbit-signal-subtle)',
  borderRadius: 'var(--qrbit-radius-md)',
  padding: 'var(--qrbit-space-md)',
  border: '1px solid var(--qrbit-border)',
  boxShadow: 'inset 0 1px 3px rgba(11, 18, 32, 0.05)',
} as const

/**
 * The code as a person reads it, not as a machine parses it.
 *
 * The element is a plain `<code>` wearing `styles.css`'s `.code` primitive (mono, 24px, 600,
 * tracked 0.18em — the same primitive `QRDisplay` projects in its enlarge modal, and what
 * `.session-qr .code` was written for). It cannot be a Mantine `Text`: `Text`'s own root class
 * declares `font-size: var(--text-fz)` and `font-weight: regular`, and measured in a browser a
 * `Text component="code" className="code"` came out at 14px/400 — the primitive silently lost to
 * the component. `tabular-nums` is restated here because this is the Data role's figure set
 * (DESIGN.md, "The Mono Means Data Rule"), and centred because the plate above it is.
 */
const CODE_STYLE = {
  display: 'block',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
} as const

/** Which of the three copy states the control is in — the code is always on screen anyway. */
type CopyState = 'idle' | 'copied' | 'blocked'

/**
 * The copy control's accessible name, per state. The name changes with the outcome so the
 * control describes what it will do (or just did) rather than sitting on a fixed label the
 * user cannot tell the difference between.
 */
const COPY_LABEL: Record<CopyState, string> = {
  idle: 'Copy the full session link',
  copied: 'Session link copied',
  blocked: 'Copy blocked by this browser',
}

/**
 * The line under the row, shown only while it has something to say. `blocked` names the
 * recovery that still works — the code is legible on this screen and the typed field is under
 * the hairline — because the link itself cannot be dragged over by hand.
 */
const COPY_STATUS: Record<Exclude<CopyState, 'idle'>, string> = {
  copied: 'The full link is on your clipboard.',
  blocked: 'This browser blocked the copy. Type the code into the field below instead.',
}

/**
 * The link row's inset: a Sunken plate with a hairline, which is what DESIGN.md reserves
 * `--qrbit-sunken` for (code wells and insets) and what makes the row read as a field rather
 * than as a sentence on the panel.
 */
const LINK_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--qrbit-space-xs)',
  width: '100%',
  padding: 'var(--qrbit-space-xs) var(--qrbit-space-xs) var(--qrbit-space-xs) var(--qrbit-space-sm)',
  background: 'var(--qrbit-sunken)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-sm)',
  minWidth: 0,
} as const

/** The anchor: one line, shrinks to whatever the row has left, clips rather than wraps. */
const LINK_STYLE = {
  display: 'flex',
  minWidth: 0,
  flex: '1 1 auto',
  alignItems: 'center',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textDecoration: 'underline',
  textUnderlineOffset: '0.15em',
} as const

/** The clipped front of the URL. `text-overflow` only works on a block with `overflow: hidden`. */
const LINK_HEAD_STYLE = {
  display: 'block',
  minWidth: 0,
  flex: '0 1 auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

/** The end of the URL — the code. Never truncated, so it is always readable by eye. */
const LINK_TAIL_STYLE = { display: 'block', flex: 'none', whiteSpace: 'nowrap' } as const

/**
 * Splits a link into the part that may be clipped and the part that may not.
 *
 * `head + tail` is always the exact input, which is what keeps the DOM text — and the
 * page-level assertion that the full URL is on screen — true at every width.
 */
function splitLink(url: string): { head: string; tail: string } {
  const query = url.indexOf('?')
  if (query >= 0) return { head: url.slice(0, query), tail: url.slice(query) }
  const path = url.lastIndexOf('/')
  if (path >= 0) return { head: url.slice(0, path), tail: url.slice(path) }
  return { head: url, tail: '' }
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

  /**
   * The link row's two halves: the origin may clip, `?code=…` may not. Derived from the
   * payload, so the address the row shows and the address the symbol carries are one fact.
   */
  const link = useMemo(() => splitLink(payload ?? ''), [payload])

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
      {/*
        `w="100%"` is load-bearing, not cosmetic. A Mantine `Stack` with `align="center"` is a
        column flex container, so a child that is not stretched is sized by `fit-content` — and
        `fit-content` only clamps to the parent's width when that width is *definite*. Left at
        `width: auto` inside a panel that also centres it, this Stack resolved to its own
        max-content (measured in a browser at 1280×900: 451px inside a 352px content box), which
        pushed the link row 34px past each side of the card and straight over the panel's border
        and reticle corners. Giving the Stack a definite width makes the row's `width: 100%` mean
        100% of the card, so the row is contained by construction and the anchor inside it ellipsises
        the origin instead of the layout spilling.
      */}
      <Stack align="center" gap="md" w="100%" className="tactical-qr">
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
                This browser cannot draw the code. Use the link below.
              </Text>
            ) : null}
          </div>
        </div>

        {/*
          The code on its own line, in its own right — not only as the tail of a URL.

          This is the string a user reads ALOUD to check that the two devices are on the same
          session, and the one they type into the field under the hairline if the camera fails, so
          it gets a line of its own between the symbol and the link. It wears the stylesheet's
          session-code primitive (`.code`: the mono family, 24px, 600, tracked 0.18em — the same
          primitive `QRDisplay` projects in its enlarge modal), and the element is a real `<code>`,
          which is what picks up `styles.css`'s `code, pre, kbd { font-variant-numeric: tabular-nums }`
          — the Data role's figures. Not the Data role's *size*: 13px on the Data ladder is a byte
          count, and a code a person has to read across a table is not that.

          It sits BELOW the plate rather than on it: the plate is `--qrbit-signal-subtle`, which
          deliberately does not flip in the dark scheme, and `--qrbit-ink` does, so code painted on
          the plate would be light-on-light there. A scanner reads the plate's luminance; a person
          reads this line.
        */}
        {code !== null ? (
          <code className="code tactical-qr__code" style={CODE_STYLE}>
            {code}
          </code>
        ) : null}

        {showLabel ? (
          <Stack gap="xs" className="tactical-qr__label" w="100%">
            {/*
              One line: the link, clipped at the front, and the control that copies the whole
              thing. The code is the tail, so clipping can never hide what a user checks by eye.
            */}
            <div className="tactical-qr__link-row" style={LINK_ROW_STYLE}>
              <a
                className="tactical-qr__link qrbit-text-data"
                href={payload}
                title={payload}
                style={LINK_STYLE}
              >
                <span className="tactical-qr__link-head" style={LINK_HEAD_STYLE}>
                  {link.head}
                </span>
                <span className="tactical-qr__link-code" style={LINK_TAIL_STYLE}>
                  {link.tail}
                </span>
              </a>

              {interactive ? (
                <ActionIcon
                  // DESIGN.md's icon-only row: quiet fill, Ink Secondary glyph. 44px
                  // (`size="xl"`) because this is a thumb target on the phone held over the
                  // other device, which outranks the table's 32px box.
                  className="tactical-qr__copy tactile-btn"
                  variant="subtle"
                  size="xl"
                  flex="none"
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
                <ActionIcon
                  className="tactical-qr__regenerate tactile-btn"
                  variant="subtle"
                  size="xl"
                  flex="none"
                  aria-label="Start a new pairing code"
                  onClick={onRegenerate}
                >
                  <IconRefresh size={18} aria-hidden="true" />
                </ActionIcon>
              ) : null}
            </div>

            {/*
              The copy outcome, in words, in a live region. Rendered only while it has something
              to say, so the resting panel carries no status line the session could not verify.
            */}
            {copy === 'idle' ? null : (
              <Text
                component="span"
                className="tactical-qr__copy-status qrbit-text-body-secondary"
                c={copy === 'blocked' ? 'danger' : undefined}
                role="status"
                aria-live="polite"
              >
                {COPY_STATUS[copy]}
              </Text>
            )}
          </Stack>
        ) : null}
      </Stack>
    </WithMantine>
  )
}

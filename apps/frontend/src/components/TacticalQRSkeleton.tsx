/**
 * Tactical QR skeleton loader (PLAN.md §7; ORCHESTRATION D13, D15).
 *
 * Replaces the spinner `<Loader size="sm" />` while connecting the host session or
 * generating the QR code.
 *
 * ## Geometry and design rationale
 *
 * Reflects the exact geometry of `TacticalQRCode` and the pairing panel:
 * 1. **Status bar skeleton**: small pulsing beacon dot placeholder and status line for
 *    "Connecting host session…" (or caller-supplied status label).
 * 2. **Well skeleton**: square plate with the same dimensions (`size` = 220px default,
 *    responsive aspect-ratio 1:1), with tactical reticle corner accents (matching the
 *    viewfinder brackets), 3 corner finder-pattern boxes (top-left, top-right, bottom-left)
 *    resembling a QR code forming, timing patterns, an alignment pattern, and an animated
 *    cyber/tactical shimmering scan line.
 * 3. **Code line skeleton**: centered placeholder pill matching `.code` dimensions for the
 *    8-character session code.
 * 4. **Link row skeleton**: Sunken plate row matching `TacticalQRCode`'s link row with
 *    placeholder bars for the session link and the 44px copy action button.
 *
 * ## Design System compliance
 *
 * - Strict mode TypeScript.
 * - Semantic tokens from `styles.css`: `--qrbit-signal-subtle` (luminance-stable well plate),
 *   `--qrbit-sunken`, `--qrbit-border`, `--qrbit-signal`, `--qrbit-ink`, `--qrbit-radius-*`.
 * - Dark mode compatible without inverting the well luminance.
 * - Respects `prefers-reduced-motion`.
 */

import type { CSSProperties, JSX } from 'react'
import { Stack } from '@mantine/core'

import { WithMantine } from './common/WithMantine'

export interface TacticalQRSkeletonProps {
  /**
   * Rendered width of the QR well in CSS pixels (default: 220).
   * Matches `TacticalQRCode`'s `size` prop.
   */
  size?: number

  /**
   * Status text displayed in the status bar or announced to assistive tech
   * (default: 'Connecting host session…').
   */
  statusText?: string

  /**
   * Whether to display the top status bar pill skeleton.
   * Defaults to `true` when `variant === 'full'`, and `false` when `variant === 'well-only'`.
   */
  showStatusBar?: boolean

  /**
   * Whether to display the centered 8-character session code pill skeleton.
   * Defaults to `true` when `variant === 'full'`, and `false` when `variant === 'well-only'`.
   */
  showCodeLine?: boolean

  /**
   * Whether to display the session link and copy button row skeleton.
   * Defaults to `true` when `variant === 'full'`, and `false` when `variant === 'well-only'`.
   */
  showLinkRow?: boolean

  /**
   * Layout variant:
   * - 'full': Complete pairing panel skeleton (status bar, well, code line, link row)
   * - 'well-only': Only the square well with corner reticles and finder patterns
   * (default: 'full')
   */
  variant?: 'full' | 'well-only'

  /**
   * Whether to enable animated shimmering and beacon pulse (default: true).
   * Automatically disabled under prefers-reduced-motion.
   */
  animate?: boolean

  /**
   * Additional className to apply to the root container.
   */
  className?: string

  /**
   * Additional inline styles for the root container.
   */
  style?: CSSProperties
}

/**
 * The light plate behind the code skeleton, identical to `TacticalQRCode`'s WELL_STYLE.
 * `--qrbit-signal-subtle` stays light on both schemes to preserve luminance.
 */
const SKELETON_WELL_STYLE = {
  background: 'var(--qrbit-signal-subtle)',
  borderRadius: 'var(--qrbit-radius-md)',
  padding: 'var(--qrbit-space-md)',
  border: '1px solid var(--qrbit-border)',
  boxShadow: 'inset 0 1px 3px rgba(11, 18, 32, 0.05)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  position: 'relative',
  overflow: 'hidden',
} as const satisfies CSSProperties

/**
 * Viewfinder reticle corner brackets, one per corner.
 */
const RETICLE_CORNER_STYLE = {
  position: 'absolute',
  width: 'var(--qrbit-space-md)',
  height: 'var(--qrbit-space-md)',
  borderStyle: 'solid',
  borderColor: 'var(--qrbit-signal)',
  pointerEvents: 'none',
  zIndex: 3,
} as const satisfies CSSProperties

/**
 * Centered placeholder pill for the 8-character session code.
 * Matches `styles.css` `.code` geometry (height ~40px, rounded-sm, sunken).
 */
const SKELETON_CODE_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--qrbit-space-xs)',
  height: '2.5rem',
  minWidth: '10rem',
  padding: '0.35rem 0.85rem',
  background: 'var(--qrbit-sunken)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-sm)',
  boxShadow: 'inset 0 1px 2px rgba(11, 18, 32, 0.05)',
} as const satisfies CSSProperties

/**
 * Link row container, matching `TacticalQRCode`'s LINK_ROW_STYLE.
 */
const SKELETON_LINK_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--qrbit-space-xs)',
  width: '100%',
  padding: 'var(--qrbit-space-xs) var(--qrbit-space-xs) var(--qrbit-space-xs) var(--qrbit-space-sm)',
  background: 'var(--qrbit-sunken)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-sm)',
  minWidth: 0,
  height: '3.25rem',
} as const satisfies CSSProperties

/**
 * Helper component for rendering a 3-layer QR finder pattern skeleton box
 * (7x7 modules standard geometry: outer square, quiet spacer, inner solid core).
 */
function FinderPatternBox({
  position,
  animate,
}: {
  position: 'tl' | 'tr' | 'bl'
  animate: boolean
}): JSX.Element {
  const positionStyles: Record<'tl' | 'tr' | 'bl', CSSProperties> = {
    tl: { top: 'var(--qrbit-space-sm)', left: 'var(--qrbit-space-sm)' },
    tr: { top: 'var(--qrbit-space-sm)', right: 'var(--qrbit-space-sm)' },
    bl: { bottom: 'var(--qrbit-space-sm)', left: 'var(--qrbit-space-sm)' },
  }

  return (
    <div
      aria-hidden="true"
      className={`tactical-qr-skeleton__finder tactical-qr-skeleton__finder--${position} ${
        animate ? 'tactical-qr-skeleton__pulse' : ''
      }`}
      style={{
        position: 'absolute',
        width: '46px',
        height: '46px',
        border: '3.5px solid color-mix(in srgb, var(--qrbit-ink) 50%, transparent)',
        borderRadius: 'var(--qrbit-radius-sm)',
        display: 'grid',
        placeItems: 'center',
        padding: '3px',
        backgroundColor: 'transparent',
        boxSizing: 'border-box',
        ...positionStyles[position],
      }}
    >
      <div
        style={{
          width: '20px',
          height: '20px',
          borderRadius: 'var(--qrbit-radius-xs)',
          backgroundColor: 'color-mix(in srgb, var(--qrbit-ink) 50%, transparent)',
        }}
      />
    </div>
  )
}

export function TacticalQRSkeleton({
  size = 220,
  statusText = 'Connecting host session…',
  showStatusBar,
  showCodeLine,
  showLinkRow,
  variant = 'full',
  animate = true,
  className = '',
  style,
}: TacticalQRSkeletonProps): JSX.Element {
  const isWellOnly = variant === 'well-only'
  const shouldShowStatusBar = showStatusBar ?? !isWellOnly
  const shouldShowCodeLine = showCodeLine ?? !isWellOnly
  const shouldShowLinkRow = showLinkRow ?? !isWellOnly

  return (
    <WithMantine>
      <Stack
        align="center"
        gap="md"
        w="100%"
        className={`tactical-qr-skeleton ${className}`.trim()}
        style={style}
      >
        {/*
          1. Status bar skeleton: small pulsing dot placeholder and status bar for
             "Connecting host session...". Preserves role="status" and aria-live="polite".
        */}
        {shouldShowStatusBar ? (
          <div
            className="tactical-qr-skeleton__status"
            role="status"
            aria-live="polite"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--qrbit-space-sm)',
              padding: '0.35rem 0.85rem',
              background: 'var(--qrbit-sunken)',
              border: '1px solid var(--qrbit-border)',
              borderRadius: 'var(--qrbit-radius-full)',
              boxShadow: '0 1px 2px rgba(11, 18, 32, 0.04)',
              marginBottom: 'var(--qrbit-space-md)',
            }}
          >
            <span
              aria-hidden="true"
              className={`tactical-qr-skeleton__status-dot ${
                animate ? 'animate-beacon-ping' : ''
              }`}
              style={{
                width: '0.5rem',
                height: '0.5rem',
                borderRadius: 'var(--qrbit-radius-full)',
                background: 'var(--qrbit-signal)',
                flexShrink: 0,
              }}
            />
            <span
              className="tactical-qr-skeleton__status-text qrbit-text-body-secondary"
              style={{
                color: 'var(--qrbit-ink-secondary)',
                fontSize: '0.8125rem',
                letterSpacing: '0.02em',
              }}
            >
              {statusText}
            </span>
          </div>
        ) : null}

        {/*
          2. Well skeleton: square plate with the same dimensions (220px size or responsive
             aspect-ratio 1:1), with tactical reticle corner accents (matching viewfinder brackets),
             and 3 finder-pattern skeleton boxes (top-left, top-right, bottom-left) resembling
             a QR code forming, timing patterns, and an animated cyber/tactical shimmering scan line.
        */}
        <div className="tactical-qr-skeleton__well" style={SKELETON_WELL_STYLE}>
          <div
            className="tactical-qr-skeleton__frame relative grid place-items-center"
            style={{
              width: size,
              maxWidth: '100%',
              aspectRatio: '1 / 1',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Viewfinder reticle corner accents */}
            <span
              aria-hidden="true"
              className="tactical-qr-skeleton__reticle tactical-qr-skeleton__reticle--tl"
              style={{
                ...RETICLE_CORNER_STYLE,
                top: 0,
                left: 0,
                borderTopWidth: 2,
                borderLeftWidth: 2,
              }}
            />
            <span
              aria-hidden="true"
              className="tactical-qr-skeleton__reticle tactical-qr-skeleton__reticle--tr"
              style={{
                ...RETICLE_CORNER_STYLE,
                top: 0,
                right: 0,
                borderTopWidth: 2,
                borderRightWidth: 2,
              }}
            />
            <span
              aria-hidden="true"
              className="tactical-qr-skeleton__reticle tactical-qr-skeleton__reticle--bl"
              style={{
                ...RETICLE_CORNER_STYLE,
                bottom: 0,
                left: 0,
                borderBottomWidth: 2,
                borderLeftWidth: 2,
              }}
            />
            <span
              aria-hidden="true"
              className="tactical-qr-skeleton__reticle tactical-qr-skeleton__reticle--br"
              style={{
                ...RETICLE_CORNER_STYLE,
                bottom: 0,
                right: 0,
                borderBottomWidth: 2,
                borderRightWidth: 2,
              }}
            />

            {/* 3 Corner Finder Pattern Skeleton Boxes */}
            <FinderPatternBox position="tl" animate={animate} />
            <FinderPatternBox position="tr" animate={animate} />
            <FinderPatternBox position="bl" animate={animate} />

            {/* Timing pattern lines (connecting top-left to top-right and top-left to bottom-left) */}
            <div
              aria-hidden="true"
              className={`tactical-qr-skeleton__timing-h ${
                animate ? 'tactical-qr-skeleton__pulse' : ''
              }`}
              style={{
                position: 'absolute',
                top: '28px',
                left: '60px',
                right: '60px',
                height: '4px',
                backgroundImage:
                  'repeating-linear-gradient(90deg, color-mix(in srgb, var(--qrbit-ink) 35%, transparent) 0px, color-mix(in srgb, var(--qrbit-ink) 35%, transparent) 4px, transparent 4px, transparent 8px)',
              }}
            />
            <div
              aria-hidden="true"
              className={`tactical-qr-skeleton__timing-v ${
                animate ? 'tactical-qr-skeleton__pulse' : ''
              }`}
              style={{
                position: 'absolute',
                top: '60px',
                bottom: '60px',
                left: '28px',
                width: '4px',
                backgroundImage:
                  'repeating-linear-gradient(180deg, color-mix(in srgb, var(--qrbit-ink) 35%, transparent) 0px, color-mix(in srgb, var(--qrbit-ink) 35%, transparent) 4px, transparent 4px, transparent 8px)',
              }}
            />

            {/* Bottom-right alignment pattern skeleton */}
            <div
              aria-hidden="true"
              className={`tactical-qr-skeleton__alignment ${
                animate ? 'tactical-qr-skeleton__pulse' : ''
              }`}
              style={{
                position: 'absolute',
                bottom: '22px',
                right: '22px',
                width: '26px',
                height: '26px',
                border: '2.5px solid color-mix(in srgb, var(--qrbit-ink) 35%, transparent)',
                borderRadius: 'var(--qrbit-radius-xs)',
                display: 'grid',
                placeItems: 'center',
                boxSizing: 'border-box',
              }}
            >
              <div
                style={{
                  width: '8px',
                  height: '8px',
                  backgroundColor: 'color-mix(in srgb, var(--qrbit-ink) 35%, transparent)',
                  borderRadius: '1px',
                }}
              />
            </div>

            {/* Tactical cyber dot module matrix */}
            <div
              aria-hidden="true"
              className="tactical-qr-skeleton__grid"
              style={{
                position: 'absolute',
                inset: '16px',
                backgroundImage:
                  'radial-gradient(circle, color-mix(in srgb, var(--qrbit-ink) 25%, transparent) 1.5px, transparent 1.5px)',
                backgroundSize: '12px 12px',
                backgroundPosition: 'center',
                opacity: 0.6,
                pointerEvents: 'none',
              }}
            />

            {/* Optical scanner sweep line */}
            {animate ? (
              <div
                aria-hidden="true"
                className="tactical-qr-skeleton__sweep animate-scan-sweep"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 0,
                  height: '2px',
                  background:
                    'linear-gradient(90deg, transparent 0%, var(--qrbit-signal) 50%, transparent 100%)',
                  boxShadow:
                    '0 0 10px 2px color-mix(in srgb, var(--qrbit-signal) 60%, transparent)',
                  pointerEvents: 'none',
                  zIndex: 2,
                }}
              />
            ) : null}

            {/* Cyber shimmer gradient sweep */}
            {animate ? (
              <div
                aria-hidden="true"
                className="tactical-qr-skeleton__shimmer"
              />
            ) : null}
          </div>
        </div>

        {/*
          3. Code line skeleton: centered placeholder pill for the 8-character session code.
        */}
        {shouldShowCodeLine ? (
          <div
            className="tactical-qr-skeleton__code"
            style={SKELETON_CODE_STYLE}
            aria-hidden="true"
          >
            {Array.from({ length: 8 }).map((_, index) => (
              <span
                key={index}
                className={`tactical-qr-skeleton__code-char ${
                  animate ? 'tactical-qr-skeleton__pulse' : ''
                }`}
                style={{
                  display: 'inline-block',
                  width: '0.75rem',
                  height: '1.25rem',
                  background: 'color-mix(in srgb, var(--qrbit-ink) 22%, transparent)',
                  borderRadius: 'var(--qrbit-radius-xs)',
                  animationDelay: `${index * 100}ms`,
                }}
              />
            ))}
          </div>
        ) : null}

        {/*
          4. Link row skeleton: placeholder row for the session link and copy icon.
        */}
        {shouldShowLinkRow ? (
          <div
            className="tactical-qr-skeleton__link-container"
            style={{ width: '100%' }}
            aria-hidden="true"
          >
            <div
              className="tactical-qr-skeleton__link-row"
              style={SKELETON_LINK_ROW_STYLE}
            >
              {/* Link bar placeholder */}
              <div
                className={`tactical-qr-skeleton__link-bar ${
                  animate ? 'tactical-qr-skeleton__pulse' : ''
                }`}
                style={{
                  flex: '1 1 auto',
                  height: '1rem',
                  background: 'color-mix(in srgb, var(--qrbit-ink-muted) 22%, transparent)',
                  borderRadius: 'var(--qrbit-radius-xs)',
                  minWidth: 0,
                }}
              />

              {/* Action icon placeholder (44px target) */}
              <div
                className={`tactical-qr-skeleton__copy-btn ${
                  animate ? 'tactical-qr-skeleton__pulse' : ''
                }`}
                style={{
                  flex: 'none',
                  width: '2.75rem',
                  height: '2.75rem',
                  borderRadius: 'var(--qrbit-radius-sm)',
                  background: 'color-mix(in srgb, var(--qrbit-ink-muted) 16%, transparent)',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <div
                  style={{
                    width: '1.125rem',
                    height: '1.125rem',
                    borderRadius: 'var(--qrbit-radius-xs)',
                    background: 'color-mix(in srgb, var(--qrbit-ink-muted) 32%, transparent)',
                  }}
                />
              </div>
            </div>
          </div>
        ) : null}
      </Stack>
    </WithMantine>
  )
}

/**
 * The arithmetic that decides whether a phone camera can read a QRBit code (DESIGN.md,
 * "Signature: the pairing panel"; PLAN.md §16 Phase 6).
 *
 * `TacticalQRCode` (the home pairing panel) and `QRDisplay` (the session panel) draw the
 * same symbol, so the settings are written once here instead of being re-invented per
 * screen — the two copies previously disagreed on quiet zone (1 module vs 4) and on module
 * colour (near-black navy vs pure black), which is exactly the kind of drift that makes a
 * code unreadable on one screen and fine on the other.
 *
 * ## Why the palette is deliberately absent
 *
 * A scanner measures luminance, so the symbol has to be dark modules on a light field in
 * BOTH schemes. Every surface token in `styles.css` flips under `[data-theme]`
 * (`--qrbit-raised` is #171F2C in the dark scheme), and `qrcode` rasterises in JavaScript,
 * where it needs literal colour strings — so DESIGN.md's "No Raw Hex Rule" and a fixed
 * module/background pair cannot both be satisfied by naming the colours in a component.
 * The pair is therefore the renderer's own documented default (`#000000ff` modules over
 * `#ffffffff` field), reached by never passing `color`, and the polarity is pinned at the
 * pixels rather than by restating the string: see `QRDisplay.test.tsx`, which reads the
 * blitted bitmap and fails if anything but pure black on pure white appears.
 *
 * The plate the canvas sits on is a different thing and does use a token:
 * `--qrbit-signal-subtle`, declared once at `:root` in `styles.css` and never redefined
 * under `[data-theme='dark']`, so a dark page still frames the code with a light well.
 */

import type { QRCodeErrorCorrectionLevel, QRCodeRenderersOptions } from 'qrcode'

/**
 * The error-correction floor for a screen-to-camera scan: the redundancy buys back a
 * reflection or a slightly soft focus, and level M still keeps a session URL at 29 modules
 * (version 3) — roughly 8 CSS pixels per module at the resting size. Higher correction
 * buys nothing here because nothing overlaps the symbol any more.
 */
const QR_ERROR_CORRECTION_LEVEL: QRCodeErrorCorrectionLevel = 'M'

/**
 * The QR spec's quiet zone, in modules. The renderer's own default, pinned because a
 * one-module margin leaves the finder patterns touching the edge of the well and the code
 * stops decoding at an angle.
 */
const QR_QUIET_ZONE_MODULES = 4

/** Rendering above this ratio costs bitmap memory without adding detail a camera can use. */
const MAX_DEVICE_PIXEL_RATIO = 3

/**
 * The canvas bitmap size in device pixels.
 *
 * The canvas is laid out in CSS pixels but rasterised in its own pixel grid, so a bitmap
 * rendered at one pixel per CSS pixel is upscaled (and blurred) on any modern phone. The
 * ratio is clamped because past 3× the extra pixels are invisible to a camera.
 */
export function qrBitmapSize(cssSize: number): number {
  const ratio = window.devicePixelRatio
  const usable = Number.isFinite(ratio) && ratio > 1 ? Math.min(ratio, MAX_DEVICE_PIXEL_RATIO) : 1
  return Math.round(cssSize * usable)
}

/** The renderer options for one code, at one resting size in CSS pixels. */
export function qrRenderOptions(cssSize: number): QRCodeRenderersOptions {
  return {
    errorCorrectionLevel: QR_ERROR_CORRECTION_LEVEL,
    margin: QR_QUIET_ZONE_MODULES,
    width: qrBitmapSize(cssSize),
  }
}

/**
 * Takes the element's sizing back from the renderer.
 *
 * `toCanvas` writes the *bitmap* size into `canvas.style` on every draw, which would show a
 * 2× screen its 2× code at double the intended width. Applied after the draw settles,
 * whether or not it succeeded.
 */
export function releaseCanvasSizing(canvas: HTMLCanvasElement): void {
  canvas.style.width = '100%'
  canvas.style.height = 'auto'
}

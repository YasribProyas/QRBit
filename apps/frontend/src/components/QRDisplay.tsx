/**
 * This device's session QR panel (PLAN.md §7).
 *
 * PHASE 1: a static placeholder that renders the session URL as text, because
 * PLAN.md §16 Phase 1 asks only for "static QR display (hardcoded URL for now)".
 *
 * PHASE 6 SEAM: swap the contents of `.qr__frame` for a `<canvas>` drawn by the
 * `qrcode` package from the same `url` prop. The frame is already sized at its
 * final aspect ratio, so the surrounding layout will not shift. No prop changes
 * are needed — deliberately, so Phase 6 touches only this component.
 */

export interface QRDisplayProps {
  /** The full session URL a peer's camera should open. */
  url: string
  caption?: string
}

export function QRDisplay({ url, caption = 'Scan this to send files here' }: QRDisplayProps) {
  return (
    <div className="qr">
      <div className="qr__frame" role="img" aria-label={`Session link: ${url}`}>
        <span className="qr__placeholder-label">QR rendering lands in Phase 6</span>
        <code className="qr__url">{url}</code>
      </div>
      <p className="qr__caption">{caption}</p>
    </div>
  )
}

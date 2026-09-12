/**
 * Transfer progress ring (PLAN.md §5, §9).
 *
 * A ring rather than a bar because in-flight items sit in a list: several of them
 * can be transferring at once (PLAN.md §9 — items are independent) and a ring
 * keeps each row the same height.
 *
 * The ring is also the accessible value: `role="progressbar"` with an
 * `aria-valuenow` on the wrapper, so the SVG inside is hidden from assistive
 * technology. Callers that want a numeric readout next to a filename render it
 * themselves — the ring carries no text, which is what keeps it usable at 24px.
 */

export interface ProgressRingProps {
  /** Percentage, 0–100. Anything outside the range (or non-finite) is clamped. */
  progress: number
  /** Rendered diameter in pixels. */
  size?: number
  /** Accessible name. Required: a ring with no name conveys nothing. */
  label: string
}

/*
 * r = 100 / 2π, so the circumference is exactly 100 units and the dash pattern
 * can be expressed directly in percent — no arithmetic in the render path.
 */
const RADIUS = 15.9155

export function ProgressRing({ progress, size = 36, label }: ProgressRingProps) {
  const value = Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0))

  return (
    <span
      className="progress-ring"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      <svg className="progress-ring__svg" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
        <circle className="progress-ring__track" cx="18" cy="18" r={RADIUS} />
        <circle
          className="progress-ring__value"
          cx="18"
          cy="18"
          r={RADIUS}
          strokeDasharray={`${value} ${100 - value}`}
        />
      </svg>
    </span>
  )
}

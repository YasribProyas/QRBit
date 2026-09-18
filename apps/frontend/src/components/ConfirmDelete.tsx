/**
 * Confirmation for a destructive, unrecoverable action (Phase 5 review P2).
 *
 * `window.confirm()` is not an option here even though it would be three fewer lines: it
 * is blocked in cross-origin iframes and embedded web views — which is exactly where a
 * PWA opened from a share sheet or another origin can land — and it cannot be styled.
 * A safety prompt that the browser silently swallows is worse than no prompt, because the
 * caller believes it asked.
 *
 * So this is a real dialog. It owns presentation and keyboard behaviour only; the words
 * come from the caller, which is the only thing that knows what is about to be lost. That
 * keeps it reusable outside the library (a session clear, an export wipe) without it
 * having to know anything about either.
 *
 * The contract with its callers:
 *  - The confirm control is the only path that acts, and both its label and its styling
 *    say that what happens next is permanent. It is deliberately LAST in the DOM, so
 *    reading order, tab order and thumb reach all meet the safe control first.
 *  - Escape always cancels. It never confirms, whatever else is listening.
 *  - Focus moves into the dialog on open — onto Cancel, because the default reply to a
 *    destructive question should be the one that costs nothing — and goes back to the
 *    element that opened it when the dialog unmounts. The restore is best effort by
 *    nature: a trigger that unmounts while the dialog is open (a row menu that closes
 *    itself on the way in) cannot be focused again, so it is skipped rather than pushing
 *    focus at a detached node.
 *  - Backdrop clicks do nothing. Dismissing a dialog that offers a Cancel button by
 *    tapping the empty space beside the panel is how the wrong answer gets given.
 */

import { useEffect, useId, useRef } from 'react'
import type { CSSProperties } from 'react'

export interface ConfirmDeleteProps {
  /** The dialog's accessible name, e.g. `Delete “Work”?`. */
  title: string
  /** What is about to be lost, stated concretely — counts and names, not adjectives. */
  message: string
  /** The destructive verb, e.g. `Delete folder and contents permanently`. */
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The destructive treatment.
 *
 * The shared modal shell (`.library-modal*`) already styles the overlay, the panel and
 * the button row, so only the two properties that shell does not express are set here:
 * the theme's own `--error` token — the same colour the `···` menus use for their danger
 * entries — and a weight that keeps the label from reading like the muted Cancel next to
 * it. The `confirm-delete__confirm` class is the hook for moving this into the
 * stylesheet later without touching the markup.
 */
const DANGER_STYLE: CSSProperties = {
  color: 'var(--error)',
  borderColor: 'color-mix(in srgb, var(--error) 55%, var(--border-strong))',
  fontWeight: 650,
}

export function ConfirmDelete({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDeleteProps) {
  const headingId = useId()
  const bodyId = useId()
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  /*
   * The cancel callback is read through a ref so an inline arrow prop (a new function
   * identity per render, which is what every caller here passes) cannot re-subscribe the
   * Escape listener. This effect is declared before that one, so on mount the ref is
   * already current by the time the listener can be called.
   */
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onCancelRef.current = onCancel
  })

  useEffect(() => {
    const trigger = document.activeElement
    cancelRef.current?.focus()

    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])

  /*
   * Escape cancels. A document listener rather than a key handler on the panel, the same
   * idiom the library browser uses for leaving selection mode: it works wherever focus
   * happens to be, including on a browser chrome edge after a mis-tap.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      onCancelRef.current()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div
      className="library-modal confirm-delete"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={bodyId}
    >
      <div className="library-modal__panel confirm-delete__panel">
        <h2 className="library-modal__title confirm-delete__title" id={headingId}>
          {title}
        </h2>

        <p className="library-modal__hint confirm-delete__message" id={bodyId}>
          {message}
        </p>

        <div className="library-modal__actions">
          <button
            type="button"
            className="button library-modal__cancel confirm-delete__cancel"
            ref={cancelRef}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button confirm-delete__confirm"
            style={DANGER_STYLE}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

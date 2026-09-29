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
 * having to know anything about either. `lib/folders.ts`'s `describeDelete` is what
 * supplies the words when the loss is a folder tree, because the numbers in them have to
 * come from the same arithmetic the delete runs.
 *
 * The contract with its callers:
 *  - The confirm control is the only path that acts, and both its label and its styling
 *    say that what happens next is permanent. It is deliberately LAST in the DOM, so
 *    reading order, tab order and thumb reach all meet the safe control first.
 *  - Escape always cancels. It never confirms, whatever else is listening. That is
 *    Mantine's `closeOnEscape`, which routes to `onCancel` — the same callback the Cancel
 *    button uses, so there is one way to back out rather than two that can drift.
 *  - Focus moves into the dialog on open — onto Cancel, via `data-autofocus`, because the
 *    default reply to a destructive question should be the one that costs nothing — and
 *    goes back to the element that opened it when the dialog closes (Mantine's
 *    `returnFocus`). The restore is best effort by nature: a trigger that unmounts while
 *    the dialog is open (a row menu that closes itself on the way in) cannot be focused
 *    again, so it is skipped rather than pushing focus at a detached node.
 *  - Backdrop clicks do nothing (`closeOnClickOutside={false}`). Dismissing a dialog that
 *    offers a Cancel button by tapping the empty space beside the panel is how the wrong
 *    answer gets given.
 */

import { useEffect, useRef } from 'react'
import { Button, Group, Modal, Text } from '@mantine/core'

import { WithMantine } from './common/WithMantine'

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
 * The one destructive question in the app.
 *
 * DESIGN.md's dialog row: a Mantine `Modal` (radius md, the sheet shadow, title at the
 * Title role), actions right-aligned in the order Quiet then Primary, and the destructive
 * answer wearing Danger — the filled Fault Red control whose white label reads 6.53:1 in
 * both schemes. No hex and no ad-hoc size is written here: the red is `--qrbit-danger`
 * through the theme's `danger` colour, and the type roles come from `qrbit-text-*`.
 */
export function ConfirmDelete({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDeleteProps) {
  /*
   * The focus handoff back to whoever asked the question.
   *
   * Mantine returns focus when `opened` flips to false, and this dialog is not driven that
   * way — callers unmount it the moment it is answered, so the flip never happens. Capturing
   * the invoker on mount and restoring it on unmount is the only spelling that works, and it
   * is best effort by nature: `returnFocus={false}` below says the dialog is not relying on
   * Mantine's version of this.
   */
  const invoker = useRef<HTMLElement | null>(null)
  useEffect(() => {
    invoker.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    return () => {
      const target = invoker.current
      if (target !== null && target.isConnected) target.focus()
    }
  }, [])

  return (
    <WithMantine>
      <Modal
        // The dialog exists only while a delete is pending: callers mount and unmount it,
        // so `opened` is constant and there is no exit transition to animate into a tree
        // that is already gone.
        opened
        onClose={onCancel}
        title={title}
        size="sm"
        centered
        padding="lg"
        withCloseButton={false}
        closeOnClickOutside={false}
        returnFocus={false}
      >
        {/*
         * The consequence, in the Body role. It is the sentence a person has to read before
         * they answer, so it is not demoted to helper text and not tinted: emphasis comes from
         * the words and the size (DESIGN.md, "The Weight Before Colour Rule"), and the colour
         * is the theme's `text` slot, which is `--qrbit-ink` in both schemes. Mantine points
         * the dialog's `aria-describedby` at this region, so a screen reader reads the loss
         * aloud with the buttons after it.
         */}
        <Text className="qrbit-text-body">{message}</Text>

        <Group justify="flex-end" mt="lg" gap="sm" wrap="nowrap">
          <Button variant="subtle" size="sm" data-autofocus onClick={onCancel}>
            Cancel
          </Button>
          <Button
            // Filled Fault Red: the only control here that acts, and it looks like it.
            color="danger"
            size="sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Modal>
    </WithMantine>
  )
}

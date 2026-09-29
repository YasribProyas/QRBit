/** @vitest-environment jsdom */
/**
 * Destructive-confirm dialog tests.
 *
 * The dialog is the only thing standing between one mis-tap and an unrecoverable loss, so
 * what is pinned here is the safety of the interaction rather than the copy: it is a real
 * dialog (never `window.confirm`, which browsers suppress in a cross-origin iframe and
 * which would silently delete with no question asked), Escape always cancels and never
 * confirms, the backdrop is not an answer, only the named destructive control acts, and
 * focus goes into the dialog on open and back to the trigger on close so a keyboard user
 * is not left at the top of the document after a cancel.
 *
 * The dialog is a Mantine `Modal`, which renders through a Portal into `document.body`, so
 * these helpers reach it through the document rather than through the harness host — a
 * modal is document-level furniture, and an assertion scoped to the mount point would be
 * asserting that the portal is broken.
 */

import { act, createElement, useState } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmDelete } from './ConfirmDelete'
import type { ConfirmDeleteProps } from './ConfirmDelete'

/** The copy a folder cascade would get, as `describeDelete` states it. */
const COPY = {
  title: 'Delete “Work”?',
  message:
    'This permanently deletes 1 folder, 2 dossiers and 3 items from this device — “Work” and ' +
    'every folder and file nested inside it. This cannot be undone.',
  confirmLabel: 'Delete folder and contents permanently',
}

interface Harness {
  element: HTMLDivElement
  unmount: () => void
}

const openHarnesses: Harness[] = []

function mount(element: ReactElement): Harness {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  act(() => {
    root.render(element)
  })

  const harness: Harness = {
    element: host,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      host.remove()
    },
  }

  openHarnesses.push(harness)
  return harness
}

function renderDialog(overrides: Partial<ConfirmDeleteProps> = {}): Harness & { props: ConfirmDeleteProps } {
  const props: ConfirmDeleteProps = {
    ...COPY,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }

  return { ...mount(createElement(ConfirmDelete, props)), props }
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** The gesture a real backdrop tap is: `pointerdown`/`mousedown`, not a bare click. */
function press(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/**
 * Escape, from the element a browser would send it from.
 *
 * `document` is not a legal `keydown` target for a user: the event always starts at the
 * focused element (or the body when nothing is focused), and Mantine's escape handler reads
 * `event.target.getAttribute(...)`, which a document-targeted event does not have.
 */
function pressEscape(): void {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

/** Lets Mantine's portal, transition and focus trap commit before an assertion reads them. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null))
    })
  })
}

function dialog(): HTMLElement {
  const node = document.querySelector('[role="dialog"]')
  if (!(node instanceof HTMLElement)) throw new Error('test bug: no dialog')
  return node
}

function action(label: string): HTMLButtonElement {
  for (const candidate of dialog().querySelectorAll<HTMLButtonElement>('button')) {
    if (candidate.textContent === label) return candidate
  }
  throw new Error(`test bug: no button labelled ${label}`)
}

/** The dialog's buttons in DOM order — which is tab order, and the order a thumb reaches. */
function dialogButtons(): HTMLButtonElement[] {
  return [...dialog().querySelectorAll<HTMLButtonElement>('button')]
}

/**
 * The dialog mounted the way its callers mount it: behind a trigger that opens it and
 * stays in the DOM, which is what makes the focus handoff observable.
 */
function Trigger({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void
  onCancel: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className="probe-trigger"
        onClick={() => {
          setOpen(true)
        }}
      >
        Delete Work
      </button>
      {open
        ? createElement(ConfirmDelete, {
            ...COPY,
            onConfirm: () => {
              setOpen(false)
              onConfirm()
            },
            onCancel: () => {
              setOpen(false)
              onCancel()
            },
          })
        : null}
    </>
  )
}

function triggerOf(element: HTMLElement): HTMLButtonElement {
  const trigger = element.querySelector<HTMLButtonElement>('.probe-trigger')
  if (!(trigger instanceof HTMLButtonElement)) throw new Error('test bug: no trigger')
  return trigger
}

/**
 * Opens the dialog from its trigger with focus already on it. jsdom, unlike a browser,
 * does not focus a button when it is clicked, and the dialog reads the focused element as
 * the thing to hand focus back to — so a test that presses the trigger without focusing
 * it first is testing a keyboard user who was not on the trigger at all.
 */
async function openFromTrigger(trigger: HTMLButtonElement): Promise<void> {
  act(() => {
    trigger.focus()
  })
  click(trigger)
  await settle()
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop()
    if (harness) harness.unmount()
  }
  document.body.innerHTML = ''
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('ConfirmDelete — the dialog itself', () => {
  it('is a modal dialog named by its title and described by its message', () => {
    renderDialog()
    const node = dialog()

    expect(node.getAttribute('aria-modal')).toBe('true')

    const labelledBy = node.getAttribute('aria-labelledby')
    const describedBy = node.getAttribute('aria-describedby')
    if (labelledBy === null || describedBy === null) throw new Error('test bug: unlabelled dialog')

    expect(document.getElementById(labelledBy)?.textContent).toBe(COPY.title)
    expect(document.getElementById(describedBy)?.textContent).toContain(COPY.message)
  })

  it('offers the destructive verb as the only thing that acts', () => {
    const { props } = renderDialog()

    expect(action(COPY.confirmLabel).textContent).toBe(COPY.confirmLabel)

    // Cancel first, then the destructive control: tab order and thumb reach meet the
    // safe answer before the one that costs the library a subtree.
    const buttons = dialogButtons()
    expect(buttons.map((candidate) => candidate.textContent)).toEqual([
      'Cancel',
      COPY.confirmLabel,
    ])
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('wears the danger treatment on the confirm control alone', () => {
    renderDialog()
    const [cancel, confirm] = dialogButtons()
    if (cancel === undefined || confirm === undefined) throw new Error('test bug: fewer buttons than rendered')

    // The theme's `danger` colour is what makes it Fault Red, in both schemes; nothing here
    // writes a hex value, so the control follows the token the dialog is named after.
    expect(confirm.style.getPropertyValue('--button-bg')).toContain('danger')
    expect(cancel.style.getPropertyValue('--button-bg')).not.toContain('danger')
  })

  it('never reaches for window.confirm or window.alert', () => {
    // The blocked-in-iframes path: if either were used, the dialog below would render and
    // these spies would stay untouched, while a suppressed native prompt would have
    // deleted the folder with no question shown at all.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    const { props } = renderDialog()
    click(action(COPY.confirmLabel))
    pressEscape()

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('ignores the backdrop: dismissing on empty space is not an answer', () => {
    const { props } = renderDialog()

    // Mantine's `Overlay` is the one `position: fixed` surface the dialog mounts behind its
    // panel; `data-fixed` is how it says so.
    const overlay = document.querySelector('[data-fixed="true"]')
    if (overlay === null) throw new Error('test bug: no overlay to press')

    press(overlay)
    click(dialog())

    expect(props.onCancel).not.toHaveBeenCalled()
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).not.toBe(null)
  })
})

describe('ConfirmDelete — answers', () => {
  it('confirms exactly once, through the destructive control only', () => {
    const { props } = renderDialog()

    click(action(COPY.confirmLabel))

    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('cancels through the cancel control', () => {
    const { props } = renderDialog()

    click(action('Cancel'))

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('takes Escape as a cancel, never as a confirm', () => {
    const { props } = renderDialog()

    pressEscape()

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('stops listening once it is closed', () => {
    const { props } = renderDialog()

    pressEscape()
    const harness = openHarnesses[openHarnesses.length - 1]
    if (harness === undefined) throw new Error('test bug: no harness')
    harness.unmount()
    openHarnesses.pop()

    pressEscape()

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="dialog"]')).toBe(null)
  })
})

describe('ConfirmDelete — focus', () => {
  it('moves focus into the dialog on open, onto the safe control', async () => {
    const { element } = mount(createElement(Trigger, { onConfirm: vi.fn(), onCancel: vi.fn() }))
    const trigger = triggerOf(element)

    await openFromTrigger(trigger)

    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) throw new Error('test bug: nothing focused')

    expect(dialog().contains(focused)).toBe(true)
    expect(focused.textContent).toBe('Cancel')
  })

  it('returns focus to the trigger when the user cancels', async () => {
    const onCancel = vi.fn()
    const { element } = mount(createElement(Trigger, { onConfirm: vi.fn(), onCancel }))
    const trigger = triggerOf(element)

    await openFromTrigger(trigger)
    click(action('Cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="dialog"]')).toBe(null)
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the trigger when Escape cancels', async () => {
    const { element } = mount(createElement(Trigger, { onConfirm: vi.fn(), onCancel: vi.fn() }))
    const trigger = triggerOf(element)

    await openFromTrigger(trigger)
    pressEscape()

    expect(document.querySelector('[role="dialog"]')).toBe(null)
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the trigger after a confirm, too', async () => {
    const { element } = mount(
      createElement(Trigger, { onConfirm: vi.fn(), onCancel: vi.fn() }),
    )
    const trigger = triggerOf(element)

    await openFromTrigger(trigger)
    click(action(COPY.confirmLabel))

    expect(document.activeElement).toBe(trigger)
  })
})

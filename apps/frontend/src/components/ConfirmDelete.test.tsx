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
 */

import { act, createElement, useState } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmDelete } from './ConfirmDelete'
import type { ConfirmDeleteProps } from './ConfirmDelete'

/** The copy a folder cascade would get, as the dialog itself sees it. */
const COPY = {
  title: 'Delete “Work”?',
  message:
    'This permanently deletes 2 folders and 3 items from this device — “Work” and every ' +
    'folder and file nested inside it. This cannot be undone.',
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

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function dialog(element: HTMLElement): HTMLElement {
  const node = element.querySelector('[role="dialog"]')
  if (!(node instanceof HTMLElement)) throw new Error('test bug: no dialog')
  return node
}

function action(element: HTMLElement, label: string): HTMLButtonElement {
  for (const candidate of element.querySelectorAll<HTMLButtonElement>('button')) {
    if (candidate.textContent === label) return candidate
  }
  throw new Error(`test bug: no button labelled ${label}`)
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
function openFromTrigger(trigger: HTMLButtonElement): void {
  act(() => {
    trigger.focus()
  })
  click(trigger)
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
    const { element } = renderDialog()
    const node = dialog(element)

    expect(node.getAttribute('aria-modal')).toBe('true')

    const labelledBy = node.getAttribute('aria-labelledby')
    const describedBy = node.getAttribute('aria-describedby')
    if (labelledBy === null || describedBy === null) throw new Error('test bug: unlabelled dialog')

    expect(document.getElementById(labelledBy)?.textContent).toBe(COPY.title)
    expect(document.getElementById(describedBy)?.textContent).toBe(COPY.message)
  })

  it('offers the destructive verb as the only thing that acts', () => {
    const { element, props } = renderDialog()

    expect(action(element, COPY.confirmLabel).textContent).toBe(
      'Delete folder and contents permanently',
    )
    // The danger treatment rides on the confirm control alone.
    expect(element.querySelector('.confirm-delete__confirm')?.textContent).toBe(COPY.confirmLabel)
    expect(element.querySelector('.library-modal__cancel')?.textContent).toBe('Cancel')

    // Cancel first, then the destructive control: tab order and thumb reach meet the
    // safe answer before the one that costs the library a subtree.
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('.library-modal__actions button')]
    expect(buttons.map((candidate) => candidate.textContent)).toEqual([
      'Cancel',
      COPY.confirmLabel,
    ])
    expect(buttons[1]?.className).toContain('confirm-delete__confirm')
    expect(buttons[0]?.className).not.toContain('confirm-delete__confirm')

    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('never reaches for window.confirm or window.alert', () => {
    // The blocked-in-iframes path: if either were used, the dialog below would render and
    // these spies would stay untouched, while a suppressed native prompt would have
    // deleted the folder with no question shown at all.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    const { element, props } = renderDialog()
    click(action(element, COPY.confirmLabel))
    pressEscape()

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('ignores the backdrop: dismissing on empty space is not an answer', () => {
    const { element, props } = renderDialog()

    click(dialog(element))

    expect(props.onCancel).not.toHaveBeenCalled()
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(element.querySelector('[role="dialog"]')).not.toBe(null)
  })
})

describe('ConfirmDelete — answers', () => {
  it('confirms exactly once, through the destructive control only', () => {
    const { element, props } = renderDialog()

    click(action(element, COPY.confirmLabel))

    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('cancels through the cancel control', () => {
    const { element, props } = renderDialog()

    click(action(element, 'Cancel'))

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('takes Escape as a cancel, never as a confirm', () => {
    const { element, props } = renderDialog()

    pressEscape()

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('stops listening once it is closed', () => {
    const { element, props } = renderDialog()

    pressEscape()
    const harness = openHarnesses[openHarnesses.length - 1]
    if (harness === undefined) throw new Error('test bug: no harness')
    harness.unmount()
    openHarnesses.pop()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(element.querySelector('[role="dialog"]')).toBe(null)
  })
})

describe('ConfirmDelete — focus', () => {
  it('moves focus into the dialog on open, onto the safe control', () => {
    const { element } = mount(createElement(Trigger, { onConfirm: vi.fn(), onCancel: vi.fn() }))
    const trigger = triggerOf(element)

    openFromTrigger(trigger)

    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) throw new Error('test bug: nothing focused')

    expect(dialog(element).contains(focused)).toBe(true)
    expect(focused.textContent).toBe('Cancel')
  })

  it('returns focus to the trigger when the user cancels', () => {
    const onCancel = vi.fn()
    const { element } = mount(createElement(Trigger, { onConfirm: vi.fn(), onCancel }))
    const trigger = triggerOf(element)

    openFromTrigger(trigger)
    click(action(element, 'Cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(element.querySelector('[role="dialog"]')).toBe(null)
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the trigger when Escape cancels', () => {
    const { element } = mount(createElement(Trigger, { onConfirm: vi.fn(), onCancel: vi.fn() }))
    const trigger = triggerOf(element)

    openFromTrigger(trigger)
    pressEscape()

    expect(element.querySelector('[role="dialog"]')).toBe(null)
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the trigger after a confirm, too', () => {
    const { element } = mount(createElement(Trigger, { onConfirm: vi.fn(), onCancel: vi.fn() }))
    const trigger = triggerOf(element)

    openFromTrigger(trigger)
    click(action(element, COPY.confirmLabel))

    expect(document.activeElement).toBe(trigger)
  })
})

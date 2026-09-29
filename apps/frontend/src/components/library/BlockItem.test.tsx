/** @vitest-environment jsdom */
/**
 * Behaviour tests for a single dossier row (ORCHESTRATION D16.2/D16.3, spec row 6).
 *
 * The row used to render a `GripVertical` that did nothing — an affordance and a lie. These
 * tests pin the row contract that makes it true:
 *
 *   - the grip is a real `<button>` carrying the props `useReorderDrag` hands out (its
 *     `aria-label`, its `touch-action: none`), so a pointer can grab it and a keyboard can
 *     focus it;
 *   - the row itself carries `data-reorder-item`, one per row and in list order, dividers
 *     included — the hook counts those markers to measure pitch, and a row that hides from the
 *     count shifts every index under a drag;
 *   - the grabbed row is translated by the offset the hook reports, `onMove` fires once and
 *     only on release, and a cancelled drag leaves neither a translation nor an announcement;
 *   - ArrowUp/ArrowDown/Home/End on the grip announce the same moves the pointer would
 *     (the keyboard twin, D16.3);
 *   - the visible up/down buttons still fire `onMoveUp`/`onMoveDown` with their own row index
 *     and disable themselves at the ends of the list;
 *   - typing in a block calls `onUpdate` with that block's id and only the changed fields, and
 *     does not touch the order — the row has no save path, because D16.1 moved saving into
 *     the editor.
 *
 * `Harness` wires the rows through the real hook and the real `moveIndex`, exactly the way
 * `FileEditView` does, because testing the grip against a stubbed handle would prove nothing
 * about the grip.
 *
 * jsdom 30 has no `PointerEvent`, so the fake extends `MouseEvent` and carries the three fields
 * the hook actually reads; dispatching a bare `MouseEvent` named `pointerdown` would leave
 * `pointerId` undefined and the hook's per-pointer matching would silently never fire. jsdom
 * also has no layout: rows measure 0 and the hook falls back to `DEFAULT_ITEM_HEIGHT` (48px),
 * so drags are stated in pitches of 48.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { BlockItem } from './BlockItem'
import { WithMantine } from '../common/WithMantine'
import { decryptItem, encryptItem } from '../../lib/crypto'
import { useReorderDrag } from '../../hooks/useReorderDrag'
import { DEFAULT_ITEM_HEIGHT, moveIndex } from '../../lib/reorder'
import type { FileBlock } from '../../lib/library'

// ---------------------------------------------------------------------------
// The pointer API jsdom does not have
// ---------------------------------------------------------------------------

interface PointerInit {
  pointerId?: number
  pointerType?: string
  isPrimary?: boolean
  clientY?: number
  button?: number
}

class HarnessPointerEvent extends MouseEvent {
  readonly pointerId: number
  readonly pointerType: string
  readonly isPrimary: boolean

  constructor(type: string, init: PointerInit = {}) {
    super(type, {
      bubbles: true,
      cancelable: true,
      clientY: init.clientY ?? 0,
      button: init.button ?? 0,
    })
    this.pointerId = init.pointerId ?? 1
    this.pointerType = init.pointerType ?? 'mouse'
    this.isPrimary = init.isPrimary ?? true
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function heading(id: string, content: string): FileBlock {
  return { id, type: 'heading', content }
}

const BLOCKS: FileBlock[] = [
  heading('b-1', 'Alpha'),
  heading('b-2', 'Bravo'),
  heading('b-3', 'Charlie'),
]

/** A divider renders a different root element, so it is the row that could fall out of the count. */
const WITH_DIVIDER: FileBlock[] = [
  heading('b-1', 'Alpha'),
  { id: 'd-1', type: 'divider' },
  heading('b-3', 'Charlie'),
]

// ---------------------------------------------------------------------------
// The harness: the same wiring FileEditView uses
// ---------------------------------------------------------------------------

interface HarnessProps {
  blocks: FileBlock[]
  mode?: 'edit' | 'sender' | 'receiver'
  onMove?(from: number, to: number): void
  onUpdate?(id: string, changes: Partial<FileBlock>): void
  onMoveUp?(index: number): void
  onMoveDown?(index: number): void
  onUnlockCredential?(id: string, plaintextContent: string): void
}

function Harness(props: HarnessProps): ReactNode {
  const [rows, setRows] = useState(props.blocks)
  const { drag, getHandleProps } = useReorderDrag({
    length: rows.length,
    onMove: (from, to) => {
      props.onMove?.(from, to)
      setRows((current) => moveIndex(current, from, to))
    },
  })

  return (
    <div className="space-y-3">
      {rows.map((block, index) => (
        <BlockItem
          key={block.id}
          block={block}
          index={index}
          totalBlocks={rows.length}
          mode={props.mode ?? 'edit'}
          onUpdate={(id, changes) => {
            // The same reducer the editor runs: the row is controlled, so what it announces
            // is what comes back down as props.
            props.onUpdate?.(id, changes)
            setRows((current) =>
              current.map((row) => (row.id === id ? { ...row, ...changes } : row)),
            )
          }}
          onMoveUp={props.onMoveUp}
          onMoveDown={props.onMoveDown}
          onUnlockCredential={props.onUnlockCredential}
          reorderHandleProps={getHandleProps(index)}
          isReorderDragging={drag?.from === index}
          reorderOffset={drag !== null && drag.from === index ? drag.offset : 0}
        />
      ))}
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(props: HarnessProps): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    // The row is built from Mantine controls, and the lock dialog is a Mantine `Modal`, so the
    // harness supplies the provider the app supplies (`FileEditView.test.tsx` does the same).
    root?.render(
      <WithMantine>
        <Harness {...props} />
      </WithMantine>,
    )
  })
}

/**
 * The lock dialog floats in a portal on `document.body`, and Mantine mounts a portal on a frame
 * rather than inside the `act()` that opened it, so a test that drives it waits one first. The
 * unlock form is deliberately NOT in here: it is rendered inline in the row, and reading the
 * dialog from the document keeps that distinction visible instead of papering over it.
 */
async function openDialog(): Promise<HTMLElement> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve()
      })
    })
  })
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (dialog === null) throw new Error('test bug: the lock dialog never opened')
  return dialog
}

function unmountNow(): void {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
}

afterEach(unmountNow)

function element(): HTMLDivElement {
  if (container === null) throw new Error('test bug: nothing is mounted')
  return container
}

/** The rows the hook can see, in list order. */
function markedRows(): HTMLElement[] {
  return Array.from(element().querySelectorAll('[data-reorder-item]')) as HTMLElement[]
}

function grips(): HTMLButtonElement[] {
  return Array.from(element().querySelectorAll('button')).filter((button) =>
    (button.getAttribute('aria-label') ?? '').startsWith('Reorder item'),
  ) as HTMLButtonElement[]
}

function gripAt(index: number): HTMLButtonElement {
  const grip = grips()[index]
  if (grip === undefined) throw new Error('test bug: no grip at index ' + index)
  return grip
}

function arrowIn(rowIndex: number, direction: 'up' | 'down'): HTMLButtonElement {
  const row = markedRows()[rowIndex]
  if (row === undefined) throw new Error('test bug: no row at index ' + rowIndex)
  const wanted = direction === 'up' ? ' block up' : ' block down'
  const button = Array.from(row.querySelectorAll('button')).find((candidate) =>
    (candidate.getAttribute('aria-label') ?? '').endsWith(wanted),
  )
  if (button === undefined) throw new Error(`test bug: no "${direction}" arrow in row ${rowIndex}`)
  return button as HTMLButtonElement
}

function headingInputs(): HTMLInputElement[] {
  return Array.from(
    element().querySelectorAll<HTMLInputElement>('input[placeholder="Enter section heading..."]'),
  )
}

function headingInput(index: number): HTMLInputElement {
  const input = headingInputs()[index]
  if (input === undefined) throw new Error('test bug: no heading input at index ' + index)
  return input
}

/** The rendered heading texts, in document order — what the user sees the list as. */
function headingOrder(): string[] {
  return headingInputs().map((input) => input.value)
}

function click(button: HTMLElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: input value has no setter')
  setter.call(input, value)
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pointerDown(handle: HTMLElement, clientY: number): void {
  act(() => {
    handle.dispatchEvent(new HarnessPointerEvent('pointerdown', { clientY }))
  })
}

function pointerMove(clientY: number): void {
  act(() => {
    // On the window, not the grip: a pointer that strays off the handle still drives the drag.
    window.dispatchEvent(new HarnessPointerEvent('pointermove', { clientY }))
  })
}

function pointerUp(): void {
  act(() => {
    window.dispatchEvent(new HarnessPointerEvent('pointerup', { clientY: 0 }))
  })
}

function pressOn(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** Grabs row `from` and travels it to row `to`, one pitch at a time. */
function drag(from: number, to: number): void {
  const startY = 100
  pointerDown(gripAt(from), startY)
  pointerMove(startY + (to - from) * DEFAULT_ITEM_HEIGHT)
  pointerUp()
}

// ---------------------------------------------------------------------------
// The grip is a real handle (D16.2)
// ---------------------------------------------------------------------------

describe('BlockItem — the drag grip', () => {
  it('renders the hook handle as a focusable button, and marks every row for measurement', () => {
    mount({ blocks: BLOCKS })

    expect(markedRows()).toHaveLength(3)
    expect(grips()).toHaveLength(3)

    const grip = gripAt(1)
    expect(grip.tagName).toBe('BUTTON')
    expect(grip.getAttribute('aria-label')).toBe('Reorder item 2 of 3')
    // `touch-action: none` is what lets a touch drag move the row instead of scrolling the page.
    expect(grip.style.touchAction).toBe('none')
  })

  it('marks a divider row too, so grip indices still match list indices', () => {
    mount({ blocks: WITH_DIVIDER })

    expect(markedRows()).toHaveLength(3)
    expect(grips()).toHaveLength(3)
    const dividerRow = markedRows()[1]
    expect(dividerRow?.querySelector('button[aria-label^="Reorder item"]')).not.toBeNull()
  })

  it('renders no grip and no row marker outside the editor', () => {
    mount({ blocks: [heading('b-1', 'Alpha')], mode: 'receiver' })

    expect(grips()).toHaveLength(0)
    expect(markedRows()).toHaveLength(0)
  })

  it('moves a row with the pointer, announcing once and only on release', () => {
    const onMove = vi.fn()
    mount({ blocks: BLOCKS, onMove })

    const startY = 100
    pointerDown(gripAt(0), startY)
    pointerMove(startY + DEFAULT_ITEM_HEIGHT)

    // Mid-drag: nothing has been announced, nothing has been reordered, the row is only moved.
    expect(onMove).not.toHaveBeenCalled()
    expect(headingOrder()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(markedRows()[0]?.style.transform).toContain('48px')

    pointerUp()

    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith(0, 1)
    expect(headingOrder()).toEqual(['Bravo', 'Alpha', 'Charlie'])
    // The translation belongs to the drag, and the drag is over.
    expect(markedRows()[0]?.style.transform).toBe('')
    expect(markedRows()[1]?.style.transform).toBe('')
  })

  it('cancels on Escape: no move, no announcement, no leftover offset', () => {
    const onMove = vi.fn()
    mount({ blocks: BLOCKS, onMove })

    pointerDown(gripAt(2), 200)
    pointerMove(200 - 2 * DEFAULT_ITEM_HEIGHT)
    expect(markedRows()[2]?.style.transform).toContain('-96px')

    pressOn(document.body, 'Escape')
    pointerUp()

    expect(onMove).not.toHaveBeenCalled()
    expect(headingOrder()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(markedRows()[2]?.style.transform).toBe('')
  })

  it('moves the same row from the keyboard on that grip (D16.3)', () => {
    const onMove = vi.fn()
    mount({ blocks: BLOCKS, onMove })

    pressOn(gripAt(0), 'ArrowDown')
    expect(onMove).toHaveBeenLastCalledWith(0, 1)

    drag(0, 2) // put row 0 at the bottom, so the next key has a fresh list to act on
    const before = headingOrder()

    pressOn(gripAt(0), 'End')
    expect(onMove).toHaveBeenLastCalledWith(0, 2)
    expect(headingOrder()).not.toEqual(before)

    // A key the grip does not own is left to the browser, so Tab and page scrolling work.
    const calls = onMove.mock.calls.length
    pressOn(gripAt(0), 'Tab')
    expect(onMove).toHaveBeenCalledTimes(calls)
  })
})

// ---------------------------------------------------------------------------
// The arrow buttons stay the accessible twin
// ---------------------------------------------------------------------------

describe('BlockItem — the arrow controls', () => {
  it('labels both arrows and reports which row was pressed', () => {
    const onMoveUp = vi.fn()
    const onMoveDown = vi.fn()
    mount({ blocks: BLOCKS, onMoveUp, onMoveDown })

    click(arrowIn(1, 'down'))
    expect(onMoveDown).toHaveBeenCalledWith(1)

    click(arrowIn(1, 'up'))
    expect(onMoveUp).toHaveBeenCalledWith(1)
  })

  it('disables the arrows that would move a row off the list', () => {
    mount({ blocks: BLOCKS })

    expect(arrowIn(0, 'up').disabled).toBe(true)
    expect(arrowIn(0, 'down').disabled).toBe(false)
    expect(arrowIn(2, 'down').disabled).toBe(true)
    expect(arrowIn(2, 'up').disabled).toBe(false)
  })

  it('takes a divider out of the way with the grip, the same way as any other row', () => {
    const onMove = vi.fn()
    mount({ blocks: WITH_DIVIDER, onMove })

    drag(1, 2)

    expect(onMove).toHaveBeenCalledWith(1, 2)
    // The divider is not a heading input, so the two headings simply swap places behind it.
    expect(headingOrder()).toEqual(['Alpha', 'Charlie'])
    expect(markedRows()[2]?.textContent ?? '').toContain('DIVIDER')
  })
})

// ---------------------------------------------------------------------------
// Editing a block stays local (D16.1)
// ---------------------------------------------------------------------------

describe('BlockItem — editing a block', () => {
  it('announces the changed field for that block id, and never reorders or persists', () => {
    const onUpdate = vi.fn()
    const onMove = vi.fn()
    const onMoveUp = vi.fn()
    mount({ blocks: BLOCKS, onUpdate, onMove, onMoveUp })

    typeInto(headingInput(0), 'Alpha rewritten')
    expect(onUpdate).toHaveBeenLastCalledWith('b-1', { content: 'Alpha rewritten' })

    typeInto(headingInput(1), 'Bravo rewritten')
    expect(onUpdate).toHaveBeenLastCalledWith('b-2', { content: 'Bravo rewritten' })

    // Typing is not a reorder, and the row has no save path of its own.
    expect(onMove).not.toHaveBeenCalled()
    expect(onMoveUp).not.toHaveBeenCalled()
    expect(headingOrder()).toEqual(['Alpha rewritten', 'Bravo rewritten', 'Charlie'])
  })

  it('keeps the grip and the block actions out of the sender screen', () => {
    mount({ blocks: [heading('b-1', 'Alpha')], mode: 'sender' })

    expect(grips()).toHaveLength(0)
    expect(headingInputs()).toHaveLength(0)
    expect(element().textContent ?? '').toContain('Alpha')
  })
})

// ---------------------------------------------------------------------------
// Attachments: bytes are chosen, never invented
// ---------------------------------------------------------------------------

/**
 * The image/fileAttachment rows used to render a filename, a resolution and a size that no file
 * ever supplied (`image_attachment.png`, `1920×1080 · 412 KB`, `data_export.bin` at `2.4 MB`),
 * and `fileBlocksToLibraryItems` then transmitted 100 null bytes for them. These tests hold the
 * line at the row: an empty block says it is empty, a size is always `blob.size`, and a refused
 * choice writes nothing.
 */

function attachmentInput(): HTMLInputElement {
  const input = element().querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) throw new Error('test bug: the row rendered no file input')
  return input
}

function chooseFile(file: File | null): void {
  const input = attachmentInput()
  Object.defineProperty(input, 'files', {
    value: file === null ? [] : [file],
    configurable: true,
  })

  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = Array.from(element().querySelectorAll('button')).find(
    (candidate) => (candidate.textContent ?? '').trim() === label,
  )
  if (button === undefined) throw new Error(`test bug: no button labelled "${label}"`)
  return button as HTMLButtonElement
}

function screenText(): string {
  return element().textContent ?? ''
}

/** Opens the block's lock dialog, the way the shield in its header bar does. */
function openLockModal(): void {
  const trigger = Array.from(element().querySelectorAll('button')).find(
    (button) => (button.getAttribute('title') ?? '') === 'Encrypt this block with a password',
  )
  if (trigger === undefined) throw new Error('test bug: no lock button on the row')
  click(trigger)
}

/** The password field of the portaled lock dialog, in the document the dialog floats in. */
async function lockPasswordField(): Promise<HTMLInputElement> {
  const dialog = await openDialog()
  const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')
  if (field === null) throw new Error('test bug: the lock dialog has no password field')
  return field
}

/** The password field of the row's inline unlock form, which stays inside the container. */
function passwordField(): HTMLInputElement {
  const field = element().querySelector<HTMLInputElement>('input[type="password"]')
  if (field === null) throw new Error('test bug: the unlock form never opened')
  return field
}

/**
 * Submits the lock dialog's form and waits for it to settle — either the announced tuple or the
 * refusal. PBKDF2 at 600,000 iterations (PLAN.md §11.4) is real work rather than a microtask, so
 * a single flush would race it, and the wait is on the outcome the test then asserts (D15).
 */
async function submitLock(onUpdate: ReturnType<typeof vi.fn>): Promise<void> {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  const form = dialog?.querySelector('form')
  if (form === null || form === undefined) throw new Error('test bug: the lock dialog has no form')

  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })

  const settled = (): boolean =>
    onUpdate.mock.calls.length > 0 ||
    (document.querySelector('[role="dialog"]')?.querySelector('[data-lock-error]') ?? null) !==
      null

  await act(async () => {
    for (let attempt = 0; attempt < 400 && !settled(); attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10)
      })
    }
  })

  if (!settled()) throw new Error('test bug: the lock dialog neither wrote a tuple nor refused')
}

function imageFile(name: string, byteLength: number): File {
  const payload = new Uint8Array(byteLength)
  for (let index = 0; index < byteLength; index += 1) {
    payload[index] = (index * 37 + 11) % 251
  }
  return new File([payload], name, { type: 'image/png' })
}

describe('BlockItem — an attachment block holds a file or it holds nothing', () => {
  it('says an image block has no image, and shows none of the invented metadata', () => {
    mount({ blocks: [{ id: 'b-img', type: 'image' }] })

    expect(screenText()).toContain('No image chosen yet')
    expect(attachmentInput().accept).toBe('image/*')
    expect(buttonByLabel('Choose image')).toBeInstanceOf(HTMLButtonElement)

    // Absence, the D15 lesson: every one of these was on screen before, next to a block with no
    // bytes, and none of them could fail a "does it render" test.
    for (const invented of [
      'image_attachment.png',
      'attachment_photo.png',
      '1920×1080',
      '412 KB',
      'Telemetry capture',
      'CAM_01',
      'LIDAR_A',
    ]) {
      expect(screenText()).not.toContain(invented)
    }
  })

  it('says a fileAttachment block has no file and claims no size', () => {
    mount({ blocks: [{ id: 'b-file', type: 'fileAttachment' }] })

    expect(screenText()).toContain('No file chosen')
    expect(screenText()).toContain('no size until a file is chosen')
    for (const invented of ['file_attachment.bin', 'data_export.bin', '2.4 MB']) {
      expect(screenText()).not.toContain(invented)
    }
  })

  it('writes the chosen file onto the block: bytes, name, type and a measured byte count', () => {
    const onUpdate = vi.fn()
    mount({ blocks: [{ id: 'b-img', type: 'image' }], onUpdate })
    const file = imageFile('rig.png', 5)

    chooseFile(file)

    const changes = vi.mocked(onUpdate).mock.calls[0]?.[1]
    if (changes === undefined) throw new Error('test bug: the row announced nothing')
    expect(vi.mocked(onUpdate).mock.calls[0]?.[0]).toBe('b-img')
    expect(changes.blob).toBe(file)
    expect(changes.fileName).toBe('rig.png')
    expect(changes.mimeType).toBe('image/png')
    // A number of bytes, not a display string: this is `blob.size`, stored as what it is.
    expect(changes.fileSize).toBe(5)

    expect(screenText()).toContain('rig.png')
    expect(screenText()).toContain('5 B')
    expect(buttonByLabel('Replace image')).toBeInstanceOf(HTMLButtonElement)
  })

  it('shows the size measured from the blob, never the string stored beside it', () => {
    // A record that carries both a real 12-byte file and a stale hand-written label: the
    // measurement wins, because the label is the thing that lied.
    mount({
      blocks: [
        {
          id: 'b-file',
          type: 'fileAttachment',
          fileName: 'thing.bin',
          fileSize: '14.2 MB',
          blob: new Blob([new Uint8Array(12)], { type: 'application/octet-stream' }),
        },
      ],
    })

    expect(screenText()).toContain('12 B')
    expect(screenText()).not.toContain('14.2 MB')
  })

  it('refuses a non-image on an image block and writes nothing to the block', () => {
    const onUpdate = vi.fn()
    mount({ blocks: [{ id: 'b-img', type: 'image' }], onUpdate })

    chooseFile(new File(['a,b,c'], 'payload.csv', { type: 'text/csv' }))

    expect(onUpdate).not.toHaveBeenCalled()
    const error = element().querySelector('[data-attachment-error]')
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain('is not an image')
    // The block is still the empty block it was: no half-written draft, no orphaned filename.
    expect(screenText()).toContain('No image chosen yet')
  })

  it('refuses to lock a payload over D6, and writes no tuple', async () => {
    const onUpdate = vi.fn()
    mount({
      blocks: [
        {
          id: 'b-file',
          type: 'fileAttachment',
          fileName: 'weights.bin',
          fileSize: 3 * 1024 * 1024 + 1,
          blob: new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'weights.bin', {
            type: 'application/octet-stream',
          }),
        },
      ],
      onUpdate,
    })

    openLockModal()
    typeInto(await lockPasswordField(), 'sentry-4')
    await submitLock(onUpdate)

    expect(onUpdate).not.toHaveBeenCalled()
    expect(
      document
        .querySelector<HTMLElement>('[role="dialog"]')
        ?.querySelector('[data-lock-error]')?.textContent,
    ).toContain('3.0 MiB')
  })

  it('locks the bytes the block actually holds, and stores only the tuple', async () => {
    // Requirement: a locked attachment is ciphertext of ITS OWN file, never of the literal
    // `'secret'` the send path used to fall back to, and never of nothing at all.
    const onUpdate = vi.fn()
    const payload = new File([new Uint8Array([12, 34, 56, 78])], 'key.bin', {
      type: 'application/octet-stream',
    })
    mount({
      blocks: [{ id: 'b-file', type: 'fileAttachment', fileName: 'key.bin', blob: payload }],
      onUpdate,
    })

    openLockModal()
    typeInto(await lockPasswordField(), 'sentry-4')
    await submitLock(onUpdate)

    const changes = vi.mocked(onUpdate).mock.calls[0]?.[1]
    if (changes?.lockedData === undefined) throw new Error('test bug: locking announced no tuple')
    expect(changes.isLocked).toBe(true)
    expect(changes.lockedData.innerType).toBe('fileAttachment')
    expect(changes.lockedData.iv).toHaveLength(12)
    expect(changes.lockedData.salt).toHaveLength(16)

    const decrypted = await decryptItem(
      'sentry-4',
      changes.lockedData.salt as Uint8Array,
      changes.lockedData.iv as Uint8Array,
      changes.lockedData.ciphertext as Uint8Array,
    )
    expect(decrypted).toEqual(new Uint8Array([12, 34, 56, 78]))
  })

  it('will not let a locked attachment be swapped out from under its own ciphertext', async () => {
    /*
     * The row shows one payload while the tuple holds another is the same defect in a hat, so the
     * chooser disappears once the bytes are encrypted.
     *
     * The fixture is the real flow, not a hand-planted flag: the guard reads the CIPHERTEXT, so a
     * block that only carries `isLocked` (the shape every locked row was before this lane, and the
     * shape a legacy record still has) must keep its file chooser — otherwise there would be no
     * way to choose the bytes that need encrypting, and the warning state would be a dead end.
     */
    const onUpdate = vi.fn()
    const original = new File([new Uint8Array(3)], 'locked.png', { type: 'image/png' })
    mount({
      blocks: [{ id: 'b-img', type: 'image', fileName: 'locked.png', blob: original }],
      onUpdate,
    })

    // Before it is encrypted the row is an ordinary image row: it can still replace its own file.
    expect(attachmentInput()).toBeInstanceOf(HTMLInputElement)
    expect(element().querySelector('[data-attachment-locked]')).toBeNull()

    openLockModal()
    typeInto(await lockPasswordField(), 'sentry-4')
    await submitLock(onUpdate)

    // After it, the bytes underneath the ciphertext are frozen.
    expect(element().querySelector('input[type="file"]')).toBeNull()
    expect(element().querySelector('[data-attachment-locked]')?.textContent).toContain(
      'Remove the lock',
    )
    expect(screenText()).toContain('locked.png')
    // …because the row is now genuinely protected, which is the only state that earns the badge.
    expect(element().querySelector('[data-block-protected]')).not.toBeNull()
    expect(element().querySelector('[data-block-unprotected]')).toBeNull()
  })

  it('keeps the file chooser on a block that is flagged locked but holds no ciphertext', () => {
    // The legacy shape: `isLocked: true`, plaintext bytes, no tuple. The row must say it is not
    // encrypted AND still let the user replace the file, because choosing bytes is the first step
    // to encrypting them. A guard on the flag instead of the ciphertext would lock both out.
    mount({
      blocks: [
        {
          id: 'b-img',
          type: 'image',
          fileName: 'unprotected.png',
          blob: new File([new Uint8Array(3)], 'unprotected.png', { type: 'image/png' }),
          isLocked: true,
        },
      ],
    })

    expect(attachmentInput()).toBeInstanceOf(HTMLInputElement)
    expect(element().querySelector('[data-attachment-locked]')).toBeNull()
    expect(element().querySelector('[data-block-unprotected]')).not.toBeNull()
    expect(element().querySelector('[data-block-protected]')).toBeNull()
    expect(screenText()).toContain('Not encrypted')
  })

  it('replaces a chosen file, and the new bytes are what the row shows', () => {
    const onUpdate = vi.fn()
    mount({ blocks: [{ id: 'b-img', type: 'image' }], onUpdate })

    chooseFile(imageFile('first.png', 5))
    chooseFile(imageFile('second.png', 9))

    const last = vi.mocked(onUpdate).mock.calls.at(-1)?.[1]
    if (last === undefined) throw new Error('test bug: no replacement was announced')
    expect(last.fileName).toBe('second.png')
    expect(last.fileSize).toBe(9)
  })

  it('removes an attachment by taking its bytes and its metadata off the block together', () => {
    const onUpdate = vi.fn()
    mount({ blocks: [{ id: 'b-img', type: 'image' }], onUpdate })
    chooseFile(imageFile('rig.png', 5))
    onUpdate.mockClear()

    click(buttonByLabel('Remove image'))

    const changes = vi.mocked(onUpdate).mock.calls[0]?.[1]
    if (changes === undefined) throw new Error('test bug: removing announced nothing')
    expect(changes.blob).toBeUndefined()
    expect(changes.fileName).toBeUndefined()
    expect(changes.fileSize).toBeUndefined()
    expect(changes.mimeType).toBeUndefined()
    expect(screenText()).toContain('No file chosen')
    expect(screenText()).not.toContain('rig.png')
  })

  it('draws the chosen image with an object URL, and releases it on every exit path', () => {
    const createObjectURL = vi.fn((): string => 'blob:qrbit/1')
    const revokeObjectURL = vi.fn()
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL

    try {
      const onUpdate = vi.fn()
      mount({ blocks: [{ id: 'b-img', type: 'image' }], onUpdate })

      // No bytes, no URL: nothing is created for an empty block to leak.
      expect(createObjectURL).not.toHaveBeenCalled()

      const first = imageFile('first.png', 5)
      chooseFile(first)
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(createObjectURL).toHaveBeenCalledWith(first)
      expect(element().querySelector('[data-attachment-preview]')).not.toBe(null)

      // Replacing the file releases the old URL before drawing the new one.
      const second = imageFile('second.png', 7)
      chooseFile(second)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:qrbit/1')
      expect(createObjectURL).toHaveBeenCalledTimes(2)

      act(() => {
        root?.unmount()
        root = null
      })
      expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })
})

// ---------------------------------------------------------------------------
// Unlocking: the password is the only door, and `pass` is not a key
//
// The shipped row checked `const expectedPassword = block.password || 'pass'` and then
// `if (passwordInput === expectedPassword || passwordInput === 'pass')`, so every locked block in
// the app opened to the four letters p-a-s-s — and what it "revealed" was `block.content`, the
// plaintext IndexedDB had been holding all along, or the string `'sys_x94#kK99!Alpha2'` when the
// block held nothing. There is one way in now: `decryptItem` on the block's own `{ciphertext, iv,
// salt}`. These tests are written as absences, because a test that only asks whether the row
// RENDERED a lock is the test that let the bug ship: after a refused unlock the secret must be
// nowhere on the screen, and the refusal must look identical whatever caused it.
//
// One tuple is derived for the whole block (`beforeAll`): PBKDF2 is at 600,000 iterations
// (PLAN.md §19 decision 9), so a fixture per test would spend the suite's time budget on key
// derivation instead of on the assertion, and each test below still pays one real derivation for
// its own attempt.
// ---------------------------------------------------------------------------

const GATEWAY_SECRET = 'krnl-7742-rotor-alt-seed'
const GATEWAY_PASSWORD = 'correct-horse-not-stored'

let gatewayBlock: FileBlock

beforeAll(async () => {
  const tuple = await encryptItem(GATEWAY_PASSWORD, new TextEncoder().encode(GATEWAY_SECRET))
  gatewayBlock = {
    id: 'b-lock',
    type: 'locked',
    label: 'Cluster keyphrase',
    isLocked: true,
    lockedData: { ...tuple, innerType: 'shortText' },
  }
})

/** A fresh copy of the encrypted fixture, so a test cannot leak state into the next one. */
function protectedGatewayBlock(): FileBlock {
  return structuredClone(gatewayBlock)
}

/**
 * Mounts `block`, opens its unlock form, types `password`, submits, and waits for one of the two
 * outcomes the row is allowed to produce.
 *
 * The wait is one `act` per tick rather than one `act` around the loop: the re-render that paints
 * the refusal comes from a continuation of the Web Crypto promise, and a single long-lived `act`
 * scope can end before it, which is how a working component looked like a hanging test.
 */
async function unlockWith(
  block: FileBlock,
  password: string,
  onUnlockCredential?: (id: string, plaintextContent: string) => void,
): Promise<ReturnType<typeof vi.fn>> {
  const onUpdate = vi.fn()
  mount({ blocks: [block], onUpdate, onUnlockCredential })

  click(buttonByLabel('Unlock'))
  typeInto(passwordField(), password)

  const form = element().querySelector('form')
  if (form === null) throw new Error('test bug: the unlock form never opened')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })

  const settled = (): boolean =>
    onUpdate.mock.calls.length > 0 || element().querySelector('[data-unlock-error]') !== null
  for (let attempt = 0; attempt < 600 && !settled(); attempt += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10)
      })
    })
  }
  if (!settled()) throw new Error('test bug: the unlock neither revealed nor refused')

  return onUpdate
}

describe('BlockItem — unlocking really decrypts', () => {
  it('opens to the exact plaintext that went in, and only to the password that made it', async () => {
    const credential = vi.fn()
    const onUpdate = await unlockWith(protectedGatewayBlock(), GATEWAY_PASSWORD, credential)

    expect(element().querySelector('[data-unlock-error]')).toBeNull()
    expect(element().querySelector('[data-revealed]')?.textContent).toBe(GATEWAY_SECRET)
    expect(onUpdate).toHaveBeenCalledWith('b-lock', {
      isUnlocked: true,
      content: GATEWAY_SECRET,
    })
    // The editor is handed the credential only because the bytes decrypted — and the badge the
    // row wears is earned by the ciphertext, not by a flag.
    expect(credential).toHaveBeenCalledWith('b-lock', GATEWAY_SECRET)
    expect(element().querySelector('[data-block-protected]')).not.toBeNull()
    expect(element().querySelector('[data-block-unprotected]')).toBeNull()
  })

  it('is not opened by the literal "pass", and leaves no trace of the secret on screen', async () => {
    const credential = vi.fn()
    const onUpdate = await unlockWith(protectedGatewayBlock(), 'pass', credential)

    // The exact input that opened every locked block in the shipped build.
    expect(onUpdate).not.toHaveBeenCalled()
    expect(credential).not.toHaveBeenCalled()
    expect(element().querySelector('[data-revealed]')).toBeNull()
    const error = element().querySelector('[data-unlock-error]')
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain('Incorrect password')

    // Absence in both directions: no reveal of the real payload, and no fabricated one either.
    expect(screenText()).not.toContain(GATEWAY_SECRET)
    expect(screenText()).not.toContain('sys_x94')
  })

  it('refuses a wrong password and a tampered ciphertext in the same words', async () => {
    /*
     * `lib/library.ts` insists that both unlock paths report a failed GCM check as a wrong
     * password, because "you typed it wrong" and "those bytes are not what they were" are two
     * different things for whoever is at the keyboard to learn. One message, whatever the cause.
     */
    const tampered = protectedGatewayBlock()
    await unlockWith(tampered, 'not-the-password')
    const wrongPassword = element().querySelector('[data-unlock-error]')?.textContent
    expect(wrongPassword).toContain('Incorrect password')

    unmountNow()

    const data = tampered.lockedData
    if (data === undefined) throw new Error('test bug: the fixture lost its tuple')
    const corruptedBytes = data.ciphertext.slice()
    const last = corruptedBytes.length - 1
    corruptedBytes[last] = (corruptedBytes[last] ?? 0) ^ 0x01

    const onUpdate = await unlockWith(
      { ...tampered, lockedData: { ...data, ciphertext: corruptedBytes } },
      GATEWAY_PASSWORD,
    )

    // The right password over one flipped byte: refused, in the sentence the wrong password got.
    expect(onUpdate).not.toHaveBeenCalled()
    expect(element().querySelector('[data-unlock-error]')?.textContent).toBe(wrongPassword)
    expect(element().querySelector('[data-revealed]')).toBeNull()
    expect(screenText()).not.toContain(GATEWAY_SECRET)
  })

  it('shows no invented secret, no blurred fake and no password hint beside ciphertext', () => {
    // The static state, so no derivation is needed: these are the strings the old build printed
    // over every locked block, whatever that block actually held.
    mount({ blocks: [protectedGatewayBlock()] })

    for (const invented of [
      'sys_x94#kK99!Alpha2',
      'sys_x94#kK99!Alpha2_protected_vault',
      'Passphrase:',
      '••••••••',
      '(set)',
      'hint: pass',
      GATEWAY_SECRET,
    ]) {
      expect(screenText()).not.toContain(invented)
    }
    expect(element().querySelector('[data-ciphertext-state]')).not.toBeNull()
    expect(element().querySelector('[data-unlock-error]')).toBeNull()
  })

  it('shows a plaintext locked block as NOT encrypted, with no badge and no unlock to fake', () => {
    // The legacy row: a lock flag, a plaintext secret, no ciphertext at all. The row used to put a
    // "Locked Payload" pill on it, a blurred `sys_x94#kK99!Alpha2_protected_vault` under the pill
    // and a `pass` hint under that — three claims, none of them true.
    mount({
      blocks: [
        {
          id: 'b-legacy',
          type: 'locked',
          label: 'Cluster keyphrase',
          content: GATEWAY_SECRET,
          isLocked: true,
        },
      ],
    })

    expect(element().querySelector('[data-block-unprotected]')).not.toBeNull()
    expect(element().querySelector('[data-block-protected]')).toBeNull()
    expect(element().querySelector('[data-unprotected-badge]')?.textContent).toContain(
      'Not encrypted',
    )
    expect(element().querySelector('[data-unprotected-note]')?.textContent).toContain(
      'stored as plaintext',
    )

    // No badge, no invented secret, and no Unlock affordance with which to pretend to decrypt.
    expect(buttonByLabelOrAbsent('Unlock')).toBeNull()
    expect(buttonByLabelOrAbsent('Locked Payload')).toBeNull()
    expect(element().querySelector('[data-revealed]')).toBeNull()
    for (const invented of ['sys_x94', 'Passphrase:', 'hint: pass', '••••••••']) {
      expect(screenText()).not.toContain(invented)
    }
  })
})

function buttonByLabelOrAbsent(label: string): HTMLButtonElement | null {
  return (
    Array.from(element().querySelectorAll('button')).find(
      (candidate) => (candidate.textContent ?? '').trim() === label,
    ) ?? null
  )
}

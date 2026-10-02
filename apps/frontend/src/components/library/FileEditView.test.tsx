/** @vitest-environment jsdom */
/**
 * Behaviour tests for the dossier editor (ORCHESTRATION D16.1/D16.2/D16.3, spec rows 6-8).
 *
 * These assert the things the editor EXISTS to get right, not that it renders:
 *
 *   - a keystroke alone must not reach the library (the per-keystroke autosave is the bug
 *     D16.1 removed), and `Save` must be the thing that writes, flipping the draft back to
 *     clean and disabling itself;
 *   - leaving with a dirty draft must interrupt, and both exits (save-and-leave, discard)
 *     have to be observable through the host's own callbacks;
 *   - `Send` must hand over the DRAFT, persisted first, so what leaves the device is what the
 *     user was looking at;
 *   - a grip drag, a key on the grip and the visible arrow button must produce the SAME
 *     order — that is the whole D16.3 claim, and it is asserted by comparing the three
 *     resulting orders rather than by trusting that they share a reducer;
 *   - a folder move must survive the next save (the saved record carries the new `folderId`,
 *     not the one the host's stale `file` prop still holds).
 *
 * The harness is the repo's own: `createRoot` into a node appended to `document.body` (React 19
 * will not route an event dispatched in a detached tree), native value setters for typing, and
 * a `PointerEvent` stand-in extending `MouseEvent` with the three fields `useReorderDrag` reads
 * — jsdom 30 ships no PointerEvent, and a bare `MouseEvent` under the name `pointerdown` would
 * leave `pointerId` undefined and silently skip the hook's per-pointer matching.
 *
 * jsdom has no layout, so every row measures 0 and the hook falls back to `DEFAULT_ITEM_HEIGHT`
 * (48px). Drag distances are therefore stated in pitches of 48.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { FileEditView } from './FileEditView'
import type { FileEditViewProps } from './FileEditView'
import { fileBlocksToLibraryItems } from '../../lib/dossier'
import { WithMantine } from '../common/WithMantine'
import { DEFAULT_ITEM_HEIGHT } from '../../lib/reorder'
import { useLibraryStore } from '../../store/libraryStore'
import type { FileBlock, LibraryFile, LibraryFolder } from '../../lib/library'

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
// Fixture
// ---------------------------------------------------------------------------

const FOLDERS: LibraryFolder[] = [
  { id: 'f-1', name: 'Credentials', parentId: null, createdAt: 1, updatedAt: 1 },
  { id: 'f-2', name: 'Field Notes', parentId: null, createdAt: 2, updatedAt: 2 },
]

function heading(id: string, content: string): FileBlock {
  return { id, type: 'heading', content }
}

function makeFile(overrides: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id: 'file-1',
    folderId: 'f-1',
    name: 'Relay Dossier',
    createdAt: 1000,
    updatedAt: 1000,
    blocks: [heading('b-1', 'Alpha'), heading('b-2', 'Bravo'), heading('b-3', 'Charlie')],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mount + query helpers
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(props: FileEditViewProps): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <WithMantine>
        <FileEditView {...props} />
      </WithMantine>,
    )
  })
}

function rerender(props: FileEditViewProps): void {
  act(() => {
    root?.render(
      <WithMantine>
        <FileEditView {...props} />
      </WithMantine>,
    )
  })
}

function unmount(): void {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
}

function element(): HTMLDivElement {
  if (container === null) throw new Error('test bug: nothing is mounted')
  return container
}

function buttons(): HTMLButtonElement[] {
  return Array.from(element().querySelectorAll('button'))
}

/** Mantine renders the label as text content, or for icon buttons in aria-label/title. */
function buttonByLabel(label: string): HTMLButtonElement {
  const clean = label.replace(/[….]+$/, '').trim()
  const found = buttons().find(
    (button) =>
      (button.textContent ?? '').trim() === label ||
      button.getAttribute('aria-label') === label ||
      button.getAttribute('title') === label ||
      (clean !== '' &&
        (button.getAttribute('aria-label')?.startsWith(clean) ||
          button.getAttribute('title')?.startsWith(clean))),
  )
  if (found === undefined) throw new Error(`test bug: no button labelled "${label}"`)
  return found
}

/*
 * The Save control is found by the state it declares, not by its words: its label is a sentence
 * about the draft (`Save dossier` while there is one, `Saved` while there is not), so a label
 * lookup would have to change with every edit. `data-save-state` is that same declaration, and the
 * tests below still assert the words — just through the control the marker found.
 */
function saveButton(): HTMLButtonElement {
  const found = element().querySelector<HTMLButtonElement>('button[data-save-state]')
  if (found === null) throw new Error('test bug: the editor rendered no Save control')
  return found
}

/**
 * A control is sized to its content when a flex row cannot squeeze it narrower: `flex-grow: 0`
 * and `flex-shrink: 0`. That is the whole truncation fix — Mantine's button root is
 * `overflow: hidden` over a `white-space: nowrap` label, so a squeezed button does not shrink its
 * text, it cuts the text off.
 */
function isContentSized(button: HTMLElement): boolean {
  return button.style.flexGrow === '0' && button.style.flexShrink === '0'
}

function byText(text: string): boolean {
  return (element().textContent ?? '').includes(text)
}

/*
 * The folder picker is a Mantine `Modal`, which renders into a portal on `document.body` and so
 * sits outside the container that `element()`, `buttons()` and `byText()` search. Those stay
 * container-scoped deliberately — a document-wide query would let an editor test pass while the
 * row it claims to drive is absent — and everything about a dialog goes through these instead.
 */
function dialogButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('button'))
}

function buttonInDialog(label: string): HTMLButtonElement {
  const found = dialogButtons().find((button) => (button.textContent ?? '').trim() === label)
  if (found === undefined) throw new Error(`test bug: no dialog button labelled "${label}"`)
  return found
}

/** A dialog button whose label contains `text` — the block-type rows carry a name and a description. */
function dialogButtonContaining(text: string): HTMLButtonElement {
  const found = dialogButtons().find((button) => (button.textContent ?? '').includes(text))
  if (found === undefined) throw new Error(`test bug: no dialog button containing "${text}"`)
  return found
}

/** The same, scoped to the open dialog's own panel. */
function buttonContainingInDialog(text: string): HTMLButtonElement {
  const found = dialogButtons().find(
    (button) =>
      (button.textContent ?? '').includes(text) &&
      button.closest('[role="dialog"]') !== null,
  )
  if (found === undefined) throw new Error(`test bug: no dialog button containing "${text}"`)
  return found
}

function inDialog(text: string): boolean {
  const panel = document.body.querySelector('[role="dialog"]')
  return (panel?.textContent ?? '').includes(text)
}

/** The row of action buttons at the foot of the open dialog, as the element that holds them. */
function dialogActionRow(aButton: HTMLButtonElement): HTMLElement {
  const row = aButton.parentElement
  if (row === null) throw new Error('test bug: the dialog action has no row')
  return row
}

/**
 * The leave and encrypt prompts are Mantine `Modal`s: they float in a portal on `document.body`,
 * which is mounted on a frame rather than inside the `act()` that opened it, so a test that reads
 * one waits for it first. The helpers above stay container-scoped on purpose — a document-wide
 * query would let an editor test pass while the row it claims to drive is absent.
 */
async function dialogOpened(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve()
      })
    })
  })
}

async function dialogClosed(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

function gripAt(index: number): HTMLButtonElement {
  const grips = buttons().filter((button) =>
    (button.getAttribute('aria-label') ?? '').startsWith('Reorder item'),
  )
  const grip = grips[index]
  if (grip === undefined) throw new Error(`test bug: no drag grip at index ${index}`)
  return grip
}

/** The heading inputs, in document order — their values ARE the rendered block order. */
function renderedOrder(): string[] {
  return Array.from(
    element().querySelectorAll<HTMLInputElement>('input[placeholder="Enter section heading..."]'),
  ).map((input) => input.value)
}

function headingInput(index: number): HTMLInputElement {
  const input = element().querySelectorAll<HTMLInputElement>(
    'input[placeholder="Enter section heading..."]',
  )[index]
  if (input === undefined) throw new Error(`test bug: no heading input at index ${index}`)
  return input
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

/** One completed grip drag: grab row `from`, travel one pitch per row down to `to`. */
function dragGrip(from: number, to: number): void {
  const startY = 100
  act(() => {
    gripAt(from).dispatchEvent(new HarnessPointerEvent('pointerdown', { clientY: startY }))
  })
  act(() => {
    window.dispatchEvent(
      new HarnessPointerEvent('pointermove', { clientY: startY + (to - from) * DEFAULT_ITEM_HEIGHT }),
    )
  })
  act(() => {
    window.dispatchEvent(new HarnessPointerEvent('pointerup', { clientY: 0 }))
  })
}

function pressOn(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function arrowButton(index: number, direction: 'up' | 'down'): HTMLButtonElement {
  const rows = element().querySelectorAll('[data-reorder-item]')
  const row = rows[index]
  if (row === undefined) throw new Error('test bug: no reorder row at index ' + index)
  const wanted = direction === 'up' ? ' block up' : ' block down'
  const button = Array.from(row.querySelectorAll('button')).find((candidate) =>
    (candidate.getAttribute('aria-label') ?? '').endsWith(wanted),
  )
  if (button === undefined) throw new Error(`test bug: no "${direction}" arrow in row ${index}`)
  return button
}

async function flush(ticks = 2): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
    })
  }
}

/**
 * The host's callbacks, each one a spy carrying the signature of the prop it stands in for, so
 * a saved or sent payload can be read out of the mock without a cast — and so the object is
 * assignable to `FileEditViewProps` by construction.
 */
interface HostProps {
  onBack: Mock<() => void>
  onSaveFile: Mock<(file: LibraryFile) => void>
  onSendFile: Mock<(file: LibraryFile) => void>
  onDirtyChange: Mock<(isDirty: boolean) => void>
}

function callbacks(): HostProps {
  return {
    onBack: vi.fn(),
    onSaveFile: vi.fn(),
    onSendFile: vi.fn(),
    onDirtyChange: vi.fn(),
  }
}

/** The first file the editor asked the host to persist. */
function savedDraft(host: HostProps): LibraryFile {
  const args = host.onSaveFile.mock.calls[0]
  if (args === undefined) throw new Error('test bug: the editor never saved anything')
  return args[0]
}

/** The file the editor handed to the transfer path. */
function sentDraft(host: HostProps): LibraryFile {
  const args = host.onSendFile.mock.calls[0]
  if (args === undefined) throw new Error('test bug: the editor never sent anything')
  return args[0]
}

function backButton(): HTMLButtonElement {
  const back = element().querySelector<HTMLButtonElement>('button[aria-label="Return to library"]')
  if (back === null) throw new Error('test bug: no back button')
  return back
}

function renameTrigger(): HTMLElement {
  // The pencil next to the heading is the control; the heading itself is text, so the rename
  // path has a focusable door instead of a clickable div.
  const trigger = element().querySelector<HTMLElement>('button[aria-label="Rename dossier"]')
  if (trigger === null) throw new Error('test bug: the title cannot be renamed')
  return trigger
}

function titleInput(): HTMLInputElement {
  const input = element().querySelector<HTMLInputElement>('input[aria-label="Dossier name"]')
  if (input === null) throw new Error('test bug: the title editor never opened')
  return input
}

afterEach(() => {
  unmount()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// D16.1 — explicit save
// ---------------------------------------------------------------------------

describe('FileEditView — explicit save (D16.1)', () => {
  it('does not write to the library on a keystroke, and marks the draft dirty instead', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    // Clean on arrival: no indicator, and nothing to save.
    expect(byText('Unsaved changes')).toBe(false)
    expect(saveButton().disabled).toBe(true)

    typeInto(headingInput(0), 'Alpha edited')

    expect(host.onSaveFile).not.toHaveBeenCalled()
    expect(host.onBack).not.toHaveBeenCalled()
    expect(byText('Unsaved changes')).toBe(true)
    expect(saveButton().disabled).toBe(false)
    expect(host.onDirtyChange).toHaveBeenLastCalledWith(true)

    // A second keystroke does not sneak a write in either.
    typeInto(headingInput(1), 'Bravo edited')
    expect(host.onSaveFile).not.toHaveBeenCalled()
  })

  it('Save persists the whole draft once, then goes clean and disables itself', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    typeInto(headingInput(0), 'Alpha edited')
    click(saveButton())

    expect(host.onSaveFile).toHaveBeenCalledTimes(1)
    const saved = savedDraft(host)
    expect(saved.id).toBe('file-1')
    expect(saved.folderId).toBe('f-1')
    expect(saved.blocks.map((block) => block.content)).toEqual([
      'Alpha edited',
      'Bravo',
      'Charlie',
    ])

    expect(byText('Unsaved changes')).toBe(false)
    expect(saveButton().disabled).toBe(true)
    expect(host.onDirtyChange).toHaveBeenLastCalledWith(false)

    // Re-opening a different file must not resurrect the previous draft: the seed follows the
    // dossier identity, not whatever local state the editor happened to be holding.
    const reopened = makeFile({ id: 'file-2', name: 'Other', blocks: [heading('x-1', 'Delta')] })
    rerender({ file: reopened, folders: FOLDERS, ...host })
    expect(renderedOrder()).toEqual(['Delta'])
    expect(byText('Unsaved changes')).toBe(false)
    expect(saveButton().disabled).toBe(true)
  })

  it('keeps an in-progress draft when the host echoes the same dossier id back', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    typeInto(headingInput(0), 'Alpha edited')

    // `handleSaveFile` in the host sets the edited file (and an IndexedDB refresh can hand
    // over a fresh-but-equal copy). Same identity, new object: re-seeding here would delete
    // whatever the user is mid-way through typing.
    rerender({
      file: makeFile({ updatedAt: 2000 }),
      folders: FOLDERS,
      ...host,
    })

    expect(renderedOrder()).toEqual(['Alpha edited', 'Bravo', 'Charlie'])
    expect(byText('Unsaved changes')).toBe(true)
    expect(saveButton().disabled).toBe(false)
  })

  it('leaves the library\'s own ordering field out of what it saves', () => {
    const host = callbacks()
    mount({ file: makeFile({ sortOrder: 5000 }), folders: FOLDERS, ...host })

    typeInto(headingInput(0), 'Alpha edited')
    click(saveButton())

    const saved = savedDraft(host)
    expect(saved.blocks.map((block) => block.content)).toEqual(['Alpha edited', 'Bravo', 'Charlie'])
    // The library panel owns where a dossier sits in its folder. `updateFile` merges a patch
    // over the stored row, so a field the editor does not own keeps whatever is stored —
    // saving a dossier must not roll back a reorder that landed while it was open.
    expect('sortOrder' in saved).toBe(false)
  })

  it('renaming the dossier edits the draft only, and Save carries the new name', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    click(renameTrigger())
    typeInto(titleInput(), 'Renamed Relay')

    expect(host.onSaveFile).not.toHaveBeenCalled()
    click(saveButton())
    expect(savedDraft(host).name).toBe('Renamed Relay')
  })
})

// ---------------------------------------------------------------------------
// D16.1 consequence — leaving with a dirty draft
// ---------------------------------------------------------------------------

describe('FileEditView — leaving a dirty draft (spec row 8)', () => {
  it('goes straight back when nothing is unsaved', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    click(saveButton()) // disabled, so nothing happens either way
    const back = backButton()
    click(back)

    expect(host.onBack).toHaveBeenCalledTimes(1)
    expect(inDialog('Discard changes?')).toBe(false)
  })

  it('stops the exit while the draft is dirty, and offers both real ways out', async () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })
    const back = backButton()

    typeInto(headingInput(0), 'Alpha edited')
    click(back)
    await dialogOpened()

    // The prompt is a decision, not a toast: nothing left, nothing was saved.
    expect(inDialog('Discard changes?')).toBe(true)
    expect(host.onBack).not.toHaveBeenCalled()
    expect(host.onSaveFile).not.toHaveBeenCalled()

    click(buttonInDialog('Keep editing'))
    await dialogClosed()
    expect(inDialog('Discard changes?')).toBe(false)
    expect(host.onBack).not.toHaveBeenCalled()
    expect(byText('Unsaved changes')).toBe(true)

    // Escape is the same answer as "Keep editing".
    click(back)
    await dialogOpened()
    pressOn(document.body, 'Escape')
    await dialogClosed()
    expect(inDialog('Discard changes?')).toBe(false)
    expect(host.onBack).not.toHaveBeenCalled()

    click(back)
    await dialogOpened()
    click(buttonInDialog('Discard unsaved edits'))
    expect(host.onBack).toHaveBeenCalledTimes(1)
    expect(host.onSaveFile).not.toHaveBeenCalled()
  })

  it('"Save & leave" writes before it leaves', async () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })
    const back = backButton()

    typeInto(headingInput(2), 'Charlie edited')
    click(back)
    await dialogOpened()
    click(buttonInDialog('Save & leave'))

    expect(host.onSaveFile).toHaveBeenCalledTimes(1)
    const saved = savedDraft(host)
    expect(saved.blocks[2]?.content).toBe('Charlie edited')
    expect(host.onBack).toHaveBeenCalledTimes(1)
    expect(host.onBack.mock.invocationCallOrder[0] ?? 0).toBeGreaterThan(
      host.onSaveFile.mock.invocationCallOrder[0] ?? 0,
    )
  })
})

// ---------------------------------------------------------------------------
// The owner's list 1-3: two distinct button roles, and no dialog label clipped
// ---------------------------------------------------------------------------

describe('FileEditView — the top bar\'s two actions are different controls', () => {
  /*
   * The report was that Save and Send "look exact same". They are two DESIGN.md roles now, and
   * that is asserted through the slots Mantine actually paints (`--button-bg`, `--button-bd`,
   * `--button-color`) rather than through a class name, because a class name is hashed.
   */
  it('makes Send the filled signal primary and Save the bordered Default control', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    const send = buttonByLabel('Send')
    const save = saveButton()

    expect(send.getAttribute('data-variant')).toBe('filled')
    expect(send.style.getPropertyValue('--button-bg')).toContain('signal-filled')
    expect(send.style.getPropertyValue('--button-color')).toBe('var(--mantine-color-white)')

    // Default: the raised fill with 1px `--qrbit-border-strong` behind it — DESIGN.md's "the
    // outline of a control the user must find", which is why Save does not need the accent.
    expect(save.getAttribute('data-variant')).toBe('default')
    expect(save.style.getPropertyValue('--button-bg')).toContain('mantine-color-default')
    expect(save.style.getPropertyValue('--button-bd')).toContain('mantine-color-default-border')
    expect(save.style.getPropertyValue('--button-bg')).not.toBe(send.style.getPropertyValue('--button-bg'))
  })

  it('never flips Send\'s label to a dark colour on hover', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })
    const send = buttonByLabel('Send')

    // The black-on-blue hover was Mantine's `light` variant: its fill lifts to
    // `--mantine-color-signal-light-hover` while the label stays `--mantine-color-signal-light-color`,
    // which is signal-9 (`--qrbit-signal-deep`'s neighbour at the bottom of the ramp) in the light
    // scheme — a near-black in the accent's own family, on a blue fill. A filled control takes
    // its hover fill from the same ramp and its hover label from `--button-color` (white), so the
    // only way this can regress is if a hover *label* slot is set at all.
    expect(send.style.getPropertyValue('--button-hover')).toContain('signal-filled-hover')
    expect(send.style.getPropertyValue('--button-hover-color')).toBe('')
    expect(send.getAttribute('data-variant')).not.toBe('light')
  })

  /*
   * The owner's point 5: the amber badge must not be the only thing that distinguishes Save's
   * states. The control says it itself, in its own word and glyph.
   */
  it('says what Save is for in the control itself, not only in the badge beside it', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    expect(saveButton().getAttribute('data-save-state')).toBe('clean')
    expect(saveButton().textContent?.trim()).toBe('Saved')

    typeInto(headingInput(0), 'Alpha edited')

    expect(saveButton().getAttribute('data-save-state')).toBe('dirty')
    expect(saveButton().textContent?.trim()).toBe('Save dossier')
    expect(saveButton().disabled).toBe(false)

    click(saveButton())

    expect(saveButton().getAttribute('data-save-state')).toBe('clean')
    expect(saveButton().textContent?.trim()).toBe('Saved')
  })

  it('sizes the top bar\'s actions to their own words and lets the cluster wrap', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    typeInto(headingInput(0), 'Alpha edited')

    for (const control of [saveButton(), buttonByLabel('Send')]) {
      expect(isContentSized(control)).toBe(true)
    }
    // The cluster they live in wraps onto its own line rather than squeezing them.
    const cluster = dialogActionRow(saveButton())
    expect(cluster.style.getPropertyValue('--group-wrap')).toBe('wrap')
  })
})

describe('FileEditView — no dialog label is cut off (spec row: "Discard changes?")', () => {
  /*
   * The cause, stated once because the fix is not obvious from the diff: a Mantine `Button` root
   * is `overflow: hidden` and its label part is `white-space: nowrap`, so when a `wrap="nowrap"`
   * row is narrower than its buttons want to be, the buttons shrink and the words are CUT, not
   * ellipsised. Three actions in a `size="sm"` sheet (380px, 348px of content, 316px on a 320px
   * phone) want about 390px. `flex: none` on each control plus a wrapping row is the fix: a
   * control is exactly as wide as its own words, and the row gains a line.
   */
  it('gives the Discard dialog all three full labels, each control sized to its content', async () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    typeInto(headingInput(0), 'Alpha edited')
    click(backButton())
    await dialogOpened()

    const actions = ['Keep editing', 'Save & leave', 'Discard unsaved edits'] as const
    for (const label of actions) {
      const control = buttonInDialog(label)
      // The whole sentence is there — nothing was truncated to "Keep edit".
      expect(control.textContent?.trim()).toBe(label)
      // …and nothing can squeeze it: the control is sized to its content, not to the row.
      expect(isContentSized(control)).toBe(true)
    }

    const row = dialogActionRow(buttonInDialog('Keep editing'))
    expect(row.style.getPropertyValue('--group-wrap')).toBe('wrap')
    expect(row.style.getPropertyValue('--group-justify')).toBe('flex-end')
  })

  it('gives the three actions three different DESIGN.md roles', async () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    typeInto(headingInput(0), 'Alpha edited')
    click(backButton())
    await dialogOpened()

    const keep = buttonInDialog('Keep editing')
    const saveAndLeave = buttonInDialog('Save & leave')
    const discard = buttonInDialog('Discard unsaved edits')

    // Quiet: transparent fill, and its label on the bridged Ink Secondary slot rather than on
    // Mantine's default, which resolves a subtle label to `--mantine-color-signal-light-color` —
    // the bottom of the signal ramp, a near-black in the accent's own family.
    expect(keep.getAttribute('data-variant')).toBe('subtle')
    expect(keep.style.getPropertyValue('--button-bg')).toBe('transparent')
    expect(keep.style.color).toContain('mantine-color-dimmed')

    // Primary: the one filled control in the dialog, and the one that keeps the work.
    expect(saveAndLeave.getAttribute('data-variant')).toBe('filled')
    expect(saveAndLeave.style.getPropertyValue('--button-bg')).toContain('signal-filled')

    // Default, wearing the status colour: raised fill, 1px border-strong, Fault Red words.
    // Two filled buttons one tap apart is the defect the top bar just had.
    expect(discard.getAttribute('data-variant')).toBe('default')
    expect(discard.style.getPropertyValue('--button-bd')).toContain('mantine-color-default-border')
    expect(discard.style.color).toContain('mantine-color-danger')

    // Safe answer first in DOM order, and the dialog is a real modal (Escape still cancels).
    const order = Array.from(dialogActionRow(keep).querySelectorAll('button'))
    expect(order[0]).toBe(keep)
    expect(order.at(-1)).toBe(discard)
  })

  it('keeps the encrypt-before-save actions whole too, with the same role split', async () => {
    const host = callbacks()
    const secret: FileBlock = { id: 'b-sec', type: 'locked', content: 'hunter2-or-not' }
    mount({
      file: makeFile({ blocks: [heading('b-1', 'Alpha'), secret] }),
      folders: FOLDERS,
      ...host,
    })

    // The prompt only opens on a save that is allowed to happen, so the draft must be dirty.
    typeInto(headingInput(0), 'Alpha edited')
    click(saveButton())
    await dialogOpened()

    // The prompt is up because a marked secret is still plaintext — the invariant under test here
    // is that answering it is possible at all, so both of its controls must be legible.
    const cancel = buttonInDialog('Cancel the save')
    const submit = buttonContainingInDialog('Encrypt and save')
    expect(cancel.textContent?.trim()).toBe('Cancel the save')
    expect(cancel.style.color).toContain('mantine-color-dimmed')
    expect(submit.textContent?.trim()).toBe('Encrypt and save')
    for (const control of [cancel, submit]) {
      expect(isContentSized(control)).toBe(true)
    }
    expect(dialogActionRow(cancel).style.getPropertyValue('--group-wrap')).toBe('wrap')

    // And cancelling still writes nothing: the security path is untouched by the relayout.
    click(cancel)
    await dialogClosed()
    expect(host.onSaveFile).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Send carries the draft
// ---------------------------------------------------------------------------

describe('FileEditView — Send', () => {
  it('persists the draft first, then hands the same edited file to the transfer path', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    typeInto(headingInput(1), 'Bravo unsaved')
    click(buttonByLabel('Send'))

    expect(host.onSaveFile).toHaveBeenCalledTimes(1)
    expect(host.onSendFile).toHaveBeenCalledTimes(1)
    const sent = sentDraft(host)
    expect(sent.blocks.map((block) => block.content)).toEqual([
      'Alpha',
      'Bravo unsaved',
      'Charlie',
    ])
    expect(host.onSendFile.mock.invocationCallOrder[0] ?? 0).toBeGreaterThan(
      host.onSaveFile.mock.invocationCallOrder[0] ?? 0,
    )
    // What is on screen is now what is stored, so the draft is clean again.
    expect(byText('Unsaved changes')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Reordering: one reducer, three doors (D16.2/D16.3, spec row 6)
// ---------------------------------------------------------------------------

describe('FileEditView — reordering blocks', () => {
  it('produces the same order from a grip drag, a grip key and the arrow button', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    expect(byText('Drag the grip, or use the arrows, to reorder')).toBe(true)
    expect(renderedOrder()).toEqual(['Alpha', 'Bravo', 'Charlie'])

    // 1. A pointer drag: row 0 travels one pitch down (D16.2 — pointer events, not HTML5 DnD).
    dragGrip(0, 1)
    const dragged = renderedOrder()
    expect(dragged).toEqual(['Bravo', 'Alpha', 'Charlie'])

    // 2. The keyboard twin on the same grip, from the same starting order.
    unmount()
    mount({ file: makeFile(), folders: FOLDERS, ...host })
    pressOn(gripAt(0), 'ArrowDown')
    const keyed = renderedOrder()

    // 3. The visible arrow button, again from the same starting order.
    unmount()
    mount({ file: makeFile(), folders: FOLDERS, ...host })
    click(arrowButton(0, 'down'))
    const clicked = renderedOrder()

    expect(keyed).toEqual(dragged)
    expect(clicked).toEqual(dragged)

    // And Home/End on the grip reach the ends of the list through the same reducer.
    unmount()
    mount({ file: makeFile(), folders: FOLDERS, ...host })
    pressOn(gripAt(0), 'End')
    expect(renderedOrder()).toEqual(['Bravo', 'Charlie', 'Alpha'])
  })

  it('reorders the DRAFT: nothing is written until Save, which writes the new order', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    dragGrip(2, 0)
    expect(renderedOrder()).toEqual(['Charlie', 'Alpha', 'Bravo'])
    expect(host.onSaveFile).not.toHaveBeenCalled()
    expect(byText('Unsaved changes')).toBe(true)

    click(saveButton())
    const saved = savedDraft(host)
    expect(saved.blocks.map((block) => block.id)).toEqual(['b-3', 'b-1', 'b-2'])
  })

  it('paints the grabbed row while the pointer is down, and a cancelled drag moves nothing', () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    act(() => {
      gripAt(0).dispatchEvent(new HarnessPointerEvent('pointerdown', { clientY: 100 }))
    })
    act(() => {
      window.dispatchEvent(
        new HarnessPointerEvent('pointermove', { clientY: 100 + 2 * DEFAULT_ITEM_HEIGHT }),
      )
    })

    const firstRow = element().querySelector('[data-reorder-item]')
    expect(firstRow instanceof HTMLElement ? firstRow.style.transform : '').toContain('96px')
    // Still only translating: the order has not changed mid-drag.
    expect(renderedOrder()).toEqual(['Alpha', 'Bravo', 'Charlie'])

    // Escape drops the grab, and the release after it must not announce a stale move.
    pressOn(document.body, 'Escape')
    act(() => {
      window.dispatchEvent(new HarnessPointerEvent('pointerup', { clientY: 0 }))
    })

    expect(renderedOrder()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(host.onSaveFile).not.toHaveBeenCalled()
    expect(firstRow instanceof HTMLElement ? firstRow.style.transform : '').toBe('')
  })

  it('measures every block row, dividers included, so grip indices match list indices', () => {
    const host = callbacks()
    const withDivider = makeFile({
      blocks: [heading('b-1', 'Alpha'), { id: 'b-2', type: 'divider' }, heading('b-3', 'Charlie')],
    })
    mount({ file: withDivider, folders: FOLDERS, ...host })

    const rows = element().querySelectorAll('[data-reorder-item]')
    const grips = buttons().filter((button) =>
      (button.getAttribute('aria-label') ?? '').startsWith('Reorder item'),
    )
    expect(rows).toHaveLength(3)
    expect(grips).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Folder membership
// ---------------------------------------------------------------------------

describe('FileEditView — folder membership', () => {
  it('shows the folder the dossier is in, and moving it writes through the store', async () => {
    const host = callbacks()
    const moveFile = vi
      .spyOn(useLibraryStore.getState(), 'moveFile')
      .mockResolvedValue(undefined)
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    expect(byText('Credentials')).toBe(true)

    click(buttonByLabel('Move to folder…'))
    // The dialog names the action it performs. It moved to "Save to library" wording once the
    // shared picker was reused here without `purpose`, which is a mislabel, not a stale test.
    expect(inDialog('Move dossier')).toBe(true)

    // Pick the other folder in the reused picker, then confirm.
    const folderOption = dialogButtons().find((button) =>
      (button.textContent ?? '').includes('Field Notes'),
    )
    if (folderOption === undefined) throw new Error('test bug: no folder option in the picker')
    click(folderOption)
    click(buttonInDialog('Move dossier'))
    await flush()

    expect(moveFile).toHaveBeenCalledWith('file-1', 'f-2')
    expect(byText('Field Notes')).toBe(true)
    expect(byText('Credentials')).toBe(false)
  })

  it('saves the folder the user moved to, not the one the host prop still holds', async () => {
    const host = callbacks()
    vi.spyOn(useLibraryStore.getState(), 'moveFile').mockResolvedValue(undefined)
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    click(buttonByLabel('Move to folder…'))
    const folderOption = dialogButtons().find((button) =>
      (button.textContent ?? '').includes('Field Notes'),
    )
    if (folderOption === undefined) throw new Error('test bug: no folder option in the picker')
    click(folderOption)
    click(buttonInDialog('Move dossier'))
    await flush()

    typeInto(headingInput(0), 'Alpha edited')
    click(saveButton())

    const saved = savedDraft(host)
    expect(saved.folderId).toBe('f-2')
  })
})

// ---------------------------------------------------------------------------
// Attachments: chosen, or the Send is refused
// ---------------------------------------------------------------------------

/**
 * The editor is where an `image`/`fileAttachment` block gets its bytes, and where it used to get
 * a filename instead. `handleAddBlockType` pre-filled `attachment_photo.png` at `Telemetry
 * capture`, and `data_export.bin` at `2.4 MB`, so every new dossier looked like it carried files
 * it did not have — and `lib/dossier.ts` transmitted 100 null bytes to match the claim. These
 * cases pin the two halves of the fix: a new attachment block is empty and says so, and a Send
 * that would have had to invent something stops with a sentence on screen.
 */

function buttonContaining(text: string): HTMLButtonElement {
  const button = buttons().find((candidate) => (candidate.textContent ?? '').includes(text))
  if (button === undefined) throw new Error(`test bug: no button containing "${text}"`)
  return button
}

function attachmentInput(): HTMLInputElement {
  const input = element().querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) throw new Error('test bug: no file input in the editor')
  return input
}

function chooseFile(file: File | null): void {
  const input = attachmentInput()
  Object.defineProperty(input, 'files', { value: file === null ? [] : [file], configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function sendErrorText(): string | null {
  return element().querySelector('[data-send-error]')?.textContent ?? null
}

function attachmentBlockOf(file: LibraryFile, index = 0) {
  const block = file.blocks[index]
  if (block === undefined) throw new Error('test bug: the draft has no block at that index')
  return block
}

describe('FileEditView — an attachment block holds a file the user chose', () => {
  it('gives every block-type row its full description, with room to grow rather than clip', async () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    click(buttonContaining('Add Block to Dossier'))
    await dialogOpened()

    const rows = Array.from(
      document.body.querySelectorAll('[role="dialog"] button[data-variant="default"]'),
    ) as HTMLButtonElement[]
    expect(rows).toHaveLength(7)

    for (const row of rows) {
      // Two lines of prose inside a fixed-height, `overflow: hidden` button is the same cut-off as
      // a squeezed dialog action: the row has to grow, not ellipsis the instruction.
      expect(row.style.height).toBe('auto')
      expect(row.style.minHeight).toBe('2.75rem')
      // One name, visible and spoken: the accessible name is the row's own words.
      expect(row.getAttribute('aria-label')).toBe(null)
      expect((row.textContent ?? '').trim().length).toBeGreaterThan(0)
    }

    // The sentence the locked row exists to tell the user, whole.
    const locked = rows.find((row) => (row.textContent ?? '').includes('Locked Credential'))
    if (locked === undefined) throw new Error('test bug: no locked-credential row')
    expect(locked.textContent?.trim()).toBe(
      'Locked CredentialSecret or key, encrypted when you give it a password',
    )
  })

  it('adds an image block with nothing invented on it', async () => {
    const host = callbacks()
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    click(buttonContaining('Add Block to Dossier'))
    // The block type picker is a Mantine `Modal`, so its rows float in the document, not in the
    // editor container.
    await dialogOpened()
    click(dialogButtonContaining('Image Payload'))
    await flush()

    // The row reads as what it is: a block waiting for a file.
    expect(byText('No image chosen yet')).toBe(true)
    expect(byText('Choose image')).toBe(true)
    for (const invented of [
      'attachment_photo.png',
      'Telemetry capture',
      'data_export.bin',
      '2.4 MB',
      'image_attachment.png',
      '1920×1080',
    ]) {
      expect(byText(invented)).toBe(false)
    }

    // And a Save writes the same emptiness to the library, because an unfinished attachment is
    // work in progress — it just cannot be sent.
    click(saveButton())
    const saved = attachmentBlockOf(savedDraft(host), 3)
    expect(saved.type).toBe('image')
    expect(saved.fileName).toBeUndefined()
    expect(saved.fileSize).toBeUndefined()
    expect(saved.caption).toBeUndefined()
    expect(saved.blob).toBeUndefined()
  })

  it('refuses to Send a dossier whose attachment block has no file, and says why', () => {
    const host = callbacks()
    const file = makeFile({
      blocks: [heading('b-1', 'Alpha'), { id: 'b-img', type: 'image' }],
    })
    mount({ file, folders: FOLDERS, ...host })

    click(buttonByLabel('Send'))

    expect(host.onSendFile).not.toHaveBeenCalled()
    // Nothing is persisted on the way either: a refused Send changes nothing at all.
    expect(host.onSaveFile).not.toHaveBeenCalled()
    expect(sendErrorText()).toContain('no file chosen yet')
    expect(byText('Unsaved changes')).toBe(false)
  })

  it('sends the real bytes once a file is chosen, and they survive the conversion', async () => {
    const host = callbacks()
    const file = makeFile({ blocks: [heading('b-1', 'Alpha'), { id: 'b-img', type: 'image' }] })
    mount({ file, folders: FOLDERS, ...host })

    const payload = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1])
    chooseFile(new File([payload], 'rig.png', { type: 'image/png' }))

    expect(byText('rig.png')).toBe(true)
    expect(byText('9 B')).toBe(true)
    expect(sendErrorText()).toBe(null)

    click(buttonByLabel('Send'))
    expect(host.onSendFile).toHaveBeenCalledTimes(1)

    const block = attachmentBlockOf(sentDraft(host), 1)
    expect(block.blob).toBeInstanceOf(Blob)
    expect(block.fileSize).toBe(payload.byteLength)

    // The whole point, end to end: the item that goes to the transfer path carries these bytes
    // and this size — not 100 zeros, not '2.4 MB'.
    const items = await fileBlocksToLibraryItems(sentDraft(host))
    const image = items[1]
    if (image?.type !== 'image') throw new Error('test bug: the attachment did not convert')
    expect(image.size).toBe(payload.byteLength)
    expect(new Uint8Array(await image.blob.arrayBuffer())).toEqual(payload)
  })

  it('refuses a wrong-type choice before it can reach the draft', () => {
    const host = callbacks()
    const file = makeFile({ blocks: [{ id: 'b-img', type: 'image' }] })
    mount({ file, folders: FOLDERS, ...host })

    chooseFile(new File(['a,b,c'], 'telemetry.csv', { type: 'text/csv' }))

    expect(byText('Choose image')).toBe(true)
    expect(byText('no size until a file is chosen')).toBe(true)

    // Save now: the draft still holds an empty block, so the refusal wrote nothing half-way.
    click(saveButton())
    expect(host.onSaveFile).not.toHaveBeenCalled() // a no-op choice left the draft clean
  })

  it('surfaces a send failure raised by the host, instead of swallowing it', async () => {
    const host = callbacks()
    host.onSendFile.mockRejectedValue(new Error('No peer is on the channel yet'))
    mount({ file: makeFile(), folders: FOLDERS, ...host })

    click(buttonByLabel('Send'))
    await flush()

    expect(sendErrorText()).toContain('No peer is on the channel yet')
  })
})

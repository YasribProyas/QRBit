/** @vitest-environment jsdom */
/**
 * SenderSessionView tests (PLAN.md §7, §8, §9; ORCHESTRATION D16).
 *
 * The screen is the sender's live board plus the one bar that puts more on the channel
 * mid-flight, so these tests pin the two things that have broken here before:
 *
 *  1. **Nothing goes out that nobody wrote.** A picked type opens a form; submitting an empty
 *     form refuses with a message, and the characters that do leave are the characters in the
 *     field. An image/file row sends the `File` the user chose, and a locked row goes through
 *     `LockedItemComposeModal` — this component imports no crypto and holds no password.
 *  2. **Nothing is claimed that the store does not know.** No invented peer name, no placeholder
 *     verification words, no delivery claim for an item still in flight, and no pill at all for a
 *     queued dossier block, which has no item linked to it on this side.
 *
 * The harness is the repo's own (`createRoot` into a node on `document.body`), and the session is
 * a stand-in of exactly the four members `SenderSessionApi` allows, because that `Pick` is the
 * component's whole reach. Items go into the real session store: the header ratio and every row's
 * pill are read from it, so a fake store would test nothing.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SenderSessionView } from './SenderSessionView'
import type { SenderSessionApi, SenderSessionViewProps } from './SenderSessionView'
import { useSessionStore } from '../../store/sessionStore'
import type {
  ImageItem as ImageItemModel,
  SessionItem,
  TextItem as TextItemModel,
} from '../../store/sessionStore'
import type { FileBlock, LibraryFile } from '../../lib/library'

const PHRASE: readonly [string, string, string] = ['cobalt', 'timber', 'falcon']

const createObjectURL = vi.fn((_source: Blob | MediaSource): string => 'blob:qrbit/1')
const revokeObjectURL = vi.fn()
const previousCreateObjectURL = URL.createObjectURL
const previousRevokeObjectURL = URL.revokeObjectURL

const onEndSession = vi.fn()

let container: HTMLDivElement | null = null
let root: Root | null = null

function makeApi(overrides: Partial<SenderSessionApi> = {}): SenderSessionApi {
  return {
    addTextItem: vi.fn((): string => 'sent-1'),
    addFileItem: vi.fn((): string => 'sent-2'),
    addLockedItem: vi.fn(async (): Promise<string> => 'sent-3'),
    safetyPhrase: null,
    ...overrides,
  }
}

function makeFile(name: string, blocks: FileBlock[]): LibraryFile {
  return { id: 'file-1', folderId: 'root', name, createdAt: 1, updatedAt: 1, blocks }
}

function textItem(overrides: Partial<TextItemModel> = {}): TextItemModel {
  return {
    id: 'sent-1',
    type: 'text',
    status: 'complete',
    createdAt: 1,
    content: 'typed here',
    ...overrides,
  }
}

function imageItem(overrides: Partial<ImageItemModel> = {}): ImageItemModel {
  return {
    id: 'sent-2',
    type: 'image',
    status: 'transferring',
    createdAt: 1,
    fileName: 'gate.png',
    mimeType: 'image/png',
    totalSize: 5,
    totalChunks: 1,
    progress: 40,
    ...overrides,
  }
}

function setItems(items: SessionItem[]): void {
  act(() => {
    useSessionStore.getState().setItems(items)
  })
}

function renderView(
  session: SenderSessionApi,
  options: { sessionFile?: LibraryFile | null; peerName?: string } = {},
): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(
      createElement(SenderSessionView, {
        session,
        sessionFile: options.sessionFile ?? null,
        // Only present when the test supplies one: this screen has no invented peer name.
        ...(options.peerName === undefined ? {} : { peerName: options.peerName }),
        onEndSession,
      } satisfies SenderSessionViewProps),
    )
  })

  container = element
  root = created
  return element
}

/** Tears the current screen down so a test can mount a second one into a clean body. */
function dispose(): void {
  if (root !== null) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
}

function buttons(element: ParentNode): HTMLButtonElement[] {
  return Array.from(element.querySelectorAll('button'))
}

/**
 * A control by its visible words, container-scoped. `AddBlockModal` and the locked composer are
 * portals/overlays on `document.body` and are searched there on purpose, so an editor control
 * outside the screen under test can never satisfy a test by accident.
 */
function buttonContaining(element: ParentNode, label: string): HTMLButtonElement {
  const found = buttons(element).find((candidate) =>
    (candidate.textContent ?? '').trim().toLowerCase().includes(label.toLowerCase()),
  )
  if (found === undefined) throw new Error(`test bug: no button containing "${label}"`)
  return found
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * A Mantine `Modal` mounts its panel on the next frame, so a test that reads one waits first
 * (the same reason `FileEditView.test.tsx` has this helper).
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

function form(element: HTMLElement): HTMLFormElement {
  const node = element.querySelector('form')
  if (!(node instanceof HTMLFormElement)) throw new Error('test bug: no compose form')
  return node
}

function submit(element: HTMLElement): void {
  act(() => {
    form(element).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function textarea(element: HTMLElement): HTMLTextAreaElement {
  const node = element.querySelector('textarea')
  if (!(node instanceof HTMLTextAreaElement)) throw new Error('test bug: no compose textarea')
  return node
}

function fileInput(element: HTMLElement): HTMLInputElement {
  const node = element.querySelector<HTMLInputElement>('input[type="file"]')
  if (node === null) throw new Error('test bug: no file input')
  return node
}

/** Types into a controlled React field through the value setter, as the other suites do. */
function typeInto(field: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(field, value)

  act(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** jsdom has no real file picker, so the selection is injected as a FileList-shaped value. */
function pick(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Opens the type picker and chooses one row of it. */
async function chooseBlockType(element: HTMLElement, name: string): Promise<void> {
  click(buttonContaining(element, 'Add block'))
  await dialogOpened()
  click(buttonContaining(document.body, name))
}

function shows(element: HTMLElement, text: string): boolean {
  return (element.textContent ?? '').includes(text)
}

/** The board's empty state doubles as the evidence that no row was appended. */
function boardIsEmpty(element: HTMLElement): boolean {
  return shows(element, 'Nothing has been sent on this channel yet.')
}

function composeErrorMessage(element: HTMLElement): string | null {
  return element.querySelector('[data-compose-error="true"]')?.textContent ?? null
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
  act(() => {
    useSessionStore.getState().reset()
  })
})

afterEach(() => {
  dispose()
  URL.createObjectURL = previousCreateObjectURL
  URL.revokeObjectURL = previousRevokeObjectURL
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('SenderSessionView header', () => {
  it('names the other device honestly when no name was handed in', () => {
    const element = renderView(makeApi())

    // There is no peer-name field on the wire. The old prop default asserted a peer called
    // 'Connected peer' on every paint of this screen.
    expect(shows(element, 'Other device')).toBe(true)
    expect(shows(element, 'Connected peer')).toBe(false)
  })

  it('shows the name it was given instead of the generic one', () => {
    const element = renderView(makeApi(), { peerName: 'Pixel 8' })

    expect(shows(element, 'Pixel 8')).toBe(true)
  })

  it('counts the store\'s complete items over its items, and calls them sent', () => {
    setItems([
      textItem({ id: 'a', status: 'complete' }),
      textItem({ id: 'b', status: 'transferring' }),
    ])
    const element = renderView(makeApi())

    expect(shows(element, 'Items sent')).toBe(true)
    expect(shows(element, '1 / 2')).toBe(true)
    // `complete` on this side is the last frame being handed to the data channel; nothing on this
    // screen is told the peer received anything, so the ratio cannot claim delivery.
    expect(shows(element, 'delivered')).toBe(false)
    expect(shows(element, 'Delivered')).toBe(false)
  })

  it('asks the page to end the session, and nothing else', () => {
    const element = renderView(makeApi())

    click(buttonContaining(element, 'End session'))

    expect(onEndSession).toHaveBeenCalledTimes(1)
  })

  it('shows the verification words only when the key exchange produced them', () => {
    const without = renderView(makeApi())

    // The honest absence: no placeholder phrase under the label the phrase exists to earn.
    expect(without.querySelector('[data-safety-phrase="absent"]')).not.toBeNull()
    expect(shows(without, 'cobalt')).toBe(false)
    expect(shows(without, 'COBALT')).toBe(false)

    dispose()

    const withPhrase = renderView(makeApi({ safetyPhrase: PHRASE }))
    expect(withPhrase.querySelector('[data-safety-phrase="absent"]')).toBeNull()
    for (const word of PHRASE) expect(shows(withPhrase, word)).toBe(true)
  })
})

describe('SenderSessionView board', () => {
  it('wears no status pill on a queued dossier block', () => {
    // The dossier arrived with the session and no item id links to it on this side, so the row
    // says nothing about delivery rather than guessing from its index.
    setItems([textItem({ id: 'unrelated', status: 'complete' })])
    const element = renderView(makeApi(), {
      sessionFile: makeFile('Gateway plan', [{ id: 'b1', type: 'heading', content: 'Region A' }]),
    })

    expect(shows(element, 'Region A')).toBe(true)
    expect(shows(element, 'Gateway plan')).toBe(true)
    expect(shows(element, 'Delivered')).toBe(false)
    expect(shows(element, 'Pending')).toBe(false)
  })

  it('reports a chunked row by its own item\'s real progress, not as delivered', async () => {
    const api = makeApi()
    setItems([imageItem({ id: 'sent-2', status: 'transferring', progress: 40 })])
    const element = renderView(api)

    await chooseBlockType(element, 'Image Payload')
    pick(fileInput(element), [new File(['12345'], 'gate.png', { type: 'image/png' })])
    submit(element)

    expect(api.addFileItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'gate.png' }))
    // The percentage is the store's own progress for this item id, in tabular figures.
    expect(shows(element, '40%')).toBe(true)
    expect(shows(element, 'Delivered')).toBe(false)
  })
})

describe('SenderSessionView mid-session sends', () => {
  it('sends exactly the characters typed, and nothing else', async () => {
    const api = makeApi()
    const element = renderView(api)
    const content = 'Failover window: Sunday 02:00'

    await chooseBlockType(element, 'Section Heading')
    typeInto(textarea(element), content)
    submit(element)

    expect(api.addTextItem).toHaveBeenCalledTimes(1)
    expect(api.addTextItem).toHaveBeenCalledWith(content)
    expect(composeErrorMessage(element)).toBeNull()
    expect(shows(element, content)).toBe(true)
  })

  it('refuses an empty form with a message instead of a placeholder payload', async () => {
    const api = makeApi()
    const element = renderView(api)

    await chooseBlockType(element, 'Short Text Pair')
    submit(element)

    expect(api.addTextItem).not.toHaveBeenCalled()
    expect(composeErrorMessage(element)).toContain('Nothing was sent.')
    expect(boardIsEmpty(element)).toBe(true)
  })

  it('refuses a send the session cannot take, without appending a row', async () => {
    // `useSession` answers '' outside an active session; a row here would claim a send that
    // never reached the wire.
    const api = makeApi({ addTextItem: vi.fn((): string => '') })
    const element = renderView(api)

    await chooseBlockType(element, 'Rich Text / Notes')
    typeInto(textarea(element), 'Rotation notes')
    submit(element)

    expect(api.addTextItem).toHaveBeenCalledTimes(1)
    expect(composeErrorMessage(element)).toContain('The session is no longer active')
    expect(boardIsEmpty(element)).toBe(true)
  })

  it('sends the file the user chose', async () => {
    const api = makeApi()
    const element = renderView(api)
    const chosen = new File(['12345'], 'gate.png', { type: 'image/png' })

    await chooseBlockType(element, 'Image Payload')
    pick(fileInput(element), [chosen])
    submit(element)

    expect(api.addFileItem).toHaveBeenCalledTimes(1)
    expect(api.addFileItem).toHaveBeenCalledWith(chosen)
    expect(shows(element, 'gate.png')).toBe(true)
  })

  it('refuses a file send before anything is chosen', async () => {
    const api = makeApi()
    const element = renderView(api)

    await chooseBlockType(element, 'File Attachment')
    submit(element)

    expect(api.addFileItem).not.toHaveBeenCalled()
    expect(composeErrorMessage(element)).toContain('Choose a file first.')
    expect(boardIsEmpty(element)).toBe(true)
  })

  it('says a divider carries no payload rather than appending a row', async () => {
    const api = makeApi()
    const element = renderView(api)

    await chooseBlockType(element, 'Divider')

    expect(composeErrorMessage(element)).toContain('A divider carries no payload')
    expect(boardIsEmpty(element)).toBe(true)
    expect(api.addTextItem).not.toHaveBeenCalled()
  })

  it('routes a locked block through the one locked composer, and holds no crypto itself', async () => {
    const api = makeApi()
    const element = renderView(api)

    await chooseBlockType(element, 'Locked Credential')

    // The composer opens; nothing has been sent and no secret text is on screen.
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(api.addTextItem).not.toHaveBeenCalled()
    expect(api.addLockedItem).not.toHaveBeenCalled()
    expect(shows(element, 'sent-3')).toBe(false)
    expect(shows(element, 'Password')).toBe(true)
  })
})

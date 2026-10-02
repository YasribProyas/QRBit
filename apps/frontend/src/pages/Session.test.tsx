/** @vitest-environment jsdom */
/**
 * Page-level tests for `pages/Session.tsx` (PLAN.md §8).
 *
 * `useSession` is mocked so the page can be rendered in each phase directly; the
 * hook's real behaviour is covered by useSession.test.tsx. What matters here is the
 * gating contract: the safety-phrase overlay is mounted only while the store is in
 * 'pairing', it carries both confirmation flags, Abort is wired through, and the
 * session board (PLAN.md §8 Phase 3) is the active view — with the add bar on the
 * sender only, and the Phase 1/2 channel-check panel gone for good. The unload
 * contract (PLAN.md §16 Phase 8) is here too: a `beforeunload` reaches the hook while
 * the session can carry traffic, and never after it has ended.
 *
 * The ended screen's save section (PLAN.md §8 Phase 4) is exercised against a real
 * (fake-indexeddb) library: the received items are offered because they are in memory
 * only, and what the save actually stores is asserted in IndexedDB rather than in the
 * store's copy. A locked item is the one that must not change shape on the way in
 * (decision D9).
 */

import 'fake-indexeddb/auto'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APP_URL } from '../config'
import type { UseSessionResult, HostSession } from '../hooks/useSession'
import type { ItemsApi } from '../components/session/SessionBoard'
import { closeLibraryDatabase, createFolder, getItemsInFolder } from '../lib/library'
import { useLibraryStore } from '../store/libraryStore'
import { useSessionStore } from '../store/sessionStore'
import type { SessionItem } from '../store/sessionStore'

/**
 * The items API is part of what `useSession` returns, so the stand-in result carries
 * it too — the page hands it straight to the board and the add bar.
 */
type MockedSession = UseSessionResult & ItemsApi

const mocked = vi.hoisted(() => ({
  current: null as MockedSession | null,
  options: null as { code: string | null } | null,
  confirmPhrase: vi.fn(),
  abort: vi.fn(),
  restart: vi.fn(),
  notifyUnload: vi.fn(),
}))

vi.mock('../hooks/useSession', () => ({
  useSession: (options: { code: string | null }) => {
    mocked.options = options
    return mocked.current
  },
}))

const { Session } = await import('./Session')

const PHRASE: [string, string, string] = ['RIVER', 'COPPER', 'EIGHT']

function makeResult(overrides: Partial<MockedSession> = {}): MockedSession {
  return {
    role: 'guest',
    phase: 'connecting',
    sessionCode: 'A7X3K9P2',
    connectionState: 'new',
    errorMessage: null,
    status: { label: 'Connecting…', tone: 'idle' },
    roleLabel: 'Guest — you opened the other device’s session',
    safetyPhrase: null,
    phraseConfirmed: false,
    peerConfirmed: false,
    confirmPhrase: () => {
      mocked.confirmPhrase()
    },
    abort: () => {
      mocked.abort()
    },
    restart: () => {
      mocked.restart()
    },
    notifyUnload: () => {
      mocked.notifyUnload()
    },
    addTextItem: () => 'text-id',
    addRichTextItem: () => 'rich-id',
    addFileItem: () => 'file-id',
    addLockedItem: async () => 'locked-id',
    sendLibraryItem: vi.fn(),
    unlockItem: async () => true,
    lockItemAgain: vi.fn(),
    updateTextItem: vi.fn(),
    updateRichTextItem: vi.fn(),
    deleteItem: vi.fn(),
    receivedItems: [],
    ...overrides,
  }
}

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

function renderSession(
  entry: string | { pathname: string; search?: string; state?: unknown } = '/session?code=A7X3K9P2',
): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)
  act(() => {
    created.render(
      <MemoryRouter initialEntries={[entry]}>
        <Session />
      </MemoryRouter>,
    )
  })
  container = element
  root = created
  return element
}

function queryButton(element: HTMLElement, label: string): HTMLButtonElement | null {
  for (const button of element.querySelectorAll('button')) {
    if (button.textContent?.includes(label)) return button
  }
  return null
}

/** Re-renders the mounted page, the way a phase change in the hook's result would. */
function rerenderSession(): void {
  const mounted = root
  if (!mounted) throw new Error('test bug: no page is mounted to re-render')
  act(() => {
    mounted.render(
      <MemoryRouter initialEntries={['/session?code=A7X3K9P2']}>
        <Session />
      </MemoryRouter>,
    )
  })
}

/** Fires the browser's teardown event at the page, as closing the tab would. */
function fireBeforeUnload(): void {
  act(() => {
    window.dispatchEvent(new Event('beforeunload'))
  })
}

beforeEach(async () => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  vi.clearAllMocks()
  mocked.options = null
  useSessionStore.getState().reset()
  useLibraryStore.setState({ folders: [], items: [], loading: false, error: null })
  await freshLibraryDatabase()
})

/** The library layer caches its connection; a `deleteDatabase` needs it closed first. */
async function freshLibraryDatabase(): Promise<void> {
  await closeLibraryDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('qrbit-library')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'))
  })
}

afterEach(async () => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  await closeLibraryDatabase()
})

describe('Session page phase gating (PLAN.md §8)', () => {
  it('mounts the safety-phrase overlay while pairing', () => {
    mocked.current = makeResult({ phase: 'pairing', safetyPhrase: PHRASE, connectionState: 'connected' })

    const element = renderSession()

    const overlay = element.querySelector('.safety-phrase')
    expect(overlay).not.toBe(null)
    expect(overlay?.getAttribute('aria-modal')).toBe('true')
    expect(element.textContent).toContain('Confirm these match on both devices:')
    for (const word of PHRASE) {
      expect(element.textContent).toContain(word)
    }
    expect(queryButton(element, 'Confirmed')).not.toBe(null)
    expect(queryButton(element, 'Abort session')).not.toBe(null)
  })

  it('does not mount the overlay before the phrase exists', () => {
    mocked.current = makeResult({ phase: 'connecting', safetyPhrase: null })

    const element = renderSession()

    expect(element.querySelector('.safety-phrase')).toBe(null)
    expect(element.textContent).toContain('Connecting…')
  })

  it('unmounts the overlay once the session is active', () => {
    mocked.current = makeResult({
      phase: 'active',
      safetyPhrase: PHRASE,
      phraseConfirmed: true,
      peerConfirmed: true,
      status: { label: 'Connected', tone: 'ok' },
    })

    const element = renderSession()

    expect(element.querySelector('.safety-phrase')).toBe(null)
    expect(element.textContent).toContain('Connected')
  })

  it('shows this device confirmed while awaiting activation', () => {
    mocked.current = makeResult({ phase: 'pairing', safetyPhrase: PHRASE, phraseConfirmed: true })

    const element = renderSession()

    expect(element.textContent).toContain('confirmed')
    expect(element.textContent).not.toContain('\u2713')
    // The confirm button is a one-way action.
    expect(queryButton(element, 'Confirmed')?.disabled).toBe(true)
    // Abort must stay available while waiting.
    expect(queryButton(element, 'Abort session')?.disabled).toBe(false)
  })

  it('reports the peer confirmation as soon as it arrives', () => {
    mocked.current = makeResult({ role: 'host', phase: 'pairing', safetyPhrase: PHRASE, peerConfirmed: true })

    const element = renderSession('/session')

    const peerState = element.querySelector('.safety-phrase__status p:last-child')
    expect(peerState?.getAttribute('data-state')).toBe('confirmed')
  })

  it('renders safety phrase for receiver (host) without gating confirm button (decision D14)', () => {
    mocked.current = makeResult({
      role: 'host',
      phase: 'pairing',
      safetyPhrase: PHRASE,
      connectionState: 'connected',
    })

    const element = renderSession('/session')

    const overlay = element.querySelector('.safety-phrase')
    expect(overlay).not.toBe(null)
    for (const word of PHRASE) {
      expect(element.textContent).toContain(word)
    }
    expect(queryButton(element, 'Confirmed')).toBe(null)
    expect(queryButton(element, 'Abort session')).not.toBe(null)
  })

  it('wires Confirmed and Abort to the session hook', () => {
    mocked.current = makeResult({ phase: 'pairing', safetyPhrase: PHRASE })
    const element = renderSession()

    const confirm = queryButton(element, 'Confirmed')
    const abort = queryButton(element, 'Abort session')
    if (!confirm || !abort) throw new Error('test bug: the overlay buttons are missing')

    act(() => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      abort.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocked.confirmPhrase).toHaveBeenCalledTimes(1)
    expect(mocked.abort).toHaveBeenCalledTimes(1)
  })
})

describe('Session page session sources (PLAN.md §8, §16 Phase 6)', () => {
  it('treats a ?code= URL as the guest (PLAN.md §7 flow B)', () => {
    mocked.current = makeResult({ role: 'guest', sessionCode: 'A7X3K9P2' })

    const element = renderSession('/session?code=A7X3K9P2')

    expect(mocked.options?.code).toBe('A7X3K9P2')
    expect(element.querySelector('.badge')?.textContent).toBe('guest')
  })

  /*
   * The receiving flow's other half. Home and Session both render the QR only when
   * actually listening as host.
   */
  it('renders the scannable QR for the host, who is the device that listens', () => {
    mocked.current = makeResult({ role: 'host', sessionCode: 'ABCDEFGH' })

    const element = renderSession('/session')

    const panel = element.querySelector('.session-qr')
    expect(panel).not.toBe(null)
    // QRDisplay is mounted. jsdom has no canvas 2D context, so it takes its own
    // documented fallback and prints the URL as text -- which is also the assertion that
    // matters most: the QR carries the FULL session URL on this app's origin (§3), not a
    // bare code.
    expect(panel?.querySelector('.qr')).not.toBe(null)
    expect(element.textContent).toContain(`${APP_URL}/session?code=ABCDEFGH`)
    expect(element.textContent).toContain('Scan to send files here')
  })

  it('shows the guest no QR to scan', () => {
    mocked.current = makeResult({ role: 'guest', sessionCode: 'A7X3K9P2' })

    const element = renderSession('/session?code=A7X3K9P2')

    expect(element.querySelector('.session-qr')).toBe(null)
    expect(element.querySelector('.qr')).toBe(null)
  })

  it('shows the share landing hint when a shared file was not captured (PLAN.md §15, ORCHESTRATION.md D12)', () => {
    mocked.current = makeResult({ role: 'host' })

    const element = renderSession('/session?share=1')

    expect(element.querySelector('.session-share')).not.toBe(null)
    expect(element.textContent).toContain('was not captured')
    expect(element.textContent).toContain('add it from the board')
    expect(element.textContent).toContain('Text and link sharing work directly')
    expect(element.textContent).toContain('documented limitation')
    expect(element.textContent).not.toContain('file capture works')
    expect(mocked.options?.code).toBe(null)
  })

  it('composes a text item ready to send when ?text is present on mount in active phase (ORCHESTRATION.md D12)', () => {
    const addTextItem = vi.fn()
    mocked.current = makeResult({ role: 'host', phase: 'active', addTextItem })

    renderSession('/session?text=Hello%20shared%20world')

    expect(addTextItem).toHaveBeenCalledWith('Hello shared world')
    // A share landing with no ?code is a host session
    expect(mocked.options?.code).toBe(null)
  })

  it('composes a text item ready to send when ?url is present on mount (ORCHESTRATION.md D12)', () => {
    const addTextItem = vi.fn()
    mocked.current = makeResult({ role: 'host', phase: 'active', addTextItem })

    renderSession('/session?url=https%3A%2F%2Fexample.com%2Fdocs')

    expect(addTextItem).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('composes a text item ready to send when ?title is present on mount (ORCHESTRATION.md D12)', () => {
    const addTextItem = vi.fn()
    mocked.current = makeResult({ role: 'host', phase: 'active', addTextItem })

    renderSession('/session?title=Important%20Link')

    expect(addTextItem).toHaveBeenCalledWith('Important Link')
  })

  it('prefers url > text > title when multiple share params are present (ORCHESTRATION.md D12)', () => {
    const addTextItem = vi.fn()
    mocked.current = makeResult({ role: 'host', phase: 'active', addTextItem })

    renderSession(
      '/session?title=Title&text=Some%20text&url=https%3A%2F%2Fpreferred.example.com',
    )

    expect(addTextItem).toHaveBeenCalledWith('https://preferred.example.com')
  })

  it('prefers text > title when url is absent (ORCHESTRATION.md D12)', () => {
    const addTextItem = vi.fn()
    mocked.current = makeResult({ role: 'host', phase: 'active', addTextItem })

    renderSession('/session?title=My%20Title&text=My%20Text')

    expect(addTextItem).toHaveBeenCalledWith('My Text')
  })

  it('shows shared text preview and does not send before session becomes active', () => {
    const addTextItem = vi.fn()
    mocked.current = makeResult({ role: 'host', phase: 'connecting', addTextItem })

    const element = renderSession('/session?text=Pending%20share%20note')

    expect(addTextItem).not.toHaveBeenCalled()
    expect(element.querySelector('.session-share-pending')).not.toBe(null)
    expect(element.textContent).toContain('Pending share note')
  })

  it('does not show the share hint on an ordinary session URL', () => {
    mocked.current = makeResult({ role: 'guest' })

    expect(renderSession('/session?code=A7X3K9P2').querySelector('.session-share')).toBe(null)
  })
})

describe('Session page in the active phase (PLAN.md §8 Phase 3)', () => {
  it('renders the board for the sender, with the add bar and no channel check', () => {
    mocked.current = makeResult({
      role: 'guest',
      phase: 'active',
      connectionState: 'connected',
      status: { label: 'Connected', tone: 'ok' },
    })

    const element = renderSession()

    expect(element.querySelector('.session-board')).not.toBe(null)
    expect(element.querySelector('.add-item-bar')).not.toBe(null)
    // The Phase 1/2 greeting panel has been retired by Phase 3.
    expect(element.textContent).not.toContain('Channel check')
    expect(element.textContent).not.toContain('Waiting for the data channel')
  })

  it('renders the board with send capabilities for both peers symmetrically', () => {
    mocked.current = makeResult({
      role: 'host',
      phase: 'active',
      connectionState: 'connected',
      status: { label: 'Connected', tone: 'ok' },
    })

    const element = renderSession()

    expect(element.querySelector('.session-board')).not.toBe(null)
    expect(element.querySelector('.add-item-bar')).not.toBe(null)
  })

  it('shows no board before the session is active', () => {
    mocked.current = makeResult({ phase: 'connecting' })

    const element = renderSession()

    expect(element.querySelector('.session-board')).toBe(null)
    expect(element.querySelector('.add-item-bar')).toBe(null)
  })
})

describe('Session page recovery paths (PLAN.md §8 Phase 4)', () => {
  it('offers a retry on error', () => {
    mocked.current = makeResult({
      phase: 'ended',
      errorMessage: 'the signaling connection closed before pairing (code 1006)',
      status: { label: 'Error', tone: 'error' },
    })

    const element = renderSession()
    const retry = queryButton(element, 'Try again')
    if (!retry) throw new Error('test bug: the retry button is missing')

    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocked.restart).toHaveBeenCalledTimes(1)
    expect(element.querySelector('.safety-phrase')).toBe(null)
  })

  it('offers a fresh session after a clean end', () => {
    mocked.current = makeResult({
      phase: 'ended',
      errorMessage: null,
      status: { label: 'Session ended', tone: 'idle' },
    })

    const element = renderSession()
    expect(element.textContent).toContain('Session ended')

    const start = queryButton(element, 'Start a new session')
    if (!start) throw new Error('test bug: the new-session button is missing')
    act(() => {
      start.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocked.restart).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Unload behaviour (PLAN.md §16 Phase 8, §17)
// ---------------------------------------------------------------------------

/**
 * A tab that goes away ends the session, so the peer is not left on a live board
 * until the Durable Object's TTL closes its socket.
 *
 * The page's contract here is delegation, and that is what these cases pin: while a
 * session can still carry traffic ('active' or 'pairing') a `beforeunload` asks the
 * hook to tell the peer, the listener is absent while this device is still connecting,
 * and it is gone once the session has ended — which is what stops a session the peer
 * already heard end from being announced twice. The frame that actually crosses the
 * data channel is asserted in useSession.test.tsx, against the real hook.
 */
describe('Session page unload behaviour (PLAN.md §16 Phase 8)', () => {
  it('tells the peer the session ended when the page unloads while active', () => {
    mocked.current = makeResult({
      phase: 'active',
      connectionState: 'connected',
      status: { label: 'Connected', tone: 'ok' },
    })
    renderSession()

    fireBeforeUnload()

    expect(mocked.notifyUnload).toHaveBeenCalledTimes(1)
  })

  it('does the same while the session is still pairing', () => {
    mocked.current = makeResult({ phase: 'pairing', safetyPhrase: PHRASE })
    renderSession()

    fireBeforeUnload()

    expect(mocked.notifyUnload).toHaveBeenCalledTimes(1)
  })

  it('sends nothing during the connecting phase, when there is no peer yet', () => {
    mocked.current = makeResult({ phase: 'connecting' })
    renderSession()

    fireBeforeUnload()

    expect(mocked.notifyUnload).not.toHaveBeenCalled()
  })

  it('stops listening once the session has ended cleanly', () => {
    mocked.current = makeResult({
      phase: 'active',
      connectionState: 'connected',
      status: { label: 'Connected', tone: 'ok' },
    })
    renderSession()
    fireBeforeUnload()
    expect(mocked.notifyUnload).toHaveBeenCalledTimes(1)

    // A clean end (Abort, or the peer's own session-end) has already told the peer, so
    // the phase leaves 'active' — and the listener leaves with it, rather than
    // announcing the same end a second time from a later unload.
    mocked.current = makeResult({
      phase: 'ended',
      errorMessage: null,
      status: { label: 'Session ended', tone: 'idle' },
    })
    rerenderSession()
    fireBeforeUnload()

    expect(mocked.notifyUnload).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The ended screen's save-to-library section (PLAN.md §8 Phase 4, §16 Phase 5)
// ---------------------------------------------------------------------------

/** Deterministic bytes, so a byte-identical comparison means something. */
function bytes(length: number): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(new ArrayBuffer(length))
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * 41 + 13) % 256
  }
  return value
}

function receivedText(): SessionItem {
  return {
    id: 'received-text',
    type: 'text',
    status: 'complete',
    createdAt: Date.now(),
    content: 'Portal password is hunter2',
  }
}

function receivedLocked(): SessionItem {
  return {
    id: 'received-locked',
    type: 'locked',
    status: 'complete',
    createdAt: Date.now(),
    label: 'Uni portal password',
    innerType: 'text',
    ciphertext: bytes(48),
    iv: bytes(12),
    salt: bytes(16),
  }
}

function receivedPartial(): SessionItem {
  return {
    id: 'received-partial',
    type: 'file',
    status: 'transferring',
    createdAt: Date.now(),
    fileName: 'half.bin',
    mimeType: 'application/octet-stream',
    totalSize: 10,
    totalChunks: 1,
    progress: 30,
    blob: new Blob(['hal']),
  }
}

/** The ended screen with the given items, rendered and settled. */
async function renderEnded(items: SessionItem[]): Promise<HTMLElement> {
  mocked.current = makeResult({
    phase: 'ended',
    status: { label: 'Session ended', tone: 'idle' },
    receivedItems: items,
  })

  const element = renderSession()
  await settle()
  return element
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/**
 * Waits for the library to catch up.
 *
 * A save is a chain of fake-indexeddb round trips plus the store's re-read, and how many
 * ticks that takes depends on the machine: under a full parallel run the last write can
 * land after a fixed number of them, which would leave a save in flight past the end of
 * the test (and its assertion looking at an empty folder). Polling the outcome instead of
 * counting ticks is the same rule the hook's tests use.
 */
async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function clickButton(element: HTMLElement, label: string): Promise<void> {
  const target = queryButton(element, label)
  if (!target) throw new Error(`test bug: no button labelled ${label}`)
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function modalRows(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>('.library-modal--save .library-modal__item')]
}

/** The save dialog's folder radio whose label names `folderName`. */
function folderOption(element: HTMLElement, folderName: string): HTMLButtonElement {
  for (const option of element.querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
    if (option.textContent?.includes(folderName) === true) return option
  }
  throw new Error(`test bug: no folder option named ${folderName}`)
}

describe('Session page — saving received items (PLAN.md §8 Phase 4)', () => {
  it('lists the received items and offers one save affordance for the batch', async () => {
    const element = await renderEnded([receivedText(), receivedPartial()])

    expect(element.textContent).toContain('Session ended')
    expect(element.textContent).toContain('Portal password is hunter2')
    expect(element.textContent).toContain('half.bin')
    expect(queryButton(element, 'Save to Library')).not.toBe(null)
    // Nothing is stored until the user asks.
    expect(useLibraryStore.getState().items).toEqual([])
  })

  it('says so when the session received nothing', async () => {
    const element = await renderEnded([])

    expect(element.textContent).toContain('No items were received from the other device.')
    expect(queryButton(element, 'Save to Library')).toBe(null)
  })

  it('saves one received item into the chosen folder', async () => {
    const folder = await createFolder('Uni Stuff', null)
    const element = await renderEnded([receivedText(), receivedPartial()])

    await clickButton(element, 'Save to Library')
    const rows = modalRows(element)
    expect(rows).toHaveLength(2)

    await act(async () => {
      folderOption(element, 'Uni Stuff').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    })

    const save = rows[0]?.querySelector<HTMLButtonElement>('.library-modal__save')
    if (!save) throw new Error('test bug: the first row has no save button')
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await waitFor(
      () => useLibraryStore.getState().items.length === 1,
      'the item to be stored',
    )

    // The row lands in the folder, named and stored by the library layer itself.
    const stored = await getItemsInFolder(folder.id)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      type: 'text',
      name: 'Portal password is hunter2',
      content: 'Portal password is hunter2',
      folderId: folder.id,
    })
    // And the screen now says it is kept.
    expect(element.textContent).toContain('Saved')
  })

  it('saves every complete item with Save all, and never the unfinished one', async () => {
    const folder = await createFolder('Uni Stuff', null)
    const element = await renderEnded([
      receivedText(),
      receivedLocked(),
      receivedPartial(),
    ])

    await clickButton(element, 'Save to Library')
    await act(async () => {
      folderOption(element, 'Uni Stuff').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    })
    await clickButton(element, 'Save all')
    // Save all walks the items sequentially: wait for the last write rather than guess.
    await waitFor(
      () => useLibraryStore.getState().items.length === 2,
      'both saves to land',
    )

    const stored = await getItemsInFolder(folder.id)
    expect(stored.map((item) => item.type).sort()).toEqual(['locked', 'text'])
    expect(stored.map((item) => item.name).sort()).toEqual([
      'Portal password is hunter2',
      'Uni portal password',
    ])
  })

  it('cannot save an item whose transfer never finished, and says why', async () => {
    const element = await renderEnded([receivedPartial()])

    await clickButton(element, 'Save to Library')
    const row = modalRows(element)[0]
    if (!row) throw new Error('test bug: no row')

    expect(row.querySelector('.library-modal__save')?.hasAttribute('disabled')).toBe(true)
    expect(row.textContent).toContain('Transfer did not finish')
    expect(useLibraryStore.getState().items).toEqual([])
  })

  it('stores a received locked item’s tuple exactly as it arrived (D9)', async () => {
    const folder = await createFolder('Work', null)
    const locked = receivedLocked()
    const element = await renderEnded([locked])

    await clickButton(element, 'Save to Library')
    await act(async () => {
      folderOption(element, 'Work').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    })
    const save = modalRows(element)[0]?.querySelector<HTMLButtonElement>('.library-modal__save')
    if (!save) throw new Error('test bug: no save button')
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await waitFor(() => useLibraryStore.getState().items.length === 1, 'the locked item to be stored')

    const stored = (await getItemsInFolder(folder.id))[0]
    if (stored?.type !== 'locked') throw new Error('test bug: the stored item is not locked')
    if (locked.type !== 'locked') throw new Error('test bug: the fixture is not locked')
    expect(stored.label).toBe('Uni portal password')
    expect(stored.name).toBe('Uni portal password')
    expect(stored.innerType).toBe('text')
    expect(stored.ciphertext).toEqual(locked.ciphertext)
    expect(stored.iv).toEqual(locked.iv)
    expect(stored.salt).toEqual(locked.salt)
  })
})

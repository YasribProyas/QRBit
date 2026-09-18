/** @vitest-environment jsdom */
/**
 * Page-level tests for `pages/Home.tsx` (PLAN.md §7, §16 Phase 5/6).
 *
 * The page is the library's wiring and the live session QR. These tests drive both end to
 * end: the browser against a real (fake-indexeddb) library, and the QR against a stubbed
 * `/session/new` response (the shape the signaling worker returns).
 *
 * The two send flows of PLAN.md §7 are pinned here: **Flow A** — select items, hit "Scan &
 * Send": exactly those items go into the session-scoped, memory-only queue (decision D8)
 * and the page navigates to the SCANNED code as the guest; and the host side — the code
 * minted for the QR is handed to the session page in router state, so opening the session
 * never mints a second one (PLAN.md §16 Phase 6). The session hook draining the queue is
 * covered in useSession.test.tsx.
 *
 * `QRScanner` is replaced with a stub: its job (camera, detection) has its own tests, and a
 * scan is the one thing this page cannot produce without a camera. The stub reports the
 * codes the real component would, including a malformed one, which is how the page's own
 * "validate before navigating" guard is exercised.
 */

import 'fake-indexeddb/auto'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { Home } from './Home'
import {
  closeLibraryDatabase,
  createFolder,
  getItemsInFolder,
  ROOT_FOLDER_ID,
  saveItem,
} from '../lib/library'
import type { LibraryItem } from '../lib/library'
import { takeQueuedLibrarySends } from '../hooks/useSession'
import { APP_URL, buildNewSessionUrl } from '../config'
import { useLibraryStore } from '../store/libraryStore'

/**
 * The codes the stubbed worker mints, and the code a peer's QR would carry. All three are
 * well-formed in the Phase 1 alphabet (no 0, 1, I, L, O or U).
 */
const HOME_CODE = 'ABCDEFGH'
const REFRESHED_CODE = 'JKMNPQRS'
const scannerStub = vi.hoisted(() => ({ peerCode: '23456789' }))
const PEER_CODE = scannerStub.peerCode

/**
 * The scanner, reduced to the codes it reports. `QRScanner.test.tsx` covers the camera,
 * the detection paths and the teardown; what this page does with a code is what matters
 * here — including a malformed one, which the real component filters out before `onScan`
 * and which this page's guard must reject anyway.
 */
vi.mock('../components/QRScanner', () => ({
  QRScanner: ({ onScan, onCancel }: { onScan: (code: string) => void; onCancel: () => void }) => (
    <div className="qr-scanner-stub">
      <button
        type="button"
        className="scanner__scan-valid"
        onClick={() => {
          onScan(scannerStub.peerCode)
        }}
      >
        scan a QRDrop code
      </button>
      <button
        type="button"
        className="scanner__scan-malformed"
        onClick={() => {
          onScan('nope')
        }}
      >
        scan a malformed code
      </button>
      <button
        type="button"
        className="scanner__cancel"
        onClick={() => {
          onCancel()
        }}
      >
        cancel
      </button>
    </div>
  ),
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

async function freshLibraryDatabase(): Promise<void> {
  await closeLibraryDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('qrdrop-library')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'))
  })
}

function note(folderId: string, name: string): LibraryItem {
  const now = Date.now()
  return {
    id: globalThis.crypto.randomUUID(),
    folderId,
    name,
    type: 'text',
    createdAt: now,
    updatedAt: now,
    content: `content of ${name}`,
  }
}

/** The shape the signaling worker's `/session/new` route answers with. */
function jsonResponse(body: unknown): unknown {
  return { ok: true, status: 200, json: async (): Promise<unknown> => body }
}

/**
 * What the session route could see, if the page navigated to it: the URL's query and the
 * host bundle the page handed over in router state. Without this the double-mint would be
 * invisible — the page would look identical whether it passed the minted code on or not.
 */
function hostCodeFromState(state: unknown): string {
  if (typeof state !== 'object' || state === null) return ''
  const bundle = (state as { hostSession?: unknown }).hostSession
  if (typeof bundle !== 'object' || bundle === null) return ''
  const { code } = bundle as { code?: unknown }
  return typeof code === 'string' ? code : ''
}

function SessionRoute() {
  const location = useLocation()
  return (
    <div
      className="session-route"
      data-search={location.search}
      data-host-code={hostCodeFromState(location.state)}
    />
  )
}

/** Renders Home with a `/session` route that records what the navigation carried. */
function renderHome(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/session" element={<SessionRoute />} />
        </Routes>
      </MemoryRouter>,
    )
  })

  container = element
  root = created
  return element
}

/**
 * The mount refresh and the store's own IDB round trips need real timer ticks, and a
 * fake-indexeddb request lands on a later one than the call that started it.
 */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/**
 * Polls the page until it shows what the test is about to assert.
 *
 * The number of ticks a library load or write takes depends on the machine — under a
 * full parallel run a fixed count can be too few — so the tests wait for the outcome
 * rather than for a guess.
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

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function buttonByClass(element: HTMLElement, className: string): HTMLButtonElement {
  const node = element.querySelector(`.${className}`)
  if (!(node instanceof HTMLButtonElement)) throw new Error(`test bug: no button.${className}`)
  return node
}

function itemNames(element: HTMLElement): (string | undefined)[] {
  return [...element.querySelectorAll<HTMLElement>('.library-item__name')].map(
    (name) => name.textContent ?? undefined,
  )
}

let mintFetch: Mock

beforeEach(async () => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  useLibraryStore.setState({ folders: [], items: [], loading: false, error: null })
  takeQueuedLibrarySends()
  // The QR is live from Phase 6: the page mints a code through the worker on mount.
  mintFetch = vi.fn(async (): Promise<unknown> => jsonResponse({ code: HOME_CODE }))
  ;(globalThis as unknown as Record<string, unknown>)['fetch'] = mintFetch
  await freshLibraryDatabase()
})

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
  takeQueuedLibrarySends()
  await closeLibraryDatabase()
})

describe('Home — the library (PLAN.md §7, §16 Phase 5/6)', () => {
  it('renders the library from the store, and navigates folders', async () => {
    const folder = await createFolder('Uni Stuff', null)
    await saveItem(note(ROOT_FOLDER_ID, 'Loose note'))
    await saveItem(note(folder.id, 'Portal password'))

    const element = renderHome()
    await waitFor(() => itemNames(element).length === 1, 'the library to load')

    // The root is what the browser opens on.
    expect(itemNames(element)).toEqual(['Loose note'])
    expect(element.textContent).toContain('Uni Stuff')

    const folderName = [...element.querySelectorAll<HTMLButtonElement>('.folder-node__name')].find(
      (candidate) => candidate.textContent?.includes('Uni Stuff') === true,
    )
    if (!folderName) throw new Error('test bug: no folder named Uni Stuff')
    click(folderName)

    expect(itemNames(element)).toEqual(['Portal password'])
  })

  it('reports a store failure in the browser instead of throwing it', async () => {
    const element = renderHome()
    await settle()

    await act(async () => {
      useLibraryStore.setState({ error: 'library: no folder with id "gone"' })
    })

    expect(element.querySelector('.library-browser__error')?.textContent).toContain(
      'no folder with id "gone"',
    )
  })

  it('deletes an item through the browser, in the store and in IndexedDB', async () => {
    const item = note(ROOT_FOLDER_ID, 'Loose note')
    await saveItem(item)

    const element = renderHome()
    await waitFor(() => itemNames(element).length === 1, 'the library to load')

    click(buttonByClass(element, 'library-item__menu-toggle'))
    const remove = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (menuItem) => menuItem.textContent === 'Delete',
    )
    if (!remove) throw new Error('test bug: no Delete menu item')
    click(remove)

    /*
     * The row menu asks; it does not delete (Phase 5 review P2). A deletion is only
     * allowed to follow an answer, so the item has to still be on the page and still be
     * in IndexedDB while the question is open — an implementation that deleted on the
     * menu click would get past a test that merely clicked whatever confirm button it
     * found, and this is the half that would catch it.
     */
    const dialog = element.querySelector('[role="dialog"]')
    if (!(dialog instanceof HTMLElement)) throw new Error('test bug: no confirmation dialog')
    expect(itemNames(element)).toEqual(['Loose note'])
    expect((await getItemsInFolder(ROOT_FOLDER_ID)).map((stored) => stored.id)).toEqual([
      item.id,
    ])

    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === 'Delete item permanently',
    )
    if (!confirm) throw new Error('test bug: no destructive confirm button in the dialog')
    click(confirm)
    await waitFor(() => itemNames(element).length === 0, 'the item to be deleted')

    expect(itemNames(element)).toEqual([])
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toEqual([])
    expect(useLibraryStore.getState().error).toBe(null)
  })

  it('opens the camera scanner from Scan & Send, and only then (PLAN.md §16 Phase 6)', async () => {
    const element = renderHome()
    await settle()

    const scan = [...element.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Scan & Send'),
    )
    if (!scan) throw new Error('test bug: no Scan & Send button')

    expect(scan.disabled).toBe(false)
    // Camera permission is requested when the scanner mounts, never on page load.
    expect(element.querySelector('.qr-scanner-stub')).toBe(null)

    click(scan)
    expect(element.querySelector('.qr-scanner-stub')).not.toBe(null)

    click(buttonByClass(element, 'scanner__cancel'))
    expect(element.querySelector('.qr-scanner-stub')).toBe(null)
  })
})

describe('Home — send selected (PLAN.md §7 flow A, decision D8)', () => {
  it('queues the selected library items and opens a host session', async () => {
    const first = note(ROOT_FOLDER_ID, 'Portal password')
    const second = note(ROOT_FOLDER_ID, 'Thesis draft')
    const untouched = note(ROOT_FOLDER_ID, 'Not selected')
    await saveItem(first)
    await saveItem(second)
    await saveItem(untouched)

    const element = renderHome()
    await waitFor(() => itemNames(element).length === 3, 'the library to load')

    click(buttonByClass(element, 'library-browser__select'))
    const checkboxes = [...element.querySelectorAll<HTMLInputElement>('.library-item__checkbox')]
    // Most recently updated first, so all three are there to choose from.
    expect(checkboxes).toHaveLength(3)

    const names = itemNames(element)
    const boxFor = (name: string): HTMLInputElement => {
      const index = names.indexOf(name)
      const box = checkboxes[index]
      if (!box) throw new Error(`test bug: no checkbox for ${name}`)
      return box
    }
    click(boxFor('Portal password'))
    click(boxFor('Thesis draft'))

    // The QR is live by the time the selection exists, so the host navigation can carry
    // the code the other device is meant to scan.
    await waitFor(() => element.textContent?.includes(HOME_CODE) === true, 'the minted code')

    click(buttonByClass(element, 'library-browser__send-selected'))

    // The route changed to the session page with no code — this device is the host —
    // carrying the code its QR already shows rather than minting a second one.
    const route = element.querySelector<HTMLElement>('.session-route')
    expect(route).not.toBe(null)
    expect(route?.getAttribute('data-search')).toBe('')
    expect(route?.getAttribute('data-host-code')).toBe(HOME_CODE)

    // The queue holds exactly the selected items, in memory: the Home page never wrote
    // anything to get them across (the library is the only IndexedDB user, and nothing
    // asked it to save).
    const queued = takeQueuedLibrarySends()
    expect(queued.map((item) => item.name).sort()).toEqual(['Portal password', 'Thesis draft'])
    expect(queued.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toHaveLength(3)
  })

  it('sends a single item from the row menu without a selection', async () => {
    const only = note(ROOT_FOLDER_ID, 'Portal password')
    await saveItem(only)

    const element = renderHome()
    await waitFor(() => itemNames(element).length === 1, 'the library to load')

    click(buttonByClass(element, 'library-item__menu-toggle'))
    const send = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (menuItem) => menuItem.textContent === 'Send',
    )
    if (!send) throw new Error('test bug: no Send menu item')
    click(send)

    expect(element.querySelector('.session-route')).not.toBe(null)
    expect(takeQueuedLibrarySends().map((item) => item.id)).toEqual([only.id])
  })
})

describe('Home — the live session QR (PLAN.md §7, §16 Phase 6)', () => {
  it('mints a code on mount and encodes the full session URL on this app’s own origin', async () => {
    const element = renderHome()

    await waitFor(() => element.textContent?.includes(HOME_CODE) === true, 'the minted code')

    expect(mintFetch).toHaveBeenCalledTimes(1)
    expect(mintFetch.mock.calls[0]?.[0]).toBe(buildNewSessionUrl())

    // PLAN.md §3 / §7 flow B: the QR carries the FULL URL, not the bare code, and it is
    // built from this app's origin — a code on someone else's origin opens nothing.
    expect(element.textContent).toContain(`${APP_URL}/session?code=${HOME_CODE}`)
    expect(element.textContent).toContain(HOME_CODE)
  })

  it('re-mints when the QR panel is tapped (PLAN.md §7 “tap to refresh”)', async () => {
    mintFetch
      .mockResolvedValueOnce(jsonResponse({ code: HOME_CODE }))
      .mockResolvedValueOnce(jsonResponse({ code: REFRESHED_CODE }))

    const element = renderHome()
    await waitFor(() => element.textContent?.includes(HOME_CODE) === true, 'the first code')

    const panel = element.querySelector('.home__qr')
    if (!(panel instanceof HTMLElement)) throw new Error('test bug: no QR panel')
    click(panel)

    await waitFor(() => element.textContent?.includes(REFRESHED_CODE) === true, 'the refreshed code')
    expect(mintFetch).toHaveBeenCalledTimes(2)
    expect(element.textContent).not.toContain(HOME_CODE)
  })

  it('re-mints once from the panel’s own refresh control, not twice', async () => {
    mintFetch
      .mockResolvedValueOnce(jsonResponse({ code: HOME_CODE }))
      .mockResolvedValueOnce(jsonResponse({ code: REFRESHED_CODE }))

    const element = renderHome()
    await waitFor(() => element.textContent?.includes(HOME_CODE) === true, 'the first code')

    const newCode = [...element.querySelectorAll<HTMLButtonElement>('.qr__actions button')].find(
      (candidate) => candidate.textContent?.includes('New code') === true,
    )
    if (!newCode) throw new Error('test bug: no New code button')
    click(newCode)

    await waitFor(() => element.textContent?.includes(REFRESHED_CODE) === true, 'the refreshed code')
    // The panel's tap-to-refresh must not double-fire when the button was what was clicked.
    expect(mintFetch).toHaveBeenCalledTimes(2)
  })

  it('offers a retry instead of a QR when the worker cannot be reached', async () => {
    mintFetch.mockRejectedValueOnce(new Error('Failed to fetch'))

    const element = renderHome()
    await waitFor(() => element.querySelector('.home__qr-error') !== null, 'the failure panel')

    expect(element.textContent).toContain('Could not reach the signaling server')
    expect(element.textContent).toContain('Failed to fetch')

    const retry = element.querySelector('.home__qr-error button')
    if (!(retry instanceof HTMLButtonElement)) throw new Error('test bug: no retry button')
    click(retry)

    await waitFor(() => element.textContent?.includes(HOME_CODE) === true, 'the retried code')
    expect(mintFetch).toHaveBeenCalledTimes(2)
    expect(element.querySelector('.home__qr-error')).toBe(null)
  })

  it('opens the host session with the code it already minted, never a second one', async () => {
    const element = renderHome()
    await waitFor(() => element.textContent?.includes(HOME_CODE) === true, 'the minted code')

    const start = [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.includes('Start a session on this device') === true,
    )
    if (!start) throw new Error('test bug: no start-session button')
    click(start)

    const route = element.querySelector<HTMLElement>('.session-route')
    expect(route?.getAttribute('data-host-code')).toBe(HOME_CODE)
    expect(route?.getAttribute('data-search')).toBe('')
    // One user intent, one session: the page never asks the worker for a second code.
    expect(mintFetch).toHaveBeenCalledTimes(1)
  })

  it('offers the typed-code fallback next to Scan & Send (PLAN.md §16 Phase 6)', async () => {
    const element = renderHome()
    await settle()

    expect(element.querySelector('.manual-code')).not.toBe(null)
    expect(element.textContent).toContain('Have a code instead?')
  })
})

describe('Home — Scan & Send, PLAN.md §7 flow A (PLAN.md §16 Phase 6, D8)', () => {
  /** Selects items in the browser by their display names, as a user with checkboxes would. */
  function selectItems(element: HTMLElement, names: string[]): void {
    click(buttonByClass(element, 'library-browser__select'))
    const displayed = itemNames(element)
    const checkboxes = [...element.querySelectorAll<HTMLInputElement>('.library-item__checkbox')]

    for (const name of names) {
      const box = checkboxes[displayed.indexOf(name)]
      if (!box) throw new Error(`test bug: no checkbox for ${name}`)
      click(box)
    }
  }

  it('queues exactly the selected items and joins the scanned session as the guest', async () => {
    const first = note(ROOT_FOLDER_ID, 'Portal password')
    const second = note(ROOT_FOLDER_ID, 'Thesis draft')
    await saveItem(first)
    await saveItem(second)
    await saveItem(note(ROOT_FOLDER_ID, 'Not selected'))

    const element = renderHome()
    await waitFor(() => itemNames(element).length === 3, 'the library to load')

    selectItems(element, ['Portal password', 'Thesis draft'])
    expect(buttonByClass(element, 'home__scan').textContent).toContain('(2)')

    click(buttonByClass(element, 'home__scan'))
    click(buttonByClass(element, 'scanner__scan-valid'))

    const route = element.querySelector<HTMLElement>('.session-route')
    // The scanned code is the PEER's session, so this device is the guest: the code is in
    // the URL and no host bundle travels with it.
    expect(route?.getAttribute('data-search')).toBe(`?code=${PEER_CODE}`)
    expect(route?.getAttribute('data-host-code')).toBe('')

    // Exactly the selection, in memory only — never written anywhere to survive the hop.
    const queued = takeQueuedLibrarySends()
    expect(queued.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
    expect(queued.map((item) => item.name).sort()).toEqual(['Portal password', 'Thesis draft'])
  })

  it('joins the scanned session plainly when nothing is selected', async () => {
    await saveItem(note(ROOT_FOLDER_ID, 'Not selected'))

    const element = renderHome()
    await waitFor(() => itemNames(element).length === 1, 'the library to load')

    click(buttonByClass(element, 'home__scan'))
    click(buttonByClass(element, 'scanner__scan-valid'))

    expect(element.querySelector('.session-route')?.getAttribute('data-search')).toBe(
      `?code=${PEER_CODE}`,
    )
    expect(takeQueuedLibrarySends()).toEqual([])
  })

  it('does not navigate on a malformed scanned code, and closes the scanner', async () => {
    const element = renderHome()
    await settle()

    click(buttonByClass(element, 'home__scan'))
    click(buttonByClass(element, 'scanner__scan-malformed'))

    expect(element.querySelector('.session-route')).toBe(null)
    // The real scanner stops its camera after reporting a code, so the overlay closes
    // rather than staying up over a dead preview.
    expect(element.querySelector('.qr-scanner-stub')).toBe(null)
    expect(takeQueuedLibrarySends()).toEqual([])
  })
})

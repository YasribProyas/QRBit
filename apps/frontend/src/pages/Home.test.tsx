/** @vitest-environment jsdom */
/**
 * Page-level tests for `pages/Home.tsx` (PLAN.md §7, §16 Phase 5).
 *
 * The page is the library's wiring: it loads the store on mount, renders the real
 * browser from the store's data, and turns the browser's callbacks into store actions.
 * These tests drive that wiring end to end against a real (fake-indexeddb) library, so
 * "renders from the store" means the items came out of IndexedDB rather than out of a
 * prop somebody handed over.
 *
 * The send flow is PLAN.md §7 flow A / decision D8: the selection goes into the
 * session-scoped, memory-only queue and the page navigates to `/session` (no code, so
 * this device is the host). The session hook draining that queue is covered in
 * useSession.test.tsx; what is pinned here is that the page fills it with the items the
 * user actually selected — and that nothing was written anywhere to get them across.
 */

import 'fake-indexeddb/auto'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
import { useLibraryStore } from '../store/libraryStore'

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

/** Renders Home with a `/session` route that marks the navigation, as the app's router does. */
function renderHome(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/session" element={<div className="session-route" />} />
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

beforeEach(async () => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  useLibraryStore.setState({ folders: [], items: [], loading: false, error: null })
  takeQueuedLibrarySends()
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

describe('Home — the library (PLAN.md §7, §16 Phase 5)', () => {
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
    await waitFor(() => itemNames(element).length === 0, 'the item to be deleted')

    expect(itemNames(element)).toEqual([])
    expect(await getItemsInFolder(ROOT_FOLDER_ID)).toEqual([])
    expect(useLibraryStore.getState().error).toBe(null)
  })

  it('keeps the Phase 6 scanner entry disabled with its hint', async () => {
    const element = renderHome()
    await settle()

    const scan = [...element.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Scan & Send'),
    )
    if (!scan) throw new Error('test bug: no Scan & Send button')

    expect(scan.disabled).toBe(true)
    expect(element.textContent).toContain('Camera scanning arrives in Phase 6')
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

    click(buttonByClass(element, 'library-browser__send-selected'))

    // The route changed to the session page with no code — this device is the host.
    expect(element.querySelector('.session-route')).not.toBe(null)

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

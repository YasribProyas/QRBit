/** @vitest-environment jsdom */
/**
 * SessionBoard tests (PLAN.md §9: "A session is an ordered array of items", §8 Phase 3:
 * "Both devices see the same board updating live").
 *
 * The board reads items straight from the session store, so these tests drive the
 * store — that is the path a receiver's items actually take — and pass a stand-in for
 * the items API. Ordering, the per-row status indicator, the delegation to each item
 * type and the sender/receiver difference in editability are all covered here; the
 * item components themselves have their own test files.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionBoard } from './SessionBoard'
import type { ItemsApi, SessionBoardProps } from './SessionBoard'
import { useSessionStore } from '../../store/sessionStore'
import type {
  FileItem as FileItemModel,
  ImageItem as ImageItemModel,
  LockedItem,
  RichTextItem as RichTextItemModel,
  SessionItem,
  TextItem as TextItemModel,
} from '../../store/sessionStore'

const createObjectURL = vi.fn((_source: Blob | MediaSource): string => 'blob:qrbit/1')
const revokeObjectURL = vi.fn()
const previousCreateObjectURL = URL.createObjectURL
const previousRevokeObjectURL = URL.revokeObjectURL

function makeApi(): ItemsApi {
  return {
    addTextItem: vi.fn((): string => 'new-text'),
    addRichTextItem: vi.fn((): string => 'new-rich'),
    addFileItem: vi.fn((): string => 'new-file'),
    addLockedItem: vi.fn(async (): Promise<string> => 'new-locked'),
    unlockItem: vi.fn(async (): Promise<boolean> => true),
    lockItemAgain: vi.fn(),
    updateTextItem: vi.fn(),
    updateRichTextItem: vi.fn(),
    deleteItem: vi.fn(),
  }
}

function textItem(overrides: Partial<TextItemModel> = {}): TextItemModel {
  return { id: 't1', type: 'text', status: 'complete', createdAt: 1, content: 'hello', ...overrides }
}

function richItem(overrides: Partial<RichTextItemModel> = {}): RichTextItemModel {
  return {
    id: 'r1',
    type: 'richtext',
    status: 'complete',
    createdAt: 2,
    content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'rich' }] }] }),
    ...overrides,
  }
}

function imageItem(overrides: Partial<ImageItemModel> = {}): ImageItemModel {
  return {
    id: 'i1',
    type: 'image',
    status: 'transferring',
    createdAt: 3,
    fileName: 'holiday.jpg',
    mimeType: 'image/jpeg',
    totalSize: 4096,
    totalChunks: 4,
    progress: 25,
    ...overrides,
  }
}

function fileItem(overrides: Partial<FileItemModel> = {}): FileItemModel {
  return {
    id: 'f1',
    type: 'file',
    status: 'pending',
    createdAt: 4,
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    totalSize: 8192,
    totalChunks: 8,
    progress: 0,
    ...overrides,
  }
}

function lockedItem(overrides: Partial<LockedItem> = {}): LockedItem {
  return {
    id: 'l1',
    type: 'locked',
    // `complete` because the unlocked announce has landed its ciphertext, which is what
    // the row's Unlock affordance waits for.
    status: 'complete',
    createdAt: 5,
    label: 'Uni portal password',
    innerType: 'text',
    ciphertext: new Uint8Array([1, 2, 3]),
    iv: new Uint8Array([4, 5, 6]),
    salt: new Uint8Array([7, 8, 9]),
    ...overrides,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function setItems(items: SessionItem[]): void {
  act(() => {
    useSessionStore.getState().setItems(items)
  })
}

function renderBoard(overrides: Partial<SessionBoardProps> = {}): { element: HTMLDivElement; api: ItemsApi } {
  const api = makeApi()
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(createElement(SessionBoard, { api, role: 'guest', ...overrides }))
  })

  container = element
  root = created
  return { element, api }
}

function rows(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll('.session-board__row')) as HTMLElement[]
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
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  URL.createObjectURL = previousCreateObjectURL
  URL.revokeObjectURL = previousRevokeObjectURL
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('SessionBoard ordering and empty state (PLAN.md §9)', () => {
  it('renders the store items in order', () => {
    setItems([
      textItem({ id: 'first', content: 'first item' }),
      textItem({ id: 'second', content: 'second item' }),
    ])

    const { element } = renderBoard()

    const rendered = rows(element)
    expect(rendered).toHaveLength(2)
    // Read through the inputs: on the sender's side each text item is an editor.
    expect(rendered.map((row) => row.querySelector('input')?.value)).toEqual(['first item', 'second item'])
  })

  it('explains an empty board differently for each side', () => {
    const sender = renderBoard({ role: 'guest' })
    expect(sender.element.textContent).toContain('Nothing sent yet.')

    const receiver = renderBoard({ role: 'host' })
    expect(receiver.element.textContent).toContain('Nothing received yet.')
  })
})

describe('SessionBoard per-item status (PLAN.md §9)', () => {
  it('labels the status of every row', () => {
    setItems([
      textItem({ id: 'a', status: 'pending' }),
      textItem({ id: 'b', status: 'transferring' }),
      textItem({ id: 'c', status: 'complete' }),
      textItem({ id: 'd', status: 'error' }),
    ])

    const { element } = renderBoard()
    const rendered = rows(element)

    expect(rendered.map((row) => row.dataset['itemStatus'])).toEqual([
      'pending',
      'transferring',
      'complete',
      'error',
    ])
    expect(rendered[0]?.textContent).toContain('Pending')
    expect(rendered[1]?.textContent).toContain('Transferring')
    expect(rendered[2]?.textContent).toContain('Complete')
    expect(rendered[3]?.textContent).toContain('Error')
  })
})

describe('SessionBoard item delegation (PLAN.md §9)', () => {
  it('renders a text item as an input on the sender and as text on the receiver', () => {
    setItems([textItem({ content: 'typed here' })])

    const sender = renderBoard({ role: 'guest' })
    expect(sender.element.querySelector('input')).not.toBe(null)
    expect(rows(sender.element)[0]?.dataset['itemType']).toBe('text')

    const receiver = renderBoard({ role: 'host' })
    expect(receiver.element.querySelector('input')).toBe(null)
    expect(receiver.element.textContent).toContain('typed here')
  })

  it('renders a rich-text item with a Tiptap editor', () => {
    setItems([richItem()])

    const { element } = renderBoard()

    expect(rows(element)[0]?.dataset['itemType']).toBe('richtext')
    expect(element.querySelector('.ProseMirror')).not.toBe(null)
    expect(element.textContent).toContain('rich')
  })

  it('renders the image and file item bodies, not just their labels', () => {
    setItems([imageItem(), fileItem()])

    const { element } = renderBoard()
    const rendered = rows(element)

    expect(rendered[0]?.querySelector('.image-item')).not.toBe(null)
    expect(rendered[0]?.textContent).toContain('holiday.jpg')
    expect(rendered[0]?.querySelector('.progress-ring')?.getAttribute('aria-valuenow')).toBe('25')

    expect(rendered[1]?.querySelector('.file-item')).not.toBe(null)
    expect(rendered[1]?.textContent).toContain('report.pdf')
  })

  it('renders a locked row with its label and an Unlock affordance, and no password field until it is asked for', () => {
    setItems([lockedItem()])

    const { element } = renderBoard({ role: 'host' })

    expect(element.textContent).toContain('Uni portal password')
    expect(element.querySelector('.locked-item__badge')).not.toBe(null)
    const unlock = element.querySelector('.locked-item__unlock')
    expect(unlock).not.toBe(null)
    // The password modal is the row's, opened on demand: PLAN.md §9 has the receiver
    // see the label only, so a password field on the board would be a leak of nothing
    // but noise.
    expect(element.querySelector('input[type="password"]')).toBe(null)

    if (!(unlock instanceof HTMLButtonElement)) throw new Error('test bug: no unlock button')
    act(() => {
      unlock.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The row unlocks nothing itself — it opens the password modal and hands the
    // board's `api.unlockItem` to it (the submit path is pinned in LockedItem's and
    // UnlockModal's own tests).
    expect(element.querySelector('input[type="password"]')).not.toBe(null)
  })

  it('delegates unlocking and re-hiding to the items API', () => {
    setItems([lockedItem({ unlocked: true, plaintextContent: 'the secret' })])

    const { element, api } = renderBoard({ role: 'host' })

    expect(element.textContent).toContain('the secret')

    const lockAgain = element.querySelector('.locked-item__lock-again')
    expect(lockAgain).not.toBe(null)

    act(() => {
      lockAgain?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.lockItemAgain).toHaveBeenCalledWith('l1')
  })

  it('shows the inner type the sender chose to the sender only', () => {
    setItems([lockedItem({ innerType: 'file' })])

    const sender = renderBoard({ role: 'guest' })
    expect(sender.element.querySelector('.locked-item__inner-type')).not.toBe(null)

    const receiver = renderBoard({ role: 'host' })
    expect(receiver.element.querySelector('.locked-item__inner-type')).toBe(null)
  })
})

describe('SessionBoard follows the store live (PLAN.md §8 Phase 3)', () => {
  it('updates the receiver view when a delta lands', () => {
    setItems([textItem({ content: 'one' })])
    const { element } = renderBoard({ role: 'host' })
    expect(element.textContent).toContain('one')

    act(() => {
      useSessionStore.getState().upsertItem(textItem({ content: 'one two' }))
    })

    expect(element.textContent).toContain('one two')
  })

  it('drops the row when the peer deletes the item', () => {
    setItems([textItem({ id: 'keep', content: 'kept' }), textItem({ id: 'gone', content: 'deleted' })])
    const { element } = renderBoard({ role: 'host' })

    act(() => {
      useSessionStore.getState().setItems([textItem({ id: 'keep', content: 'kept' })])
    })

    expect(element.textContent).toContain('kept')
    expect(element.textContent).not.toContain('deleted')
  })
})

describe('SessionBoard removal (PLAN.md §9 items API contract)', () => {
  it('asks the API to delete the row it was clicked on', () => {
    setItems([textItem({ id: 't1' }), textItem({ id: 't2' })])
    const { element, api } = renderBoard()

    const removeButtons = element.querySelectorAll('.session-board__remove')
    expect(removeButtons).toHaveLength(2)

    act(() => {
      removeButtons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.deleteItem).toHaveBeenCalledTimes(1)
    expect(api.deleteItem).toHaveBeenCalledWith('t2')
  })
})

/** @vitest-environment jsdom */
/**
 * Page-level tests for `pages/Home.tsx` (PLAN.md §7, §16 Phase 5/6, ORCHESTRATION.md D13).
 *
 * Lane 3: Home BECOMES the host. The QR is visible and joinable the moment the app opens,
 * with no tap in between. Home connects as host to the signaling server for its minted
 * code on mount. Below the QR, the library is visible and usable while waiting.
 *
 * When a peer connects and pairs, the session surface (SessionView) replaces the library.
 * Once the session ends, Home auto-recovers to mint a fresh live code so the next peer
 * gets a joinable QR rather than a burned one (D10).
 */

import 'fake-indexeddb/auto'

import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { Home } from './Home'
import { Session } from './Session'
import {
  closeLibraryDatabase,
  createFolder,
  getItemsInFolder,
  ROOT_FOLDER_ID,
  saveItem,
} from '../lib/library'
import type { LibraryItem } from '../lib/library'
import { deriveSessionMaterial, takeQueuedLibrarySends } from '../hooks/useSession'
import { APP_URL, buildNewSessionUrl } from '../config'
import { useLibraryStore } from '../store/libraryStore'
import { useSessionStore } from '../store/sessionStore'
import { exportPublicKey, generateKeypair, toBase64 } from '../lib/crypto'
import { PeerConnection } from '../lib/webrtc'

const HOME_CODE = 'ABCDEFGH'
const scannerStub = vi.hoisted(() => ({ peerCode: '23456789' }))
const PEER_CODE = scannerStub.peerCode

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

// ---------------------------------------------------------------------------
// Fake WebSocket and PeerConnection for full host session testing
// ---------------------------------------------------------------------------

let sockets: FakeWebSocket[] = []
let fakePeers: FakeRTCPeerConnection[] = []

class FakeWebSocket {
  readonly url: string
  readonly sent: string[] = []
  readyState = 0
  closed = false
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
    sockets.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  fireOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  deliver(message: unknown): void {
    const frame = JSON.stringify(message)
    this.onmessage?.({ data: frame } as unknown as MessageEvent)
  }

  sentFrames(): { type: string; [key: string]: unknown }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; [key: string]: unknown })
  }

  sentOfType(type: string): { type: string; [key: string]: unknown } | null {
    return this.sentFrames().find((frame) => frame.type === type) ?? null
  }
}

class FakeDataChannel {
  readonly label: string
  readonly options: RTCDataChannelInit | undefined
  readonly sent: unknown[] = []
  remote: FakeDataChannel | null = null
  readyState: RTCDataChannelState = 'connecting'
  closed = false
  bufferedAmountLowThreshold = 0
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onbufferedamountlow: ((event: Event) => void) | null = null

  constructor(label: string, options?: RTCDataChannelInit) {
    this.label = label
    this.options = options
  }

  send(data: unknown): void {
    this.sent.push(data)
    this.remote?.receive(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 'closed'
  }

  open(): void {
    this.readyState = 'open'
    this.onopen?.(new Event('open'))
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload } as unknown as MessageEvent)
  }
}

class FakeRTCPeerConnection {
  readonly createdChannels: FakeDataChannel[] = []
  readonly receivedChannels: FakeDataChannel[] = []
  readonly config: RTCConfiguration | undefined
  onDataChannelCreated: ((channel: FakeDataChannel) => void) | null = null
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  closed = false
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null
  onconnectionstatechange: ((event: Event) => void) | null = null

  constructor(config?: RTCConfiguration) {
    this.config = config
    fakePeers.push(this)
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
    const channel = new FakeDataChannel(label, options)
    this.createdChannels.push(channel)
    this.onDataChannelCreated?.(channel)
    return channel as unknown as RTCDataChannel
  }

  deliverDataChannel(channel: FakeDataChannel): void {
    this.receivedChannels.push(channel)
    this.ondatachannel?.({ channel: channel as unknown as RTCDataChannel } as RTCDataChannelEvent)
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'fake-offer-sdp' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'fake-answer-sdp' }
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description
  }

  async addIceCandidate(): Promise<void> {
    // No-op
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }
}

function linkChannel(host: FakeRTCPeerConnection, guest: FakeRTCPeerConnection): void {
  host.onDataChannelCreated = (channel) => {
    const remote = new FakeDataChannel(channel.label, channel.options)
    channel.remote = remote
    remote.remote = channel
    guest.deliverDataChannel(remote)
  }
}

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

function jsonResponse(body: unknown): unknown {
  return { ok: true, status: 200, json: async (): Promise<unknown> => body }
}

function SessionRoute() {
  const location = useLocation()
  return <div className="session-route" data-search={location.search} />
}

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

async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

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
  sockets = []
  fakePeers = []
  ;(globalThis as unknown as Record<string, unknown>)['WebSocket'] = FakeWebSocket
  ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = FakeRTCPeerConnection
  useLibraryStore.setState({ folders: [], items: [], loading: false, error: null })
  useSessionStore.getState().reset()
  takeQueuedLibrarySends()
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
  for (const socket of sockets) {
    socket.onmessage = null
    socket.onopen = null
    socket.onerror = null
    socket.onclose = null
    socket.close()
  }
  for (const peer of fakePeers) {
    peer.close()
  }
  sockets = []
  fakePeers = []
  useSessionStore.getState().reset()
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
    expect(element.querySelector('.qr-scanner-stub')).toBe(null)

    click(scan)
    expect(element.querySelector('.qr-scanner-stub')).not.toBe(null)

    click(buttonByClass(element, 'scanner__cancel'))
    expect(element.querySelector('.qr-scanner-stub')).toBe(null)
  })
})

describe('Home — send selected (PLAN.md §7 flow A, decision D8)', () => {
  it('queues the selected library items for the live host session', async () => {
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

    await waitFor(() => mintFetch.mock.calls.length >= 1, 'the mint to complete')

    click(buttonByClass(element, 'library-browser__send-selected'))

    // Home is already the host session: it does not navigate away to /session,
    // and the queued items wait in memory to be sent once a peer scans Home's QR.
    expect(element.querySelector('.session-route')).toBe(null)

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

    expect(takeQueuedLibrarySends().map((item) => item.id)).toEqual([only.id])
  })
})

describe('Home — live host session and QR (ORCHESTRATION.md D13, Lane 3)', () => {
  it('opening Home shows a QR for a code it has actually joined as host (assert the join happened, not just that a canvas exists)', async () => {
    const element = renderHome()
    await waitFor(() => sockets.length === 1, 'the host signaling socket')
    const socket = sockets[0]!
    socket.fireOpen()
    await waitFor(() => socket.sentOfType('join') !== null, 'the host join frame')

    const join = socket.sentOfType('join')
    expect(socket.url).toContain(HOME_CODE)
    expect(join?.['role']).toBe('host')
    expect(typeof join?.['publicKey']).toBe('string')

    // QR panel and honest status line are rendered for this genuinely listening session
    await waitFor(() => element.querySelector('.session-qr') !== null, 'the QR panel')
    expect(element.textContent).toContain(HOME_CODE)
    expect(element.textContent).toContain(`${APP_URL}/session?code=${HOME_CODE}`)
    expect(element.textContent).toContain('Host — waiting for another device to scan your code')
  })

  it('a peer can join that code and the session proceeds to the sender-only phrase gate', async () => {
    const element = renderHome()
    await waitFor(() => sockets.length === 1, 'the host signaling socket')
    const socket = sockets[0]!
    socket.fireOpen()
    await waitFor(() => socket.sentOfType('join') !== null, 'the host join frame')

    const join = socket.sentOfType('join')
    const hostPublicKey = join?.['publicKey'] as string
    const hostFake = fakePeers[0]!

    // A guest peer joins Home's code
    const guestKeys = await generateKeypair()
    const guest = new PeerConnection()
    const guestFake = fakePeers[1]!
    linkChannel(hostFake, guestFake)

    guest.setSessionKey(
      (await deriveSessionMaterial(guestKeys.privateKey, hostPublicKey, HOME_CODE)).sessionKey,
    )

    socket.deliver({
      type: 'pubkey',
      publicKey: toBase64(await exportPublicKey(guestKeys.publicKey)),
    })
    await waitFor(() => socket.sentOfType('offer') !== null, 'the host offer frame')
    const offer = socket.sentOfType('offer')

    const answer = await guest.receiveOffer({ type: 'offer', sdp: offer?.['sdp'] as string })
    socket.deliver({ type: 'answer', sdp: answer.sdp })

    await waitFor(() => guestFake.receivedChannels.length === 1, 'the guest data channel')
    const hostChannel = hostFake.createdChannels[0]!
    const guestChannel = guestFake.receivedChannels[0]!
    hostChannel.open()
    guestChannel.open()
    await settle()

    // Host session on Home is now in pairing phase
    await waitFor(() => useSessionStore.getState().phase === 'pairing', 'the pairing phase')
    expect(element.querySelector('.safety-phrase')).not.toBe(null)

    // Under D14: Receiver (host) sees the words without gating confirm button
    const confirm = [...element.querySelectorAll('button')].find(
      (btn) => btn.textContent === 'Confirmed',
    )
    expect(confirm).toBeUndefined()
    const abort = [...element.querySelectorAll('button')].find(
      (btn) => btn.textContent === 'Abort session',
    )
    expect(abort).not.toBeUndefined()
  })

  it('Home renders the session surface when active and hides the library', async () => {
    const element = renderHome()
    await waitFor(() => sockets.length === 1, 'the host signaling socket')
    const socket = sockets[0]!
    socket.fireOpen()
    await waitFor(() => socket.sentOfType('join') !== null, 'the host join frame')

    const join = socket.sentOfType('join')
    const hostPublicKey = join?.['publicKey'] as string
    const hostFake = fakePeers[0]!

    const guestKeys = await generateKeypair()
    const guest = new PeerConnection()
    const guestFake = fakePeers[1]!
    linkChannel(hostFake, guestFake)

    guest.setSessionKey(
      (await deriveSessionMaterial(guestKeys.privateKey, hostPublicKey, HOME_CODE)).sessionKey,
    )

    socket.deliver({
      type: 'pubkey',
      publicKey: toBase64(await exportPublicKey(guestKeys.publicKey)),
    })
    await waitFor(() => socket.sentOfType('offer') !== null, 'the host offer frame')
    const offer = socket.sentOfType('offer')

    const answer = await guest.receiveOffer({ type: 'offer', sdp: offer?.['sdp'] as string })
    socket.deliver({ type: 'answer', sdp: answer.sdp })

    await waitFor(() => guestFake.receivedChannels.length === 1, 'the guest data channel')
    hostFake.createdChannels[0]!.open()
    guestFake.receivedChannels[0]!.open()
    await settle()

    // Guest (sender) confirms phrase over wire
    guest.send({ t: 'phrase-confirm' })
    await guest.drain()
    await waitFor(() => useSessionStore.getState().phase === 'active', 'the active phase')
    await settle()

    // Home renders session board in place of the library
    expect(element.querySelector('.session-board')).not.toBe(null)
    expect(element.querySelector('.safety-phrase')).toBe(null)
    expect(element.querySelector('.library-browser')).toBe(null)
    expect(element.textContent).not.toContain('Your Library')
  })

  it('the library is visible while waiting', async () => {
    const element = renderHome()
    await waitFor(() => sockets.length === 1, 'the host signaling socket')
    sockets[0]!.fireOpen()
    await settle()

    expect(element.textContent).toContain('Your Library')
    expect(element.querySelector('.library-browser')).not.toBe(null)
    expect(element.querySelector('.home__scan')).not.toBe(null)
    expect(element.querySelector('.manual-code')).not.toBe(null)
  })

  it('ending a session returns to the library with a FRESH live code', async () => {
    const FRESH_CODE = '778899AA'
    let mintCount = 0
    mintFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/new')) {
        mintCount += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: mintCount === 1 ? HOME_CODE : FRESH_CODE }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })

    const element = renderHome()
    await waitFor(() => sockets.length === 1, 'first host socket')
    sockets[0]!.fireOpen()
    await waitFor(() => sockets[0]!.sentOfType('join') !== null, 'first join')

    // Simulate clean session end (e.g. abort or peer ending)
    act(() => {
      useSessionStore.getState().endSession(null)
    })

    // Auto-recover fires, restarting with a fresh code
    await waitFor(() => sockets.length === 2, 'second host socket')
    sockets[1]!.fireOpen()
    await waitFor(() => sockets[1]!.sentOfType('join') !== null, 'second join')

    expect(sockets[1]!.url).toContain(FRESH_CODE)
    const secondJoin = sockets[1]!.sentOfType('join')
    expect(secondJoin?.['role']).toBe('host')

    // Library view is restored with the fresh QR
    expect(element.querySelector('.library-browser')).not.toBe(null)
    expect(element.textContent).toContain('Your Library')
    expect(element.textContent).toContain(FRESH_CODE)
  })

  it('a guest arriving at /session?code= is unaffected', async () => {
    const GUEST_CODE = '99887766'
    const element = document.createElement('div')
    document.body.append(element)
    const created = createRoot(element)

    act(() => {
      created.render(
        <MemoryRouter initialEntries={[`/session?code=${GUEST_CODE}`]}>
          <Routes>
            <Route path="/session" element={<Session />} />
          </Routes>
        </MemoryRouter>,
      )
    })

    await waitFor(() => sockets.length === 1, 'guest socket')
    const socket = sockets[0]!
    socket.fireOpen()
    await waitFor(() => socket.sentOfType('join') !== null, 'guest join')

    expect(socket.url).toContain(GUEST_CODE)
    const join = socket.sentOfType('join')
    expect(join?.['role']).toBe('guest')

    // Guest sees no host QR
    expect(element.querySelector('.session-qr')).toBe(null)
    expect(element.textContent).toContain('Session code')
    expect(element.textContent).toContain(GUEST_CODE)

    act(() => {
      created.unmount()
    })
    element.remove()
  })

  it('StrictMode opens exactly one signaling socket and mints exactly one code', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const created = createRoot(element)

    act(() => {
      created.render(
        <StrictMode>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<Home />} />
            </Routes>
          </MemoryRouter>
        </StrictMode>,
      )
    })

    await settle()
    await waitFor(() => sockets.length === 1, 'the single socket')

    expect(mintFetch.mock.calls.filter(([req]) => String(req).endsWith('/new'))).toHaveLength(1)
    expect(sockets).toHaveLength(1)

    act(() => {
      created.unmount()
    })
    element.remove()
  })

  it('retries the mint when the worker cannot be reached', async () => {
    mintFetch.mockRejectedValueOnce(new Error('Failed to fetch'))

    const element = renderHome()
    await waitFor(() => element.querySelector('.home__qr-error') !== null, 'the failure panel')

    expect(element.textContent).toContain('Could not reach the signaling server')
    expect(element.textContent).toContain('Failed to fetch')

    const retry = element.querySelector('.home__qr-error button')
    if (!(retry instanceof HTMLButtonElement)) throw new Error('test bug: no retry button')
    click(retry)

    await waitFor(
      () => mintFetch.mock.calls.filter(([req]) => String(req).endsWith('/new')).length >= 2,
      'the retry mint',
    )
    expect(element.querySelector('.home__qr-error')).toBe(null)
  })

  it('offers the typed-code fallback next to Scan & Send (PLAN.md §16 Phase 6)', async () => {
    const element = renderHome()
    await settle()

    expect(element.querySelector('.manual-code')).not.toBe(null)
    expect(element.textContent).toContain('Have a code instead?')
  })
})

describe('Home — Scan & Send, PLAN.md §7 flow A (PLAN.md §16 Phase 6, D8)', () => {
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
    expect(route?.getAttribute('data-search')).toBe(`?code=${PEER_CODE}`)

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
    expect(element.querySelector('.qr-scanner-stub')).toBe(null)
    expect(takeQueuedLibrarySends()).toEqual([])
  })
})

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
 *
 * ORCHESTRATION D16 changed what can be reached from this page. The `sr-only`
 * `LibraryBrowser` mount is gone (D16.4), and with it the only multi-select UI Home ever
 * shipped — so the "select items, then Scan & Send queues them" page tests went too,
 * because there is nothing on the page left to ask. `LibraryBrowser.test.tsx` still pins
 * that component directly. What replaces them is asserted through the library panel that
 * is now on screen: a dossier row opens the editor, `+ New file` writes into the folder
 * whose list it heads (the `folders[0]?.id || 'f-1'` fallback is dead, so a test seeds
 * two folders and proves the second one is the one that gets the dossier), `Scan & Send`
 * belongs to the QR panel rather than the header, and the header's Settings control
 * navigates.
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
import { WithMantine } from '../components/common/WithMantine'
import {
  closeLibraryDatabase,
  createFile,
  createFolder,
  getFile,
  getFilesInFolder,
  ROOT_FOLDER_ID,
} from '../lib/library'
import type { FileBlock } from '../lib/library'
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
        scan a QRBit code
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
    const request = indexedDB.deleteDatabase('qrbit-library')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
    request.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'))
  })
}

/** One heading block, so a seeded dossier has the blocks `parseFile` expects. */
function heading(content: string): FileBlock[] {
  return [{ id: `b-${content}`, type: 'heading', content }]
}

function jsonResponse(body: unknown): unknown {
  return { ok: true, status: 200, json: async (): Promise<unknown> => body }
}

function SessionRoute() {
  const location = useLocation()
  return <div className="session-route" data-search={location.search} />
}

/** A stand-in for `pages/Settings.tsx`, so the header link can be asserted as a navigation. */
function SettingsRoute() {
  return <div className="settings-route" />
}

function renderHome(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(
      // `main.tsx` provides Mantine at the root; `WithMantine` keeps this harness honest
      // about components that assume it, without one of them having to care.
      <WithMantine>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/session" element={<SessionRoute />} />
            <Route path="/settings" element={<SettingsRoute />} />
          </Routes>
        </MemoryRouter>
      </WithMantine>,
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

/** The dossier rows the library panel lists, in the order it lists them. */
function dossierNames(element: HTMLElement): (string | undefined)[] {
  return [...element.querySelectorAll<HTMLElement>('.library-panel__file-name')].map(
    (name) => name.textContent ?? undefined,
  )
}

function folderHeadings(element: HTMLElement): (string | undefined)[] {
  return [...element.querySelectorAll<HTMLElement>('.library-panel__folder-name')].map(
    (name) => name.textContent?.trim(),
  )
}

/** A wait predicate has to answer "not yet" rather than throw the way `sectionFor` does. */
function hasSection(element: HTMLElement, name: string): boolean {
  return [...element.querySelectorAll<HTMLElement>('.library-panel__folder')].some(
    (node) => node.querySelector('.library-panel__folder-name')?.textContent?.trim() === name,
  )
}

function sectionFor(element: HTMLElement, name: string): HTMLElement {
  for (const node of element.querySelectorAll<HTMLElement>('.library-panel__folder')) {
    if (node.querySelector('.library-panel__folder-name')?.textContent?.trim() === name) return node
  }
  throw new Error(`test bug: no folder section named ${name}`)
}

function rowFor(element: HTMLElement, name: string): HTMLElement {
  for (const row of element.querySelectorAll<HTMLElement>('.library-panel__file')) {
    if (row.querySelector('.library-panel__file-name')?.textContent?.trim() === name) return row
  }
  throw new Error(`test bug: no dossier row named ${name}`)
}

function buttonIn(scope: HTMLElement, selector: string, what: string): HTMLButtonElement {
  const node = scope.querySelector(selector)
  if (!(node instanceof HTMLButtonElement)) throw new Error(`test bug: no ${what}`)
  return node
}

/** The dossier row's `···` menu entry, opening the menu first. */
function rowMenuItem(element: HTMLElement, name: string, label: string): HTMLButtonElement {
  const row = rowFor(element, name)
  click(buttonIn(row, '.library-panel__file-menu-toggle', 'row menu'))
  for (const item of row.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
    if (item.textContent === label) return item
  }
  throw new Error(`test bug: no dossier menu item labelled ${label}`)
}

let mintFetch: Mock

beforeEach(async () => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  sockets = []
  fakePeers = []
  ;(globalThis as unknown as Record<string, unknown>)['WebSocket'] = FakeWebSocket
  ;(globalThis as unknown as Record<string, unknown>)['RTCPeerConnection'] = FakeRTCPeerConnection
  useLibraryStore.setState({ folders: [], items: [], files: [], loading: false, error: null })
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
  it('renders the library from the store, and opens a dossier in the editor', async () => {
    const folder = await createFolder('Uni Stuff', null)
    await createFile('Portal password', folder.id, heading('Portal'))
    await createFile('Loose note', ROOT_FOLDER_ID, heading('Loose'))

    const element = renderHome()
    await waitFor(() => dossierNames(element).length === 2, 'the library to load')

    expect(dossierNames(element).sort()).toEqual(['Loose note', 'Portal password'])
    expect(folderHeadings(element)).toContain('Uni Stuff')
    // Root is a section of its own, so a dossier nobody filed is still on screen.
    expect(folderHeadings(element)).toContain('Root')

    click(buttonIn(rowFor(element, 'Portal password'), '.library-panel__file-open', 'row body'))

    // Home swaps the whole shell for the editor, and the dossier it opened is this one.
    expect(element.querySelector('.library-panel')).toBe(null)
    expect(element.textContent).toContain('Portal password')
  })

  it('reports a store failure in the library panel instead of throwing it', async () => {
    const element = renderHome()
    await settle()

    await act(async () => {
      useLibraryStore.setState({ error: 'library: no folder with id "gone"' })
    })

    expect(element.querySelector('.library-panel__error')?.textContent).toContain(
      'no folder with id "gone"',
    )
  })

  it('deletes a dossier through the panel, in the store and in IndexedDB', async () => {
    const dossier = await createFile('Loose note', ROOT_FOLDER_ID, heading('Loose'))

    const element = renderHome()
    await waitFor(() => dossierNames(element).length === 1, 'the library to load')

    click(rowMenuItem(element, 'Loose note', 'Delete'))

    const dialog = element.querySelector('[role="dialog"]')
    if (!(dialog instanceof HTMLElement)) throw new Error('test bug: no confirmation dialog')
    expect(dossierNames(element)).toEqual(['Loose note'])
    expect((await getFilesInFolder(ROOT_FOLDER_ID)).map((stored) => stored.id)).toEqual([
      dossier.id,
    ])

    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === 'Delete dossier permanently',
    )
    if (!confirm) throw new Error('test bug: no destructive confirm button in the dialog')
    click(confirm)
    await waitFor(() => dossierNames(element).length === 0, 'the dossier to be deleted')

    expect(dossierNames(element)).toEqual([])
    expect(await getFilesInFolder(ROOT_FOLDER_ID)).toEqual([])
    expect(await getFile(dossier.id)).toBeUndefined()
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

/*
 * D16 behaviour changes 2 and 3, at page level: the folder a new dossier lands in is the
 * folder whose list the `+ New file` row heads. This is the test that pins the removal of
 * `folders[0]?.id || 'f-1'` — the first version wrote whichever folder happened to be
 * first, and fell back to a mock id that no longer exists anywhere.
 */
describe('Home — the top bar (ORCHESTRATION D16 behaviour change 1)', () => {
  it('carries Settings, which navigates, and exactly one Scan & Send — in the QR panel', async () => {
    const element = renderHome()
    await settle()

    const scanButtons = [...element.querySelectorAll<HTMLButtonElement>('button')].filter(
      (candidate) => candidate.textContent?.includes('Scan & Send') === true,
    )
    expect(scanButtons).toHaveLength(1)
    // The one Scan & Send belongs to the panel whose action it is, not to the header.
    expect(scanButtons[0]?.closest('.home__qr-panel')).not.toBe(null)
    expect(scanButtons[0]?.closest('header')).toBe(null)

    const settings = element.querySelector<HTMLElement>('.home__settings')
    if (!settings) throw new Error('test bug: no Settings control in the header')
    click(settings)
    await waitFor(() => element.querySelector('.settings-route') !== null, 'the /settings route')

    expect(element.querySelector('.library-panel')).toBe(null)
  })
})

describe('Home — the folder a dossier is created in (ORCHESTRATION D16)', () => {
  it('creates the dossier in the folder whose + New file row was pressed', async () => {
    const first = await createFolder('Work', null)
    const second = await createFolder('Research', null)

    const element = renderHome()
    await waitFor(() => folderHeadings(element).includes('Research'), 'both folders on screen')

    const newFile = sectionFor(element, 'Research').querySelector<HTMLButtonElement>(
      '.library-panel__new-file',
    )
    if (!newFile) throw new Error('test bug: Research has no + New file row')
    click(newFile)
    await waitFor(() => element.textContent?.includes('New Dossier') === true, 'the editor to open')

    const stored = await getFilesInFolder(second.id)
    expect(stored.map((file) => file.name)).toEqual(['New Dossier'])
    expect(await getFilesInFolder(first.id)).toEqual([])
    expect(await getFilesInFolder('f-1')).toEqual([])
    expect(useLibraryStore.getState().error).toBe(null)

    // And it is the editor that came up, not a second copy of the panel.
    expect(element.querySelector('.library-panel')).toBe(null)
  })

  it('creates an unfiled dossier from Root when there is no folder at all', async () => {
    const element = renderHome()
    await waitFor(() => hasSection(element, 'Root'), "Root's section")

    const newFile = sectionFor(element, 'Root').querySelector<HTMLButtonElement>(
      '.library-panel__new-file',
    )
    if (!newFile) throw new Error('test bug: Root has no + New file row')
    click(newFile)
    await waitFor(() => element.textContent?.includes('New Dossier') === true, 'the editor to open')

    // `root` is a real target for a file in the library layer, so this write lands rather
    // than being rejected as an unknown folder — which is what a mock-id fallback would be.
    expect((await getFilesInFolder(ROOT_FOLDER_ID)).map((file) => file.name)).toEqual([
      'New Dossier',
    ])
    expect(useLibraryStore.getState().error).toBe(null)
  })
})

describe('Home — live host session and QR (ORCHESTRATION.md D13, Lane 3)', () => {
  it('opening Home shows a QR for a code it has actually joined as host (assert the join happened, not just that a canvas exists)', async () => {
    const element = renderHome()
    await waitFor(() => sockets.length === 1, 'the host signaling socket')
    const socket = sockets[0]!

    /*
     * D13, the half that matters here: before the join frame has gone out, there must be
     * NO scannable code on screen. Asserting only that a join eventually happens is the
     * same presence-only mistake that let the original D13 defect pass 932 tests — the
     * window between minting and joining is exactly where a QR must not appear.
     */
    expect(element.querySelector('.session-qr')).toBe(null)
    expect(element.textContent).not.toContain(`${APP_URL}/session?code=${HOME_CODE}`)

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
    expect(element.querySelector('.library-panel')).toBe(null)
    expect(element.textContent).not.toContain('Local Library')
  })

  it('the library panel is visible while waiting', async () => {
    const element = renderHome()
    await waitFor(() => sockets.length === 1, 'the host signaling socket')
    sockets[0]!.fireOpen()
    await settle()

    expect(element.textContent).toContain('Local Library')
    expect(element.querySelector('.library-panel')).not.toBe(null)
    expect(element.querySelector('.home__scan')).not.toBe(null)
    expect(element.querySelector('.manual-code')).not.toBe(null)
    // D16 behaviour change 1: the header carries Settings, not a second Scan & Send.
    expect(element.querySelector('header .home__scan')).toBe(null)
    expect(element.querySelector('.home__settings')).not.toBe(null)
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
    expect(element.querySelector('.library-panel')).not.toBe(null)
    expect(element.textContent).toContain('Local Library')
    await waitFor(() => element.textContent?.includes(FRESH_CODE) === true, 'the fresh live QR')
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

/*
 * The page-level "select library items, then Scan & Send queues them" tests lived here.
 * They drove the `sr-only` `LibraryBrowser` mount that D16.4 deleted, so the page has no
 * multi-select left to test — `LibraryBrowser.test.tsx` still pins that component, and the
 * surviving half of the flow (open the camera from the QR panel, join what it scanned) is
 * asserted below.
 */
describe('Home — Scan & Send, PLAN.md §7 flow A (PLAN.md §16 Phase 6, D8, D16)', () => {
  it('joins the scanned session with an empty queue when nothing was sent first', async () => {
    const element = renderHome()
    await settle()

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

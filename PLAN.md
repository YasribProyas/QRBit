# QRDrop — Project Plan
> Scan a QR code. Files appear. No login. No cloud. No trace.

---

## 1. Project Overview

QRDrop is a symmetric, browser-based P2P transfer tool. Every device running QRDrop has:
- A **local library** — a persistent, organized folder/file store that lives in IndexedDB, never leaves the device, never touches a server
- A **QR code** — so any other device can scan and open a session to send items to it

Scanning another device's QR code opens a direct encrypted P2P session. Items transfer in real-time over WebRTC. Nothing is stored server-side. After the session, the receiver can manually save items to their local library.

**Core constraints:**
- Every device is both sender and receiver — the app is fully symmetric
- Local library lives in IndexedDB only — never synced to any cloud
- Session data is in-memory only — dies on disconnect
- QR code is the primary pairing mechanism — typed code is fallback
- All sensitive data is E2EE in transit; locked items are double-encrypted at rest and in transit
- Works on any network: LAN, CGNAT, mobile data, DPI firewalls
- PWA on mobile — installable, system share target

---

## 2. Threat Model

| Threat | Mitigation |
|---|---|
| Passive network sniffing | DTLS (WebRTC) + AES-256-GCM app layer |
| Active MITM during pairing | Safety phrase (ECDH-derived, visual verification) |
| Signaling server compromise | ECDH — server never sees the shared secret |
| TURN relay compromise | App-layer E2EE — relay only sees ciphertext |
| QR code intercepted / replayed | Session codes expire in 5 min; safety phrase catches MITM |
| Pairing code brute force | 8-char alphanumeric + server-side rate limiting |
| CGNAT / mobile data | TURN UDP fallback |
| Hostile firewall / DPI | TURN over TCP 443 (looks like HTTPS) |
| Locked item extracted from IndexedDB | PBKDF2 + AES-256-GCM; ciphertext only, key never stored |
| Physical shoulder surfing | Lock items; safety phrase enforces awareness |
| Library extracted from device | Regular items plaintext in IDB (acceptable); locked items always encrypted |

---

## 3. Architecture Overview

```
Any Device (PWA / Browser)        Signaling Worker            Any Other Device
──────────────────────────        ────────────────            ────────────────
┌─────────────────────────┐                                   ┌──────────────────────────┐
│   LOCAL LIBRARY         │                                   │   LOCAL LIBRARY          │
│   (IndexedDB)           │                                   │   (IndexedDB)            │
│   folders / items       │                                   │   folders / items        │
│   locked items: E2EE    │                                   │   locked items: E2EE     │
└─────────────────────────┘                                   └──────────────────────────┘
         │                                                              │
         │  User selects items                    User opens QRDrop    │
         │  QR reader opens          ──────────►  QR code displayed    │
         │  Scans peer QR                                               │
         ▼                                                              ▼
Generate P-256 keypair              Durable Object            Generate P-256 keypair
                                    (1 per session)
         ────── WS connect ──────►                 ◄──── WS connect ────
                                    brokers:
                                    - pubkey exchange
                                    - SDP offer/answer
                                    - ICE candidates
                                    then self-destructs

Derive shared secret (ECDH)                                   Derive shared secret (ECDH)
Derive session AES key (HKDF)                                 Derive session AES key (HKDF)
Derive safety phrase (HKDF)                                   Derive safety phrase (HKDF)

         ◄──────────── WebRTC Data Channel (DTLS) ────────────►
         ◄──────────── App-layer AES-256-GCM (on top) ─────────►

[Both devices show 3-word safety phrase — user confirms visually]

         ◄──────────── Encrypted session items flow ─────────►

After session: receiver taps "Save to Library" on items they want to keep
```

---

## 4. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend framework | React + Vite | TypeScript throughout |
| PWA | `vite-plugin-pwa` + Workbox | Share target, installable |
| Rich text | Tiptap (headless) | Serializes to JSON, React-native |
| Local storage | IndexedDB via `idb` | Typed wrapper, promise-based |
| Crypto | Web Crypto API (native) | Zero crypto dependencies |
| WebRTC | Native `RTCPeerConnection` | No lib needed |
| Wire serialization | `@msgpack/msgpack` | Binary, handles Uint8Array natively |
| State | Zustand | Session + library stores |
| QR display | `qrcode` (npm) | Renders to canvas |
| QR scan | `html5-qrcode` or native BarcodeDetector API | BarcodeDetector where available, lib as fallback |
| Signaling server | Cloudflare Workers + Durable Objects | Free tier, stateful WS |
| TURN | Cloudflare TURN | Free tier, global edge, time-limited tokens |
| Hosting | Cloudflare Pages | Pairs naturally with Workers |
| Monorepo | `pnpm` workspaces | `apps/frontend` + `apps/signaling-worker` |

---

## 5. Repository Structure

```
project-root/
├── apps/
│   ├── frontend/
│   │   ├── public/
│   │   │   ├── manifest.webmanifest
│   │   │   └── icons/
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── crypto.ts            # All Web Crypto wrappers
│   │   │   │   ├── webrtc.ts            # RTCPeerConnection + DataChannel
│   │   │   │   ├── signaling.ts         # WebSocket signaling client
│   │   │   │   ├── chunker.ts           # File → chunks + reassembly
│   │   │   │   ├── protocol.ts          # Wire message types + serialization
│   │   │   │   ├── safetyPhrase.ts      # Derive 3-word phrase from shared secret
│   │   │   │   ├── library.ts           # IndexedDB read/write for local library
│   │   │   │   └── export.ts            # Library export/import + optional encryption
│   │   │   ├── components/
│   │   │   │   ├── library/
│   │   │   │   │   ├── LibraryBrowser.tsx     # Folder tree + item list
│   │   │   │   │   ├── FolderNode.tsx
│   │   │   │   │   ├── LibraryItemRow.tsx
│   │   │   │   │   └── NewFolderModal.tsx
│   │   │   │   ├── session/
│   │   │   │   │   ├── SessionBoard.tsx        # Ordered list of in-flight items
│   │   │   │   │   ├── SafetyPhraseOverlay.tsx
│   │   │   │   │   ├── AddItemBar.tsx          # DA only
│   │   │   │   │   └── items/
│   │   │   │   │       ├── TextItem.tsx
│   │   │   │   │       ├── RichTextItem.tsx
│   │   │   │   │       ├── ImageItem.tsx
│   │   │   │   │       ├── FileItem.tsx
│   │   │   │   │       └── LockedItem.tsx
│   │   │   │   ├── QRDisplay.tsx              # Renders own QR code
│   │   │   │   ├── QRScanner.tsx              # Camera-based QR reader
│   │   │   │   ├── ProgressRing.tsx
│   │   │   │   └── ExportModal.tsx
│   │   │   ├── pages/
│   │   │   │   ├── Home.tsx                   # QR + library browser (main screen)
│   │   │   │   ├── Session.tsx                # Active session (role-aware)
│   │   │   │   └── Settings.tsx               # Export/import + prefs
│   │   │   ├── hooks/
│   │   │   │   ├── useSession.ts
│   │   │   │   ├── useWebRTC.ts
│   │   │   │   └── useLibrary.ts
│   │   │   ├── store/
│   │   │   │   ├── sessionStore.ts
│   │   │   │   └── libraryStore.ts
│   │   │   └── main.tsx
│   │   ├── vite.config.ts
│   │   └── package.json
│   └── signaling-worker/
│       ├── src/
│       │   ├── index.ts
│       │   ├── session.ts               # Durable Object
│       │   └── turn.ts
│       └── wrangler.toml
├── AGENTS.md
├── PLAN.md
├── pnpm-workspace.yaml
└── package.json
```

---

## 6. Local Library

The library is permanent, device-local storage. It is **not** a session concept — it persists across sessions and app restarts, lives entirely in IndexedDB, and is never sent to any server.

### 6.1 Data Model

```typescript
// ── Folders ──────────────────────────────────────────────────────────
interface LibraryFolder {
  id: string               // uuid v4
  name: string
  parentId: string | null  // null = root
  createdAt: number
  updatedAt: number
}

// ── Items ─────────────────────────────────────────────────────────────
type LibraryItemType = 'text' | 'richtext' | 'image' | 'file' | 'locked'

interface LibraryItemBase {
  id: string
  folderId: string         // root folder if uncategorized
  name: string             // display name, user-editable
  type: LibraryItemType
  createdAt: number
  updatedAt: number
}

interface LibraryTextItem extends LibraryItemBase {
  type: 'text'
  content: string          // plaintext in IndexedDB
}

interface LibraryRichTextItem extends LibraryItemBase {
  type: 'richtext'
  content: string          // Tiptap JSON string, plaintext in IndexedDB
}

interface LibraryImageItem extends LibraryItemBase {
  type: 'image'
  blob: Blob               // stored as Blob in IndexedDB
  mimeType: string
  size: number
}

interface LibraryFileItem extends LibraryItemBase {
  type: 'file'
  blob: Blob
  mimeType: string
  size: number
}

interface LibraryLockedItem extends LibraryItemBase {
  type: 'locked'
  label: string            // visible label, not encrypted
  innerType: 'text' | 'richtext' | 'file'
  // Encrypted payload — stored as-is in IndexedDB:
  ciphertext: Uint8Array   // AES-256-GCM output
  iv: Uint8Array           // 12 bytes
  salt: Uint8Array         // 16 bytes (PBKDF2 salt)
}

type LibraryItem =
  | LibraryTextItem
  | LibraryRichTextItem
  | LibraryImageItem
  | LibraryFileItem
  | LibraryLockedItem
```

### 6.2 Encryption at Rest

Only `LibraryLockedItem` entries are encrypted in IndexedDB. Regular items (text, richtext, image, file) are stored plaintext. The PBKDF2 key used to encrypt a locked item is derived from the user's per-item password and is **never stored anywhere** — it must be re-derived on every unlock.

```
IndexedDB stores:     { ciphertext, iv, salt }   ← all opaque bytes
Key lives only in:    User's memory (the password they typed)
```

### 6.3 IndexedDB Schema (`lib/library.ts`)

```typescript
// IDB database: "qrdrop-library", version 1
// Object stores:
//   "folders"  — keyPath: "id"
//   "items"    — keyPath: "id", indexes: ["folderId", "type", "updatedAt"]

async function getFolders(): Promise<LibraryFolder[]>
async function createFolder(name: string, parentId: string | null): Promise<LibraryFolder>
async function renameFolder(id: string, name: string): Promise<void>
async function deleteFolder(id: string): Promise<void>   // also deletes all items inside

async function getItemsInFolder(folderId: string): Promise<LibraryItem[]>
async function getItem(id: string): Promise<LibraryItem>
async function saveItem(item: LibraryItem): Promise<void>
async function updateItem(id: string, patch: Partial<LibraryItem>): Promise<void>
async function deleteItem(id: string): Promise<void>
async function moveItem(id: string, targetFolderId: string): Promise<void>

// Convenience: called after a session to save a received item
async function saveFromSession(item: SessionItem, folderId: string): Promise<LibraryItem>
```

### 6.4 Library Browser UI (`components/library/LibraryBrowser.tsx`)

Layout:
```
┌──────────────────────────────────────┐
│  📁 Root                             │
│    📁 Uni Stuff                      │
│      📄 Portal Password    🔒  ···   │
│      📄 Thesis Draft.pdf       ···   │
│    📁 Work                           │
│      📄 SSH Keys           🔒  ···   │
│  + New Folder                        │
└──────────────────────────────────────┘
```

- Folders are collapsible
- Each item has a type icon, name, lock badge if locked, and a `···` menu (rename, move, delete, send)
- Multi-select via long-press: checkbox appears on each item, "Send selected" button appears in header
- Tapping an item previews it inline (text/image) or downloads it (file)
- Locked items: tap → password prompt → reveal inline

---

## 7. Home Screen (`pages/Home.tsx`)

The primary screen. Visible immediately on app open. No landing page, no "start session / join session" split — the app is symmetric.

```
┌────────────────────────────────────┐
│  QRDrop                       ⚙️   │
│                                    │
│   ┌──────────────────────────┐     │
│   │                          │     │
│   │        [ QR CODE ]       │     │  ← This device's session QR
│   │                          │     │    Tap to refresh / enlarge
│   └──────────────────────────┘     │
│   Scan this to send files here     │
│                                    │
│   ── Your Library ─────────────    │
│   [ Library browser (§6.4) ]       │  ← Browse, select, multi-select
│                                    │
│   [ 📷 Scan & Send ]               │  ← Opens QR scanner; after scan,
│                                    │    selected items queue immediately
└────────────────────────────────────┘
```

**Two send flows from this screen:**

Flow A — Pre-select then scan:
1. Multi-select items in library
2. Tap "Scan & Send" — QR scanner opens
3. Scan peer's QR
4. Session opens, selected items start transferring immediately on channel open

Flow B — Scan first (or use native camera app):
1. User opens native camera or QR app and scans peer's QR
2. URL opens: `https://qrdrop.app/session?code=A7X3K9P2`
3. QRDrop opens on Session page
4. User selects what to send from library, or adds new items inline

Both flows converge at the Session page.

---

## 8. Session Flow

### QR Code Content

The QR encodes a full URL:
```
https://qrdrop.app/session?code=A7X3K9P2
```

Scanning with any QR reader (native or in-app) opens the session directly. No manual code entry needed in the happy path. Manual code entry (`/session?join` with a text input) exists as explicit fallback.

### Session Page (`pages/Session.tsx`)

Role is determined from URL params:
- `?code=XXXXXXXX` → guest (scanner/sender)
- No code param, arrived via own QR being scanned → host (receiver)

**Phase 1 — Connecting:**
Small status bar at top: "Connecting…" with a spinner. Library browser or compose area visible below (so user can prep items while connecting).

**Phase 2 — Safety Phrase:**
Full-screen overlay. Three large words. Both devices show the same words.
```
┌─────────────────────────────┐
│                             │
│   Confirm these match       │
│   on both devices:          │
│                             │
│    RIVER  COPPER  EIGHT     │
│                             │
│        [ Confirmed ✓ ]      │
│        [ Abort session ]    │
│                             │
└─────────────────────────────┘
```
Session does not proceed until confirmed on both sides.

**Phase 3 — Active Session:**
Session board (§9). Items transfer async. Both devices see the same board updating live.

**Phase 4 — Session Ended:**
"Session ended" message. Each received item has a "Save to Library →" button with a folder picker. Items not saved are discarded.

---

## 9. Session Data Model

A session is an **ordered array of items**. Items are independent — a large file in-flight does not block text items added after it.

### Item Types

```typescript
type ItemType = 'text' | 'richtext' | 'image' | 'file' | 'locked'
type ItemStatus = 'pending' | 'transferring' | 'complete' | 'error'

interface BaseItem {
  id: string           // uuid v4, generated by sender
  type: ItemType
  status: ItemStatus
  createdAt: number
}

interface TextItem extends BaseItem {
  type: 'text'
  content: string      // streams live as sender types
}

interface RichTextItem extends BaseItem {
  type: 'richtext'
  content: string      // Tiptap JSON, debounced 100ms
}

interface ImageItem extends BaseItem {
  type: 'image'
  fileName: string
  mimeType: string
  totalSize: number
  totalChunks: number
  progress: number     // 0–100
  blob?: Blob          // assembled on receiver
  objectURL?: string
}

interface FileItem extends BaseItem {
  type: 'file'
  fileName: string
  mimeType: string
  totalSize: number
  totalChunks: number
  progress: number
  blob?: Blob
}

interface LockedItem extends BaseItem {
  type: 'locked'
  label: string        // e.g. "Uni Portal Password" — plaintext
  innerType: 'text' | 'richtext' | 'file'
  ciphertext: Uint8Array
  iv: Uint8Array
  salt: Uint8Array
  // Receiver-side only, never sent:
  unlocked?: boolean
  plaintextContent?: string | Blob
}

type SessionItem = TextItem | RichTextItem | ImageItem | FileItem | LockedItem
```

### Session Board UI

| Item type | Sender view | Receiver view |
|---|---|---|
| `text` | Single-line input, syncs on keystroke | Live text, updates as sender types |
| `richtext` | Tiptap editor | Tiptap read-only, updates live |
| `image` | Thumbnail + progress ring | Progressive reveal as chunks arrive |
| `file` | Filename + progress ring | Progress ring → download button on complete |
| `locked` | Label + password field + content | Label only + "Unlock" → password modal → inline reveal |

**Add item bar** (sender only): `T` text · `¶` rich text · `🖼` image · `📎` file · `🔒` locked · `📚` from library

Tapping "from library" opens the library browser in a sheet — user picks items and they start sending immediately.

### Session State (Zustand)

```typescript
interface SessionState {
  role: 'host' | 'guest' | null
  phase: 'idle' | 'connecting' | 'pairing' | 'verified' | 'active' | 'ended'
  sessionCode: string | null
  safetyPhrase: [string, string, string] | null
  phraseConfirmed: boolean
  items: SessionItem[]
  connectionState: RTCPeerConnectionState
}
```

---

## 10. Wire Protocol

All messages: serialize with `@msgpack/msgpack` → encrypt with AES-256-GCM → send over DataChannel.

### Message Types

```typescript
type WireMessage =
  | { t: 'item-announce'; id: string; type: ItemType; label?: string; fileName?: string; mimeType?: string; totalSize?: number; totalChunks?: number; innerType?: string }
  | { t: 'text-delta';     id: string; content: string }
  | { t: 'richtext-delta'; id: string; content: string }
  | { t: 'file-chunk';     id: string; index: number; data: Uint8Array }
  | { t: 'file-done';      id: string }
  | { t: 'locked-payload'; id: string; ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }
  | { t: 'item-delete';    id: string }
  | { t: 'phrase-confirm' }    // sent by both sides when user taps Confirmed
  | { t: 'session-end' }
```

### Encrypted Envelope

Every message is sent as a single `ArrayBuffer`: `[iv: 12 bytes][ciphertext + GCM tag]`.

---

## 11. Crypto Module (`lib/crypto.ts`)

All crypto via native Web Crypto API. No third-party crypto libraries.

### 11.1 Key Exchange (P-256 ECDH)

```typescript
async function generateKeypair(): Promise<CryptoKeyPair>
// { name: 'ECDH', namedCurve: 'P-256' }, extractable public key

async function exportPublicKey(key: CryptoKey): Promise<ArrayBuffer>
async function importPeerPublicKey(raw: ArrayBuffer): Promise<CryptoKey>
async function deriveSharedSecret(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<ArrayBuffer>
```

### 11.2 Key Derivation (HKDF)

```typescript
// Session encryption key
async function deriveSessionKey(sharedSecret: ArrayBuffer, sessionId: string): Promise<CryptoKey>
// HKDF: hash=SHA-256, salt=sessionId bytes, info="qrdrop-session-v1"

// Safety phrase bytes
async function deriveSafetyPhraseBytes(sharedSecret: ArrayBuffer, sessionId: string): Promise<Uint8Array>
// HKDF: hash=SHA-256, salt=sessionId bytes, info="qrdrop-phrase-v1"
```

### 11.3 Session Encryption (AES-256-GCM)

```typescript
async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<ArrayBuffer>
// Random 12-byte IV prepended: [iv(12)][ciphertext+tag]

async function decrypt(key: CryptoKey, envelope: ArrayBuffer): Promise<Uint8Array>
// Slice IV from first 12 bytes, decrypt rest
```

### 11.4 Locked Item Encryption (PBKDF2 + AES-256-GCM)

Used both for in-session locked items AND for library locked items at rest.

```typescript
async function deriveItemKey(password: string, salt: Uint8Array): Promise<CryptoKey>
// PBKDF2: hash=SHA-256, iterations=600_000, keyLength=256

async function encryptItem(
  password: string,
  plaintext: Uint8Array
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }>
// 1. Generate 16-byte random salt
// 2. deriveItemKey(password, salt)
// 3. AES-256-GCM with random 12-byte IV

async function decryptItem(
  password: string,
  salt: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array>
// Throws DOMException on wrong password
```

### 11.5 Export Encryption (AES-256-GCM + PBKDF2)

```typescript
async function encryptExport(password: string, data: Uint8Array): Promise<ArrayBuffer>
// Same pattern as encryptItem — salt + IV prepended to output

async function decryptExport(password: string, data: ArrayBuffer): Promise<Uint8Array>
```

### 11.6 Safety Phrase (`lib/safetyPhrase.ts`)

```typescript
// Map bytes to words from a 256-word list (EFF short wordlist subset)
// 3 bytes → 3 words → shown on both devices
function bytesToPhrase(bytes: Uint8Array): [string, string, string]
```

---

## 12. WebRTC Module (`lib/webrtc.ts`)

### ICE Configuration

```typescript
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349',          // TCP 443 — hostile network last resort
    ],
    username: '',       // filled from signaling worker response
    credential: '',
  },
]

const config: RTCConfiguration = {
  iceServers: ICE_SERVERS,
  iceTransportPolicy: 'all',
}
```

### Connection Lifecycle

```typescript
class PeerConnection {
  // Host side (the device whose QR was scanned)
  async initAsHost(): Promise<RTCSessionDescriptionInit>
  async receiveAnswer(answer: RTCSessionDescriptionInit): Promise<void>

  // Guest side (the device that scanned)
  async receiveOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>
  async addIceCandidate(c: RTCIceCandidateInit): Promise<void>

  // Shared
  onIceCandidate(cb: (c: RTCIceCandidateInit) => void): void
  onDataChannelOpen(cb: () => void): void
  onMessage(cb: (msg: WireMessage) => void): void   // auto-decrypts
  send(msg: WireMessage): void                       // auto-encrypts
  close(): void
}
```

### File Chunking (`lib/chunker.ts`)

```typescript
const CHUNK_SIZE = 16 * 1024   // 16 KB

async function* chunkFile(id: string, file: File): AsyncGenerator<WireMessage>
// Yields: item-announce → file-chunk × N → file-done

class FileAssembler {
  addChunk(index: number, data: Uint8Array): void
  isComplete(totalChunks: number): boolean
  assemble(mimeType: string): Blob
}
```

---

## 13. Signaling Server (`apps/signaling-worker/`)

Cloudflare Worker + Durable Object. One DO per session. Brokers WebRTC handshake only — never sees data.

### Routes

```
GET  /session/new          → { code: string, turnCredentials: { username, credential } }
GET  /session/:code/ws     → WebSocket upgrade
```

### Durable Object State Machine

```
CREATED → HOST_CONNECTED → GUEST_CONNECTED → EXCHANGING → DONE (self-destructs)
```

### Signaling Messages (WebSocket)

```typescript
type SignalingMessage =
  | { type: 'join';   role: 'host' | 'guest'; publicKey: string }
  | { type: 'pubkey'; publicKey: string }
  | { type: 'offer';  sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice';    candidate: RTCIceCandidateInit }
  | { type: 'paired' }    // sent by DO to both sides, then DO destroys itself
```

### Rate Limiting

- Max 10 join attempts per IP per minute (Workers KV)
- Session codes expire after 5 minutes
- TURN credentials expire after 1 hour (HMAC-SHA256 time-limited tokens)

### TURN Credentials (`turn.ts`)

```typescript
function generateTurnCredentials(secret: string): { username: string; credential: string }
// username = `${unixTimestamp + 3600}:${randomId}`
// credential = base64(HMAC-SHA256(secret, username))
```

---

## 14. Export / Import (`lib/export.ts`)

### Export

Serializes the entire library (or a selected subset) to a single `.qrdrop` file (JSON wrapped in optional encryption).

```typescript
interface ExportManifest {
  version: 1
  exportedAt: number
  encrypted: boolean        // whether the outer file is encrypted
  folders: LibraryFolder[]
  items: LibraryItemExport[]
}

interface LibraryItemExport {
  meta: Omit<LibraryItem, 'blob'>
  // For file/image items: blob serialized as base64 string
  blobData?: string
  blobMimeType?: string
}
```

**Locked items in export:**
- Always exported in their encrypted form `{ ciphertext, iv, salt }` — unchanged
- Even if the user chooses NOT to encrypt the outer export file, locked items remain encrypted inside it
- If the user encrypts the whole export, locked items are double-encrypted (outer export key + their own item key)

```typescript
async function exportLibrary(
  folderIds: string[] | 'all',
  options: { encrypt: boolean; password?: string }
): Promise<Blob>
// Returns a .qrdrop file (JSON or encrypted binary)

async function importLibrary(
  file: File,
  options: { password?: string }
): Promise<{ imported: number; errors: string[] }>
// Merges into existing library; skips duplicates by id
```

### Export UI (`components/ExportModal.tsx`)

```
┌──────────────────────────────────┐
│  Export Library                  │
│                                  │
│  Export: ○ All  ○ Selected       │
│                                  │
│  ☐ Encrypt export file           │
│     Password: [____________]     │
│     Confirm:  [____________]     │
│                                  │
│  Note: Locked items stay locked  │
│  regardless of this setting.     │
│                                  │
│  [Cancel]        [Export ↓]      │
└──────────────────────────────────┘
```

---

## 15. PWA Configuration

### `manifest.webmanifest`

```json
{
  "name": "QRDrop",
  "short_name": "QRDrop",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f0f0f",
  "theme_color": "#0f0f0f",
  "share_target": {
    "action": "/session",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "files": [{ "name": "file", "accept": ["*/*"] }]
    }
  },
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

Share target: user long-presses a file in Files app → Share → QRDrop → file pre-loaded into session. QR scanner opens immediately so they can scan and send in one motion.

### Service Worker

- Cache: app shell only (HTML, JS, CSS, icons via Workbox `precacheAndRoute`)
- IndexedDB is NOT managed by the service worker — it's owned by the page directly
- Explicitly exclude `/session*` from cache — session pages must always be fresh

---

## 16. Implementation Phases

### Phase 1 — Signaling + Bare WebRTC
- [ ] pnpm monorepo + Vite + React + TypeScript setup
- [ ] Cloudflare Worker + Durable Object skeleton
- [ ] Session code generation, WS routing, DO state machine
- [ ] `signaling.ts` client
- [ ] `webrtc.ts` PeerConnection skeleton
- [ ] Home page: static QR display (hardcoded URL for now) + stub library panel
- [ ] Session page: connects, data channel opens, sends plaintext "hello" both ways
- [ ] Deploy to Cloudflare Pages + Worker (dev environment)

### Phase 2 — E2EE Layer
- [ ] `crypto.ts`: keypair gen, ECDH, HKDF, AES-256-GCM
- [ ] Public key exchange via signaling during WS handshake
- [ ] Session key derivation
- [ ] All DataChannel messages encrypted/decrypted transparently in `PeerConnection`
- [ ] `safetyPhrase.ts` + 256-word list
- [ ] `SafetyPhraseOverlay.tsx` + `phrase-confirm` wire message
- [ ] Session blocked until both sides confirm

### Phase 3 — Session Board + Item Types
- [ ] `protocol.ts`: WireMessage types + MessagePack serialization
- [ ] Zustand session store
- [ ] `TextItem`: real-time sync (debounced 100ms)
- [ ] `RichTextItem`: Tiptap integration, JSON delta sync
- [ ] `FileItem` + `chunker.ts`: chunk pipeline, progress tracking
- [ ] `ImageItem`: file pipeline + progressive thumbnail
- [ ] Async: multiple items in-flight simultaneously, no blocking
- [ ] `AddItemBar`: T · ¶ · 🖼 · 📎 · 🔒 (library picker later)

### Phase 4 — Locked Items (Session)
- [ ] `encryptItem` / `decryptItem` in `crypto.ts`
- [ ] `LockedItem` compose UI on sender: label, type, password, content, PBKDF2 spinner
- [ ] Wire: `locked-payload` message with `{ ciphertext, iv, salt }`
- [ ] `LockedItem` receive UI: label shown, Unlock → password modal → inline reveal
- [ ] Wrong password: DOMException catch → show error, clear input, never crash

### Phase 5 — Local Library
- [ ] `library.ts`: IDB schema + all CRUD functions
- [ ] `libraryStore.ts`: Zustand wrapper around library.ts
- [ ] `LibraryBrowser.tsx`: folder tree, item list, multi-select
- [ ] `FolderNode.tsx`, `LibraryItemRow.tsx`, `NewFolderModal.tsx`
- [ ] Locked items in library: `encryptItem` on save, `decryptItem` on open
- [ ] Save from session: "Save to Library →" button with folder picker on session end
- [ ] Home screen: QRDisplay + LibraryBrowser live
- [ ] "Scan & Send": QRScanner opens after multi-select, queues items on channel open
- [ ] "📚 from library" in AddItemBar during active session

### Phase 6 — QR + PWA
- [ ] `QRDisplay.tsx`: generate QR from session URL using `qrcode` lib
- [ ] `QRScanner.tsx`: BarcodeDetector API with `html5-qrcode` fallback
- [ ] Signaling worker: `/session/new` generates real session codes
- [ ] Home QR: tapping it calls `/session/new`, displays QR for that session
- [ ] Scanning opens `/session?code=XXXXXXXX` directly
- [ ] Manual code entry fallback UI
- [ ] `vite-plugin-pwa` setup + `manifest.webmanifest`
- [ ] Share target handler in Session page
- [ ] Cloudflare TURN credentials from worker

### Phase 7 — Export / Import + TURN Hardening
- [ ] `export.ts`: `exportLibrary`, `importLibrary`
- [ ] `ExportModal.tsx`
- [ ] Settings page with export/import + library stats
- [ ] TURN: UDP + TCP + TLS 443 ICE server config
- [ ] Test on hostile network (mobile hotspot + firewall rules blocking UDP)
- [ ] Rate limiting on signaling worker

### Phase 8 — Polish + Security Hardening
- [ ] CSP headers (strict, no unsafe-inline)
- [ ] `Sec-Fetch-*` checks on worker routes
- [ ] Session code server-side format validation
- [ ] Connection state UI (connecting, connected, ended, error)
- [ ] AES-GCM auth tag failure → drop message silently, log in dev
- [ ] Session auto-end when tab closes (beforeunload → `session-end` message)
- [ ] Service worker: verify IndexedDB not cached
- [ ] Audit: confirm no blobs or session items touch Cache API or localStorage

---

## 17. Security Checklist

- [ ] Signaling DO logs nothing; destroys all state after `paired`
- [ ] TURN credentials single-use per session; expire in 1 hour
- [ ] No session data (SDP, ICE, pubkeys, items) ever logged in production
- [ ] AES-GCM auth tag failures drop message — never crash, never expose partial plaintext
- [ ] PBKDF2 wrong password: catch `DOMException`, show UI error, clear input fields
- [ ] Session Blobs stored in memory only — never written to IDB, Cache API, or localStorage
- [ ] Library locked items: `{ ciphertext, iv, salt }` in IDB — key never persisted anywhere
- [ ] Export locked items: always encrypted inside the export file, regardless of outer encryption choice
- [ ] Service worker explicitly excludes `/session*` paths and all IDB data from cache
- [ ] QR URL session codes expire 5 min from creation; expired codes return 404 from worker
- [ ] `iceTransportPolicy: 'all'` — try direct first, TURN fallback automatic
- [ ] TURN over TCP 443 configured — works on captive portals and DPI networks
- [ ] CSP: `default-src 'self'; connect-src wss://*.workers.dev https://turn.cloudflare.com; worker-src 'self'`
- [ ] Pairing code: alphanumeric only, validated server-side before DO lookup

---

## 18. Environment Variables

### Signaling Worker (`wrangler.toml`)

```toml
name = "qrdrop-signaling"

[vars]
SESSION_TTL_SECONDS = "300"
TURN_TTL_SECONDS = "3600"

[[durable_objects.bindings]]
name = "SESSION"
class_name = "SessionDurableObject"

# wrangler secret put TURN_SECRET
```

### Frontend (`.env`)

```env
VITE_SIGNALING_URL=wss://qrdrop-signaling.YOUR_SUBDOMAIN.workers.dev
VITE_APP_URL=https://qrdrop.app
```

---

## 19. Key Design Decisions

1. **Symmetric app** — no "sender" or "receiver" role at rest. Role is assigned per-session based on who generated the QR (host) vs who scanned it (guest). Same codebase, same home screen.

2. **QR encodes a full URL** — scanning with any QR reader (native camera, third-party app, in-app scanner) opens the session. No app install required to scan — the URL works in any browser.

3. **Library locked items are never decrypted at rest** — the `{ ciphertext, iv, salt }` tuple sits in IndexedDB permanently. The PBKDF2 key is derived on unlock and used immediately; it is never stored in memory beyond the unlock operation.

4. **Export preserves locked item encryption** — even an unencrypted `.qrdrop` export file contains locked items as opaque ciphertext. An attacker who gets the export file still cannot read locked items without each item's password.

5. **P-256 ECDH** — not X25519. Web Crypto API supports P-256 natively on all browsers including old lab PCs. X25519 via `@noble/curves` is a drop-in swap if desired.

6. **One Durable Object per session** — holds exactly 2 WebSocket connections, brokers 4 message types, stores nothing else, self-destructs after pairing.

7. **MessagePack over JSON** — handles `Uint8Array` natively, no base64 bloat for file chunks.

8. **Text sync debounced at 100ms** — real-time feel without flooding the data channel.

9. **PBKDF2 at 600,000 iterations** — OWASP 2023 recommendation. ~300ms on a mid-range phone; show a subtle spinner. Worth it for password-derived keys.

10. **No session reconnect** — sessions are single-use. If the connection drops, start a new session. Reconnect logic adds complexity that isn't worth it for a quick transfer tool.

11. **BarcodeDetector first** — Chrome/Android has a native `BarcodeDetector` API that's fast and battery-efficient. Fall back to `html5-qrcode` for Safari and older browsers.

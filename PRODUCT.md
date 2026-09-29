# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

1. **Self-transfer (Personal Cross-Device):** An individual transferring notes, credentials, code snippets, photos, and files between their personal phone, tablet, and desktop/laptop without logging into cloud services (iCloud, Google Drive, Slack, email) or leaving network trails.
2. **In-Person Ad-Hoc Collaboration:** Two people in physical proximity (collaborators, peers, friends) transferring files or credentials between disparate, incompatible operating systems (iOS, Android, macOS, Linux, Windows) with zero setup, zero app store downloads, and zero contact exchange.

## Product Purpose

QRBit is a dual-purpose privacy tool: a persistent, device-local encrypted vault (the "Library" / "Dossiers") and an instant, symmetric peer-to-peer beaming utility. It eliminates account surveillance, cloud retention, and ecosystem silos. Success means generating a scannable host QR on first paint, pairing in under five seconds via camera scan or manual code, streaming direct encrypted transfers over WebRTC DataChannels, and terminating sessions with zero trace left on signaling infrastructure, relays, or disk.

## Positioning

Unlike cloud storage utilities (Dropbox, Google Drive), QRBit stores zero session or vault data on remote servers and requires zero accounts or logins. Unlike single-ecosystem transfer tools (AirDrop, Quick Share), QRBit is entirely web-standard and cross-platform across modern browsers. Unlike basic WebRTC transfer utilities (Snapdrop, PairDrop), QRBit features:
- End-to-end application-layer encryption (P-256 ECDH + AES-256-GCM) with an HKDF-derived 3-word visual safety phrase.
- A persistent offline-first vault in IndexedDB supporting structured, multi-block Dossiers, nested folders, and drag-and-drop reordering.
- Locked items double-encrypted at rest and in transit via Web Crypto PBKDF2 (600,000 iterations) + AES-256-GCM, transmitted strictly as `{ ciphertext, iv, salt }` tuples without decrypting on send.

## Operating Context

- **Network Environments:** Operates across direct local LANs, mobile hotspots, cellular carrier-grade NATs (CGNAT), and restrictive captive portals (with automatic fallback to Cloudflare TURN relays over TCP port 443 mimicking HTTPS traffic).
- **Physical Environments:** Rapid in-person interactions where one screen displays a high-contrast QR code and the peer device scans it with its camera, followed by visual confirmation of the 3-word safety phrase before transfer starts.
- **Offline / Standalone:** Fully operational offline as a standalone personal notebook, file manager, and encrypted secret vault stored locally in IndexedDB without any network connection.
- **Surface Architecture:** 
  - Desktop: Symmetric two-panel layout featuring the local Library on the left and the host pairing/QR panel on the right.
  - Mobile: First paint centers directly on the host QR code and "Scan & Send" camera action; Library access moves to the navigation header/drawer to preserve immediate scanning ergonomics.

## Capabilities and Constraints

### Confirmed Functionality
- **Symmetric Host / Guest Architecture:** Every device can act as both sender and receiver. The root route displays a live host QR code immediately on mount. Guest devices scan the host or enter the 8-character session code to connect.
- **Offline Library Vault & Dossiers:** Multi-folder file manager backed by IndexedDB. Documents are structured as "Dossiers" composed of typed blocks: `heading`, `shortText` (key-value pairs), `richText` (Tiptap notes), `image` (Blob attachments), `fileAttachment` (Blob attachments), `locked` (encrypted secrets), and `divider`.
- **Dossier & Folder Reordering:** Gap-based floating midpoint sorting (`sortOrder`) for dossiers and sibling folders, allowing drag-and-drop reordering with single-record updates instead of full-table rewrites.
- **Prop Data Integrity:** Strict prohibition against fabricated Blobs or dummy bytes. Attachment blocks must contain genuine user files; unpopulated attachments throw `DossierSendError` and reject transfer rather than transmitting placeholder bytes.
- **Locked Items & Secret Boundaries (Decisions D6, D9, D11):** Sensitive records (passwords, tokens, credentials, private files) encrypted via Web Crypto PBKDF2 (600,000 iterations) + AES-256-GCM. Plaintext is capped at 3 MiB (`LOCKED_ITEM_MAX_PLAINTEXT_BYTES`). Stored and transferred strictly as `{ ciphertext, iv, salt }` tuples. Passwords belong exclusively to the ephemeral edit/unlock modal and are never persisted in IndexedDB or sent over the wire. Plaintext buffers are zeroed immediately post-encryption and post-decryption.
- **Wire Protocol & Streaming Pipeline:** WebRTC DataChannel transport using binary MessagePack framing (`@msgpack/msgpack`). File chunking pipeline uses 16 KB chunks (`CHUNK_SIZE = 16384`) with backpressure control (`bufferedAmountLowThreshold` = 64 KB). Live text streaming is debounced at 100ms.
- **Pairing & Signaling Lifecycle:** Brokered by Cloudflare Workers + Durable Objects. 8-character alphanumeric codes with a 300-second (5-minute) TTL. Durable Objects self-destruct upon pairing or alarm. Burned codes are tracked in Cloudflare KV to prevent replay attacks.
- **Sender-Only Verification (Decision D14):** 3-word safety phrase derived via HKDF-SHA256 from the ECDH shared secret using a curated 2048-word dictionary. Confirmed by the sender to activate transfer while the receiver displays the phrase passively.
- **Library Export & Import (.qrbit):** Supports exporting the entire library or selected items into a `.qrbit` bundle—either as a plain JSON manifest or an encrypted binary bundle prefixed with the 4-byte magic `QRBE` (`application/octet-stream`) encrypted with user password. Locked items remain in their encrypted tuple state inside both formats. Import performs non-destructive additive merges.
- **PWA Share Target:** Supports PWA installation and system share target for incoming URLs and text (`?url=`, `?text=`, `?title=`), queuing items automatically for the next session. File sharing via POST is transparently documented as limited by the zero-persistence invariant.

### Technical & Architectural Constraints
- **Zero Third-Party Crypto Libraries:** Strictly native Web Crypto API (`crypto.subtle`) for ECDH key exchange, HKDF key derivation, PBKDF2, and AES-256-GCM encryption.
- **Ephemeral Session Data:** Session items, blobs, WebRTC peer descriptors, safety phrases, and key material exist strictly in volatile memory and are never persisted to IndexedDB, Cache API, or localStorage.
- **Strict Content Security Policy (CSP):** Zero `unsafe-inline` scripts. Mantine CSS variables injected safely via CSSOM (`applyThemeCssVariables`) onto `<html>`. Self-hosted fonts only; zero third-party CDN connections or tracking scripts.
- **UI Architecture:** Built with React 19, TypeScript strict mode, Vite, Mantine UI v9 semantic components, and Tabler Icons (`@tabler/icons-react`).

## Brand Commitments

- **Tagline:** *"Scan a QR code. Files appear. No login. No cloud. No trace."*
- **Voice & Tone:** Discreet, utilitarian, uncompromising, cryptographic, whisper-quiet.
- **Visual Identity:** High-contrast Dark theme (`#0E1420` canvas, `#171F2C` raised) and Light theme (`#F4F6F9` canvas, `#FFFFFF` raised); Signal blue accent (`#1D4ED8`); Plus Jakarta Sans for UI and JetBrains Mono for data, cryptographic fingerprints, and pairing codes.

## Evidence on Hand

- Comprehensive test suite (~930+ tests across unit, integration, crypto, signaling, and UI state machines) running via Vitest.
- Production deployment operational on Cloudflare Workers + Static Assets (`https://qrbit-app.proyas.workers.dev`).

## Product Principles

1. **Zero Trace by Default:** A transfer leaves no footprint on the signaling server, relay, or client storage. The session vanishes when the tab closes unless items are explicitly saved to the local vault.
2. **Local Sovereignty:** The device owns its data. IndexedDB is the solitary home of the user's library and never synchronizes to remote clouds.
3. **Zero Plaintext Secrets:** Locked items never touch disk or network as plaintext. Stored tuples travel untouched; zero placeholder or fabricated data.
4. **Zero-Friction First Paint:** Present an active, joinable QR code immediately on load. No sign-up, no configuration, no multi-step wizard.

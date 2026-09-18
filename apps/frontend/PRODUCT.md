# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

1. **Self-transfer (Personal Cross-Device):** An individual moving links, code snippets, notes, images, or files between their own phone, tablet, and workstation without logging into iCloud, Google Drive, Slack, or email.
2. **In-person Ad-hoc Collaboration:** Two people in physical proximity (coworkers, collaborators, friends) needing to transfer files or sensitive credentials across incompatible operating systems (iOS, Android, macOS, Linux, Windows) with zero setup, zero app install, and zero shared account.

## Product Purpose

QRDrop is a dual-purpose privacy tool: a device-local encrypted vault and an instant, symmetric P2P beaming utility. It eliminates the friction, account surveillance, and cloud retention of traditional file-sharing tools. Success means pairing in under five seconds via a camera scan, transmitting files directly device-to-device with end-to-end encryption, and leaving zero trace on the network or signaling infrastructure.

## Positioning

Unlike cloud storage (Dropbox, Google Drive), QRDrop stores zero session data in the cloud and requires zero accounts. Unlike single-ecosystem tools (AirDrop, Quick Share), QRDrop is completely cross-platform via standard web browsers. Unlike basic WebRTC drop tools (Snapdrop, PairDrop), QRDrop features app-layer E2EE (P-256 ECDH + AES-256-GCM) with visual safety phrase verification, a persistent offline-first local library in IndexedDB, and military-grade double-encrypted locked items that remain ciphertext at rest and in transit.

## Operating Context

- **Network Environments:** Runs anywhere from local LANs and mobile hotspots to hostile captive portals and cellular CGNAT networks (fallback via Cloudflare TURN over TCP 443).
- **Physical Environments:** Rapid in-person interaction where one screen displays a high-contrast QR code and the other points a camera at it, followed by quick verbal or visual confirmation of a 3-word safety phrase.
- **Offline / Standalone:** Used as a local personal notebook and file organizer inside IndexedDB even when disconnected from the internet.

## Capabilities and Constraints

### Confirmed Functionality
- **Symmetric Architecture:** Every device can act as both sender and receiver. The Home screen displays the device's live host QR code by default while rendering the local library below.
- **Offline Library Vault:** Multi-folder file manager backed by IndexedDB. Users can author notes, rich text, upload images/files, or create locked secrets directly offline without connecting.
- **Locked Items (Headline Feature):** Sensitive records (passwords, tokens, private keys, confidential files) encrypted via Web Crypto PBKDF2 (600,000 iterations) + AES-256-GCM. Stored strictly as `{ ciphertext, iv, salt }`. Decrypted only in volatile memory upon password entry. Plaintext is zeroed immediately post-encryption. Transferred over P2P in their locked ciphertext tuple without needing to decrypt on the sending device.
- **Wire Protocol & Streaming:** WebRTC DataChannel transport using binary MessagePack frames, 16 KB file chunking pipeline with backpressured pumps, and 100ms debounced live text streaming.
- **Pairing & Signaling:** Ephemeral signaling brokered by Cloudflare Workers + Durable Objects. Codes expire in 300s. Signaling instances self-destruct upon pairing or alarm.
- **Sender-Only Verification (D14):** 3-word safety phrase derived from HKDF session key. Displayed prominently on both devices; confirmed by the sender to activate transfer while the receiver views the words non-blockingly.

### Technical & Architectural Constraints
- **Zero Third-Party Crypto:** Native Web Crypto API strictly enforced across all hashing, key derivation, and encryption routines.
- **Ephemeral Session Data:** Session items, blobs, WebRTC descriptors, and key material live in volatile memory only—never written to IndexedDB, Cache API, or localStorage.
- **Strict Content Security Policy (CSP):** Zero `unsafe-inline` scripts; strict asset boundaries; scoped connect-src.
- **UI Architecture:** Migrating to Mantine UI component ecosystem across all frontend views.

## Brand Commitments

- **Tagline:** *"Scan a QR code. Files appear. No login. No cloud. No trace."*
- **Tone & Persona:** Discreet, utilitarian, uncompromising, cryptographic, whisper-quiet.
- **Aesthetic Direction:** High-contrast dark theme (#0f0f0f background), terminal/vault precision, legible monospaced accents, zero bloat or decorative fluff.

## Evidence on Hand

- Fully functional 930+ test suite covering crypto, signaling state machines, chunking, and local library IndexedDB CRUD.
- Production deployment running on Cloudflare Workers + Static Assets (`https://qrdrop-app.proyas.workers.dev`).

## Product Principles

1. **Zero Trace by Default:** A transfer leaves no footprint on the signaling server, relay, or storage layer. The session dies with the tab unless explicitly committed to the local vault.
2. **Local Sovereignty:** The device owns its data. IndexedDB is the solitary home of the user's library and never phones home.
3. **No Unencrypted Secrets:** Locked items never touch disk or network as plaintext. If the password is lost, data is unrecoverable.
4. **Instant Zero-Friction Pairing:** Display a scannable, listening QR on first paint. Avoid multi-step handshakes or pre-registration.

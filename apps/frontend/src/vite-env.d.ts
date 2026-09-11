/// <reference types="vite/client" />

/**
 * Environment variables consumed by the frontend (PLAN.md §18).
 *
 * Declared as an augmentation rather than a fresh interface so Vite's own
 * `ImportMetaEnv` members (MODE, BASE_URL, DEV, …) stay available. This file has
 * no imports or exports on purpose — that keeps it a global declaration file, so
 * the augmentation applies project-wide.
 */
interface ImportMetaEnv {
  /** Signaling worker base URL. WebSocket scheme, e.g. `wss://…` or `ws://localhost:8787`. */
  readonly VITE_SIGNALING_URL?: string
  /** Public origin the app is served from. Encoded into QR codes (PLAN.md §8). */
  readonly VITE_APP_URL?: string
}

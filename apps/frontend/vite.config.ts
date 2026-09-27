import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * PLAN.md §16 Phase 8 / §17: `CSP headers (strict, no unsafe-inline)`.
 *
 * Emitted at build time rather than committed, because the policy has to name the
 * signaling origin and TURN host — values that differ per deployment. Writing it from
 * the same environment the app itself reads means a domain change is a one-line edit in
 * `.env`, not a hunt through two systems that can quietly disagree.
 *
 * Strictness notes, all verified against the actual build output:
 *   - `script-src 'self'` works because the built index.html contains no inline script:
 *     Vite emits an external module plus an external registerSW.js.
 *   - `style-src 'self'` works without `'unsafe-inline'` even though two components use
 *     React's `style` prop. CSP governs the `style` *content attribute*; React applies
 *     styles through the CSSOM (`el.style.setProperty`), which is deliberately outside
 *     its reach — MDN's `style-src-attr` says so explicitly. This only holds for a
 *     client-rendered app: if SSR is ever added, the server-rendered `style="..."`
 *     attributes WOULD be blocked until hydration, and a nonce would be needed.
 *   - `img-src` needs `blob:` because received images are previewed through
 *     `URL.createObjectURL`, and `data:` for the QR canvas's fallback rendering.
 *   - `Permissions-Policy` states the camera grant explicitly: the QR scanner needs
 *     `getUserMedia`, and saying so here documents it as intended rather than ambient.
 */
function pagesSecurityHeaders(): Plugin {
  let signalingUrl = ''
  let outDirPath = ''
  const TURN_HOSTS = ['https://turn.cloudflare.com']

  return {
    name: 'qrbit-pages-security-headers',
    apply: 'build',
    configResolved(resolved) {
      const env = loadEnv(resolved.mode, resolved.root, 'VITE_')
      signalingUrl = (env.VITE_SIGNALING_URL ?? 'ws://localhost:8787').trim()
      // Captured here rather than read from `this.config` in closeBundle: the bundler
      // does not expose a plugin context there, which surfaced as an undefined `outDir`.
      outDirPath = resolve(resolved.root, resolved.build.outDir)
    },
    closeBundle() {
      // The app opens both a WebSocket and plain HTTPS requests (GET /session/new and
      // /session/:code/turn) at the worker, so both schemes of the same host are needed.
      const wsSrc = signalingUrl.replace(/\/+$/, '')
      const httpSrc = wsSrc.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
      const connectSrc = ["'self'", httpSrc, wsSrc, ...TURN_HOSTS].filter(Boolean).join(' ')

      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' blob: data:",
        "font-src 'self'",
        `connect-src ${connectSrc}`,
        "worker-src 'self'",
        "object-src 'none'",
        // frame-src (not `embed-src`, which is not a directive): this app embeds no
        // frames at all, so denying them costs nothing and closes the one remaining
        // place a document could be loaded into.
        "frame-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        // Ad-blocked-friendly and honest: this app has no analytics and no third-party
        // frames, so every one of these can be denied without breaking anything.
        "upgrade-insecure-requests",
      ].join('; ')

      const headers = [
        '/*',
        `  Content-Security-Policy: ${csp}`,
        '  X-Content-Type-Options: nosniff',
        '  X-Frame-Options: DENY',
        '  Referrer-Policy: strict-origin-when-cross-origin',
        '  Permissions-Policy: camera=(self), microphone=(), geolocation=(), display-capture=()',
        '',
      ].join('\n')

      writeFileSync(resolve(outDirPath, '_headers'), headers, 'utf8')
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    pagesSecurityHeaders(),
    // PLAN.md §15: cache the app shell only. IndexedDB is owned by the page,
    // never the service worker. /session* must always be fresh — a session page
    // is live state, and a cached one would pair against a dead session.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'manifest.webmanifest', 'icons/*.png'],
      manifest: false, // manifest.webmanifest is hand-authored in public/ per §15
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallbackDenylist: [/^\/session/],
        runtimeCaching: [
          {
            // The signaling worker is not app shell — never cache it.
            urlPattern: /^https?:\/\/[^/]*\/session\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
})

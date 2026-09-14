import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [
    react(),
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

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import { Home } from './pages/Home'
import { Session } from './pages/Session'
import { Settings } from './pages/Settings'
import {
  applyThemeCssVariables,
  applyThemeScheme,
  initialThemeScheme,
  qrbitCssVariablesResolver,
  theme,
  themeColorSchemeManager,
  useThemeSchemeAttribute,
} from './theme'
import './styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('QRward cannot start: the #root element is missing from index.html')
}

/*
 * The colour scheme, in one sentence: Mantine owns the state, `data-theme` is a mirror of
 * it. `themeColorSchemeManager` makes Mantine persist the preference under `qrbit:theme`
 * (a UI preference is the only thing this app puts in localStorage — AGENTS.md forbids
 * session data there), `defaultColorScheme="auto"` means an explicit choice is remembered
 * and an absent one follows the system, and `useThemeSchemeAttribute()` below copies the
 * resolved scheme onto `<html>` so every `--qrbit-*` token in styles.css switches with it.
 *
 * `applyThemeScheme` runs once before the first render rather than only in that effect:
 * effects run after paint, and a visitor whose system is dark would otherwise see the
 * light scheme for a frame. Both calls resolve the same stored value with the same rule,
 * which lives in theme.ts.
 *
 * `applyThemeCssVariables` runs in the same breath because Mantine's own delivery of
 * `cssVariablesResolver` cannot be relied on here: it injects the map as an inline `<style>`
 * element, which this app's `style-src 'self'` blocks, so without this the document would
 * style every Mantine control from the framework's static defaults (white-on-white quiet
 * controls in light, Mantine's own grey ramps in dark). The CSSOM is not governed by
 * `style-src`; see the note on `applyThemeCssVariables` in theme.ts.
 */
const initialScheme = initialThemeScheme()
applyThemeScheme(initialScheme)
applyThemeCssVariables(initialScheme)

/** Mounts the single `data-theme` mirror inside the provider that owns the scheme. */
function ThemedApp() {
  useThemeSchemeAttribute()

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/session" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

/*
 * Routing exists because PLAN.md §8 assigns the session role from URL params:
 * `/session?code=XXXXXXXX` is a guest, `/session` with no code is a host. The QR
 * code encodes that full URL, so any camera app can open a session directly.
 *
 * StrictMode is deliberate. It double-invokes effects in development, which is
 * exactly what surfaces the duplicate-connection bug: a second join is rejected
 * by the worker's Durable Object, which accepts one host and one guest only.
 * useSession defers its connect by a tick so the throwaway mount cannot open a
 * socket. Removing StrictMode would hide that class of bug rather than fix it.
 */
createRoot(container).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      colorSchemeManager={themeColorSchemeManager}
      defaultColorScheme="auto"
      cssVariablesResolver={qrbitCssVariablesResolver}
    >
      <ThemedApp />
    </MantineProvider>
  </StrictMode>,
)

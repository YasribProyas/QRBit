import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import { Home } from './pages/Home'
import { Session } from './pages/Session'
import { Settings } from './pages/Settings'
import { theme } from './theme'
import './styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('QRDrop cannot start: the #root element is missing from index.html')
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
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/session" element={<Session />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>,
)

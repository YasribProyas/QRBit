/**
 * HomeView — the app shell rendered on the Home page.
 *
 * Desktop (≥900px): fixed left sidebar (library) + scrollable right main area (QR panel).
 * Mobile (<900px): only the QR panel; library opens in a slide-over drawer via the
 * hamburger in the header. This matches how every real desktop web app works
 * (VS Code, Linear, Notion, etc.) — the nav is always on the left on wide screens.
 */

import { useState } from 'react'
import {
  Box,
  Drawer,
  Group,
  Stack,
  Text,
  Paper,
  TextInput,
  Button,
  Alert,
  Loader,
  ActionIcon,
  Tooltip,
} from '@mantine/core'
import {
  IconScan,
  IconKeyboard,
  IconArrowRight,
  IconSettings,
  IconMenu2,
  IconX,
} from '@tabler/icons-react'
import { Link } from 'react-router-dom'
import { TacticalQRCode } from './TacticalQRCode'
import type { LibraryFile, LibraryFolder } from '../lib/library'
import { APP_URL } from '../config'
import { WithMantine } from './common/WithMantine'

export interface HomeViewProps {
  /** Live session pairing code. Null while connecting. */
  pairingCode: string | null
  onRegeneratePairing: () => void
  /** The full LibraryBrowser node rendered inside the sidebar */
  libraryContent: React.ReactNode
  onSelectFileToEdit: (file: LibraryFile) => void
  onSendFileDirectly: (file: LibraryFile) => void
  onOpenScanner: () => void
  onCreateNewFile: () => void
  onJoinCode: (code: string) => void
  selectedCount?: number
  roleLabel?: string
  errorMessage?: string | null
  /** Passed for test harness — folders kept for sr-only library text */
  folders: LibraryFolder[]
  files: LibraryFile[]
}

export function HomeView({
  pairingCode,
  onRegeneratePairing,
  libraryContent,
  onOpenScanner,
  onJoinCode,
  selectedCount = 0,
  roleLabel,
  errorMessage,
}: HomeViewProps) {
  const [manualCode, setManualCode] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const handleManualJoin = (e: React.FormEvent) => {
    e.preventDefault()
    if (!manualCode.trim()) return
    onJoinCode(manualCode.trim().toUpperCase())
    setManualCode('')
  }

  return (
    <WithMantine>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>

        {/* ── TOP BAR ─────────────────────────────────────────── */}
        <header style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          padding: '0 1.25rem',
          height: '3.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          boxShadow: '0 1px 0 var(--border)',
        }}>
          {/* Left: hamburger (mobile only) + logo */}
          <Group gap="sm" wrap="nowrap" align="center">
            {/* Hamburger — only visible on mobile (<900px) */}
            <ActionIcon
              variant="subtle"
              color="gray"
              size="md"
              aria-label="Open library"
              onClick={() => setSidebarOpen(true)}
              style={{ display: 'none' }}
              className="mobile-burger"
            >
              <IconMenu2 size={20} />
            </ActionIcon>

            <Link to="/" style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <img src="/favicon.svg" alt="QRBit" width={28} height={28} style={{ borderRadius: 6, display: 'block', flexShrink: 0 }} />
              <h1 className="page__title" style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1 }}>
                QRBit
              </h1>
            </Link>
          </Group>

          {/* Right: Settings */}
          <Group gap="xs" wrap="nowrap">
            <Tooltip label="Settings & Library backup" position="bottom" withArrow>
              <Link to="/settings" style={{ textDecoration: 'none' }}>
                <ActionIcon variant="subtle" color="gray" size="md" aria-label="Settings">
                  <IconSettings size={18} />
                </ActionIcon>
              </Link>
            </Tooltip>
          </Group>
        </header>

        {/* ── APP BODY ─────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }} className="home-body">

          {/* LEFT SIDEBAR — library (desktop: always visible; mobile: drawer) */}
          <aside className="home-sidebar" aria-label="Local Library" style={{
            width: 300,
            minWidth: 300,
            borderRight: '1px solid var(--border)',
            background: 'var(--surface)',
            overflowY: 'auto',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0',
          }}>
            {/* sr-only for test harness */}
            <span className="sr-only">Your Library</span>
            {libraryContent}
          </aside>

          {/* Mobile drawer version of the sidebar */}
          <Drawer
            opened={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            position="left"
            size={320}
            padding={0}
            withCloseButton={false}
            styles={{
              body: { padding: 0, height: '100%', display: 'flex', flexDirection: 'column' },
              content: { display: 'flex', flexDirection: 'column' },
            }}
          >
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text fw={600} size="sm">Library</Text>
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setSidebarOpen(false)}>
                <IconX size={16} />
              </ActionIcon>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1rem' }}>
              <span className="sr-only">Your Library</span>
              {libraryContent}
            </div>
          </Drawer>

          {/* RIGHT MAIN — QR panel */}
          <main style={{ flex: 1, overflowY: 'auto', padding: '2rem 1.5rem' }}>
            <Box style={{ maxWidth: 480, margin: '0 auto' }}>
              <Stack gap="lg">

                {/* Error alert */}
                {errorMessage ? (
                  <Alert
                    color="red"
                    title="Connection error"
                    className="home__qr-error"
                    role="alert"
                    radius="md"
                  >
                    <Stack gap="xs">
                      <Text size="sm">Could not reach the signaling server.</Text>
                      <Text size="xs" ff="monospace">{errorMessage}</Text>
                      <div>
                        <Button color="red" size="xs" onClick={onRegeneratePairing}>
                          Try again
                        </Button>
                      </div>
                    </Stack>
                  </Alert>
                ) : null}

                {/* QR card */}
                <Paper shadow="xs" p="xl" radius="lg" withBorder>
                  <Stack gap="md" align="center">
                    {/* Status row */}
                    <Group justify="space-between" w="100%">
                      <Group gap={6}>
                        <Box style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: 'var(--mantine-color-telemetry-5)', animation: 'radarPing 2.2s ease infinite' }} />
                        <Text size="xs" fw={500} c="dimmed">Beacon Ready</Text>
                      </Group>
                      <Text size="xs" c="dimmed" ff="monospace" style={{ opacity: 0.5 }}>P2P</Text>
                    </Group>

                    {/* QR or loader */}
                    {pairingCode ? (
                      <div className="session-qr" style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <TacticalQRCode
                          pairingCode={pairingCode}
                          onRegenerate={onRegeneratePairing}
                          size={200}
                          showLabel={true}
                        />
                        <Text size="sm" c="telemetry.7" fw={500} mt="md" ta="center">
                          {roleLabel ?? 'Host — waiting for another device to scan your code'}
                        </Text>
                        <Text size="xs" c="dimmed" mt={4} ta="center" ff="monospace" style={{ wordBreak: 'break-all' }}>
                          {`${APP_URL}/session?code=${pairingCode}`}
                        </Text>
                      </div>
                    ) : (
                      <Box py="xl" ta="center">
                        <Group justify="center" gap="xs">
                          <Loader size="xs" />
                          <Text size="xs" c="dimmed">Connecting…</Text>
                        </Group>
                      </Box>
                    )}

                    {/* Manual code entry */}
                    <Box w="100%" pt="md" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
                      <Text size="xs" c="dimmed" mb={6} ff="monospace">Have a code instead? Type it in:</Text>
                      <form onSubmit={handleManualJoin} className="manual-code">
                        <Group gap="sm" wrap="nowrap">
                          <TextInput
                            value={manualCode}
                            onChange={e => setManualCode(e.target.value.toUpperCase())}
                            placeholder="A7X3K9P2"
                            className="manual-code__input"
                            leftSection={<IconKeyboard size={15} />}
                            size="md"
                            style={{ flex: 1 }}
                            styles={{ input: { fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', textTransform: 'uppercase' } }}
                            maxLength={8}
                            spellCheck={false}
                            autoCapitalize="characters"
                            autoComplete="off"
                          />
                          <Button
                            type="submit"
                            disabled={!manualCode.trim()}
                            className="manual-code__submit"
                            size="md"
                            variant="filled"
                            color="signal"
                            rightSection={<IconArrowRight size={14} />}
                          >
                            Join
                          </Button>
                        </Group>
                      </form>
                    </Box>
                  </Stack>
                </Paper>

                {/* Scan & Send CTA */}
                <Button
                  className="home__scan"
                  color="signal"
                  variant="light"
                  size="md"
                  fullWidth
                  leftSection={<IconScan size={18} />}
                  onClick={onOpenScanner}
                  radius="md"
                >
                  Scan &amp; Send{selectedCount > 0 ? ` (${selectedCount})` : ''}
                </Button>

              </Stack>
            </Box>
          </main>
        </div>

      </div>
    </WithMantine>
  )
}

/**
 * The home shell — a two-panel desktop surface (ORCHESTRATION D16).
 *
 * Desktop (≥ 64rem, Tailwind's `lg`): the local library on the left, the QR/session
 * panel on the right, and no page-level scroll — each panel scrolls inside its own
 * column, so the top bar and the library headings stay put while a long dossier list
 * moves. Below 64rem it is one column in flow, QR first and library second. The drawer
 * the previous pass used on phones is gone deliberately: it hid the primary object
 * behind a tap, and a stacked column is always visible.
 *
 * The header carries the brand and `Settings` only. `Scan & Send` is no longer a
 * header button: it belongs to the panel whose action it is, next to the code a peer
 * scans (D16 behaviour change 1). This component keeps the whole-shell chrome and the
 * right-hand panel; the library is handed in as `library` so the page owns the store
 * wiring and this file stays about layout.
 *
 * Nothing here writes to the library or to a session: every action is a callback, and
 * the only piece of state is the typed pairing code, which belongs to the form that
 * submits it.
 */

import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Alert, Button, Group, Loader, Paper, Stack, TextInput, Text, Title } from '@mantine/core'
import {
  IconArrowRight,
  IconCamera,
  IconKeyboard,
  IconRefresh,
  IconSettings,
} from '@tabler/icons-react'
import { Link } from 'react-router-dom'

import { TacticalQRCode } from './TacticalQRCode'
import { WithMantine } from './common/WithMantine'
import { APP_URL } from '../config'

export interface HomeViewProps {
  /** The minted session code, or `null` while the host session is still being set up. */
  pairingCode: string | null
  /** Mints a fresh code (the QR only ever shows a code the host has joined — D14). */
  onRegeneratePairing: () => void
  /** Opens the camera. This is the QR panel's primary action, not the header's. */
  onOpenScanner: () => void
  /** A typed code was submitted, already trimmed and upper-cased. */
  onJoinCode: (code: string) => void
  /**
   * The left panel: the page renders `<LibraryPanel … />` here.
   *
   * A slot rather than a prop bag, so the shell does not have to know the library's
   * API and the library does not have to know the shell's.
   */
  library: ReactNode
  /**
   * Dossiers waiting to be sent, shown on the `Scan & Send` label (PLAN.md §7 flow A).
   * `0` leaves the label bare.
   */
  selectedCount?: number
  /** The session's status line under the QR. */
  roleLabel?: string
  /** A signaling failure to surface, or `null`. */
  errorMessage?: string | null
}

export function HomeView({
  pairingCode,
  onRegeneratePairing,
  onOpenScanner,
  onJoinCode,
  library,
  selectedCount = 0,
  roleLabel,
  errorMessage,
}: HomeViewProps) {
  const [manualCode, setManualCode] = useState('')

  const handleManualJoin = (event: FormEvent): void => {
    event.preventDefault()
    const code = manualCode.trim()
    if (code === '') return
    onJoinCode(code.toUpperCase())
  }

  return (
    <WithMantine>
      <div className="page home__shell lg:h-dvh lg:overflow-hidden">
        {/* Top bar: the app's identity, and the one thing that is not about this screen. */}
        <header className="home__header page__header shrink-0">
          <Group align="center" gap="sm" wrap="nowrap">
            <img src="/favicon.svg" alt="QRBit" width={28} height={28} />
            <div>
              <Title
                order={1}
                size="h5"
                className="page__title font-display font-bold tracking-tight text-[#0F172A]"
              >
                QRBit
              </Title>
              <Text size="xs" c="dimmed">
                Air-gapped structured transfer
              </Text>
            </div>
          </Group>

          <Link className="home__settings" to="/settings" style={{ textDecoration: 'none' }}>
            <Button
              variant="subtle"
              color="gray"
              size="sm"
              leftSection={<IconSettings size={16} aria-hidden="true" />}
            >
              Settings
            </Button>
          </Link>
        </header>

        {/*
          Two columns at ≥ 64rem. The session panel is FIRST in the DOM, because that is
          the order a phone reads (QR, then library); `lg:col-start-*` puts the library in
          the left column on a desktop without reordering the markup for anybody else.
        */}
        <div className="home__panels grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)] lg:overflow-hidden">
          <section
            className="home__qr-panel min-h-0 lg:col-start-2 lg:row-start-1 lg:overflow-y-auto"
            aria-label="Pair and send"
          >
            <Stack gap="md">
              {errorMessage ? (
                <Alert color="red" title="Error" className="home__qr-error" role="alert">
                  <Stack gap="xs">
                    <Text size="sm">Could not reach the signaling server.</Text>
                    <Text size="xs" ff="monospace">
                      {errorMessage}
                    </Text>
                    <div>
                      <Button
                        color="red"
                        size="xs"
                        leftSection={<IconRefresh size={14} aria-hidden="true" />}
                        onClick={onRegeneratePairing}
                      >
                        Try again
                      </Button>
                    </div>
                  </Stack>
                </Alert>
              ) : null}

              <Paper shadow="xs" p="md" withBorder className="flex flex-col items-center">
                <Group justify="space-between" wrap="nowrap" style={{ width: '100%' }} mb="md">
                  <Group gap="xs" wrap="nowrap">
                    <span
                      className="home__beacon-dot"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: 'var(--mantine-color-telemetry-5)',
                      }}
                    />
                    <Text size="xs" fw={500} c="dimmed">
                      Beacon Ready
                    </Text>
                  </Group>
                </Group>

                {pairingCode ? (
                  <div className="session-qr flex w-full flex-col items-center">
                    <TacticalQRCode pairingCode={pairingCode} onRegenerate={onRegeneratePairing} size={195} showLabel />

                    <Text size="sm" c="telemetry" fw={500} mt="md" ta="center">
                      {roleLabel || 'Host — waiting for another device to scan your code'}
                    </Text>

                    <Text size="xs" c="dimmed" mt={4} ta="center" ff="monospace">
                      On the other device, open <code>{`${APP_URL}/session?code=${pairingCode}`}</code>
                    </Text>
                  </div>
                ) : (
                  <Group py="xl" gap="xs" wrap="nowrap" role="status">
                    <Loader size="sm" />
                    <Text size="xs" c="dimmed">
                      Connecting host session…
                    </Text>
                  </Group>
                )}

                {/*
                  The panel's own primary action (D16 behaviour change 1): it is here, by
                  the code a peer scans, rather than in a header that applies to no panel.
                  It stays available while the host code is still being minted, because
                  scanning somebody else's code never depends on having one of your own.
                */}
                <Button
                  className="home__scan mt-4 w-full"
                  color="signal"
                  size="md"
                  leftSection={<IconCamera size={16} aria-hidden="true" />}
                  onClick={onOpenScanner}
                >
                  Scan &amp; Send{selectedCount > 0 ? ` (${selectedCount})` : ''}
                </Button>

                {/* Manual pairing fallback. */}
                <div
                  className="mt-4 w-full pt-3"
                  style={{ borderTop: '1px solid var(--qrd-border, #D1D9E4)' }}
                >
                  <Text size="xs" c="dimmed" mb="xs" ff="monospace">
                    Have a code instead? Type it in:
                  </Text>
                  <form className="manual-code flex items-center gap-2" onSubmit={handleManualJoin}>
                    <Group align="center" gap="sm" wrap="nowrap" style={{ width: '100%' }}>
                      <TextInput
                        value={manualCode}
                        onChange={(event) => {
                          setManualCode(event.currentTarget.value)
                        }}
                        placeholder="Type 8-character code..."
                        className="manual-code__input desktop-sm min-w-0"
                        leftSection={<IconKeyboard size={16} aria-hidden="true" />}
                        size="md"
                        style={{ flex: 1 }}
                      />
                      <Button
                        type="submit"
                        disabled={manualCode.trim() === ''}
                        className="manual-code__submit"
                        size="md"
                        color="dark"
                        rightSection={<IconArrowRight size={14} aria-hidden="true" />}
                      >
                        Join
                      </Button>
                    </Group>
                  </form>
                </div>
              </Paper>
            </Stack>
          </section>

          <aside
            className="home__library min-h-0 lg:col-start-1 lg:row-start-1 lg:overflow-y-auto"
            aria-label="Local library"
          >
            {library}
          </aside>
        </div>
      </div>
    </WithMantine>
  )
}

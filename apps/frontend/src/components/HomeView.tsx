/**
 * The home shell — a two-panel desktop surface and the product's signature pairing panel
 * (ORCHESTRATION D16; DESIGN.md, "Signature: the pairing panel").
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
 * ## The pairing panel, and what it is allowed to say
 *
 * It is the one surface that shows the product's mechanics, so it is the one surface that
 * earns geometry: reticle corners on the panel, a status dot with the line that states what
 * the host is doing, the code on a light well, `Scan & Send` beneath it, and the typed
 * fallback under a hairline. Everything else is flat.
 *
 * Nothing here claims a state the session has not reached. The dot and the status line live
 * inside the branch that has a code, because a code only exists once this device has joined
 * as host (D15) — the previous revision painted a "Beacon Ready" dot above the panel while
 * the host was still connecting, which is the fabricated-telemetry failure this file must
 * not repeat. Before the join lands, the panel shows the loading state and says so.
 *
 * The typed fallback is `ManualCodeEntry`, mounted here rather than re-implemented here:
 * there was a second inline copy of the same form in this file, which validated nothing and
 * left the tested component unreachable.
 *
 * Nothing here writes to the library or to a session: every action is a callback, and this
 * component holds no state at all.
 */

import type { CSSProperties, ReactNode } from 'react'
import { Alert, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core'
import { IconCamera, IconRefresh, IconSettings } from '@tabler/icons-react'
import { Link } from 'react-router-dom'

import { TacticalQRCode } from './TacticalQRCode'
import { ManualCodeEntry } from './ManualCodeEntry'
import { WithMantine } from './common/WithMantine'
import { APP_URL } from '../config'

export interface HomeViewProps {
  /** The minted session code, or `null` while the host session is still being set up. */
  pairingCode: string | null
  /** Mints a fresh code (the QR only ever shows a code the host has joined — D13, D15). */
  onRegeneratePairing: () => void
  /** Opens the camera. This is the QR panel's primary action, not the header's. */
  onOpenScanner: () => void
  /** A typed code was submitted, already validated and upper-cased by `ManualCodeEntry`. */
  onJoinCode: (code: string) => void
  /**
   * The left panel: the page renders `<LibraryPanel … />` here.
   *
   * A slot rather than a prop bag, so the shell does not have to know the library's
   * API and the library does not have to know the shell's.
   */
  library: ReactNode
  /** The session's status line under the QR. */
  roleLabel?: string
  /** A signaling failure to surface, or `null`. */
  errorMessage?: string | null
}

/**
 * One corner of the panel's reticle: 12px of 2px signal on the two edges that face the
 * corner. The lengths are DESIGN's `sm`/`md` spacing steps, so the marks sit on the scale;
 * the colour is a token because Tailwind's arbitrary-value syntax is not the only consumer
 * of this file's palette and a `var()` in a utility is the one thing that cannot be checked
 * at build time.
 */
function reticle(corner: 'top' | 'bottom', side: 'left' | 'right'): CSSProperties {
  const edge = { position: 'absolute', pointerEvents: 'none' } as const
  const inset = { [corner]: 'var(--qrbit-space-sm)', [side]: 'var(--qrbit-space-sm)' }
  const width = side === 'left' ? 'borderLeftWidth' : 'borderRightWidth'
  const height = corner === 'top' ? 'borderTopWidth' : 'borderBottomWidth'
  return {
    ...edge,
    ...inset,
    width: 'var(--qrbit-space-md)',
    height: 'var(--qrbit-space-md)',
    borderStyle: 'solid',
    borderColor: 'var(--qrbit-signal)',
    [width]: 2,
    [height]: 2,
  }
}

export function HomeView({
  pairingCode,
  onRegeneratePairing,
  onOpenScanner,
  onJoinCode,
  library,
  roleLabel,
  errorMessage,
}: HomeViewProps) {
  /** The URL a peer opens; printed as text so a code is never *only* a picture. */
  const sessionUrl = pairingCode === null ? null : `${APP_URL}/session?code=${pairingCode}`

  return (
    <WithMantine>
      <div className="page home__shell lg:h-dvh lg:overflow-hidden">
        {/* Top bar: the app's identity, and the one thing that is not about this screen. */}
        <header className="home__header page__header shrink-0">
          <Group align="center" gap="sm" wrap="nowrap">
            <img src="/favicon.svg" alt="QRBit" width={28} height={28} />
            {/*
              The wordmark is the display role and needs no tagline under it. The line this
              header used to carry ("Air-gapped structured transfer") claimed a property the
              product does not have: signaling runs through the worker, so the devices are
              not air-gapped. `AppHeader.tsx` still carries the same sentence — see the
              report for this lane.
            */}
            <Text className="qrbit-text-display" component="h1">
              QRBit
            </Text>
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
                <Alert
                  color="danger"
                  className="home__qr-error"
                  role="alert"
                  title="Could not reach the signaling server"
                >
                  <Stack gap="sm">
                    {/* The runtime's own words, verbatim, as data. */}
                    <Text className="qrbit-text-data" c="danger" w="min(100%, 40ch)">
                      {errorMessage}
                    </Text>
                    <div>
                      <Button
                        size="sm"
                        color="danger"
                        leftSection={<IconRefresh size={16} aria-hidden="true" />}
                        onClick={onRegeneratePairing}
                      >
                        Try again
                      </Button>
                    </div>
                  </Stack>
                </Alert>
              ) : null}

              {/*
                The pairing panel. Flat and bordered, never shadowed at rest (DESIGN.md,
                "The Floating Only Rule"); the reticle corners are the only geometry it owns.
              */}
              <Paper
                withBorder
                p="lg"
                className="home__pairing-panel relative flex flex-col items-center"
              >
                <span aria-hidden="true" style={reticle('top', 'left')} />
                <span aria-hidden="true" style={reticle('top', 'right')} />
                <span aria-hidden="true" style={reticle('bottom', 'left')} />
                <span aria-hidden="true" style={reticle('bottom', 'right')} />

                {pairingCode !== null ? (
                  <div className="session-qr flex w-full flex-col items-center">
                    {/*
                      Status dot + line. Both are statements the session has actually earned:
                      a published code means this device is joined as host and waiting (D15).
                    */}
                    <Group
                      gap="sm"
                      wrap="nowrap"
                      justify="center"
                      mb="md"
                      className="session-qr__status"
                    >
                      <span
                        aria-hidden="true"
                        className="home__status-dot size-2 flex-none rounded-full"
                        style={{ background: 'var(--qrbit-signal)' }}
                      />
                      <Text className="qrbit-text-body">
                        {roleLabel || 'Host — waiting for another device to scan your code'}
                      </Text>
                    </Group>

                    <TacticalQRCode pairingCode={pairingCode} onRegenerate={onRegeneratePairing} size={195} />

                    {sessionUrl !== null ? (
                      <Text className="qrbit-text-data" mt="md" c="dimmed" ta="center" w="min(100%, 44ch)">
                        On the other device, open {sessionUrl}
                      </Text>
                    ) : null}
                  </div>
                ) : (
                  <Group py="xl" gap="xs" wrap="nowrap" role="status" aria-live="polite">
                    <Loader size="sm" />
                    <Text className="qrbit-text-body-secondary" c="dimmed">
                      Connecting host session…
                    </Text>
                  </Group>
                )}

                {/*
                  The panel's own primary action (D16 behaviour change 1): it is here, by
                  the code a peer scans, rather than in a header that applies to no panel.
                  It stays available while the host code is still being minted, because
                  scanning somebody else's code never depends on having one of your own.
                  44px, not the table's 36px: this is the thumb target on a phone held at
                  arm's length, which DESIGN.md's 44px touch rule outranks.
                */}
                <Button
                  className="home__scan w-full"
                  mt="lg"
                  color="signal"
                  size="md"
                  leftSection={<IconCamera size={16} aria-hidden="true" />}
                  onClick={onOpenScanner}
                >
                  Scan &amp; Send
                </Button>

                {/* Manual pairing fallback, under a hairline (DESIGN.md's pairing panel). */}
                <div
                  className="home__manual-fallback"
                  style={{
                    width: '100%',
                    marginTop: 'var(--qrbit-space-lg)',
                    paddingTop: 'var(--qrbit-space-lg)',
                    borderTop: '1px solid var(--qrbit-border)',
                  }}
                >
                  <ManualCodeEntry onSubmit={onJoinCode} />
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

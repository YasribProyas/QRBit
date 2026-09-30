/**
 * The home shell — the two-panel desktop surface and the product's signature pairing panel
 * (ORCHESTRATION D16, D17; DESIGN.md, "Signature: the pairing panel").
 *
 * ## The two layouts, and which one is which
 *
 * At ≥ 64rem (DESIGN.md's `lg`, 1024px) the shell is the desktop pair: library on the left,
 * session/QR on the right, each column scrolling inside itself so the shell never scrolls.
 * Below it the library is **not** stacked under the QR — it opens from a hamburger in the
 * header as a drawer holding the same `LibraryPanel` element. A phone has roughly 600px of
 * vertical room; a whole library below a QR made the primary task (pair) and the secondary one
 * (browse) fight over the same scroll, which is what the owner saw when the stacked column
 * shipped. This is a deliberate, reported override of DESIGN.md's "No drawer" line, and it is
 * bounded to the mobile half: the desktop layout is unchanged and never renders a drawer or a
 * hamburger at all.
 *
 * `isMobileShell` is a rendering decision, not a CSS visibility. One `LibraryPanel` exists at a
 * time — the aside is not mounted on a phone, the `Drawer` is not mounted on a desktop, and the
 * node the page hands in is *moved* between the two. Nothing is mounted and hidden: a hidden
 * second copy is how this product has previously ended up with UI that tests could reach and
 * users could not. The query asks for the mobile width rather than the desktop one so that an
 * environment where `matchMedia` cannot answer at all falls back to the desktop pair, the
 * layout that needs no secondary control.
 *
 * ## The header, the scan control, and where they live
 *
 * Brand left (plus the library toggle on a phone), `Settings` right. `Scan & Send` is neither
 * a header button nor an in-panel one any more: it is the floating action icon at the bottom
 * left of the shell, in a band that is the shell's last flex row.
 *
 * That band is the whole reason the control can be trusted not to cover the object it is for.
 * The button is `position: absolute` inside the band, so the space the band reserves is the
 * space the control occupies — there is no third thing (the viewport) for the two to disagree
 * about. It used to be `position: fixed`, which is resolved against the viewport unless an
 * ancestor establishes a containing block, and the shell does neither job reliably: the shell is
 * `max-width: 84rem` and centred, so at 1600px the fixed control was left of the band it belongs
 * to, in the page gutter, and a `fixed` box can be pulled anywhere by an ancestor's
 * `transform`. Neither was observable in a test, because the control's position is a computed
 * geometry and jsdom has no layout. The band is `flex: none`, so the panels row ends above it
 * and no scroll offset on any screen can bring the QR, its reticle corners or the manual-code
 * field underneath a control that is pinned inside reserved space. The band's height and the
 * button's `bottom` offset both carry `env(safe-area-inset-bottom)`, so on a phone with a home
 * indicator the button lifts out of that strip and stays inside the space reserved for it.
 *
 * The selection count that used to ride on the scan button is gone with it. Nothing on this
 * screen can put anything in a selection — D16.4 deleted the last multi-select — so a count
 * here would only ever have read zero, which is a number the user did not provide.
 *
 * ## The pairing panel, and what it is allowed to say
 *
 * It is the one surface that shows the product's mechanics, so it is the one surface that earns
 * geometry: reticle corners on the panel, a status dot with the line that states what the host
 * is doing, the code on a light plate, the code again as text a person can read aloud, and the
 * typed fallback under a hairline. Everything else is flat.
 *
 * The panel is DESIGN.md's Panel row in all three of its parts — `--qrbit-raised` fill, a
 * 1px `--qrbit-border`, `--qrbit-radius-lg` — and it now states all three itself. It used to
 * inherit Mantine's `Paper` background (`--mantine-color-body`, bridged to `--qrbit-canvas`) so
 * the fill went inline; then `withBorder` was left to Mantine, whose border is a *scheme-scoped*
 * rule keyed on `data-mantine-color-scheme`. That attribute is not this app's switch (`theme.ts`
 * mirrors the scheme on `data-theme` and writes the variables through the CSSOM), so the panel
 * had no edge: in the dark scheme the only thing separating a #171F2C card from a #0E1420 page
 * is that hairline, and losing it is why the card read as having no surface at all. The plate
 * under the code stays `--qrbit-signal-subtle`, the one documented surface that does not flip
 * under `[data-theme='dark']`: a scanner measures luminance, so that plate is a requirement, not
 * a preference (`TacticalQRCode`). `--qrbit-sunken` is spent on real insets, and the link row is
 * one.
 *
 * Nothing here claims a state the session has not reached. The dot and the status line live
 * inside the branch that has a code, because a code only exists once this device has joined as
 * host (D15) — a previous revision painted a "Beacon Ready" dot while the host was still
 * connecting, which is the fabricated-telemetry failure this file must not repeat. Before the
 * join lands the panel shows the loading state and says so.
 *
 * The panel's *title* is not a state. "Pair another device" describes the affordance, so it is
 * true while connecting, true once a code exists, and true when the signaling server cannot be
 * reached — which is why it sits above the branch rather than inside it, and why the two halves
 * of the shell now open with the same pair of roles (headline, then Body Secondary subline)
 * instead of one having a title and the other a status message.
 *
 * The typed fallback is `ManualCodeEntry`, mounted here rather than re-implemented here; the
 * link a peer opens, with the control that copies it, is `TacticalQRCode`'s link row — the one
 * place that knows the full URL, so there is one clipboard implementation rather than two.
 *
 * Nothing here writes to the library or to a session: every action is a callback. The only
 * state in this file is which half of the shell the library is currently in.
 */

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Burger,
  Button,
  Drawer,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconQrcode, IconRefresh, IconSettings } from '@tabler/icons-react'
import { Link } from 'react-router-dom'

import { TacticalQRCode } from './TacticalQRCode'
import { ManualCodeEntry } from './ManualCodeEntry'
import { ThemeToggle } from './common/ThemeToggle'
import { WithMantine } from './common/WithMantine'

export interface HomeViewProps {
  /** The minted session code, or `null` while the host session is still being set up. */
  pairingCode: string | null
  /** Mints a fresh code (the QR only ever shows a code the host has joined — D13, D15). */
  onRegeneratePairing: () => void
  /** Opens the camera. The floating scan control's whole job. */
  onOpenScanner: () => void
  /** A typed code was submitted, already validated and upper-cased by `ManualCodeEntry`. */
  onJoinCode: (code: string) => void
  /**
   * The local library: the page renders `<LibraryPanel … />` here.
   *
   * A slot rather than a prop bag, so the shell does not have to know the library's API and
   * the library does not have to know the shell's. This component places it — the desktop's
   * left column, or the phone's drawer — and never renders it twice.
   */
  library: ReactNode
  /** The session's status line under the QR. */
  roleLabel?: string
  /** A signaling failure to surface, or `null`. */
  errorMessage?: string | null
}

/**
 * Below DESIGN.md's desktop breakpoint. `63.9375rem` is 1023px — the last width that is
 * definitely not the two-column shell — so this and Tailwind's `lg:` utilities cannot disagree
 * about which layout a viewport gets.
 */
const MOBILE_SHELL_QUERY = '(max-width: 63.9375rem)'

/**
 * 44px on a phone, the table's 36px above it — the same treatment `AppHeader` and
 * `pages/Settings.tsx` give the header's controls, and for the same reason: Mantine has no
 * 44px step and no per-breakpoint `size`, and the `!` is what lets a layered utility beat
 * Mantine's unlayered rule. The header is where a thumb lands first on a phone.
 */
const THUMB_TARGET = 'max-md:min-h-11!'

/**
 * The resting size of the code: inside DESIGN.md's 195–240px band, and the size that makes the
 * reticle corners frame the symbol instead of the air around it. The frame keeps
 * `maxWidth: 100%`, so a phone narrower than the band shrinks the code rather than the layout.
 *
 * It was 240 — the top of the band — and restoring the code line (item 7) is what decides the
 * number now. Measured in a browser at 1440×900, where the session column's scrollport is 645px:
 * the block needs 605px with the plate at 240 and 585px at 220, so 240 leaves 20px of slack above
 * and below the centred panel and 220 leaves 30. Both overflow a 1280×800 window, which is what
 * the column's own scroll is for; the point of the 20px is that the typed fallback and the bottom
 * reticles stop being the first thing a shorter window cuts off. 220 stays inside DESIGN's band.
 */
const QR_SIZE = 220


/**
 * The band the floating scan control is pinned inside.
 *
 * `huge + lg` is 64px: the 44px control and the 20px that keeps it off the panels row. The
 * safe-area term is added here as well as to the control's own offset, so a notched phone lifts
 * the control out of the home-indicator strip *and* grows the space that is set aside for it —
 * the two cannot drift apart, which is the whole overlap argument.
 */
const FAB_BAND_STYLE = {
  flex: 'none',
  position: 'relative',
  height: 'calc(var(--qrbit-space-huge) + var(--qrbit-space-lg) + env(safe-area-inset-bottom, 0px))',
} as const satisfies CSSProperties

/**
 * The control, pinned inside its band's box — not to the viewport.
 *
 * It used to be `position: fixed`, which made its position somebody else's problem: a fixed box is
 * resolved against the nearest ancestor that establishes a containing block (any `transform`,
 * `filter`, `backdrop-filter`, `perspective`, `will-change` or `contain`) and against the
 * *viewport* otherwise — and the viewport is not the band. Measured in a browser at 1440×900 the
 * shell (`max-width: 84rem`, centred) put its band at x=64..1376 while the fixed control stayed at
 * x=16..60, and at 1600×1000 the band started at x=139 with the control still at x=16: 123px of the
 * shell's own left gutter, outside the reserved space, on the empty page. It is in the DOM and it
 * is painted (the same measurements hit-test a signal-blue 44px box there, and its ancestor chain
 * establishes no containing block, so the transform hypothesis is ruled out by measurement, not by
 * reading) — it is just not where the layout promises it, and at those widths it is off in a margin
 * rather than under the library column it belongs to.
 *
 * `absolute` inside the band takes the dependency away entirely: the band is the shell's last
 * flex row, the shell is `h-dvh overflow-hidden` and never scrolls (each column scrolls inside
 * itself), so a control pinned to the band is on screen exactly as reliably as one pinned to the
 * viewport — and it can never be laid out outside the room reserved for it. The band's bottom edge
 * is the shell's content edge, 16px above the viewport, so the control's own `xxs` inset keeps the
 * 16px-plus-2px it had as a fixed box, and the safe-area term lifts it inside the extra height the
 * band already claimed for a home indicator.
 */
const FAB_STYLE = {
  position: 'absolute',
  left: 'var(--qrbit-space-lg)',
  bottom: 'calc(var(--qrbit-space-xxs) + env(safe-area-inset-bottom, 0px))',
  zIndex: 'var(--mantine-z-index-app)',
  // DESIGN.md's sheet shadow: this control is genuinely above the page, which is the only
  // reason a resting surface gets one.
  boxShadow: 'var(--qrbit-shadow-sheet)',
} as const satisfies CSSProperties

/**
 * DESIGN.md's Panel row: Raised fill, 1px Border, radius lg, no shadow at rest.
 *
 * The fill was already inline; the border was not, and a dark scheme whose only surface step is
 * #171F2C on #0E1420 — a 1.05:1 luminance difference — cannot afford to lose its hairline. The
 * component used to ask for that hairline with `withBorder`, which is a *scheme-scoped* rule in
 * Mantine's static sheet (`[data-mantine-color-scheme='dark'] .mantine-Paper-root` sets
 * `--paper-border-color`). This app mirrors the scheme onto `data-theme` and delivers the
 * variable map through the CSSOM (`theme.ts`), so an attribute Mantine sets during mount is the
 * wrong thing to hang a panel's edge on: measured in a browser with that attribute absent, the
 * panel's computed border is `0px none` and the card is a fill floating on the page. Stating the
 * three values here costs nothing and makes the panel's surface the component's own guarantee.
 */
const PANEL_STYLE = {
  background: 'var(--qrbit-raised)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-lg)',
  width: '100%',
} as const satisfies CSSProperties

export function HomeView({
  pairingCode,
  onRegeneratePairing,
  onOpenScanner,
  onJoinCode,
  library,
  roleLabel,
  errorMessage,
}: HomeViewProps) {
  const isMobileShell = useMediaQuery(MOBILE_SHELL_QUERY, undefined, {
    getInitialValueInEffect: false,
  })
  const [libraryOpen, setLibraryOpen] = useState(false)

  return (
    <WithMantine>
      {/*
        `h-dvh overflow-hidden` at every width, not only on a desktop: the shell is a fixed
        column of header, panels and scan band, and each panel scrolls inside itself. A phone
        needs the same rule, because the band's guarantee is only as good as the fact that
        nothing can scroll underneath the control pinned in it.
      */}
      <div
        className="page home__shell h-dvh overflow-hidden"
        style={{ paddingBottom: 'var(--qrbit-space-lg)' }}
      >
        {/* Top bar: the identity, the library toggle, and the one thing not about this screen. */}
        <header className="home__header page__header shrink-0">
          <Group align="center" gap="sm" wrap="nowrap">
            {/*
              Only on a phone, and only ever this one button. At desktop widths the library is
              already on screen, so a toggle would open a drawer over a panel the user can see —
              which is the thing DESIGN.md's "No drawer" line was protecting, and the reason the
              line is only overridden below the breakpoint.
            */}
            {isMobileShell ? (
              <Burger
                className="home__library-toggle"
                opened={libraryOpen}
                size={44}
                lineSize={2}
                aria-haspopup="dialog"
                aria-expanded={libraryOpen}
                aria-label={libraryOpen ? 'Close the local library' : 'Open the local library'}
                onClick={() => {
                  setLibraryOpen((open) => !open)
                }}
              />
            ) : null}

            <img src="/favicon.svg" alt="QRBit" width={28} height={28} />
            {/*
              The wordmark is the display role and needs no tagline under it. The line this
              header used to carry ("Air-gapped structured transfer") claimed a property the
              product does not have — pairing runs through the signaling worker, so the two
              devices are not air-gapped — and `AppHeader.tsx` dropped the same sentence for the
              same reason, so the two headers now agree on what the product promises.
            */}
            <Text className="qrbit-text-display" component="h1">
              QRBit
            </Text>
            <Badge
              variant="outline"
              color="signal"
              size="sm"
              radius="sm"
              className="hidden sm:inline-flex"
              style={{
                letterSpacing: '0.08em',
                fontFamily: 'var(--qrbit-font-mono)',
                textTransform: 'uppercase',
                borderWidth: '1px',
              }}
            >
              P2P Air-Drop
            </Badge>
          </Group>

          <Group gap="xs" wrap="nowrap" align="center">
            <ThemeToggle />
            <Link className="home__settings" to="/settings" style={{ textDecoration: 'none' }}>
              <Button
                className={THUMB_TARGET}
                variant="subtle"
                color="gray"
                size="sm"
                leftSection={<IconSettings size={16} stroke={1.6} aria-hidden="true" />}
              >
                Settings
              </Button>
            </Link>
          </Group>
        </header>

        {/*
          Two columns at ≥ 64rem. The session panel is FIRST in the DOM, because that is the
          order a phone reads (the QR, and nothing else — the library is a tap away in the
          header); `lg:col-start-*` puts the library in the left column on a desktop without
          reordering the markup for anybody else.
        */}
        <div className="home__panels grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)] lg:overflow-hidden">
          <section
            className="home__qr-panel flex min-h-0 flex-col overflow-y-auto lg:col-start-2 lg:row-start-1"
            aria-label="Pair and send"
          >
            <Stack gap="md" w="100%" className="flex-1 min-h-0">
              <div className="home__pairing-heading">
                <Title order={2} className="qrbit-text-headline">
                  Pair another device
                </Title>
                <Text className="qrbit-text-body-secondary" mt="xs">
                  Another device joins by scanning the code or typing it in
                </Text>
              </div>

              {errorMessage ? (
                <Alert
                  color="danger"
                  className="home__qr-error"
                  role="alert"
                  title="Could not reach the signaling server"
                >
                  <Stack gap="sm">
                    <Text className="qrbit-text-data" c="danger" w="min(100%, 40ch)">
                      {errorMessage}
                    </Text>
                    <div>
                      <Button
                        size="sm"
                        color="danger"
                        leftSection={<IconRefresh size={16} stroke={1.6} aria-hidden="true" />}
                        onClick={onRegeneratePairing}
                      >
                        Try again
                      </Button>
                    </div>
                  </Stack>
                </Alert>
              ) : null}

              <Paper
                p="lg"
                className="home__pairing-panel relative flex flex-col flex-1 items-center justify-between"
                style={{ ...PANEL_STYLE, minHeight: 0 }}
              >
                {pairingCode !== null ? (
                  <div className="session-qr flex w-full flex-col items-center">
                    <Group
                      align="flex-start"
                      gap="sm"
                      wrap="nowrap"
                      justify="center"
                      mb="md"
                      className="session-qr__status"
                    >
                      <span
                        aria-hidden="true"
                        className="home__status-dot animate-beacon-ping size-2 flex-none rounded-full"
                        style={{
                          background: 'var(--qrbit-signal)',
                          flexShrink: 0,
                          marginTop: 'calc((1.5em - var(--qrbit-space-sm)) / 2)',
                        }}
                      />
                      <Text
                        className="qrbit-text-body session-qr__status-text"
                        style={{ minWidth: 0 }}
                      >
                        {roleLabel || 'Host — waiting for another device to scan your code'}
                      </Text>
                    </Group>

                    <TacticalQRCode
                      pairingCode={pairingCode}
                      onRegenerate={onRegeneratePairing}
                      size={QR_SIZE}
                    />
                  </div>
                ) : (
                  <Group py="xl" gap="xs" wrap="nowrap" role="status" aria-live="polite">
                    <Loader size="sm" />
                    <Text className="qrbit-text-body-secondary" c="dimmed">
                      Connecting host session…
                    </Text>
                  </Group>
                )}

                <div className="variant-pixel-divider" />

                <div className="home__manual-fallback variant-sunken-dock w-full mt-auto">
                  <ManualCodeEntry onSubmit={onJoinCode} />
                </div>
              </Paper>
            </Stack>
          </section>

          {isMobileShell ? null : (
            <aside
              className="home__library library-variant-bezel min-h-0 lg:col-start-1 lg:row-start-1 lg:overflow-y-auto"
              aria-label="Local library"
            >
              {library}
            </aside>
          )}
        </div>

        {/*
          The band, and the control pinned inside it at the viewport's bottom-left.
          `home__scan` is the same class the pairing tests reach for; the label changed because
          the control is icon-only now, and an icon-only control without a name is a mystery
          meatball. The glyph is `IconQrcode` — the thing the camera is being asked to read.
        */}
        <div className="home__fab-band" style={FAB_BAND_STYLE}>
          <ActionIcon
            className="home__scan home__fab tactile-btn"
            color="signal"
            variant="filled"
            size="xl"
            aria-label="Scan and send"
            style={FAB_STYLE}
            onClick={onOpenScanner}
          >
            <IconQrcode size={22} stroke={1.6} aria-hidden="true" />
          </ActionIcon>
        </div>

        {/*
          The phone's library, and only the phone's: at desktop widths there is no Drawer in
          the tree at all. `keepMounted={false}` is what makes "the library is not in the
          document until the toggle is pressed" a fact rather than a matter of taste, and focus
          trapping, Escape-to-close and returning focus to the toggle are stated here so they
          are part of the contract instead of an assumption about `ModalBase`'s defaults. The
          panel's own content is untouched — this is the same `library` element the aside would
          have rendered, one instance, moved.
        */}
        {isMobileShell ? (
          <Drawer
            opened={libraryOpen}
            onClose={() => {
              setLibraryOpen(false)
            }}
            className="home__library-drawer"
            title="Local library"
            position="left"
            size="90%"
            padding="md"
            keepMounted={false}
            trapFocus
            closeOnEscape
            returnFocus
          >
            {library}
          </Drawer>
        ) : null}
      </div>
    </WithMantine>
  )
}

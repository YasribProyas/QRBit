/**
 * The app chrome's one header line (DESIGN.md, "Navigation").
 *
 * Wordmark left, what the session is doing and the way out of it right — nothing else. It is
 * one line at every breakpoint, 44px of thumb target on a phone and 36px above it, flat with
 * no shadow because it does not float: DESIGN.md's "The Floating Only Rule" reserves a shadow
 * for something above the page, and this bar scrolls with the page it belongs to.
 *
 * Three things were deliberately not carried over from the previous revision of this file:
 *
 *   - the `Scan` and `Code` buttons. Nothing in the app passes handlers for them any more:
 *     the scanner and the typed-code fallback live in the pairing panel, next to the code
 *     they act on (ORCHESTRATION D16 behaviour change 1). A header button that applies to no
 *     panel is also a button that no screen renders when nothing passes its handler.
 *   - the `P2P v2.4` chip. There is no version 2.4 anywhere in the product; it was 10px mono
 *     decoration — below the 12px floor and contrary to "The Mono Means Data Rule".
 *   - the `Air-gapped structured transfer` line. It claimed a property the app does not have
 *     (pairing runs through the signaling worker, so the two devices are not air-gapped), and
 *     the promise this product actually makes — "No login. No cloud. No trace." — is spelled
 *     out on `/settings` rather than approximated by a 10px subtitle.
 *
 * Every colour here is a token or a semantic slot, so both schemes are the same markup: the
 * status dot takes the hue that matches the tone it reports, and the chip behind it is the
 * Sunken surface, which steps with the scheme.
 */

import { Badge, Burger, Button, Group, Text, Tooltip } from '@mantine/core'
import { IconLogout, IconSettings } from '@tabler/icons-react'
import type { ReactElement } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { StatusTone, UseSessionResult } from '../../hooks/useSession'
import { ThemeToggle } from '../common/ThemeToggle'

/**
 * The hue a session status is allowed to wear: green means connected, amber means the
 * transport dropped and the user should look, red means it failed. `idle` is neutral ink
 * because "Connecting…" is a wait rather than a warning (see `describeSessionStatus`).
 */
const TONE_DOT: Record<StatusTone, string> = {
  ok: 'var(--qrbit-success)',
  warn: 'var(--qrbit-warning)',
  error: 'var(--qrbit-danger)',
  idle: 'var(--qrbit-ink-muted)',
}

/**
 * 44px on a phone, the table's 36px above it. Same treatment and same reason as
 * `THUMB_TARGET` in `pages/Settings.tsx`: Mantine has no 44px step and no per-breakpoint
 * `size`, and the `!` is what lets a layered utility beat Mantine's unlayered rule.
 */
const THUMB_TARGET = 'max-md:min-h-11!'

export interface AppHeaderProps {
  /** The live session, when this screen has one. Without it the header is brand and Settings. */
  session?: UseSessionResult
  vaultOpened?: boolean
  onToggleVault?: () => void
  mobileOnlyBurger?: boolean
}

export function AppHeader({
  session,
  vaultOpened = false,
  onToggleVault,
  mobileOnlyBurger = true,
}: AppHeaderProps) {
  const navigate = useNavigate()
  const tone: StatusTone = session?.status.tone ?? 'idle'
  /**
   * Exit shows while a session is being built or carried, because that is the window in
   * which leaving costs something. `ended` and `failed` have nothing left to leave.
   */
  const hasSessionToLeave =
    session !== undefined &&
    (session.phase === 'connecting' || session.phase === 'pairing' || session.phase === 'active')

  return (

    <header className="app-header header-variant-acrylic-bezel shrink-0" style={{ width: '100%' }}>
      <Group justify="space-between" gap="md" wrap="nowrap" align="center">
        {/* Left: the way home, and the library drawer when this screen has one. */}
        <Group gap="sm" wrap="nowrap" align="center">
          {onToggleVault ? (
            <Burger
              opened={vaultOpened}
              onClick={onToggleVault}
              hiddenFrom={mobileOnlyBurger ? 'md' : undefined}
              size="sm"
              aria-label="Open the local library"
            />
          ) : null}

          {/*
            The wordmark carries the display role and is the whole link. It is not a heading:
            on `/settings` the page's own `<h1>` is "Settings", and the brand must not become
            a second h1 in the same document.
          */}
          <Link
            to="/"
            className="app-header__brand"
            style={{ textDecoration: 'none', color: 'inherit' }}
            aria-label="QRward — home"
          >
            <Group gap="sm" wrap="nowrap" align="center">
              <img src="/favicon.svg" alt="" width={30} height={30} style={{ display: 'block' }} />
              <Text
                className="qrbit-text-display font-bold tracking-tight"
                component="span"
                style={{ whiteSpace: 'nowrap' }}
              >
                QRward
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
                  borderWidth: '1.5px',
                }}
              >
                {session ? 'P2P Air-Drop // Paired' : 'P2P Air-Drop'}
              </Badge>
            </Group>
          </Link>
        </Group>

        {/* Right: what the session is doing, the way out of it, and Settings. */}
        <Group gap="sm" wrap="nowrap" align="center">
          {session ? (
            <>
              <StatusChip tone={tone} label={session.status.label} />
              {session.role ? (
                <StatusChip
                  tone="idle"
                  label={session.role === 'host' ? 'Host' : 'Guest'}
                  hiddenBelow="sm"
                />
              ) : null}
            </>
          ) : null}

          {hasSessionToLeave && session ? (
            <Tooltip
              label="End this session. Anything still in transit is not delivered, and the code stops working."
              position="bottom"
              withArrow
            >
              <Button
                variant="default"
                size="sm"
                className={THUMB_TARGET}
                leftSection={<IconLogout size={16} stroke={1.6} aria-hidden="true" />}
                onClick={() => {
                  session.abort()
                  navigate('/')
                }}
              >
                Exit
              </Button>
            </Tooltip>
          ) : null}

          <ThemeToggle />

          {/*
            DESIGN.md: a route with no entry point is a route that does not exist. The control
            IS the link (`component={Link}`) rather than a button inside an anchor, so the
            header has one focusable thing per action and the tab order matches what is read.
          */}
          <Button
            component={Link}
            to="/settings"
            className={`app-header__settings ${THUMB_TARGET}`}
            variant="outline"
            color="gray"
            size="sm"
            style={{ borderWidth: '1px' }}
            leftSection={<IconSettings size={16} stroke={1.6} aria-hidden="true" />}
          >
            Settings
          </Button>
        </Group>
      </Group>
    </header>

  )
}

/**
 * A status chip: Sunken fill, a `--qrbit-border` hairline, radius full, 22px tall, Label role
 * (DESIGN.md, "Badges and Chips"). The dot carries the hue and the word carries the meaning,
 * so the state survives a colour-blind visitor and a screen that is being read aloud — a
 * badge never relies on colour alone.
 */
function StatusChip({
  tone,
  label,
  hiddenBelow,
}: {
  tone: StatusTone
  label: string
  /**
   * Below this breakpoint the chip is dropped. On a phone the header has room for the status
   * line and the actions; which role this device took is stated on the session screen itself.
   */
  hiddenBelow?: 'xs' | 'sm' | 'md'
}): ReactElement {
  return (
    <Group
      gap="xs"
      wrap="nowrap"
      align="center"
      pl="sm"
      pr="md"
      hiddenFrom={hiddenBelow}
      style={{
        height: '1.375rem',
        flex: 'none',
        borderRadius: 'var(--qrbit-radius-full)',
        backgroundColor: 'var(--qrbit-sunken)',
        border: '1px solid var(--qrbit-border)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '0.5rem',
          height: '0.5rem',
          flex: 'none',
          borderRadius: 'var(--qrbit-radius-full)',
          backgroundColor: TONE_DOT[tone],
        }}
      />
      <Text className="qrbit-text-label" style={{ whiteSpace: 'nowrap' }}>
        {label}
      </Text>
    </Group>
  )
}

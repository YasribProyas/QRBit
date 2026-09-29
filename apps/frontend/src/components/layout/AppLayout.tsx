/**
 * The shell every non-home screen mounts inside (PLAN.md §5's layout, DESIGN.md's "Layout").
 *
 * It owns exactly three things: the page column, the header line, and the two-pane split when
 * a screen has a vault to show. Everything else is handed in as `mainContent`.
 *
 * `.page` (styles.css) is the definition of the page column — max width, centring, `lg`
 * padding and `lg` rhythm — so it is applied by class rather than re-typed as inline styles,
 * which is where the previous revision had drifted (it set `maxWidth`, `margin` and `gap`
 * inline on top of the same class). `minHeight: 100vh` is the one property that column has
 * here and nowhere else: a page with no content of its own still has to reach the bottom of
 * the viewport, or the canvas colour stops halfway down.
 *
 * The header is not sticky and carries no shadow, in either scheme. This shell scrolls with
 * the document, so nothing is ever passing underneath it — DESIGN.md's "The Floating Only
 * Rule" makes a shadow a response to floating, and a resting surface is flat with a border.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Box, Drawer, ScrollArea, Stack } from '@mantine/core'
import { AppHeader } from './AppHeader'
import type { UseSessionResult } from '../../hooks/useSession'
import { WithMantine } from '../common/WithMantine'

export interface AppLayoutProps {
  session?: UseSessionResult
  /** The local library panel. With `showVault`, it is the left column, and the drawer's body. */
  vaultContent?: ReactNode
  mainContent: ReactNode
  showVault?: boolean
}

export function AppLayout({
  session,
  vaultContent,
  mainContent,
  showVault = true,
}: AppLayoutProps) {
  const [mobileVaultOpen, setMobileVaultOpen] = useState(false)
  const hasVault = showVault && vaultContent !== undefined && vaultContent !== null

  return (
    <WithMantine>
      <Box className="page" style={{ minHeight: '100vh', width: '100%' }}>
        <AppHeader
          session={session}
          vaultOpened={mobileVaultOpen}
          onToggleVault={hasVault ? () => setMobileVaultOpen((open) => !open) : undefined}
          mobileOnlyBurger
        />

        {hasVault ? (
          <div className="dual-pane-layout">
            <aside className="vault-pane" aria-label="Local library">
              {vaultContent}
            </aside>
            <section className="session-pane" aria-label="Session surface">
              {mainContent}
            </section>

            {/*
              The phone drawer, for the one screen that has a vault and not the room for two
              columns. It is the same content, not a second copy of the panel's state.
            */}
            <Drawer
              opened={mobileVaultOpen}
              onClose={() => {
                setMobileVaultOpen(false)
              }}
              size="100%"
              padding="md"
              title="Local library"
              hiddenFrom="md"
              keepMounted={false}
            >
              <ScrollArea h="calc(100vh - 5rem)">{mobileVaultOpen ? vaultContent : null}</ScrollArea>
            </Drawer>
          </div>
        ) : (
          /*
            One column, and a reading measure rather than a stretched form: 48rem is what the
            prose on `/settings` and the session board both fit without running a line of body
            text past the measure DESIGN.md sets. The class this element used to carry
            (`single-pane-layout`) is not defined in styles.css — the centring was always the
            inline style, so it is now the props that say it.
          */
          <Stack gap="lg" w="100%" maw="48rem" mx="auto">
            {mainContent}
          </Stack>
        )}
      </Box>
    </WithMantine>
  )
}

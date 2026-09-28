import { useState } from 'react'
import type { ReactNode } from 'react'
import { Box, Drawer, ScrollArea } from '@mantine/core'
import { AppHeader } from './AppHeader'
import type { UseSessionResult } from '../../hooks/useSession'
import { WithMantine } from '../common/WithMantine'

export interface AppLayoutProps {
  session?: UseSessionResult
  vaultContent?: ReactNode
  mainContent: ReactNode
  showVault?: boolean
  onOpenScanner?: () => void
  onOpenManualCode?: () => void
  onOpenSettings?: () => void
}

export function AppLayout({
  session,
  vaultContent,
  mainContent,
  showVault = true,
  onOpenScanner,
  onOpenManualCode,
  onOpenSettings,
}: AppLayoutProps) {
  const [mobileVaultOpen, setMobileVaultOpen] = useState(false)

  return (
    <WithMantine>
      <Box className="page" style={{ minHeight: '100vh', maxWidth: '84rem', margin: '0 auto', width: '100%' }}>
        <AppHeader
          session={session}
          onOpenScanner={onOpenScanner}
          onOpenManualCode={onOpenManualCode}
          onOpenSettings={onOpenSettings}
          vaultOpened={mobileVaultOpen}
          onToggleVault={showVault && vaultContent ? () => setMobileVaultOpen((o) => !o) : undefined}
          mobileOnlyBurger={true}
        />

        {showVault && vaultContent ? (
          <div className="dual-pane-container">
            <div className="dual-pane-layout">
              {/* Desktop Sticky Left Vault Pane */}
              <aside className="vault-pane" aria-label="Local Library Vault">
                {vaultContent}
              </aside>
              {/* Right Session / QR / Actions Pane */}
              <section className="session-pane" aria-label="Session Surface">
                {mainContent}
              </section>
            </div>

            {/* Mobile Drawer for Vault: Opens when user taps hamburger on phone */}
            <Drawer
              opened={mobileVaultOpen}
              onClose={() => setMobileVaultOpen(false)}
              size="100%"
              padding="md"
              title="Local Encrypted Vault"
              hiddenFrom="md"
              keepMounted={false}
            >
              <ScrollArea h="calc(100vh - 80px)">
                {mobileVaultOpen ? vaultContent : null}
              </ScrollArea>
            </Drawer>
          </div>
        ) : (
          <div className="single-pane-layout" style={{ maxWidth: '48rem', margin: '0 auto', width: '100%' }}>
            {mainContent}
          </div>
        )}
      </Box>
    </WithMantine>
  )
}

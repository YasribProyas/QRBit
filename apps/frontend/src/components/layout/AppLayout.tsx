import { useState } from 'react'
import type { ReactNode } from 'react'
import { Box } from '@mantine/core'
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
            <div className={`dual-pane-layout ${mobileVaultOpen ? 'mobile-vault-expanded' : ''}`}>
              <aside className={`vault-pane ${mobileVaultOpen ? 'vault-pane--open' : ''}`} aria-label="Local Library Vault">
                {vaultContent}
              </aside>
              <section className="session-pane" aria-label="Session Surface">
                {mainContent}
              </section>
            </div>
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

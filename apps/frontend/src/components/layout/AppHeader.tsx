import { Badge, Box, Burger, Button, Group, Text, Tooltip } from '@mantine/core'
import { IconCamera, IconKeyboard, IconSettings, IconX } from '@tabler/icons-react'
import { Link, useNavigate } from 'react-router-dom'
import type { UseSessionResult } from '../../hooks/useSession'

export interface AppHeaderProps {
  session?: UseSessionResult
  onOpenScanner?: () => void
  onOpenManualCode?: () => void
  onOpenSettings?: () => void
  vaultOpened?: boolean
  onToggleVault?: () => void
  mobileOnlyBurger?: boolean
}

export function AppHeader({
  session,
  onOpenScanner,
  onOpenManualCode,
  onOpenSettings,
  vaultOpened = false,
  onToggleVault,
  mobileOnlyBurger = true,
}: AppHeaderProps) {
  const navigate = useNavigate()
  const statusTone = session?.status.tone ?? 'idle'
  const toneColorMap: Record<string, string> = {
    ok: 'emerald',
    warn: 'yellow',
    error: 'red',
    idle: 'gray',
  }
  const badgeColor = toneColorMap[statusTone] ?? 'gray'
  const isSessionActiveOrConnecting =
    session && (session.phase === 'connecting' || session.phase === 'pairing' || session.phase === 'active')

  return (
    <header className="page__header" style={{ width: '100%', marginBottom: '0.5rem' }}>
      <Group justify="space-between" align="center" w="100%" wrap="nowrap">
        {/* Left: Brand & Mobile Burger */}
        <Group gap="xs" align="center" wrap="nowrap">
          {onToggleVault ? (
            <Burger
              opened={vaultOpened}
              onClick={onToggleVault}
              hiddenFrom={mobileOnlyBurger ? 'md' : undefined}
              size="sm"
              aria-label="Toggle Vault drawer"
            />
          ) : null}

          <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
            <Group gap={10} align="center" wrap="nowrap">
              <img
                src="/favicon.svg"
                alt="QRBit"
                width={32}
                height={32}
                style={{ borderRadius: 8, display: 'block', flexShrink: 0 }}
              />
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <h1 className="page__title" style={{ margin: 0, lineHeight: 1.15, fontSize: '1.25rem' }}>
                    QRBit
                  </h1>
                  <span style={{ fontSize: '10px', fontFamily: 'monospace', padding: '1px 6px', background: 'rgba(29, 78, 216, 0.1)', color: '#1D4ED8', border: '1px solid rgba(29, 78, 216, 0.25)', borderRadius: '4px', fontWeight: 600 }}>
                    P2P v2.4
                  </span>
                </div>
                <Text size="xs" c="dimmed" style={{ lineHeight: 1.2, letterSpacing: '0.01em', marginTop: '2px' }}>
                  Air-gapped structured transfer
                </Text>
              </div>
            </Group>
          </Link>
        </Group>

        {/* Center: Live Session Status Pill */}
        {session ? (
          <Group gap="xs" align="center" wrap="nowrap" visibleFrom="xs">
            <Badge
              variant="dot"
              color={badgeColor}
              size="md"
              radius="xl"
              styles={{
                root: {
                  textTransform: 'none',
                  fontWeight: 550,
                  letterSpacing: '0.01em',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                },
              }}
            >
              {session.status.label}
            </Badge>
            {session.role ? (
              <Badge
                variant="outline"
                color="gray"
                size="sm"
                radius="sm"
                className="badge"
                styles={{
                  root: {
                    textTransform: 'uppercase',
                    fontSize: '0.7rem',
                    letterSpacing: '0.06em',
                  },
                }}
              >
                {session.role}
              </Badge>
            ) : null}
          </Group>
        ) : null}

        {/* Right: Quick Actions & Settings */}
        <Group gap="xs" align="center" wrap="nowrap">
          {/* Quick Exit/Abort button when in session so users can exit without refreshing */}
          {isSessionActiveOrConnecting ? (
            <Tooltip label="Leave session and return to Home" position="bottom" withArrow>
              <Button
                variant="light"
                color="red"
                size="xs"
                leftSection={<IconX size={15} />}
                onClick={() => {
                  session.abort()
                  navigate('/')
                }}
              >
                Exit
              </Button>
            </Tooltip>
          ) : null}

          {onOpenScanner ? (
            <Tooltip label="Scan & Send via camera" position="bottom" withArrow>
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                leftSection={<IconCamera size={16} />}
                onClick={onOpenScanner}
                visibleFrom="sm"
              >
                Scan
              </Button>
            </Tooltip>
          ) : null}

          {onOpenManualCode ? (
            <Tooltip label="Enter 8-character code" position="bottom" withArrow>
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                leftSection={<IconKeyboard size={16} />}
                onClick={onOpenManualCode}
                visibleFrom="md"
              >
                Code
              </Button>
            </Tooltip>
          ) : null}

          {onOpenSettings ? (
            <Tooltip label="Settings & Library backup" position="bottom" withArrow>
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                leftSection={<IconSettings size={16} />}
                onClick={onOpenSettings}
                className="link"
              >
                Settings
              </Button>
            </Tooltip>
          ) : (
            <Link className="link" to="/settings" style={{ textDecoration: 'none' }}>
              <Button variant="subtle" color="gray" size="xs" leftSection={<IconSettings size={16} />}>
                Settings
              </Button>
            </Link>
          )}
        </Group>
      </Group>
    </header>
  )
}

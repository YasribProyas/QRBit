import { Badge, Box, Burger, Button, Group, Text, Tooltip } from '@mantine/core'
import { IconCamera, IconKeyboard, IconSettings, IconShieldCheck } from '@tabler/icons-react'
import { Link } from 'react-router-dom'
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
  const statusTone = session?.status.tone ?? 'idle'
  const toneColorMap: Record<string, string> = {
    ok: 'emerald',
    warn: 'yellow',
    error: 'red',
    idle: 'gray',
  }
  const badgeColor = toneColorMap[statusTone] ?? 'gray'

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
            <Group gap={8} align="center" wrap="nowrap">
              <Box
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: 'rgba(74, 222, 128, 0.12)',
                  border: '1px solid rgba(74, 222, 128, 0.28)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#4ade80',
                }}
              >
                <IconShieldCheck size={20} stroke={2} />
              </Box>
              <div>
                <h1 className="page__title" style={{ margin: 0, lineHeight: 1.15, fontSize: '1.25rem' }}>
                  QRDrop
                </h1>
                <Text size="xs" c="dimmed" style={{ lineHeight: 1, letterSpacing: '0.02em' }}>
                  No login. No cloud. No trace.
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

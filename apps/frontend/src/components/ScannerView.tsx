/**
 * The camera screen (PLAN.md §7 Flow A, §16 Phase 6).
 *
 * What this surface is for: aiming this device at the QR code the OTHER device is showing,
 * and reporting the code it reads. Everything camera-shaped — opening the device, decoding
 * frames, the viewfinder framing and the sweep, the permission-denied error surface and the
 * teardown that hands the camera back — belongs to `QRScanner`, because that component is
 * what actually paints the camera. This file owns the screen around it: the title, the
 * dossier that is waiting to be sent, and the typed fallback for a device that cannot scan.
 *
 * It deliberately shows no telemetry it has not measured. The previous revision carried a
 * "Payload Ready" pulse dot, a "Ready to pair transmission channel" line and a "P2P" badge —
 * none of which any part of the app computes — on a surface painted with hardcoded dark
 * slate and sky-blue hexes, which stayed black in the light scheme. What is here now is real:
 * the selected dossier's name, its block count, and whether any block is locked.
 *
 * Every exit still reaches `QRScanner`'s teardown: `onCancel` unmounts this screen, the
 * scanner stops its tracks on unmount, and a decoded code goes through the same
 * `onScan` path as before.
 */

import { ActionIcon, Badge, Group, Stack, Text, Title } from '@mantine/core'
import { IconLock, IconX } from '@tabler/icons-react'

import type { LibraryFile } from '../lib/library'
import { ManualCodeEntry } from './ManualCodeEntry'
import { QRScanner } from './QRScanner'
import { WithMantine } from './common/WithMantine'

export interface ScannerViewProps {
  selectedFile?: LibraryFile | null
  onScan: (code: string) => void
  onCancel: () => void
}

/** DESIGN.md reserves Locked Rust for encryption state, and this is that badge. */
function EncryptedBadge() {
  return (
    <Badge
      color="locked"
      variant="light"
      // A badge never relies on colour alone: the word and the glyph say it too.
      leftSection={<IconLock size={12} aria-hidden="true" />}
    >
      Encrypted
    </Badge>
  )
}

export function ScannerView({
  selectedFile,
  onScan,
  onCancel,
}: ScannerViewProps) {
  const blocks = selectedFile?.blocks ?? []
  const hasLockedBlock = blocks.some((block) => block.type === 'locked' || block.isLocked)

  return (
    <WithMantine>
      <div className="scanner flex min-h-dvh flex-col" style={{ background: 'var(--qrbit-canvas)' }}>
        <header className="scanner__header shrink-0">
          <Group
            justify="space-between"
            align="center"
            wrap="nowrap"
            p="md"
            style={{ borderBottom: '1px solid var(--qrbit-border)' }}
          >
            <Title order={1} className="qrbit-text-headline">
              Scan the other device
            </Title>

            <ActionIcon
              className="scanner__cancel"
              variant="subtle"
              size="lg"
              aria-label="Stop scanning"
              onClick={onCancel}
            >
              <IconX size={20} aria-hidden="true" />
            </ActionIcon>
          </Group>
        </header>

        <main className="flex min-h-0 flex-1 flex-col justify-center">
          <Stack gap="xl" maw="30rem" mx="auto" w="100%" p="lg">
            {selectedFile ? (
              <Group
                justify="space-between"
                align="center"
                wrap="nowrap"
                p="md"
                className="scanner__payload"
                style={{
                  border: '1px solid var(--qrbit-border)',
                  borderRadius: 'var(--qrbit-radius-sm)',
                  background: 'var(--qrbit-raised)',
                }}
              >
                <Stack gap="xxs" maw="24ch">
                  <Text className="qrbit-text-title">{selectedFile.name}</Text>
                  {/* A count is data, so it is set as data and stays tabular. */}
                  <Text className="qrbit-text-data" c="dimmed">
                    {blocks.length} {blocks.length === 1 ? 'block' : 'blocks'}
                  </Text>
                </Stack>
                {hasLockedBlock ? <EncryptedBadge /> : null}
              </Group>
            ) : (
              <Text className="qrbit-text-body-secondary" c="dimmed">
                No dossier attached yet — pair first, then add files to the session.
              </Text>
            )}

            {/* The camera itself, and everything aimed with it, is `QRScanner`'s surface. */}
            <QRScanner onScan={onScan} onCancel={onCancel} />

            <Text className="qrbit-text-body-secondary" c="dimmed" ta="center">
              Hold the other device’s screen inside the frame until the code is read.
            </Text>

            {/* The typed fallback, under a hairline — the same form the pairing panel uses. */}
            <div
              className="scanner__manual"
              style={{ borderTop: '1px solid var(--qrbit-border)', paddingTop: 'var(--qrbit-space-lg)' }}
            >
              <ManualCodeEntry onSubmit={onScan} />
            </div>
          </Stack>
        </main>
      </div>
    </WithMantine>
  )
}

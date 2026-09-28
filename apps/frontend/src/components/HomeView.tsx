import { useState } from 'react'
import {
  Box,
  Group,
  Stack,
  Text,
  Title,
  Paper,
  TextInput,
  Button,
  Badge,
  Accordion,
  Alert,
  Loader
} from '@mantine/core'
import {
  IconFolder,
  IconPlus,
  IconSend,
  IconLock,
  IconFileText,
  IconScan,
  IconKeyboard,
  IconArrowRight
} from '@tabler/icons-react'
import { TacticalQRCode } from './TacticalQRCode'
import type { LibraryFile, LibraryFolder } from '../lib/library'
import { getFirstBlockPreview, hasLockedBlocks } from '../lib/dossier'
import { APP_URL } from '../config'

import { WithMantine } from './common/WithMantine'

export interface HomeViewProps {
  pairingCode: string | null
  onRegeneratePairing: () => void
  folders: LibraryFolder[]
  files: LibraryFile[]
  onSelectFileToEdit: (file: LibraryFile) => void
  onSendFileDirectly: (file: LibraryFile) => void
  onOpenScanner: () => void
  onCreateNewFile: () => void
  onJoinCode: (code: string) => void
  selectedCount?: number
  roleLabel?: string
  errorMessage?: string | null
}

export function HomeView({
  pairingCode,
  onRegeneratePairing,
  folders,
  files,
  onSelectFileToEdit,
  onSendFileDirectly,
  onOpenScanner,
  onCreateNewFile,
  onJoinCode,
  selectedCount = 0,
  roleLabel,
  errorMessage,
}: HomeViewProps) {
  const [expandedFolders, setExpandedFolders] = useState<string[]>(['f-1', 'f-2', 'f-3'])
  const [manualCode, setManualCode] = useState('')

  const handleManualJoin = (e: React.FormEvent) => {
    e.preventDefault()
    if (!manualCode.trim()) return
    onJoinCode(manualCode.trim().toUpperCase())
  }

  return (
    <WithMantine>
      <Box className="page" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top Bar / App Brand */}
      <header className="px-5 py-3.5 bg-white border-b border-[#D1D9E4] flex items-center justify-between sticky top-0 z-30 shadow-2xs">
        <Group align="center" gap="sm">
          <img src="/favicon.svg" alt="QRBit" width={28} height={28} />
          <div>
            <Title order={1} className="page__title font-display font-bold text-base tracking-tight text-[#0F172A]" size="h5">
              QRBit
            </Title>
            <Text size="xs" c="dimmed">Air-gapped structured transfer</Text>
          </div>
        </Group>

        <Button
          onClick={onOpenScanner}
          className="home__scan"
          color="signal"
          leftSection={<IconScan size={16} />}
          size="sm"
        >
          Scan &amp; Send{selectedCount > 0 ? ` (${selectedCount})` : ''}
        </Button>
      </header>

      {/* Main Stacked Content */}
      <Box style={{ flex: 1, padding: '1.25rem 1rem', maxWidth: '36rem', margin: '0 auto', width: '100%' }}>
        <Stack gap="xl">
          {/* Error panel */}
          {errorMessage ? (
            <Alert
              color="red"
              title="Error"
              className="home__qr-error"
              role="alert"
            >
              <Stack gap="xs">
                <Text size="sm">Could not reach the signaling server.</Text>
                <Text size="xs" ff="monospace">{errorMessage}</Text>
                <div>
                  <Button color="red" size="xs" onClick={onRegeneratePairing}>
                    Try again
                  </Button>
                </div>
              </Stack>
            </Alert>
          ) : null}

          {/* SECTION 1: QR CODE */}
          <Paper shadow="xs" p="xl" radius="lg" withBorder style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <Group justify="space-between" style={{ width: '100%' }} mb="md">
              <Group gap="xs">
                <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--mantine-color-telemetry-5)' }} />
                <Text size="xs" fw={500} c="dimmed">Beacon Ready</Text>
              </Group>
            </Group>

            {pairingCode ? (
              <div className="session-qr flex flex-col items-center w-full">
                <TacticalQRCode
                  pairingCode={pairingCode}
                  onRegenerate={onRegeneratePairing}
                  size={195}
                  showLabel={true}
                />

                <Text size="sm" c="telemetry" fw={500} mt="md" ta="center">
                  {roleLabel || 'Host — waiting for another device to scan your code'}
                </Text>

                <Text size="xs" c="dimmed" mt={4} ta="center" ff="monospace">
                  On the other device, open <code>{`${APP_URL}/session?code=${pairingCode}`}</code>
                </Text>
              </div>
            ) : (
              <Box py="xl" ta="center">
                <Loader size="sm" mr="xs" />
                <Text size="xs" c="dimmed" span>Connecting host session...</Text>
              </Box>
            )}

            {/* Manual pairing fallback input */}
            <Box w="100%" mt="xl" pt="md" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
              <Text size="xs" c="dimmed" mb="xs" ff="monospace">Have a code instead? Type it in:</Text>
              <form onSubmit={handleManualJoin} className="manual-code flex items-center gap-2">
                <Group align="center" gap="sm" style={{ width: '100%' }} wrap="nowrap">
                  <TextInput
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value)}
                    placeholder="Type 8-character code..."
                    className="manual-code__input"
                    leftSection={<IconKeyboard size={16} />}
                    size="md"
                    style={{ flex: 1 }}
                  />
                  <Button
                    type="submit"
                    disabled={!manualCode.trim()}
                    className="manual-code__submit"
                    size="md"
                    color="dark"
                    rightSection={<IconArrowRight size={14} />}
                  >
                    Join
                  </Button>
                </Group>
              </form>
            </Box>
          </Paper>

          {/* SECTION 2: LIBRARY */}
          <Box>
            <Group justify="space-between" mb="md">
              <div>
                <Title order={2} size="h4" className="page__section-title">
                  Local Library <span className="sr-only">Your Library</span>
                </Title>
                <Text size="xs" c="dimmed">Stored dossiers on this device</Text>
              </div>
              <Button
                variant="default"
                size="sm"
                leftSection={<IconPlus size={16} />}
                onClick={onCreateNewFile}
              >
                New File
              </Button>
            </Group>

            {folders.length === 0 ? (
              <Paper withBorder p="xl" ta="center" style={{ borderStyle: 'dashed' }}>
                <Text size="sm" c="dimmed">No folders in library yet.</Text>
              </Paper>
            ) : (
              <Accordion multiple value={expandedFolders} onChange={setExpandedFolders} variant="separated">
                {folders.map(folder => {
                  const folderFiles = files.filter(f => f.folderId === folder.id)
                  return (
                    <Accordion.Item key={folder.id} value={folder.id}>
                      <Accordion.Control icon={<IconFolder size={18} />}>
                        <Group justify="space-between">
                          <Text fw={600}>{folder.name}</Text>
                          <Badge size="sm" variant="light" color="gray">
                            {folderFiles.length} {folderFiles.length === 1 ? 'file' : 'files'}
                          </Badge>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Stack gap="xs">
                          {folderFiles.length === 0 ? (
                            <Text size="sm" c="dimmed" ta="center" py="md">
                              Empty folder. Click "+ New File" to author a dossier.
                            </Text>
                          ) : (
                            folderFiles.map(file => {
                              const previewText = getFirstBlockPreview(file)
                              const containsLock = hasLockedBlocks(file)

                              return (
                                <Paper
                                  key={file.id}
                                  withBorder
                                  p="sm"
                                  radius="md"
                                  onClick={() => onSelectFileToEdit(file)}
                                  style={{ cursor: 'pointer' }}
                                >
                                  <Group justify="space-between" wrap="nowrap">
                                    <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                                      <IconFileText size={18} color="var(--mantine-color-signal-6)" style={{ flexShrink: 0 }} />
                                      <Box style={{ minWidth: 0, flex: 1 }}>
                                        <Group gap="xs">
                                          <Text fw={600} size="sm" truncate>{file.name}</Text>
                                          {containsLock && (
                                            <Badge size="xs" color="shield" variant="light" leftSection={<IconLock size={10} />}>
                                              Encrypted
                                            </Badge>
                                          )}
                                        </Group>
                                        <Text size="xs" c="dimmed" truncate>{previewText}</Text>
                                      </Box>
                                    </Group>
                                    <Button
                                      variant="light"
                                      color="signal"
                                      size="xs"
                                      leftSection={<IconSend size={14} />}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        onSendFileDirectly(file)
                                      }}
                                    >
                                      Send
                                    </Button>
                                  </Group>
                                </Paper>
                              )
                            })
                          )}
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  )
                })}
              </Accordion>
            )}
          </Box>
        </Stack>
      </Box>
      </Box>
    </WithMantine>
  )
}

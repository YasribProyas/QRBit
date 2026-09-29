import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Grid,
  Group,
  Paper,
  Stack,
  Text,
} from '@mantine/core'
import {
  IconDeviceDesktop,
  IconDeviceMobile,
  IconFolderDown,
  IconLock,
  IconPower,
  IconReceipt2,
  IconShieldCheck,
} from '@tabler/icons-react'
import type { UseSessionResult } from '../../hooks/useSession'
import { ROOT_FOLDER_ID } from '../../lib/library'
import type { FileBlock, LibraryFolder, LibraryFile } from '../../lib/library'
import type { ItemStatus, SessionItem } from '../../store/sessionStore'
import { BlockItem } from '../library/BlockItem'
import { FolderPickerModal, type FolderPickerChoice } from '../library/FolderPickerModal'
import { sessionItemsToLibraryFile } from '../../lib/dossier'
import { WithMantine } from '../common/WithMantine'

export interface ReceiverSessionViewProps {
  session: UseSessionResult
  folders: LibraryFolder[]
  /**
   * What to call the other device. The app never learns a peer's name — there is no such
   * field on the wire — so this is optional and there is no invented default: without it
   * the screen says "Other device", which is the truth.
   */
  peerName?: string
  onSaveToLibrary: (file: LibraryFile) => void
  onEndSession: () => void
}

/** A resting panel: Raised, 1px Border, radius lg, no shadow at rest (DESIGN.md). */
const PANEL_STYLE = {
  background: 'var(--qrbit-raised)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-lg)',
} as const

/**
 * One status vocabulary for the whole session surface (shared with `SessionBoard`): green
 * only when the transport says the bytes landed, amber only while they are in flight, red
 * only for a failure, neutral for anything not reported on yet.
 */
const STATUS_LABELS: Record<ItemStatus, string> = {
  pending: 'Pending',
  transferring: 'Transferring',
  complete: 'Arrived',
  error: 'Failed',
}

const STATUS_COLORS: Record<ItemStatus, 'gray' | 'warning' | 'success' | 'danger'> = {
  pending: 'gray',
  transferring: 'warning',
  complete: 'success',
  error: 'danger',
}

const BLOCK_STATUS: Record<ItemStatus, 'pending' | 'in_progress' | 'sent' | 'error'> = {
  pending: 'pending',
  transferring: 'in_progress',
  complete: 'sent',
  error: 'error',
}

/**
 * The receiver's live screen.
 *
 * Everything on it is read off the session store: the words are the ones the ECDH exchange
 * produced (or the screen says they have not arrived — it never shows a placeholder phrase,
 * because a word the user reads back to a stranger that the code never derived teaches them
 * that the check means nothing), the list is the items that actually arrived, and each row's
 * status is that item's own transport state rather than a blanket "sent".
 *
 * There is no link-quality figure and no checksum claim here: nothing in this app measures
 * either, so a number would be decoration on the one screen whose job is to report facts.
 */
export function ReceiverSessionView(props: ReceiverSessionViewProps) {
  return (
    <WithMantine>
      <ReceiverSessionViewInner {...props} />
    </WithMantine>
  )
}

function ReceiverSessionViewInner({
  session,
  folders,
  peerName,
  onSaveToLibrary,
  onEndSession,
}: ReceiverSessionViewProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [hasSaved, setHasSaved] = useState(false)

  const receivedItems = session.receivedItems
  const safetyPhrase = session.safetyPhrase

  /**
   * The dossier is only assembled once there is something to assemble. Building a
   * `LibraryFile` for display purposes alone would invent an id, a name the user never chose
   * and a timestamp for a file that was never saved — a plausible-looking object that is not
   * real, on a screen whose whole job is to say what really arrived.
   */
  const blocks = useMemo<FileBlock[] | null>(() => {
    if (receivedItems.length === 0) return null
    return sessionItemsToLibraryFile(
      'Incoming transfer',
      folders[0]?.id || ROOT_FOLDER_ID,
      receivedItems,
    ).blocks
  }, [receivedItems, folders])

  const statusById = useMemo(() => {
    const map = new Map<string, ItemStatus>()
    for (const item of receivedItems) map.set(item.id, item.status)
    return map
  }, [receivedItems])

  /** Only a file or an image is chunked, so only those two carry a percentage. */
  const progressById = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of receivedItems) {
      if (item.type === 'file' || item.type === 'image') map.set(item.id, item.progress)
    }
    return map
  }, [receivedItems])

  const completeItems = receivedItems.filter((item) => item.status === 'complete')
  const allArrived = receivedItems.length > 0 && completeItems.length === receivedItems.length

  const handleSelectFolder = (folderChoice: FolderPickerChoice): void => {
    const targetFolderId = folderChoice.folderId || folders[0]?.id || ROOT_FOLDER_ID
    setHasSaved(true)
    onSaveToLibrary(
      sessionItemsToLibraryFile('Incoming transfer', targetFolderId, completeItems),
    )
  }

  return (
    <Stack gap="lg" className="session-board">
      <Paper p="md" radius="lg" style={PANEL_STYLE}>
        <Group justify="space-between" gap="md" wrap="wrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <IconDeviceDesktop size={20} aria-hidden="true" style={{ color: 'var(--qrbit-ink-secondary)' }} />
            <Stack gap={0}>
              <Text className="qrbit-text-title">Receiving device</Text>
              <Text span className="qrbit-text-body-secondary" c="dimmed">
                {session.status.label}
              </Text>
            </Stack>
          </Group>

          <Group gap="sm" wrap="nowrap">
            {/* The role is read off the store, so the badge can only say what is true. */}
            {session.role !== null ? (
              <Badge variant="light" color="gray" radius="full" ff="sans">
                {session.role}
              </Badge>
            ) : null}
            <Button
              variant="default"
              color="danger"
              size="sm"
              leftSection={<IconPower size={16} aria-hidden="true" />}
              onClick={onEndSession}
            >
              End session
            </Button>
          </Group>
        </Group>
      </Paper>

      <Grid grow gap="lg">
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="md">
          <Paper p="md" radius="lg" style={PANEL_STYLE}>
            <Stack gap="sm">
              <Group gap="sm" wrap="nowrap">
                <span
                  aria-hidden="true"
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: 'var(--qrbit-radius-full)',
                    flex: 'none',
                    // Green only when the sender's confirmation has actually arrived.
                    background: session.peerConfirmed
                      ? 'var(--qrbit-success)'
                      : 'var(--qrbit-border-strong)',
                  }}
                />
                <Text span className="qrbit-text-label" c="dimmed">
                  Connection
                </Text>
              </Group>

              <Group gap="xs" wrap="nowrap">
                <IconDeviceMobile size={16} aria-hidden="true" style={{ color: 'var(--qrbit-ink-muted)' }} />
                <Text span className="qrbit-text-body-secondary">
                  {peerName ?? 'Other device'}
                </Text>
              </Group>

              {/* D14: the receiver sees the words prominently and is never gated by a button. */}
              <Stack gap="xs">
                <Group gap="xs" wrap="nowrap">
                  <IconShieldCheck
                    size={16}
                    aria-hidden="true"
                    style={{ color: 'var(--qrbit-ink-muted)', flex: 'none' }}
                  />
                  <Text span className="qrbit-text-label" c="dimmed">
                    Safety phrase
                  </Text>
                </Group>

                {safetyPhrase === null ? (
                  /*
                   * The honest state. No words are shown, because there are none to show: a
                   * placeholder phrase would be read back to the person standing next to you.
                   */
                  <Text className="qrbit-text-body-secondary" c="dimmed">
                    Waiting for the pairing words.
                  </Text>
                ) : (
                  <>
                    <Group gap="xs" wrap="nowrap">
                      {safetyPhrase.map((word) => (
                        <Text
                          key={word}
                          span
                          className="qrbit-text-data"
                          style={{
                            background: 'var(--qrbit-sunken)',
                            border: '1px solid var(--qrbit-border)',
                            borderRadius: 'var(--qrbit-radius-sm)',
                            padding: '2px 8px',
                            color: 'var(--qrbit-ink)',
                          }}
                        >
                          {word}
                        </Text>
                      ))}
                    </Group>
                    <Text className="qrbit-text-body-secondary" c="dimmed">
                      Read these to the sender. The session waits for their confirmation, not yours.
                    </Text>
                  </>
                )}
              </Stack>
            </Stack>
          </Paper>

          <Paper p="md" radius="lg" style={PANEL_STYLE}>
            <Stack gap="sm">
              <Group justify="space-between" wrap="nowrap">
                <Text span className="qrbit-text-label" c="dimmed">
                  Items received
                </Text>
                <Text span className="qrbit-text-data">
                  {completeItems.length} / {receivedItems.length}
                </Text>
              </Group>

              {receivedItems.length === 0 ? (
                <Text className="qrbit-text-body-secondary" c="dimmed">
                  Nothing has arrived yet.
                </Text>
              ) : (
                <Stack gap="xs">
                  {receivedItems.map((item) => (
                    <Group key={item.id} gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                      {item.type === 'locked' ? (
                        <IconLock
                          size={14}
                          aria-hidden="true"
                          style={{ color: 'var(--qrbit-locked)', flex: 'none' }}
                        />
                      ) : null}
                      <Text
                        span
                        className="qrbit-text-body"
                        style={{ overflowWrap: 'anywhere' }}
                        lineClamp={1}
                      >
                        {itemName(item)}
                      </Text>
                      <Badge
                        variant="light"
                        color={STATUS_COLORS[item.status]}
                        radius="full"
                        ff="sans"
                      >
                        {STATUS_LABELS[item.status]}
                      </Badge>
                    </Group>
                  ))}
                </Stack>
              )}

              {completeItems.length > 0 ? (
                <Button
                  color="signal"
                  size="sm"
                  fullWidth
                  disabled={hasSaved}
                  leftSection={<IconFolderDown size={16} aria-hidden="true" />}
                  onClick={() => {
                    setIsFolderPickerOpen(true)
                  }}
                >
                  {hasSaved ? 'Saved to library' : 'Save to library'}
                </Button>
              ) : null}
            </Stack>
          </Paper>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 8 }}>
        <Paper p="lg" radius="lg" style={PANEL_STYLE}>
          <Stack gap="md">
            <Group justify="space-between" gap="sm" wrap="wrap">
              <Text className="qrbit-text-title">Incoming items</Text>
              {allArrived ? (
                <Badge
                  variant="light"
                  color="success"
                  radius="full"
                  ff="sans"
                  leftSection={<IconReceipt2 size={13} aria-hidden="true" />}
                >
                  All items arrived
                </Badge>
              ) : receivedItems.length > 0 ? (
                <Badge
                  variant="light"
                  color="warning"
                  radius="full"
                  ff="sans"
                >
                  Transfer in progress
                </Badge>
              ) : null}
            </Group>

            {blocks === null ? (
              /* Empty and loading are the same honest statement: nothing has landed. */
              <Stack gap="xs" py="xl" align="center">
                <IconFolderDown
                  size={24}
                  aria-hidden="true"
                  style={{ color: 'var(--qrbit-border-strong)' }}
                />
                <Text className="qrbit-text-body" c="dimmed">
                  Nothing has arrived from the other device yet.
                </Text>
                <Text className="qrbit-text-body-secondary" c="dimmed">
                  Items appear here as their first bytes land.
                </Text>
              </Stack>
            ) : (
              blocks.map((block, index) => {
                const status = statusById.get(block.id) ?? 'pending'
                return (
                  <BlockItem
                    key={block.id}
                    block={block}
                    index={index}
                    totalBlocks={blocks.length}
                    mode="receiver"
                    // The item's own transport state, never a blanket "sent".
                    transferStatus={BLOCK_STATUS[status]}
                    transferProgress={progressById.get(block.id) ?? 0}
                  />
                )
              })
            )}
          </Stack>
        </Paper>
        </Grid.Col>
      </Grid>

      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        onClose={() => {
          setIsFolderPickerOpen(false)
        }}
        folders={folders}
        fileName="Incoming transfer"
        onSelectFolder={handleSelectFolder}
      />
    </Stack>
  )
}

/**
 * The store's own name for an item, narrowed by type: a file or image keeps its file name,
 * a locked item its plaintext label, a note its first line. Nothing invented, nothing
 * truncated into a plausible-looking placeholder.
 */
function itemName(item: SessionItem): string {
  switch (item.type) {
    case 'text':
    case 'richtext': {
      const firstLine = item.content.trim().split('\n')[0]
      if (firstLine === undefined || firstLine === '') {
        return item.type === 'text' ? 'Text note' : 'Rich text note'
      }
      return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
    }
    case 'image':
    case 'file':
      return item.fileName.trim() === '' ? (item.type === 'image' ? 'Image' : 'File') : item.fileName
    case 'locked':
      return item.label.trim() === '' ? 'Locked item' : item.label
  }
}

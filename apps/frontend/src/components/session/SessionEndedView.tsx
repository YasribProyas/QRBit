import { useState } from 'react'
import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core'
import {
  IconCircleCheck,
  IconFolderDown,
  IconLibrary,
  IconLock,
  IconRefresh,
} from '@tabler/icons-react'
import type { UseSessionResult } from '../../hooks/useSession'
import { ROOT_FOLDER_ID } from '../../lib/library'
import type { LibraryFolder, LibraryFile } from '../../lib/library'
import { FolderPickerModal, type FolderPickerChoice } from '../library/FolderPickerModal'
import { sessionItemsToLibraryFile } from '../../lib/dossier'
import { WithMantine } from '../common/WithMantine'

export interface SessionEndedViewProps {
  session: UseSessionResult
  folders: LibraryFolder[]
  onSaveFileToLibrary: (file: LibraryFile) => void
  onStartNewSession: () => void
  onGoToLibrary: () => void
}

/** A resting panel: Raised, 1px Border, radius lg, no shadow at rest (DESIGN.md). */
const PANEL_STYLE = {
  background: 'var(--qrbit-raised)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-lg)',
} as const

/**
 * The ended-session summary (PLAN.md §8 Phase 5's closing screen).
 *
 * It states only what this device can check: how many items arrived, how many of them are
 * locked, and whether the transfer finished. There is no link-quality readout and no
 * "zero checksum errors" line here because nothing in the app measures either — a number
 * the code cannot verify is not a statistic, it is decoration, and on the one screen whose
 * job is to say what actually arrived it is a lie with a decimal point.
 */
export function SessionEndedView(props: SessionEndedViewProps) {
  return (
    <WithMantine>
      <SessionEndedViewInner {...props} />
    </WithMantine>
  )
}

function SessionEndedViewInner({
  session,
  folders,
  onSaveFileToLibrary,
  onStartNewSession,
  onGoToLibrary,
}: SessionEndedViewProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [hasSavedWholeFile, setHasSavedWholeFile] = useState(false)

  const receivedItems = session.receivedItems
  const completeItems = receivedItems.filter((item) => item.status === 'complete')
  const incompleteCount = receivedItems.length - completeItems.length
  /** A `locked` item's payload is ciphertext by definition of the wire type. */
  const lockedCount = completeItems.filter((item) => item.type === 'locked').length
  const allArrived = receivedItems.length > 0 && incompleteCount === 0

  const handleSelectFolder = (folderChoice: FolderPickerChoice): void => {
    setHasSavedWholeFile(true)
    const targetFolderId = folderChoice.folderId || folders[0]?.id || ROOT_FOLDER_ID
    const file = sessionItemsToLibraryFile('Transferred Dossier', targetFolderId, completeItems)
    onSaveFileToLibrary(file)
  }

  return (
    <Stack gap="lg" maw="36rem" mx="auto" w="100%" p="lg">
      <Paper p="lg" radius="lg" style={PANEL_STYLE}>
        <Stack gap="sm">
          <Group gap="sm" wrap="nowrap">
            <IconCircleCheck
              size={22}
              aria-hidden="true"
              style={{ color: allArrived ? 'var(--qrbit-success)' : 'var(--qrbit-warning)', flex: 'none' }}
            />
            <h2 className="qrbit-text-headline">
              {allArrived ? 'Transfer complete' : 'Session ended'}
            </h2>
          </Group>

          <Text className="qrbit-text-body-secondary" c="dimmed">
            {allArrived
              ? `All ${completeItems.length} ${completeItems.length === 1 ? 'item' : 'items'} arrived and the session is closed.`
              : `${completeItems.length} of ${receivedItems.length} items arrived; the rest did not finish in time.`}
          </Text>

          <Group gap="lg" wrap="wrap" pt="xs">
            <EndedStat label="Items received" value={String(completeItems.length)} />
            <EndedStat label="Locked" value={String(lockedCount)} />
            <EndedStat label="Not finished" value={String(incompleteCount)} />
          </Group>
        </Stack>
      </Paper>

      {completeItems.length > 0 ? (
        <Paper p="lg" radius="lg" style={PANEL_STYLE}>
          <Stack gap="sm">
            <Group justify="space-between" wrap="nowrap">
              <h3 className="qrbit-text-title">Transferred Dossier</h3>
              {/* Data role: a count is a count, and it reads as one. */}
              <Text span className="qrbit-text-data" c="dimmed">
                {completeItems.length} {completeItems.length === 1 ? 'item' : 'items'}
              </Text>
            </Group>

            <Text className="qrbit-text-body-secondary" c="dimmed">
              Save what arrived into a folder on this device. Nothing is stored until you choose one.
            </Text>

            <Button
              className="session-ended__save"
              color="signal"
              size="sm"
              fullWidth
              disabled={hasSavedWholeFile}
              leftSection={
                hasSavedWholeFile ? (
                  <IconCircleCheck size={16} aria-hidden="true" />
                ) : (
                  <IconFolderDown size={16} aria-hidden="true" />
                )
              }
              onClick={() => {
                setIsFolderPickerOpen(true)
              }}
            >
              {hasSavedWholeFile ? 'Saved to library' : 'Save to library'}
            </Button>

            {hasSavedWholeFile ? (
              <Badge
                variant="light"
                color="success"
                radius="full"
                ff="sans"
                leftSection={<IconCircleCheck size={13} aria-hidden="true" />}
              >
                Stored on this device
              </Badge>
            ) : null}
          </Stack>
        </Paper>
      ) : null}

      <Stack gap="xs">
        <Button
          variant="default"
          size="sm"
          fullWidth
          leftSection={<IconRefresh size={16} aria-hidden="true" />}
          onClick={onStartNewSession}
        >
          Start a new session
        </Button>
        <Button
          variant="subtle"
          size="sm"
          fullWidth
          c="dimmed"
          leftSection={<IconLibrary size={16} aria-hidden="true" />}
          onClick={onGoToLibrary}
        >
          Return to library
        </Button>
      </Stack>

      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        onClose={() => {
          setIsFolderPickerOpen(false)
        }}
        folders={folders}
        fileName="Transferred Dossier"
        onSelectFolder={handleSelectFolder}
      />
    </Stack>
  )
}

/**
 * One counted fact. A value not backed by a field on the store's items is not shown here —
 * that is why there is no percentage and no signal-strength figure on this screen.
 */
function EndedStat({ label, value }: { label: string; value: string }) {
  return (
    <Group gap="xs" wrap="nowrap">
      {label === 'Locked' ? (
        <IconLock size={14} aria-hidden="true" style={{ color: 'var(--qrbit-locked)', flex: 'none' }} />
      ) : null}
      <Text span className="qrbit-text-label" c="dimmed">
        {label}
      </Text>
      <Text span className="qrbit-text-data">
        {value}
      </Text>
    </Group>
  )
}

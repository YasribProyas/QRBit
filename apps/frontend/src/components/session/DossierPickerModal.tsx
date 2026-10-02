import { useState } from 'react'
import {
  Button,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core'
import {
  IconFileText,
  IconFolder,
  IconLock,
  IconSearch,
  IconSend,
} from '@tabler/icons-react'

import { WithMantine } from '../common/WithMantine'
import { useLibraryStore } from '../../store/libraryStore'
import { ROOT_FOLDER_ID, type LibraryFile, type LibraryFolder } from '../../lib/library'

export interface DossierPickerModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectDossier: (file: LibraryFile) => void
}

export function DossierPickerModal({
  isOpen,
  onClose,
  onSelectDossier,
}: DossierPickerModalProps) {
  const files = useLibraryStore((state) => state.files)
  const folders = useLibraryStore((state) => state.folders)
  const [searchQuery, setSearchQuery] = useState('')

  if (!isOpen) return null

  const trimmedQuery = searchQuery.trim().toLowerCase()
  const filteredFiles = files.filter((file) => {
    if (!trimmedQuery) return true
    return file.name.toLowerCase().includes(trimmedQuery)
  })

  const getFolderName = (folderId: string): string => {
    if (folderId === ROOT_FOLDER_ID) return 'Root'
    const found = folders.find((f) => f.id === folderId)
    return found ? found.name : 'Root'
  }

  return (
    <WithMantine>
      <Modal
        opened={isOpen}
        onClose={onClose}
        title="Send dossier from library"
        size="md"
        centered
        padding="lg"
      >
        <Stack gap="sm">
          <TextInput
            placeholder="Search dossiers…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            leftSection={<IconSearch size={16} stroke={1.5} style={{ color: 'var(--qrbit-ink-muted)' }} />}
            size="sm"
            autoFocus
          />

          <ScrollArea.Autosize mah={320} type="scroll" offsetScrollbars>
            {filteredFiles.length === 0 ? (
              <div className="py-8 text-center text-sm text-[var(--qrbit-ink-muted)]">
                {files.length === 0
                  ? 'No dossiers found in your library.'
                  : 'No dossiers match your search.'}
              </div>
            ) : (
              <Stack gap="xs">
                {filteredFiles.map((file) => {
                  const folderName = getFolderName(file.folderId)
                  return (
                    <UnstyledButton
                      key={file.id}
                      onClick={() => {
                        onSelectDossier(file)
                        onClose()
                      }}
                      className="group flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border border-[var(--qrbit-border)] hover:border-[var(--qrbit-border-strong)] hover:bg-[var(--qrbit-selected)] transition-colors text-left"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <IconFileText
                          size={18}
                          stroke={1.6}
                          className="text-[var(--qrbit-ink-muted)] group-hover:text-[var(--qrbit-signal)] shrink-0 transition-colors"
                        />
                        <div className="min-w-0">
                          <Text className="qrbit-text-title truncate" c="var(--qrbit-ink)">
                            {file.name}
                          </Text>
                          <Group gap="xs" wrap="nowrap">
                            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--qrbit-ink-muted)]">
                              <IconFolder size={12} stroke={1.5} />
                              {folderName}
                            </span>
                            <span className="text-[11px] text-[var(--qrbit-ink-muted)]">
                              • {file.blocks.length} {file.blocks.length === 1 ? 'block' : 'blocks'}
                            </span>
                            {file.isLocked ? (
                              <span className="inline-flex items-center gap-0.5 text-[11px] text-[var(--qrbit-locked)] font-mono">
                                <IconLock size={11} stroke={1.5} />
                                Locked
                              </span>
                            ) : null}
                          </Group>
                        </div>
                      </div>

                      <Button
                        variant="subtle"
                        size="xs"
                        color="signal"
                        leftSection={<IconSend size={13} stroke={1.5} />}
                        className="shrink-0 opacity-80 group-hover:opacity-100"
                        tabIndex={-1}
                      >
                        Send
                      </Button>
                    </UnstyledButton>
                  )
                })}
              </Stack>
            )}
          </ScrollArea.Autosize>

          <Group justify="flex-end" pt="xs">
            <Button variant="default" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </Modal>
    </WithMantine>
  )
}

/**
 * The folder chooser: pick where a dossier goes, or make the folder it goes into first.
 *
 * Two surfaces ask this question and they ask it about different verbs — the library panel
 * moves a dossier it already has, the receive path saves a dossier that arrived over the
 * wire. `purpose` says which, so the dialog's title and its primary control name the action
 * the user is actually taking (DESIGN.md, "state a control's action in its label"). It
 * defaults to `save`, which is what the session surfaces have always shown.
 *
 * What it promises and what it delivers are the same thing: it answers with a
 * `FolderPickerChoice` and then closes, and the caller performs the write. Nothing here
 * touches the store, so a failed move is the caller's error to show — the picker never
 * claims the folder exists.
 *
 * Only the folders the caller passes are offered, and there is deliberately no Root option:
 * every caller means "file this in a folder", and `moveFile`/`createFile` take a folder id,
 * not the root sentinel. A new folder is always made at the top level, which is what
 * `createFolder(name, null)` does everywhere else in the app.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core'
import { IconArrowLeft, IconFolderPlus } from '@tabler/icons-react'

import { WithMantine } from '../common/WithMantine'
import { FolderOptionRow } from './FolderPicker'
import { ROOT_FOLDER_ID } from '../../lib/library'
import type { LibraryFolder } from '../../lib/library'

/** What the user chose. `isNew` answers are a name, not an id: the folder does not exist yet. */
export interface FolderPickerChoice {
  isNew: boolean
  folderId?: string
  folderName?: string
}

export interface FolderPickerModalProps {
  isOpen: boolean
  onClose: () => void
  /** The folders on offer. The caller decides which ones; the picker does not filter. */
  folders: LibraryFolder[]
  onSelectFolder: (choice: FolderPickerChoice) => void
  /** The dossier being filed, so the question names its subject. */
  fileName?: string
  /**
   * Whose verb this is: `move` for a dossier the device already has, `save` for one that
   * arrived over a session. @default 'save'
   */
  purpose?: 'move' | 'save'
}

/** The two vocabularies, in one place, so the title and the button cannot disagree. */
const PURPOSE_WORDS: Record<'move' | 'save', { title: string; question: string; confirm: string }> = {
  move: {
    title: 'Move dossier',
    question: 'Move “{name}” into:',
    confirm: 'Move dossier',
  },
  save: {
    title: 'Save to library',
    question: 'Save “{name}” into:',
    confirm: 'Save to library',
  },
}

export function FolderPickerModal({
  isOpen,
  onClose,
  folders = [],
  onSelectFolder,
  fileName = 'Received Dossier',
  purpose = 'save',
}: FolderPickerModalProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string>(
    folders[0]?.id || ROOT_FOLDER_ID,
  )
  const [newFolderName, setNewFolderName] = useState('')
  const [isCreatingNew, setIsCreatingNew] = useState(false)

  if (!isOpen) return null

  const trimmedNewName = newFolderName.trim()
  const creating = isCreatingNew
  // Nothing chosen is not an answer: a creation needs a name, a pick needs a folder.
  const canConfirm = creating ? trimmedNewName !== '' : selectedFolderId !== ''
  const words = PURPOSE_WORDS[purpose]

  const confirm = (): void => {
    if (!canConfirm) return

    if (creating) {
      onSelectFolder({ isNew: true, folderName: trimmedNewName })
    } else {
      onSelectFolder({ isNew: false, folderId: selectedFolderId })
    }
    onClose()
  }

  return (
    <WithMantine>
      <Modal
        opened
        onClose={onClose}
        title={words.title}
        size="sm"
        centered
        padding="lg"
        withCloseButton={false}
      >
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            confirm()
          }}
        >
          <Stack gap="md">
            <Text className="qrbit-text-body-secondary">
              {words.question.replace('{name}', fileName)}
            </Text>

            {creating ? (
              <TextInput
                label="New folder name"
                // DESIGN.md's Label role is 12px/600; Mantine's input label is 12px/500,
                // and the weight is not a theme slot (see theme.ts).
                styles={{ label: { fontWeight: 600 } }}
                type="text"
                value={newFolderName}
                autoComplete="off"
                autoFocus
                onChange={(event) => {
                  setNewFolderName(event.target.value)
                }}
              />
            ) : folders.length === 0 ? (
              // An empty library is the normal case on a new device, and "New folder" is the
              // way out of it — so the empty state says that instead of showing a blank list.
              <Text className="qrbit-text-body-secondary">
                There are no folders on this device yet. Create one below and the dossier goes
                into it.
              </Text>
            ) : (
              <div role="radiogroup" aria-label={words.title}>
                <FolderOptionRow
                  key={ROOT_FOLDER_ID}
                  name="Root"
                  selected={selectedFolderId === ROOT_FOLDER_ID}
                  onSelect={() => {
                    setSelectedFolderId(ROOT_FOLDER_ID)
                  }}
                />
                {folders.map((folder) => (
                  <FolderOptionRow
                    key={folder.id}
                    name={folder.name}
                    selected={selectedFolderId === folder.id}
                    onSelect={() => {
                      setSelectedFolderId(folder.id)
                    }}
                  />
                ))}
              </div>
            )}

            {creating ? (
              <Button
                type="button"
                variant="subtle"
                size="sm"
                // Back to the list, and the name is dropped with the mode: a half-typed
                // folder name that survives a "back" is a name that might be submitted twice.
                leftSection={<IconArrowLeft size={16} aria-hidden="true" />}
                onClick={() => {
                  setIsCreatingNew(false)
                  setNewFolderName('')
                }}
              >
                Back
              </Button>
            ) : (
              <Button
                type="button"
                variant="subtle"
                size="sm"
                // A `Stack` stretches its children; an affordance that spans the dialog reads
                // like the answer to the question rather than a way to change it.
                w="fit-content"
                leftSection={<IconFolderPlus size={16} aria-hidden="true" />}
                onClick={() => {
                  setIsCreatingNew(true)
                }}
              >
                New folder
              </Button>
            )}

            <Group justify="flex-end" gap="sm" wrap="nowrap" mt="xs">
              <Button type="button" variant="subtle" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" color="signal" size="sm" disabled={!canConfirm}>
                {words.confirm}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </WithMantine>
  )
}

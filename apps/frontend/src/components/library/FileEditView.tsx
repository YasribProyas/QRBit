import { useState } from 'react'
import {
  IconArrowLeft,
  IconSend,
  IconPlus,
  IconPencil,
  IconCheck,
  IconStack2,
} from '@tabler/icons-react'
import {
  Box,
  Group,
  Stack,
  Text,
  Button,
  ActionIcon,
  TextInput,
  UnstyledButton,
} from '@mantine/core'
import { BlockItem } from './BlockItem'
import { AddBlockModal } from './AddBlockModal'
import type { BlockType, FileBlock, LibraryFile, LibraryFolder } from '../../lib/library'

export interface FileEditViewProps {
  file: LibraryFile
  onBack: () => void
  onSaveFile: (file: LibraryFile) => void
  onSendFile: (file: LibraryFile) => void
  folders: LibraryFolder[]
}

export function FileEditView({
  file,
  onBack,
  onSaveFile,
  onSendFile,
}: FileEditViewProps) {
  const [fileName, setFileName] = useState(file.name)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [blocks, setBlocks] = useState<FileBlock[]>(file.blocks || [])
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)

  const currentFile = () => ({ ...file, name: fileName, blocks })

  const handleMoveUp = (index: number) => {
    if (index <= 0) return
    const next = [...blocks]
    const moved = next.splice(index, 1)[0]
    if (moved) {
      next.splice(index - 1, 0, moved)
      setBlocks(next)
      onSaveFile({ ...file, name: fileName, blocks: next })
    }
  }

  const handleMoveDown = (index: number) => {
    if (index >= blocks.length - 1) return
    const next = [...blocks]
    const moved = next.splice(index, 1)[0]
    if (moved) {
      next.splice(index + 1, 0, moved)
      setBlocks(next)
      onSaveFile({ ...file, name: fileName, blocks: next })
    }
  }

  const handleUpdateBlock = (blockId: string, changes: Partial<FileBlock>) => {
    const updated = blocks.map((b) => (b.id === blockId ? { ...b, ...changes } : b))
    setBlocks(updated)
    onSaveFile({ ...file, name: fileName, blocks: updated })
  }

  const handleDeleteBlock = (blockId: string) => {
    const updated = blocks.filter((b) => b.id !== blockId)
    setBlocks(updated)
    onSaveFile({ ...file, name: fileName, blocks: updated })
  }

  const handleDuplicateBlock = (blockId: string) => {
    const item = blocks.find((b) => b.id === blockId)
    if (!item) return
    const copy: FileBlock = {
      ...item,
      id: `b-${Date.now()}`,
      content: item.content ? `${item.content} (Copy)` : undefined,
    }
    const index = blocks.findIndex((b) => b.id === blockId)
    const updated = [...blocks]
    updated.splice(index + 1, 0, copy)
    setBlocks(updated)
    onSaveFile({ ...file, name: fileName, blocks: updated })
  }

  const handleAddBlockType = (type: BlockType) => {
    const newBlock: FileBlock = {
      id: `b-${Date.now()}`,
      type,
      content: '',
    }
    const updated = [...blocks, newBlock]
    setBlocks(updated)
    onSaveFile({ ...file, name: fileName, blocks: updated })
    setIsAddModalOpen(false)
  }

  const handleTitleSubmit = () => {
    setIsEditingTitle(false)
    onSaveFile({ ...file, name: fileName, blocks })
  }

  const handleUnlockCredential = (blockId: string) => {
    handleUpdateBlock(blockId, { isUnlocked: true })
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>

      {/* Header */}
      <Box
        component="header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          padding: '0 1.25rem',
          height: '3.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
        }}
      >
        {/* Left: back + editable title */}
        <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <ActionIcon variant="subtle" color="gray" size="md" onClick={onBack} title="Back to library">
            <IconArrowLeft size={18} />
          </ActionIcon>

          {isEditingTitle ? (
            <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
              <TextInput
                autoFocus
                value={fileName}
                onChange={e => setFileName(e.target.value)}
                onBlur={handleTitleSubmit}
                onKeyDown={e => e.key === 'Enter' && handleTitleSubmit()}
                size="sm"
                style={{ flex: 1 }}
                styles={{ input: { fontWeight: 700 } }}
              />
              <ActionIcon variant="light" color="teal" size="sm" onClick={handleTitleSubmit}>
                <IconCheck size={14} />
              </ActionIcon>
            </Group>
          ) : (
            <UnstyledButton
              onClick={() => setIsEditingTitle(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}
              title="Click to rename"
            >
              <Text fw={700} size="md" truncate style={{ fontFamily: 'var(--font-display)' }}>
                {fileName}
              </Text>
              <IconPencil size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            </UnstyledButton>
          )}
        </Group>

        {/* Right: Save + Send */}
        <Group gap="xs" wrap="nowrap">
          <Button
            variant="default"
            size="sm"
            onClick={() => onSaveFile(currentFile())}
          >
            Save
          </Button>
          <Button
            variant="filled"
            color="signal"
            size="sm"
            leftSection={<IconSend size={14} />}
            onClick={() => onSendFile(currentFile())}
          >
            Send
          </Button>
        </Group>
      </Box>

      {/* Block list */}
      <Box component="main" style={{ flex: 1, padding: '1.5rem 1.25rem', maxWidth: '640px', margin: '0 auto', width: '100%' }}>
        <Stack gap="md">
          {/* Meta */}
          <Group justify="space-between" px={2}>
            <Group gap={6}>
              <IconStack2 size={14} style={{ color: 'var(--text-muted)' }} />
              <Text size="xs" c="dimmed">
                {blocks.length} {blocks.length === 1 ? 'block' : 'blocks'}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">Click block to edit · ··· to delete/move</Text>
          </Group>

          {/* Blocks */}
          <Stack gap="sm">
            {blocks.map((block, index) => (
              <BlockItem
                key={block.id}
                block={block}
                index={index}
                totalBlocks={blocks.length}
                mode="edit"
                onUpdate={handleUpdateBlock}
                onDelete={handleDeleteBlock}
                onDuplicate={handleDuplicateBlock}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onUnlockCredential={handleUnlockCredential}
              />
            ))}
          </Stack>

          {/* Add block */}
          <UnstyledButton
            onClick={() => setIsAddModalOpen(true)}
            style={{
              width: '100%',
              padding: '0.875rem',
              border: '2px dashed var(--border)',
              borderRadius: 'var(--radius)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              color: 'var(--accent)',
              fontSize: '0.875rem',
              fontWeight: 600,
              transition: 'border-color 120ms, background 120ms',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLElement).style.background = 'rgba(29,78,216,0.04)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.background = '' }}
          >
            <IconPlus size={16} />
            Add block
          </UnstyledButton>
        </Stack>
      </Box>

      <AddBlockModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSelectType={handleAddBlockType}
      />
    </Box>
  )
}

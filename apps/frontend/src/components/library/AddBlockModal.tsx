/**
 * The block type picker (ORCHESTRATION D16): the one way a dossier gains a block.
 *
 * It is a Mantine `Modal` — DESIGN.md's dialog shell: radius md, the sheet shadow, the title at
 * the Title role, Escape cancelling, focus returning to the control that opened it. It used to be
 * a hand-painted overlay with a bottom-sheet radius on phones and a different radius on
 * desktop,
 * and seven hand-rolled buttons that each carried their own colour of icon tile (blue, indigo,
 * amber, violet, orange, slate) — seven hues where the design system has one accent and four
 * status colours, none of which means "heading" or "attachment".
 *
 * The hues are gone. A row here is a choice of *what a block is*, and the only information it
 * needs to carry is the name and what it holds, so every row is the same quiet control with the
 * same neutral glyph.
 */

import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import {
  IconAlignLeft,
  IconChevronRight,
  IconMinus,
  IconKey,
  IconPaperclip,
  IconPhoto,
  IconTypography,
  IconHeading,
} from '@tabler/icons-react'
import type { BlockType } from '../../lib/library'

export interface AddBlockModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectType: (type: BlockType) => void
}

const BLOCK_DEFINITIONS: {
  type: BlockType
  name: string
  desc: string
  icon: typeof IconHeading
}[] = [
  {
    type: 'heading',
    name: 'Section Heading',
    desc: 'Primary title or topical header',
    icon: IconHeading,
  },
  {
    type: 'shortText',
    name: 'Short Text Pair',
    desc: 'Key-value or labeled single-line string',
    icon: IconTypography,
  },
  {
    type: 'richText',
    name: 'Rich Text / Notes',
    // The editor hands this block a plain multiline field; nothing here formats markdown, so the
    // row no longer claims it does.
    desc: 'Multiline note or documentation',
    icon: IconAlignLeft,
  },
  {
    type: 'image',
    name: 'Image Payload',
    desc: 'Diagram or screenshot chosen from disk',
    icon: IconPhoto,
  },
  {
    type: 'fileAttachment',
    name: 'File Attachment',
    desc: 'Binary payload, yaml config, or dataset',
    icon: IconPaperclip,
  },
  {
    type: 'locked',
    name: 'Locked Credential',
    // A new locked block arrives as plaintext and CANNOT be saved until a password is given
    // (`encryptPrompt` in FileEditView), so the row says what the user has to do rather than
    // claiming the block is already encrypted.
    desc: 'Secret or key, encrypted when you give it a password',
    icon: IconKey,
  },
  {
    type: 'divider',
    name: 'Divider Line',
    desc: 'Visual separator between blocks',
    icon: IconMinus,
  },
]

export function AddBlockModal({ isOpen, onClose, onSelectType }: AddBlockModalProps) {
  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title="Insert Block"
      size="md"
      padding="lg"
      withCloseButton={false}
    >
      <Text className="qrbit-text-body-secondary" c="dimmed" mb="md">
        Select a block type to append to this dossier
      </Text>

      <Stack gap="xs">
        {BLOCK_DEFINITIONS.map((item) => {
          const Icon = item.icon
          return (
            <Button
              key={item.type}
              type="button"
              variant="default"
              size="md"
              // A list of choices reads as a list: label left, glyph left of it, nothing centred.
              //
              // The height is a minimum, not a fixed size. A row here is two lines of prose (name +
              // what it holds) inside a Mantine `Button`, whose root is `overflow: hidden` at a fixed
              // `--button-height-md` of 42px: on a narrow sheet the description takes a second line
              // and the row cut it off mid-word. `2.75rem` is DESIGN.md's 44px thumb minimum — the
              // same spelling `styles.css` uses — and the row grows past it instead of clipping.
              style={{ height: 'auto', minHeight: '2.75rem' }}
              styles={{
                root: { width: '100%' },
                inner: { justifyContent: 'flex-start' },
                label: { whiteSpace: 'normal', textAlign: 'left', flex: '1 1 auto' },
              }}
              leftSection={
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    flex: 'none',
                    color: 'var(--qrbit-ink-secondary)',
                    backgroundColor: 'var(--qrbit-sunken)',
                    borderRadius: 'var(--qrbit-radius-sm)',
                  }}
                >
                  <Icon size={16} />
                </span>
              }
              rightSection={
                <IconChevronRight size={16} aria-hidden="true" style={{ opacity: 0.6 }} />
              }
              onClick={() => {
                onSelectType(item.type)
                onClose()
              }}
            >
              <Group gap={0} wrap="nowrap" style={{ minWidth: 0, textAlign: 'left' }}>
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text span className="qrbit-text-body" style={{ fontWeight: 600 }}>
                    {item.name}
                  </Text>
                  {/*
                    Not `truncate`: this sentence is the reason a user picks the row ("Secret or key,
                    encrypted when you give it a password"), and an ellipsis on it hides the
                    instruction the locked row exists to give. It wraps, and the row grows.
                  */}
                  <Text span className="qrbit-text-body-secondary" c="dimmed" style={{ minWidth: 0 }}>
                    {item.desc}
                  </Text>
                </Stack>
              </Group>
            </Button>
          )
        })}
      </Stack>
    </Modal>
  )
}

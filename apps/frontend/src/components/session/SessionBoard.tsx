/**
 * The session board (PLAN.md §9): the ordered list of items this session carries.
 *
 * Both devices render this same board from the same store shape. The sender's copy
 * of an item and the receiver's copy differ only in `status`/`progress`/`blob` as
 * the wire catches up, so there is one rendering path, not two (PLAN.md §8 Phase 3:
 * "Both devices see the same board updating live").
 *
 * The board owns no transport of its own. It reads items from the session store and
 * takes the items API as a prop, which is what makes it testable with a stand-in and
 * keeps this file free of any knowledge of frames, chunking or the DataChannel.
 */

import type { SessionRole } from '../../lib/signaling'
import { ActionIcon, Badge, Group, Text } from '@mantine/core'
import type { MantineColor } from '@mantine/core'
import { IconTrash } from '@tabler/icons-react'
import { WithMantine } from '../common/WithMantine'
import { useSessionStore } from '../../store/sessionStore'
import type { ItemStatus, ItemType, SessionItem } from '../../store/sessionStore'
import type { LockedItemInput } from './LockedItemComposeModal'
import { FileItem } from './items/FileItem'
import { ImageItem } from './items/ImageItem'
import { LockedItem } from './items/LockedItem'
import { RichTextItem } from './items/RichTextItem'
import { TextItem } from './items/TextItem'

/**
 * The only way the board mutates a session (pinned by the Phase 3 orchestrator
 * contract). `useSession` implements it; the item components below consume it
 * through props so they never reach for the hook themselves.
 */
export interface ItemsApi {
  addTextItem(initialContent?: string): string
  addRichTextItem(initialJson?: string): string
  addFileItem(file: File): string
  /**
   * Phase 4 (PLAN.md §16): encrypts the composed content under the password on this
   * device and sends it as an announce plus a `locked-payload`, resolving with the new
   * item's id. Typed with the compose modal's own input, so the two ends of that
   * contract cannot drift without a compile error at the page that joins them.
   */
  addLockedItem(input: LockedItemInput): Promise<string>
  /**
   * Phase 4: decrypts a locked item. True with the plaintext revealed in memory, false
   * for a wrong password, rejection only when there is nothing to unlock.
   */
  unlockItem(id: string, password: string): Promise<boolean>
  /** Phase 4: re-hides an unlocked item. */
  lockItemAgain(id: string): void
  updateTextItem(id: string, content: string): void
  updateRichTextItem(id: string, json: string): void
  deleteItem(id: string): void
}

/**
 * PLAN.md §8: `?code=…` is the guest (the device that scanned, and therefore the
 * sender ≈ the AddItemBar owner); no code is the host (the receiver). One spelling
 * of that rule, used by both the board and the page.
 */
export const SENDER_ROLE: SessionRole = 'guest'

export function isSenderRole(role: SessionRole | null): boolean {
  return role === SENDER_ROLE
}

const STATUS_LABELS: Record<ItemStatus, string> = {
  pending: 'Pending',
  transferring: 'Transferring',
  complete: 'Complete',
  error: 'Error',
}

/**
 * One state vocabulary for the whole board (DESIGN.md, "The Meaningful Colour Rule"): green
 * only when the transport says the item arrived, amber only while it is in flight — which is
 * a caution, not a failure — red only when it genuinely failed, and neutral for a state the
 * transport has not reported on yet. No row colours itself.
 */
const STATUS_COLORS: Record<ItemStatus, MantineColor> = {
  pending: 'gray',
  transferring: 'warning',
  complete: 'success',
  error: 'danger',
}

const TYPE_LABELS: Record<ItemType, string> = {
  text: 'Text',
  richtext: 'Rich text',
  image: 'Image',
  file: 'File',
  locked: 'Locked',
}

export interface SessionBoardProps {
  api: ItemsApi
  /** This device's role for the session; decides which items are editable. */
  role: SessionRole | null
}

export function SessionBoard(props: SessionBoardProps) {
  return (
    <WithMantine>
      <SessionBoardInner {...props} />
    </WithMantine>
  )
}

function SessionBoardInner({ api, role }: SessionBoardProps) {
  const items = useSessionStore((state) => state.items)
  const editable = isSenderRole(role)

  return (
    <section className="session-board" aria-label="Session items">
      {items.length === 0 ? (
        <p className="empty">
          {editable ? 'Nothing sent yet.' : 'Nothing received yet.'}
        </p>
      ) : (
        <ol className="session-board__list">
          {items.map((item) => (
            <li
              className="session-board__row"
              key={item.id}
              data-item-type={item.type}
              data-item-status={item.status}
            >
              <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Text span className="qrbit-text-label" c="dimmed">
                    {TYPE_LABELS[item.type]}
                  </Text>
                  {/*
                    The status the transport keeps for this item. It is the one piece
                    of per-item state that is meaningful on both sides equally.
                  */}
                  <Badge variant="light" color={STATUS_COLORS[item.status]} radius="full" ff="sans">
                    {STATUS_LABELS[item.status]}
                  </Badge>
                </Group>
                <ActionIcon
                  variant="subtle"
                  color="danger"
                  size="md"
                  aria-label={`Remove ${TYPE_LABELS[item.type].toLowerCase()} item`}
                  title={`Remove ${TYPE_LABELS[item.type].toLowerCase()} item`}
                  onClick={() => {
                    api.deleteItem(item.id)
                  }}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>

              {renderItem(item, editable, api)}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function renderItem(item: SessionItem, editable: boolean, api: ItemsApi) {
  switch (item.type) {
    case 'text':
      return (
        <TextItem
          item={item}
          editable={editable}
          onChange={(id, content) => {
            api.updateTextItem(id, content)
          }}
        />
      )
    case 'richtext':
      return (
        <RichTextItem
          item={item}
          editable={editable}
          onChange={(id, json) => {
            api.updateRichTextItem(id, json)
          }}
        />
      )
    case 'image':
      return <ImageItem item={item} />
    case 'file':
      return <FileItem item={item} />
    case 'locked':
      /*
        The one item whose sender and receiver views are the same shape (PLAN.md §9):
        both sides unlock the ciphertext with the password, and `sender` only decides
        whether the row states the inner type the author chose. The row owns the reveal;
        see `items/LockedItem.tsx`.
      */
      return (
        <LockedItem
          item={item}
          sender={editable}
          onUnlock={api.unlockItem}
          onLockAgain={api.lockItemAgain}
        />
      )
    default:
      return assertNever(item)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled item type: ${JSON.stringify(value)}`)
}

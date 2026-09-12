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
import { useSessionStore } from '../../store/sessionStore'
import type { ItemStatus, ItemType, LockedItem, SessionItem } from '../../store/sessionStore'
import { FileItem } from './items/FileItem'
import { ImageItem } from './items/ImageItem'
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

export function SessionBoard({ api, role }: SessionBoardProps) {
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
              <div className="session-board__row-header">
                <span className="session-board__type">{TYPE_LABELS[item.type]}</span>
                {/*
                  The status the transport keeps for this item. It is the one piece
                  of per-item state that is meaningful on both sides equally.
                */}
                <span className={`item-status item-status--${item.status}`}>
                  {STATUS_LABELS[item.status]}
                </span>
                <button
                  type="button"
                  className="session-board__remove"
                  aria-label={`Remove ${TYPE_LABELS[item.type].toLowerCase()} item`}
                  onClick={() => {
                    api.deleteItem(item.id)
                  }}
                >
                  ✕
                </button>
              </div>

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
      return <LockedItemRow item={item} />
    default:
      return assertNever(item)
  }
}

/**
 * Phase 4 owns locked items end to end (PLAN.md §16). Until then the label the
 * sender chose is all there is to show — no password field, no unlock, and no
 * ciphertext handling, all of which arrive with `LockedItem.tsx` in that phase.
 */
function LockedItemRow({ item }: { item: LockedItem }) {
  return (
    <p className="locked-item muted">
      <span className="locked-item__label">{item.label}</span> — locked; unlocking arrives in Phase 4.
    </p>
  )
}

function assertNever(value: never): never {
  throw new Error(`unhandled item type: ${JSON.stringify(value)}`)
}

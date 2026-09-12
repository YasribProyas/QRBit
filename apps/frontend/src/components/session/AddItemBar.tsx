/**
 * Add item bar (PLAN.md §9: "Add item bar (sender only)").
 *
 * Six actions are specified there — T text, ¶ rich text, 🖼 image, 📎 file,
 * 🔒 locked, 📚 from library — and five exist now:
 *
 *   - 🔒 opens the Phase 4 compose modal (label, inner type, password twice,
 *     content). The bar only opens it: the modal owns the draft and calls
 *     `addLockedItem`, which encrypts and sends.
 *   - 📚 (library picker) is Phase 5. It is not rendered at all, so the bar cannot
 *     imply a feature that does not exist.
 *
 * Every action calls the items API and the new item appears on the board through
 * the store immediately — the bar never writes item state itself.
 */

import { useRef, useState } from 'react'
import type { ItemsApi } from './SessionBoard'
import { LockedItemComposeModal } from './LockedItemComposeModal'
import type { LockedItemInput } from './LockedItemComposeModal'

/**
 * What this bar needs from the items API: the three add methods the board also
 * declares, plus the Phase 4 locked-item add (which encrypts before it sends and
 * therefore resolves asynchronously).
 */
export type AddItemBarApi = Pick<ItemsApi, 'addTextItem' | 'addRichTextItem' | 'addFileItem'> & {
  addLockedItem: (input: LockedItemInput) => Promise<string>
}

export interface AddItemBarProps {
  /** Only the add methods are used here; the rest of the API belongs to the board. */
  api: AddItemBarApi
  /**
   * D6's plaintext cap for a locked file item, forwarded to the compose modal.
   * Left unset by default so the modal's own D6 default applies; a caller that has
   * `crypto.ts`'s constant can pass it here to keep one source for the number.
   */
  maxLockedFileBytes?: number
}

export function AddItemBar({ api, maxLockedFileBytes }: AddItemBarProps) {
  const imageInput = useRef<HTMLInputElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [lockedComposeOpen, setLockedComposeOpen] = useState(false)

  /** Multi-select fans out to one item per file (PLAN.md §9: items are independent). */
  const addAll = (files: FileList | null): void => {
    if (files === null) return
    for (const file of Array.from(files)) {
      api.addFileItem(file)
    }
  }

  return (
    <>
      <div className="add-item-bar" role="toolbar" aria-label="Add item">
        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add text item"
          title="Text"
          onClick={() => {
            api.addTextItem()
          }}
        >
          T
        </button>

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add rich text item"
          title="Rich text"
          onClick={() => {
            api.addRichTextItem()
          }}
        >
          ¶
        </button>

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add images"
          title="Image"
          onClick={() => {
            imageInput.current?.click()
          }}
        >
          🖼
        </button>
        <input
          ref={imageInput}
          className="add-item-bar__image-input"
          type="file"
          accept="image/*"
          multiple
          hidden
          tabIndex={-1}
          onChange={(event) => {
            addAll(event.currentTarget.files)
            // Cleared so picking the same file twice in a row still fires a change.
            event.currentTarget.value = ''
          }}
        />

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add files"
          title="File"
          onClick={() => {
            fileInput.current?.click()
          }}
        >
          📎
        </button>
        <input
          ref={fileInput}
          className="add-item-bar__file-input"
          type="file"
          multiple
          hidden
          tabIndex={-1}
          onChange={(event) => {
            addAll(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />

        <button
          type="button"
          className="add-item-bar__button"
          aria-label="Add locked item"
          title="Locked item"
          onClick={() => {
            setLockedComposeOpen(true)
          }}
        >
          🔒
        </button>
        <p className="add-item-bar__hint muted">
          🔒 locked items also need a password to open — the label stays visible
        </p>
      </div>

      {/*
        Outside the toolbar: it is a modal dialog covering the page, not another
        control in the bar. Mounted only while open so the draft (and the password
        in it) exists for as long as the user is composing and no longer.
      */}
      {lockedComposeOpen ? (
        <LockedItemComposeModal
          onAdd={api.addLockedItem}
          onClose={() => {
            setLockedComposeOpen(false)
          }}
          maxFileBytes={maxLockedFileBytes}
        />
      ) : null}
    </>
  )
}

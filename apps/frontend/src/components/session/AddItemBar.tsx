/**
 * Add item bar (PLAN.md §9: "Add item bar (sender only)").
 *
 * Six actions are specified there — T text, ¶ rich text, 🖼 image, 📎 file,
 * 🔒 locked, 📚 from library — and only four can do anything yet:
 *
 *   - 🔒 is rendered *disabled*: composing a locked item is Phase 4, and PLAN.md
 *     §16 puts `encryptItem` in crypto.ts in that phase. The hint next to it says
 *     so instead of leaving a dead control with no explanation.
 *   - 📚 (library picker) is Phase 5. It is not rendered at all, so the bar cannot
 *     imply a feature that does not exist.
 *
 * Every action calls the items API and the new item appears on the board through
 * the store immediately — the bar never writes item state itself.
 */

import { useRef } from 'react'
import type { ItemsApi } from './SessionBoard'

export interface AddItemBarProps {
  /** Only the three add methods are used here; the rest of the API belongs to the board. */
  api: Pick<ItemsApi, 'addTextItem' | 'addRichTextItem' | 'addFileItem'>
}

export function AddItemBar({ api }: AddItemBarProps) {
  const imageInput = useRef<HTMLInputElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  /** Multi-select fans out to one item per file (PLAN.md §9: items are independent). */
  const addAll = (files: FileList | null): void => {
    if (files === null) return
    for (const file of Array.from(files)) {
      api.addFileItem(file)
    }
  }

  return (
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
        title="Locked items arrive in Phase 4"
        disabled
      >
        🔒
      </button>
      <p className="add-item-bar__hint muted">🔒 locked items arrive in Phase 4</p>
    </div>
  )
}

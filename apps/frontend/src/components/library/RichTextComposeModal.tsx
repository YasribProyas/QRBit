/**
 * Rich-text compose modal for the library's offline `¶` action (PLAN.md §6.1, §6.4).
 *
 * The editor is `components/session/items/RichTextItem.tsx` — this app's only Tiptap
 * wiring — so the document is serialised exactly the way the session board serialises it:
 * `JSON.stringify(editor.getJSON())`, stored as the §6.1 `content` string. That is what
 * makes a note authored here and a note received in a session render identically in
 * `LibraryItemRow`'s preview and in an export; a second editor configured separately is how
 * the two would drift.
 *
 * The name is optional at the keyboard: an unnamed note is filed under "Rich text note",
 * which is the name `lib/library.ts` gives a received one.
 */

import { useCallback, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { RichTextItem } from '../session/items/RichTextItem'
import type { RichTextItem as RichTextItemModel } from '../../store/sessionStore'

/**
 * What an untouched editor holds, in the same string form `RichTextItem` emits —
 * `getJSON()` of a StarterKit document with nothing in it is one empty paragraph. Saving a
 * named-but-empty note is a real item (§6.1 allows an empty `content`), and it is stored as
 * a document rather than as `''` so every reader of a richtext row parses the same thing.
 */
const EMPTY_RICH_TEXT_DOC = '{"type":"doc","content":[{"type":"paragraph"}]}'

export interface RichTextComposeModalProps {
  /** Receives the finished document; a rejection leaves the dialog open with its draft. */
  onSave: (name: string, content: string) => Promise<void> | void
  onClose: () => void
  /** The folder the note will be filed under, for the title to name it. */
  folderName?: string
}

export function RichTextComposeModal({ onSave, onClose, folderName }: RichTextComposeModalProps) {
  const [name, setName] = useState('')
  const [richTextJson, setRichTextJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * Built once, on purpose: `RichTextItem`'s `useEditor` reads `item.content` when it
   * creates the instance, and handing it a new object every render is how a controlled
   * editor starts fighting the caret. The id is a placeholder — a draft is not a board row
   * and gets no uuid until `NewItemBar` saves one.
   */
  const [draftItem] = useState<RichTextItemModel>(() => ({
    id: 'richtext-compose-draft',
    type: 'richtext',
    status: 'complete',
    createdAt: 0,
    content: '',
  }))

  /** Stable so the editor never re-binds its update handler while the dialog is open. */
  const handleRichTextChange = useCallback((_id: string, json: string): void => {
    setRichTextJson(json)
  }, [])

  const trimmedName = name.trim()
  const canSubmit = !busy && (trimmedName !== '' || richTextJson.trim() !== '')

  /** Latch beside `busy` — see the note in `TextComposeModal` on a double submit. */
  const inFlight = useRef(false)

  const submit = async (): Promise<void> => {
    if (inFlight.current || !canSubmit) return

    inFlight.current = true
    setBusy(true)
    setError(null)

    const finalName = trimmedName || 'Rich text note'
    const finalContent = richTextJson.trim() !== '' ? richTextJson : EMPTY_RICH_TEXT_DOC

    try {
      await onSave(finalName, finalContent)
      onClose()
    } catch (cause: unknown) {
      inFlight.current = false
      setBusy(false)
      const detail = cause instanceof Error && cause.message.trim() !== '' ? ` (${cause.message})` : ''
      setError(`Could not save the rich text note${detail}.`)
    }
  }

  return (
    <div
      className="library-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="richtext-compose-title"
    >
      <form
        className="library-modal__panel"
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2 className="library-modal__title" id="richtext-compose-title">
          New rich text note{folderName ? ` in ${folderName}` : ''}
        </h2>

        <label className="library-modal__field">
          <span className="library-modal__field-label">Name</span>
          <input
            className="library-modal__input"
            type="text"
            value={name}
            aria-label="Name"
            placeholder="e.g. Project plan"
            autoComplete="off"
            autoFocus
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </label>

        <div className="library-modal__field">
          <span className="library-modal__field-label">Content</span>
          {/*
            No wrapper of its own: `.richtext-item .ProseMirror` already brings the field
            styling (surface, border, padding, min-height) that the in-session editor uses,
            so a second box would frame the editor twice.
          */}
          <RichTextItem
            item={draftItem}
            editable
            onChange={handleRichTextChange}
          />
        </div>

        {error !== null ? (
          <p className="library-modal__error item-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="library-modal__actions">
          <button
            type="submit"
            className="button library-modal__submit"
            disabled={!canSubmit}
          >
            {busy ? 'Saving…' : 'Save to library'}
          </button>
          <button
            type="button"
            className="button library-modal__cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

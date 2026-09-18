/**
 * Text compose modal for the library's offline `T` action (PLAN.md §6.1, §6.4).
 *
 * Asks for a name and a body and hands them to `onSave` — no session, no network, no
 * `PeerConnection`. The body reuses `components/session/items/TextItem.tsx` in its
 * `editable` form rather than opening a second textarea, so the widget that authors a
 * note in a session is the same one that authors one at rest and the two cannot drift.
 *
 * The name is optional at the keyboard: an unnamed note is filed under "Text note", the
 * same default `lib/library.ts` gives a received one.
 */

import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { TextItem } from '../session/items/TextItem'
import type { TextItem as TextItemModel } from '../../store/sessionStore'

export interface TextComposeModalProps {
  /** Receives the finished note; a rejection leaves the dialog open with its draft. */
  onSave: (name: string, content: string) => Promise<void> | void
  onClose: () => void
  /** The folder the note will be filed under, for the title to name it. */
  folderName?: string
}

export function TextComposeModal({ onSave, onClose, folderName }: TextComposeModalProps) {
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * `TextItem` is this app's only text-entry widget (PLAN.md §9's sender view), so the
   * compose step feeds it a draft item rather than reimplementing an input it already
   * owns. The draft is built once — `useState`'s initialiser runs on mount only, which is
   * what keeps the editor's internal copy from being reset on every keystroke — and the id
   * is a placeholder: a draft is not a row and has no uuid until `NewItemBar` saves one.
   */
  const [draftItem] = useState<TextItemModel>(() => ({
    id: 'text-compose-draft',
    type: 'text',
    status: 'complete',
    createdAt: 0,
    content: '',
  }))

  const trimmedName = name.trim()
  const canSubmit = !busy && (trimmedName !== '' || content.trim() !== '')

  /*
   * A latch beside `busy`, for the same reason `LockedItemComposeModal` has one: `setBusy`
   * is batched, so two submits in one tick would both read the pre-update value and store
   * the same note twice. A duplicated library row is permanent, so this one is worth the
   * ref. A ref flips synchronously.
   */
  const inFlight = useRef(false)

  const submit = async (): Promise<void> => {
    if (inFlight.current || !canSubmit) return

    inFlight.current = true
    setBusy(true)
    setError(null)

    const finalName = trimmedName || 'Text note'

    try {
      await onSave(finalName, content)
      onClose()
    } catch (cause: unknown) {
      inFlight.current = false
      setBusy(false)
      const detail = cause instanceof Error && cause.message.trim() !== '' ? ` (${cause.message})` : ''
      setError(`Could not save the text note${detail}.`)
    }
  }

  return (
    <div
      className="library-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="text-compose-title"
    >
      <form
        className="library-modal__panel"
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2 className="library-modal__title" id="text-compose-title">
          New text note{folderName ? ` in ${folderName}` : ''}
        </h2>

        <label className="library-modal__field">
          <span className="library-modal__field-label">Name</span>
          <input
            className="library-modal__input"
            type="text"
            value={name}
            aria-label="Name"
            placeholder="e.g. Meeting notes"
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
            `editable` stays true while a save is in flight, exactly as the in-session
            locked composer does (`LockedItemComposeModal`). Flipping it would swap
            `TextItem` for its read-only view — which renders the frozen draft, not what is
            on screen — for the length of one IndexedDB write, and a field that visibly
            empties itself is worse than one that is merely still typing.
          */}
          <TextItem
            item={draftItem}
            editable
            onChange={(_id, newContent) => {
              setContent(newContent)
            }}
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

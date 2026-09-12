/**
 * New folder dialog (PLAN.md §6.4's "+ New Folder", §16 Phase 5).
 *
 * The parent is fixed by the browser: a new folder is created inside the folder the
 * user is looking at, with the root as `null` (PLAN.md §6.3's `createFolder(name,
 * parentId: string | null)`). The dialog says which folder that is, so "created
 * inside the folder I am looking at" is never a guess.
 *
 * Validation is deliberately one rule: a folder needs a non-empty name. The name is
 * trimmed before it is handed over — a name that is only whitespace is not a name,
 * and a trailing space is invisible in the tree.
 *
 * The create callback is the store's, so it can be asynchronous (IndexedDB). The
 * dialog stays open and busy until it settles, and reports a rejection instead of
 * closing and leaving the user to wonder whether the folder exists.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'

export interface NewFolderModalProps {
  /** The folder the new one goes inside; `null` is the tree's Root. */
  parentId: string | null
  /** The parent's display name, shown in the title. */
  parentName: string
  onCreate: (name: string, parentId: string | null) => Promise<void> | void
  onClose: () => void
}

export function NewFolderModal({ parentId, parentName, onCreate, onClose }: NewFolderModalProps) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()

  const submit = async (): Promise<void> => {
    if (busy || trimmed === '') return

    setBusy(true)
    setError(null)

    try {
      await onCreate(trimmed, parentId)
    } catch (cause: unknown) {
      setBusy(false)
      setError(failureMessage(cause))
      return
    }

    setBusy(false)
    onClose()
  }

  return (
    <div
      className="library-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-folder-title"
    >
      <form
        className="library-modal__panel"
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2 className="library-modal__title" id="new-folder-title">
          New folder in {parentName}
        </h2>

        <label className="library-modal__field">
          <span className="library-modal__field-label">Folder name</span>
          <input
            className="library-modal__input"
            type="text"
            value={name}
            aria-label="Folder name"
            autoComplete="off"
            autoFocus
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </label>

        {error !== null ? (
          <p className="library-modal__error item-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="library-modal__actions">
          <button
            type="submit"
            className="button library-modal__submit"
            disabled={busy || trimmed === ''}
          >
            {busy ? 'Creating…' : 'Create'}
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

function failureMessage(cause: unknown): string {
  const detail = cause instanceof Error && cause.message.trim() !== '' ? ` (${cause.message})` : ''
  return `Could not create the folder${detail}.`
}

/**
 * Save-to-library dialog, shown on the session's ended screen (PLAN.md §8 Phase 4
 * "Save to Library →", §16 Phase 5).
 *
 * The session's items are in memory and die with it (PLAN.md §1), so this is the one
 * moment a received item can be kept. The dialog is presentational: it knows nothing
 * about IndexedDB, the session store or `saveFromSession`, and reports choices back
 * through callbacks — the page performs the saving.
 *
 * Two shapes of "save" are offered because both are wanted in practice: one folder
 * choice for the batch, and a per-item save for the one thing that mattered. Either
 * way the callback receives `(itemId, folderId)`, with `null` for the tree's Root.
 *
 * Items whose transfer never finished are not saveable — PLAN.md §17's rule that a
 * half-transfer must never be persisted, stated in the UI (their button is disabled
 * with the reason) instead of failing silently. Items the page has already saved are
 * reported through `savedIds` so the dialog can show that state rather than offer the
 * same save twice.
 */

import { useState } from 'react'
import { FolderPicker } from './FolderPicker'
import { ITEM_TYPE_ICONS } from '../../lib/itemType'
import type { LibraryFolder, LibraryItemType } from '../../lib/library'

/** One session item as this dialog needs it: an id, a name and its type. */
export interface SaveableSessionItem {
  /** The session item's id (the page maps it to the item it is saving). */
  id: string
  /** Display name: a file name, a note's summary or a locked item's label. */
  name: string
  type: LibraryItemType
  /** False when the transfer never finished — nothing to save. */
  complete: boolean
}

export interface SaveToLibraryModalProps {
  items: SaveableSessionItem[]
  /** Every folder, for the picker's tree. */
  folders: LibraryFolder[]
  /** Ids the page has already saved; those rows show 'Saved'. */
  savedIds?: string[]
  onSaveItem: (itemId: string, folderId: string | null) => void | Promise<void>
  /** Saves every complete, not-yet-saved item into one folder. */
  onSaveAll: (folderId: string | null) => void | Promise<void>
  onClose: () => void
}

export function SaveToLibraryModal({
  items,
  folders,
  savedIds = [],
  onSaveItem,
  onSaveAll,
  onClose,
}: SaveToLibraryModalProps) {
  /** The folder every save in this dialog goes into; `null` is the tree's Root. */
  const [folderId, setFolderId] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const saveable = items.filter((item) => item.complete && !savedIds.includes(item.id))

  /*
   * One save in flight at a time. The callbacks are the page's, so they can be
   * asynchronous (IndexedDB, and `saveFromSession` per item); the dialog waits for the
   * one it started before accepting the next, and reports a rejection instead of
   * pretending the item was kept.
   */
  const runSave = async (key: string, save: () => void | Promise<void>): Promise<void> => {
    if (pending !== null) return

    setPending(key)
    setError(null)

    try {
      await save()
    } catch (cause: unknown) {
      setError(failureMessage(cause))
    }

    setPending(null)
  }

  return (
    <div
      className="library-modal library-modal--save"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-to-library-title"
    >
      <div className="library-modal__panel">
        <h2 className="library-modal__title" id="save-to-library-title">
          Save to library
        </h2>
        <p className="library-modal__hint muted">
          Saved items are kept in this browser only — never uploaded, never synced.
        </p>

        <p className="library-modal__field-label">Folder</p>
        <FolderPicker
          folders={folders}
          value={folderId}
          onChange={setFolderId}
          label="Save to folder"
        />

        <button
          type="button"
          className="button library-modal__save-all"
          disabled={saveable.length === 0 || pending !== null}
          onClick={() => {
            void runSave('all', () => onSaveAll(folderId))
          }}
        >
          Save all ({saveable.length})
        </button>

        {items.length === 0 ? (
          <p className="library-modal__empty muted">No received items to save.</p>
        ) : (
          <ul className="library-modal__items">
            {items.map((item) => {
              const saved = savedIds.includes(item.id)

              return (
                <li
                  key={item.id}
                  className="library-modal__item"
                  data-saved={saved ? 'true' : undefined}
                >
                  <span className="library-item__icon" aria-hidden="true">
                    {ITEM_TYPE_ICONS[item.type]}
                  </span>
                  <span className="library-modal__item-name">{item.name}</span>

                  {saved ? (
                    <span className="badge library-modal__saved">Saved</span>
                  ) : (
                    <button
                      type="button"
                      className="button button--link library-modal__save"
                      disabled={!item.complete || pending !== null}
                      title={item.complete ? undefined : 'The transfer did not finish'}
                      onClick={() => {
                        void runSave(item.id, () => onSaveItem(item.id, folderId))
                      }}
                    >
                      Save
                    </button>
                  )}

                  {!item.complete ? (
                    <span className="library-modal__item-note muted">Transfer did not finish</span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}

        {error !== null ? (
          <p className="library-modal__error item-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="library-modal__actions">
          <button
            type="button"
            className="button library-modal__done"
            onClick={onClose}
            disabled={pending !== null}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function failureMessage(cause: unknown): string {
  const detail = cause instanceof Error && cause.message.trim() !== '' ? ` (${cause.message})` : ''
  return `Could not save to the library${detail}.`
}

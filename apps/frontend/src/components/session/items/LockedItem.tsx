/**
 * Locked item row (PLAN.md §9's `locked` row, §16 Phase 4).
 *
 * A locked item is a secret a session carries without either device being able to
 * read it in transit: the sender encrypts the content locally under a password
 * before the item is announced, and that password never travels. PLAN.md §9 gives
 * the item two views, and they differ only in what the sender already knows:
 *
 *   - SENDER — label, 🔒 badge and the inner type the sender chose. The sender
 *     knows the password, so the row keeps its Unlock affordance: it is the only
 *     way to check the item really decrypts back to what was meant.
 *   - RECEIVER — label and 🔒 badge only, plus the same Unlock affordance
 *     (PLAN.md §9: "Label only + Unlock → password modal → inline reveal").
 *
 * Encryption, the wrong-password outcome and the memory-only plaintext all belong
 * to the items API (see the Phase 4 contract): this component renders the state the
 * store holds and calls `onUnlock` / `onLockAgain`, so it knows nothing about
 * crypto, frames or the DataChannel.
 *
 * The label is plaintext by design (PLAN.md §9): it is the item's public name, and
 * it is what the receiver picks the password against.
 *
 * Unlocked plaintext lives on the store's item for the lifetime of the session and
 * nowhere else — AGENTS.md forbids IndexedDB, the Cache API and localStorage. The
 * one resource this component owns is the download URL of an unlocked file, which
 * is revoked when the item is locked again and when the row unmounts.
 */

import { useEffect, useState } from 'react'
import type {
  LockedItem as LockedItemModel,
  RichTextItem as RichTextItemModel,
} from '../../../store/sessionStore'
import { UnlockModal } from '../UnlockModal'
import { RichTextItem } from './RichTextItem'

export interface LockedItemViewProps {
  /** The store's copy of this item. */
  item: LockedItemModel
  /** True on the device that authored the item (PLAN.md §9's sender view). */
  sender: boolean
  /**
   * Decrypts with the given password. Resolves true on success, false for a wrong
   * password, and rejects only for infrastructure failures (the item is gone, the
   * channel is dead) — the split `UnlockModal` renders as two different messages.
   */
  onUnlock: (id: string, password: string) => Promise<boolean>
  /** Re-hides the item: `unlocked = false` and the plaintext is dropped from memory. */
  onLockAgain: (id: string) => void
}

const INNER_TYPE_LABELS: Record<LockedItemModel['innerType'], string> = {
  text: 'Text',
  richtext: 'Rich text',
  file: 'File',
}

export function LockedItem({ item, sender, onUnlock, onLockAgain }: LockedItemViewProps) {
  const [unlockOpen, setUnlockOpen] = useState(false)

  /*
   * `unlocked` is only ever true on the device that decrypted the item, and only
   * while the session lives. Until the locked payload arrives the item is not
   * `complete` and there is nothing to decrypt, so the affordance waits.
   */
  const unlocked = item.unlocked === true
  const canUnlock = !unlocked && item.status === 'complete'

  return (
    <div className="locked-item">
      <div className="locked-item__row">
        <span className="locked-item__badge" aria-hidden="true">
          🔒
        </span>
        <span className="locked-item__label">{item.label}</span>
        {/* Only the sender chose the type, and only the sender's row states it. */}
        {sender ? (
          <span className="locked-item__inner-type">{INNER_TYPE_LABELS[item.innerType]}</span>
        ) : null}

        {canUnlock ? (
          <button
            type="button"
            className="button button--link locked-item__unlock"
            title={
              sender
                ? 'Check this item with the password you set'
                : 'Enter the password for this item'
            }
            onClick={() => {
              setUnlockOpen(true)
            }}
          >
            Unlock
          </button>
        ) : null}

        {unlocked ? (
          <button
            type="button"
            className="button button--link locked-item__lock-again"
            onClick={() => {
              onLockAgain(item.id)
            }}
          >
            Lock again
          </button>
        ) : null}
      </div>

      {unlocked ? (
        <LockedReveal item={item} />
      ) : canUnlock ? null : (
        <p className="locked-item__pending muted">
          {item.status === 'error'
            ? 'The locked payload did not arrive.'
            : 'Waiting for the encrypted payload…'}
        </p>
      )}

      {unlockOpen ? (
        <UnlockModal
          label={item.label}
          onSubmit={(password) => onUnlock(item.id, password)}
          onClose={() => {
            setUnlockOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

/** The inline reveal PLAN.md §9 asks for, one rendering path per inner type. */
function LockedReveal({ item }: { item: LockedItemModel }) {
  const plaintext = item.plaintextContent

  if (item.innerType === 'file') {
    if (!(plaintext instanceof Blob)) return <LockedPlaintextMissing />
    return <LockedFileReveal fileNameFallback={item.label} blob={plaintext} />
  }

  if (typeof plaintext !== 'string') return <LockedPlaintextMissing />

  if (item.innerType === 'richtext') {
    return <LockedRichTextReveal id={item.id} createdAt={item.createdAt} json={plaintext} />
  }

  return <p className="locked-item__reveal locked-item__text">{plaintext}</p>
}

/**
 * A file-sized unlock can only produce a Blob; `unlocked` without plaintext means
 * the store was left half-updated, so the row says so instead of rendering nothing.
 */
function LockedPlaintextMissing() {
  return (
    <p className="locked-item__error item-error" role="alert">
      The unlocked contents are missing — lock the item again and retry.
    </p>
  )
}

/**
 * Read-only. `RichTextItem` is the app's only richtext renderer — it owns the Tiptap
 * setup and the JSON parsing — so the reveal reuses it with a draft item, exactly
 * the path a received `richtext` row takes.
 */
function LockedRichTextReveal({
  id,
  createdAt,
  json,
}: {
  id: string
  createdAt: number
  json: string
}) {
  const draft: RichTextItemModel = {
    id,
    type: 'richtext',
    status: 'complete',
    createdAt,
    content: json,
  }

  return (
    <div className="locked-item__reveal">
      <RichTextItem item={draft} editable={false} onChange={NO_EDIT} />
    </div>
  )
}

/** Never called: `editable={false}` keeps the reveal from emitting an update. */
const NO_EDIT = (): void => {}

function LockedFileReveal({ fileNameFallback, blob }: { fileNameFallback: string; blob: Blob }) {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)

  /*
   * Keyed on the Blob alone. Re-locking clears `plaintextContent`, which unmounts
   * this component and runs the cleanup — that is the "revoked on re-lock" half;
   * unmount (an item removal or a session end) is the other.
   */
  useEffect(() => {
    const created = URL.createObjectURL(blob)
    setDownloadUrl(created)
    return () => {
      URL.revokeObjectURL(created)
    }
  }, [blob])

  /*
   * The locked payload carries no file name — PLAN.md §9's LockedItem has no such
   * field and the name would be a plaintext leak — so the decrypted File's own name
   * is used when the plaintext still is one, and the label stands in otherwise.
   */
  const fileName = blob instanceof File ? blob.name : fileNameFallback

  if (downloadUrl === null) return null

  return (
    <a
      className="file-item__download locked-item__download"
      href={downloadUrl}
      download={fileName}
    >
      Download
    </a>
  )
}

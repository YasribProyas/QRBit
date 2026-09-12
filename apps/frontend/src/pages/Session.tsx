import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AddItemBar } from '../components/session/AddItemBar'
import { SafetyPhraseOverlay } from '../components/session/SafetyPhraseOverlay'
import { SessionBoard, isSenderRole } from '../components/session/SessionBoard'
import { SaveToLibraryModal } from '../components/library/SaveToLibraryModal'
import { ITEM_TYPE_ICONS } from '../components/library/LibraryItemRow'
import type { SaveableSessionItem } from '../components/library/SaveToLibraryModal'
import { useSession } from '../hooks/useSession'
import type { UseSessionResult } from '../hooks/useSession'
import { LOCKED_ITEM_MAX_PLAINTEXT_BYTES } from '../lib/crypto'
import { useLibraryStore } from '../store/libraryStore'
import type { SessionItem } from '../store/sessionStore'

/**
 * Session page (PLAN.md §8).
 *
 * Role comes from the URL: `?code=XXXXXXXX` means this device scanned a peer and
 * is the guest; no code means this device is the host whose QR was scanned.
 *
 * The page stays presentational: `useSession` owns the handshake, the safety phrase
 * and the both-sides confirmation gate.
 */
export function Session() {
  const [searchParams] = useSearchParams()

  const rawCode = searchParams.get('code')
  const code = rawCode !== null && rawCode.trim() !== '' ? rawCode.trim() : null

  const session = useSession({ code })

  return (
    <main className="page">
      <header className="page__header">
        <Link className="link" to="/">
          ← QRDrop
        </Link>
        <span className="badge">{session.role ?? 'assigning'}</span>
      </header>

      <div className={`status status--${session.status.tone}`} role="status" aria-live="polite">
        <span className="status__dot" aria-hidden="true" />
        <span>{session.status.label}</span>
      </div>

      <p className="muted">{session.roleLabel}</p>

      {session.sessionCode !== null ? (
        <section className="panel">
          <h2 className="panel__title">Session code</h2>
          <p className="code">{session.sessionCode}</p>
          <p className="muted">
            On the other device, open <code>/session?code={session.sessionCode}</code>
          </p>
        </section>
      ) : null}

      {session.errorMessage !== null ? (
        <section className="panel panel--error">
          <h2 className="panel__title">Error</h2>
          <p>{session.errorMessage}</p>
          <button type="button" className="button" onClick={session.restart}>
            Try again
          </button>
        </section>
      ) : null}

      {/*
        A clean end (the overlay's Abort, or the peer ending the session) has no
        error to show, but it still needs a way back to a fresh session: PLAN.md §19
        decision 10 makes sessions single-use, so "again" always means "new".

        PLAN.md §8 Phase 4: this is also the last moment a RECEIVED item can be kept,
        because unsaved items die with the session (PLAN.md §1). The save section is
        shown for an errored end too — the items that did arrive are just as real, and
        the error panel above already carries the reason.
      */}
      {session.phase === 'ended' ? (
        <section className="panel">
          <SessionEnded api={session} />
        </section>
      ) : null}

      {/*
        PLAN.md §8 Phase 3: the board *is* the active session. The Phase 1/2
        channel-check panel is gone with it — the both-sides encrypted
        phrase-confirm already proved the channel, so a hello exchange would prove
        nothing new about it.

        The add bar is sender-only (PLAN.md §9), but both devices render the board:
        the receiver's copy fills in as items and chunks arrive, which is the
        symmetric view PLAN.md §1 asks for. 'verified' is deliberately not handled:
        the phase sequence is connecting → pairing → active → ended.
      */}
      {session.phase === 'active' ? (
        <>
          {/*
            D6's cap reaches the compose modal from the one module that owns the number
            (`lib/crypto.ts`), rather than from a second copy in the UI.
          */}
          {isSenderRole(session.role) ? (
            <AddItemBar api={session} maxLockedFileBytes={LOCKED_ITEM_MAX_PLAINTEXT_BYTES} />
          ) : null}
          <SessionBoard api={session} role={session.role} />
        </>
      ) : null}

      {/*
        PLAN.md §8 Phase 2: the full-screen overlay is up from the moment the phrase
        exists until BOTH devices have confirmed. `busy` is left at its default so the
        Abort button stays usable while this device waits for the peer to confirm.
      */}
      {session.phase === 'pairing' && session.safetyPhrase !== null ? (
        <SafetyPhraseOverlay
          phrase={session.safetyPhrase}
          confirmed={session.phraseConfirmed}
          peerConfirmed={session.peerConfirmed}
          onConfirm={session.confirmPhrase}
          onAbort={session.abort}
        />
      ) : null}
    </main>
  )
}

/**
 * The ended screen's save section (PLAN.md §8 Phase 4, §16 Phase 5).
 *
 * Only the RECEIVED items are offered: the hook reports them as the items this device
 * did not create, because the ones it did create either already exist in the library
 * (they were sent FROM it) or are the user's own composition on the other side of a
 * transfer they just made. A received item is in memory only and dies with the session
 * (PLAN.md §1), so this is its one chance to be kept.
 *
 * Saving is explicit and per item, even for 'Save all': `saveFromSession` writes one
 * row per item, and an item whose transfer never finished has no bytes to write — its
 * row is disabled in the dialog with the reason (PLAN.md §17), never stored truncated.
 * Nothing is decrypted on the way in: a locked item is stored as the exact
 * `{ciphertext, iv, salt}` tuple it arrived with (decision D9).
 *
 * The library lives in IndexedDB and the folders are the dialog's picker, so the section
 * refreshes the store on mount; a failure shows under the buttons rather than throwing
 * into the render.
 */
function SessionEnded({ api }: { api: UseSessionResult }) {
  const folders = useLibraryStore((state) => state.folders)
  const error = useLibraryStore((state) => state.error)
  const refresh = useLibraryStore((state) => state.refresh)
  const saveFromSession = useLibraryStore((state) => state.saveFromSession)

  /** Session item ids this device has already stored; the dialog shows them as 'Saved'. */
  const [savedIds, setSavedIds] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const received = api.receivedItems
  const rows = received.map(saveableRow)

  const saveItem = async (itemId: string, folderId: string | null): Promise<void> => {
    const item = received.find((candidate) => candidate.id === itemId)
    if (item === undefined) throw new Error('this session no longer has that item')

    await saveFromSession(item, folderId)
    setSavedIds((ids) => (ids.includes(itemId) ? ids : [...ids, itemId]))
  }

  /** PLAN.md §8 Phase 4's batch: one `saveFromSession` call per complete, unsaved item. */
  const saveAll = async (folderId: string | null): Promise<void> => {
    for (const row of rows) {
      if (!row.complete || savedIds.includes(row.id)) continue
      await saveItem(row.id, folderId)
    }
  }

  return (
    <>
      <h2 className="panel__title">Session ended</h2>

      {received.length === 0 ? (
        <p className="muted">No items were received from the other device.</p>
      ) : (
        <>
          <p className="muted">
            {received.length} received {received.length === 1 ? 'item' : 'items'} — save what
            you want to keep. Anything you leave is discarded with the session.
          </p>
          <ul className="session-ended__items library-modal__items">
            {rows.map((row) => (
              <li
                className="library-modal__item"
                key={row.id}
                data-saved={savedIds.includes(row.id) ? 'true' : undefined}
              >
                <span className="library-item__icon" aria-hidden="true">
                  {ITEM_TYPE_ICONS[row.type]}
                </span>
                <span className="library-modal__item-name">{row.name}</span>
                {savedIds.includes(row.id) ? (
                  <span className="badge library-modal__saved">Saved</span>
                ) : null}
                {!row.complete ? (
                  <span className="library-modal__item-note muted">Transfer did not finish</span>
                ) : null}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="button session-ended__save"
            onClick={() => {
              setPickerOpen(true)
            }}
          >
            Save to Library →
          </button>
        </>
      )}

      {error !== null ? (
        <p className="library-modal__error item-error" role="alert">
          {error}
        </p>
      ) : null}

      {api.errorMessage === null ? (
        <button type="button" className="button" onClick={api.restart}>
          Start a new session
        </button>
      ) : null}

      {pickerOpen ? (
        <SaveToLibraryModal
          items={rows}
          folders={folders}
          savedIds={savedIds}
          onSaveItem={saveItem}
          onSaveAll={saveAll}
          onClose={() => {
            setPickerOpen(false)
          }}
        />
      ) : null}
    </>
  )
}

/** Note names are clipped to the same width the library uses for them. */
const NOTE_NAME_MAX_LENGTH = 40

/**
 * One session item as the save dialog needs it.
 *
 * The name here is the dialog row's label, not what gets stored: `saveFromSession`
 * (lib/library.ts) names the stored item itself (a note's opening words, a locked item's
 * label, a file's name). This mirrors that naming just far enough to be recognisable.
 */
function saveableRow(item: SessionItem): SaveableSessionItem {
  return {
    id: item.id,
    name: displayName(item),
    type: item.type,
    complete: item.status === 'complete',
  }
}

function displayName(item: SessionItem): string {
  switch (item.type) {
    case 'text': {
      const collapsed = item.content.trim().replace(/\s+/g, ' ')
      if (collapsed === '') return 'Text note'
      return collapsed.length <= NOTE_NAME_MAX_LENGTH
        ? collapsed
        : `${collapsed.slice(0, NOTE_NAME_MAX_LENGTH)}…`
    }
    case 'richtext':
      return 'Rich text note'
    case 'locked':
      return item.label.trim() === '' ? 'Locked item' : item.label
    case 'image':
    case 'file':
      if (item.fileName.trim() !== '') return item.fileName
      return item.type === 'image' ? 'Image' : 'File'
  }
}

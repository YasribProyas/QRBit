import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AddItemBar } from './AddItemBar'
import { QRDisplay } from '../QRDisplay'
import { SafetyPhraseOverlay } from './SafetyPhraseOverlay'
import { SessionBoard, isSenderRole } from './SessionBoard'
import { SaveToLibraryModal } from '../library/SaveToLibraryModal'
import { ITEM_TYPE_ICONS } from '../library/LibraryItemRow'
import { APP_URL } from '../../config'
import type { SaveableSessionItem } from '../library/SaveToLibraryModal'
import type { UseSessionResult } from '../../hooks/useSession'
import { LOCKED_ITEM_MAX_PLAINTEXT_BYTES } from '../../lib/crypto'
import { useLibraryStore } from '../../store/libraryStore'
import type { SessionItem } from '../../store/sessionStore'

export interface SessionViewProps {
  session: UseSessionResult
  /**
   * Whether to display the code/QR panel while connecting.
   * Defaults to true.
   */
  showConnectingCode?: boolean
}

/**
 * Shared session UI view (PLAN.md §8, ORCHESTRATION.md D13/D14).
 *
 * Renders the session surface across both `/` (when active) and `/session`:
 * the status bar, role label, connecting code/QR panel, error recovery,
 * pairing safety-phrase overlay, active board, and ended-session save flow.
 */
export function SessionView({ session, showConnectingCode = true }: SessionViewProps) {
  const { notifyUnload, phase } = session

  useEffect(() => {
    if (phase !== 'active' && phase !== 'pairing') return

    const handleBeforeUnload = (): void => {
      notifyUnload()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [phase, notifyUnload])

  return (
    <>
      <div className={`status status--${session.status.tone}`} role="status" aria-live="polite">
        <span className="status__dot" aria-hidden="true" />
        <span>{session.status.label}</span>
      </div>

      <p className="muted">{session.roleLabel}</p>

      {showConnectingCode &&
      session.sessionCode !== null &&
      session.role !== null &&
      !isSenderRole(session.role) &&
      session.phase === 'connecting' ? (
        <section className="panel session-qr">
          {import.meta.env.DEV && new URL(APP_URL).origin !== window.location.origin ? (
            <p className="item-error" role="alert">
              Dev warning: VITE_APP_URL ({APP_URL}) does not match this page's origin
              ({window.location.origin}). The QR encodes the wrong URL and cannot be scanned.
            </p>
          ) : null}
          <h2 className="panel__title">Scan to send files here</h2>
          <QRDisplay code={session.sessionCode} />
          <p className="code">{session.sessionCode}</p>
          <p className="muted">
            On the other device, open <code>{`${APP_URL}/session?code=${session.sessionCode}`}</code>
          </p>
        </section>
      ) : null}

      {showConnectingCode &&
      session.sessionCode !== null &&
      session.role !== null &&
      isSenderRole(session.role) &&
      session.phase === 'connecting' ? (
        <section className="panel">
          <h2 className="panel__title">Session code</h2>
          <p className="code">{session.sessionCode}</p>
          <p className="muted">
            On the other device, open <code>/session?code={session.sessionCode}</code>
          </p>
          <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }}>
            <Link
              className="link button"
              to="/"
              style={{ textAlign: 'center', textDecoration: 'none', width: 'auto', padding: '0.6rem 1.5rem' }}
              onClick={() => session.abort()}
            >
              Cancel &amp; Return Home
            </Link>
          </div>
        </section>
      ) : null}

      {session.errorMessage !== null ? (
        <section className="panel panel--error home__qr-error" role="alert">
          <h2 className="panel__title">Error</h2>
          <p className="muted">Could not reach the signaling server.</p>
          <p className="item-error">{session.errorMessage}</p>
          <div className="session-error__actions">
            <button type="button" className="button" onClick={session.restart}>
              Try again
            </button>
            <Link className="link" to="/">
              Go to home
            </Link>
          </div>
        </section>
      ) : null}

      {session.phase === 'ended' ? (
        <section className="panel">
          <SessionEnded api={session} />
        </section>
      ) : null}

      {session.phase === 'active' ? (
        <>
          {isSenderRole(session.role) ? (
            <AddItemBar api={session} maxLockedFileBytes={LOCKED_ITEM_MAX_PLAINTEXT_BYTES} />
          ) : null}
          <SessionBoard api={session} role={session.role} />
        </>
      ) : null}

      {session.phase === 'pairing' && session.safetyPhrase !== null ? (
        <SafetyPhraseOverlay
          phrase={session.safetyPhrase}
          confirmed={session.phraseConfirmed}
          peerConfirmed={session.peerConfirmed}
          onConfirm={session.confirmPhrase}
          onAbort={session.abort}
          isSender={isSenderRole(session.role)}
          role={session.role}
        />
      ) : null}
    </>
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
 */
export function SessionEnded({ api }: { api: UseSessionResult }) {
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
        {api.errorMessage === null ? (
          <button type="button" className="button" onClick={api.restart}>
            Start a new session
          </button>
        ) : null}
        <Link
          className="link"
          to="/"
          style={{ textAlign: 'center', padding: '0.4rem', textDecoration: 'none', color: 'var(--text-muted)' }}
        >
          ← Return to Home
        </Link>
      </div>

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

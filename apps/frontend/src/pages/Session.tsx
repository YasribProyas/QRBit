import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { AddItemBar } from '../components/session/AddItemBar'
import { QRDisplay } from '../components/QRDisplay'
import { SafetyPhraseOverlay } from '../components/session/SafetyPhraseOverlay'
import { SessionBoard, isSenderRole } from '../components/session/SessionBoard'
import { SaveToLibraryModal } from '../components/library/SaveToLibraryModal'
import { ITEM_TYPE_ICONS } from '../components/library/LibraryItemRow'
import { APP_URL } from '../config'
import type { SaveableSessionItem } from '../components/library/SaveToLibraryModal'
import { useSession } from '../hooks/useSession'
import type { HostSession, UseSessionResult } from '../hooks/useSession'
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
  const location = useLocation()

  const rawCode = searchParams.get('code')
  const code = rawCode !== null && rawCode.trim() !== '' ? rawCode.trim() : null

  /*
   * The host bundle Home minted and carried in router state (PLAN.md §16 Phase 6). Only
   * the host path uses it: a `?code=` URL is always the guest (PLAN.md §8), whatever else
   * the navigation carried. If the code is absent or malformed, `useSession` mints fresh.
   */
  const hostSession = code === null ? hostSessionFromState(location.state) : null

  const session = useSession({ code, hostSession })

  /*
   * GET share target (ORCHESTRATION.md D12): reads ?url, ?text, ?title on mount.
   * Prefers url > text > title. When present, composes an item ready to send once the session
   * goes active. Respects existing role rules: a share landing with no ?code is a host session,
   * so the shared text becomes an outgoing item.
   */
  const sharedText = extractSharedText(searchParams)
  const pendingShareRef = useRef<string | null>(sharedText)
  const addTextItem = session.addTextItem

  useEffect(() => {
    if (session.phase === 'active' && pendingShareRef.current !== null) {
      const textToSend = pendingShareRef.current
      pendingShareRef.current = null
      addTextItem(textToSend)
    }
  }, [session.phase, addTextItem])

  /*
   * PLAN.md §16 Phase 8 / §17: a session that is abandoned by closing the tab (or by
   * navigating away) tells the peer it is over, instead of leaving the other device on
   * a live board until the Durable Object's 300s TTL closes its socket.
   *
   * `beforeunload`, not `unload`: only `beforeunload` runs while the page can still put
   * a frame on the wire ('unload' is deprecated and fires after the transport is already
   * going away). The listener is installed for exactly as long as a session can carry
   * traffic — not while this device is merely connecting (there is no peer to notify
   * yet), and not once the session has ended, because the cleanup removes it on the
   * phase change. That is what keeps a clean end (Abort, or the peer ending the session)
   * from being announced a second time: the peer already heard that `session-end`.
   *
   * The handler sends and does nothing else. `notifyUnload` is deliberately state-free
   * for the same reason: a React state write here would land in a tree that is being
   * torn down.
   */
  const { notifyUnload } = session
  const phase = session.phase
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

  /*
   * PLAN.md §15's share target POSTs to `/session` with the file as multipart form data,
   * and only a service worker of our own can read that body. This build ships
   * vite-plugin-pwa's generated worker, which has no share-target handler, so a share
   * that lands here (the browser redirecting to a GET after the POST) must not look like
   * a session that silently dropped the file: the hint below says what happened and what
   * to do about it.
   */
  const sharedFileNotCaptured = searchParams.get('share') === '1'

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

      {sharedFileNotCaptured ? (
        <section className="panel panel--error session-share" role="status">
          <h2 className="panel__title">Your shared file was not captured</h2>
          <p className="muted">
            Text and link sharing work directly, but sharing files is a documented limitation
            that requires an owner decision to relax the no-session-persistence rule. The file
            was not captured and is still where you shared it from — please add it from the
            board once the session is open.
          </p>
        </section>
      ) : null}

      {sharedText && session.phase !== 'active' && session.phase !== 'ended' ? (
        <section className="panel session-share-pending" aria-label="Shared item ready to send">
          <h2 className="panel__title">Shared text ready to send</h2>
          <p className="session-share-pending__text">{sharedText}</p>
        </section>
      ) : null}

      <p className="muted">{session.roleLabel}</p>

      {/*
        The host's QR lives here, on the page that is actually listening.

        This is the other half of the fix for the dead-end receiving flow: Home used to own
        the QR while only this page held the session, so the scannable code and the waiting
        host were on two different screens and never overlapped. Showing it here means a
        code is only ever visible while joining it can succeed. The 8-character code stays
        as text beside it, because that is the manual-entry fallback (PLAN.md §8) and the
        thing a user reads aloud when the camera will not focus.
      */}
      {session.sessionCode !== null && session.role !== null && !isSenderRole(session.role) ? (
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

      {session.sessionCode !== null && session.role !== null && isSenderRole(session.role) ? (
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
 * Reads share target parameters (?url, ?text, ?title) from the query string (ORCHESTRATION.md D12).
 *
 * Prefers url > text > title (the most substantial item; a URL shares better as a text item).
 * Returns null when none are present or all are empty.
 */
export function extractSharedText(searchParams: URLSearchParams): string | null {
  const url = searchParams.get('url')?.trim()
  if (url && url !== '') return url

  const text = searchParams.get('text')?.trim()
  if (text && text !== '') return text

  const title = searchParams.get('title')?.trim()
  if (title && title !== '') return title

  return null
}

/**
 * The host session bundle Home handed over in router state (PLAN.md §16 Phase 6), or
 * `null` when this navigation did not carry one.
 *
 * Router state is same-document data, so it cannot be addressed from a URL the way
 * `?code=` can, but it is still untrusted input to this render: the code is returned for
 * `useSession` to validate (an invalid one falls back to minting fresh).
 * Under D10, TURN credentials come from the /session/:code/turn route and are no longer
 * carried across router state.
 */
function hostSessionFromState(state: unknown): HostSession | null {
  if (typeof state !== 'object' || state === null) return null

  const bundle = (state as { hostSession?: unknown }).hostSession
  if (typeof bundle !== 'object' || bundle === null) return null

  const { code } = bundle as { code?: unknown }
  if (typeof code !== 'string') return null

  return { code }
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

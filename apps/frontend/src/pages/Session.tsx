import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AppLayout } from '../components/layout/AppLayout'
import { SessionView } from '../components/session/SessionView'
import { FileEditView } from '../components/library/FileEditView'
import { useSession } from '../hooks/useSession'
import { useLibraryStore } from '../store/libraryStore'
import { ROOT_FOLDER_ID, type LibraryFile } from '../lib/library'

/**
 * Session page (PLAN.md §8).
 *
 * Role comes from the URL: `?code=XXXXXXXX` means this device scanned a peer and
 * is the guest; no code means this device is the host whose QR was scanned.
 *
 * Upgraded with Mantine UI: unified shell header and stealth minimalist styling.
 * The page stays presentational: `SessionView` owns the session surface (status,
 * connecting code panel, board, phrase overlay and end-of-session save flow),
 * while `useSession` owns the handshake.
 */
export function Session() {
  const [searchParams] = useSearchParams()

  const rawCode = searchParams.get('code')
  const code = rawCode !== null && rawCode.trim() !== '' ? rawCode.trim() : null

  const session = useSession({ code })

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

  const notifyUnload = session.notifyUnload
  const phase = session.phase

  useEffect(() => {
    if (phase !== 'active') return

    const handleBeforeUnload = () => {
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

  const folders = useLibraryStore((state) => state.folders)
  const saveFile = useLibraryStore((state) => state.saveFile)

  const [sharedDossier, setSharedDossier] = useState<LibraryFile | null>(null)

  useEffect(() => {
    if (session.phase === 'active' && sharedDossier === null) {
      setSharedDossier({
        id: 'shared-live-dossier',
        name: 'Shared Dossier',
        folderId: ROOT_FOLDER_ID,
        blocks: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
  }, [session.phase, sharedDossier])

  return (
    <AppLayout
      session={session}
      showVault={false}
      mainContent={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)' }}>
          <header className="page__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Link className="link" to="/" style={{ textDecoration: 'none', color: 'var(--accent)', fontWeight: 550 }}>
              ← QRBit
            </Link>
            <span className="badge">{session.role ?? 'assigning'}</span>
          </header>

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

          {session.phase === 'active' || sharedDossier ? (
            <FileEditView
              file={
                sharedDossier ?? {
                  id: 'shared-live-dossier',
                  name: 'Shared Dossier',
                  folderId: ROOT_FOLDER_ID,
                  blocks: [],
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                }
              }
              onBack={() => {
                session.abort()
                setSharedDossier(null)
              }}
              onSaveFile={(file) => {
                saveFile(file).catch(() => undefined)
              }}
              folders={folders}
              session={session}
              isSharedSession={true}
              onEndSession={() => session.abort()}
            />
          ) : (
            <SessionView session={session} />
          )}
        </div>
      }
    />
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

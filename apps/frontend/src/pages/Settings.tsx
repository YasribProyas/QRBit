/**
 * Settings page (PLAN.md §5, §14, §16 Phase 7) — library export, library import and
 * the library's own size.
 *
 * The page is a thin coordinator. `lib/export.ts` owns the file format, `ExportModal`
 * owns the export choices, and the library store is the only route to IndexedDB; what
 * lives here is the three states the user needs to see: what is in the library, which
 * file is about to be imported and whether it needs a password, and how the last
 * import went.
 *
 * The password field appears only for an encrypted export, and that is decided by
 * reading the file's four-byte header (`isEncryptedExport`) rather than by asking the
 * user or guessing from the name. A plain JSON export therefore imports with no
 * ceremony at all. The password itself is component state for the duration of one
 * import and is cleared as soon as it succeeds or the file changes; it is never
 * stored, logged or sent anywhere.
 *
 * A failed import and a failed export are both rendered inline. `importLibrary`
 * reports per-item problems instead of throwing, so those are listed with the count
 * that did arrive — a partial import is never reported as a clean one.
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { ExportModal } from '../components/ExportModal'
import { EXPORT_FILE_EXTENSION, importLibrary, isEncryptedExport } from '../lib/export'
import { useLibraryStore } from '../store/libraryStore'

export function Settings() {
  const folders = useLibraryStore((state) => state.folders)
  const items = useLibraryStore((state) => state.items)
  const storeError = useLibraryStore((state) => state.error)
  const refresh = useLibraryStore((state) => state.refresh)

  const [exporting, setExporting] = useState(false)
  /** The chosen file, held until the user confirms the import. */
  const [file, setFile] = useState<File | null>(null)
  /** True while the 4-byte QRDE header is being read asynchronously. The Import
   * button stays disabled during this window so the user cannot submit before we
   * know whether a password is required. */
  const [headerReading, setHeaderReading] = useState(false)
  /** Whether that file starts with the encrypted-export magic (§11.5 header). */
  const [needsPassword, setNeedsPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  /*
   * The header read is asynchronous, so a slow answer for the previous file must not
   * decide the password field for the current one. A counter, not state: nothing
   * renders it.
   */
  const selection = useRef(0)

  // The library lives in IndexedDB, so the first render has no stats to show.
  useEffect(() => {
    void refresh()
  }, [refresh])

  const blobBytes = items.reduce(
    (total, item) => (item.type === 'image' || item.type === 'file' ? total + item.size : total),
    0,
  )

  const chooseFile = (chosen: File | null): void => {
    selection.current += 1
    setStatus(null)
    setProblems([])
    setPassword('')

    if (chosen === null) {
      setFile(null)
      setNeedsPassword(false)
      setHeaderReading(false)
      setError(null)
      return
    }

    // `accept` is a hint to the file picker, not a rule: anything can still be
    // dropped onto it, so the extension is checked here too.
    if (!chosen.name.toLowerCase().endsWith(EXPORT_FILE_EXTENSION)) {
      setFile(null)
      setNeedsPassword(false)
      setHeaderReading(false)
      setError(`That is not a ${EXPORT_FILE_EXTENSION} file. Choose a QRDrop export.`)
      return
    }

    setFile(chosen)
    setError(null)
    setHeaderReading(true)

    const token = selection.current
    void isEncryptedExport(chosen).then((encrypted) => {
      if (selection.current === token) {
        setNeedsPassword(encrypted)
        setHeaderReading(false)
      }
    })
  }

  const runImport = async (): Promise<void> => {
    if (file === null || busy) return

    setBusy(true)
    setError(null)
    setStatus(null)
    setProblems([])

    try {
      const result = await importLibrary(file, {
        password: needsPassword ? password : undefined,
      })
      setStatus(`Imported ${result.imported} ${result.imported === 1 ? 'item' : 'items'}.`)
      setProblems(result.errors)
      setFile(null)
      setNeedsPassword(false)
      setHeaderReading(false)
      setPassword('')
      // The import writes straight to IndexedDB, so the page's stats are re-read
      // rather than patched with a guess at what the merge did.
      await refresh()
    } catch (cause: unknown) {
      setError(importFailedMessage(cause))
    }

    setBusy(false)
  }

  return (
    <main className="page">
      <header className="page__header">
        <Link className="link" to="/">
          ← QRDrop
        </Link>
        <h1 className="page__title">Settings</h1>
      </header>

      <section className="panel">
        <h2 className="panel__title">Export &amp; import</h2>
        <p className="muted">
          Exporting writes the library to one file on this device — nothing is uploaded. Locked
          items stay encrypted inside that file whether or not you encrypt the file itself
          (PLAN.md §14).
        </p>

        <button type="button" className="button" onClick={() => setExporting(true)}>
          Export Library
        </button>

        <label className="library-modal__field">
          <span className="library-modal__field-label">Import Library</span>
          <input
            className="library-modal__input"
            type="file"
            accept={EXPORT_FILE_EXTENSION}
            aria-label="Import Library"
            disabled={busy}
            onChange={(event) => {
              const chosen = event.currentTarget.files?.[0] ?? null
              // Cleared so picking the same file twice in a row still fires a change.
              event.currentTarget.value = ''
              chooseFile(chosen)
            }}
          />
        </label>

        {file !== null ? <p className="muted">{`Chosen file: ${file.name}`}</p> : null}

        {needsPassword ? (
          <label className="library-modal__field">
            <span className="library-modal__field-label">Password</span>
            <input
              className="library-modal__input"
              type="password"
              value={password}
              aria-label="Import password"
              autoComplete="off"
              placeholder="Password for this export file"
              disabled={busy}
              onChange={(event) => {
                setPassword(event.target.value)
              }}
            />
          </label>
        ) : null}

        {file !== null ? (
          <button
            type="button"
            className="button"
            disabled={busy || headerReading || (needsPassword && password === '')}
            onClick={() => {
              void runImport()
            }}
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        ) : null}

        {status !== null ? (
          <p className="muted" role="status">
            {status}
          </p>
        ) : null}

        {problems.length > 0 ? (
          <ul className="muted">
            {problems.map((problem, index) => (
              // A report rather than rows with identity: the list has no ids of its
              // own, and the whole thing is replaced on the next import.
              <li key={index}>{problem}</li>
            ))}
          </ul>
        ) : null}

        {error !== null ? (
          <p className="item-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2 className="panel__title">Library</h2>
        <p className="muted">{`Folders: ${folders.length}`}</p>
        <p className="muted">{`Items: ${items.length}`}</p>
        <p className="muted">{`File and image data: ${formatBytes(blobBytes)}`}</p>
        {storeError !== null ? (
          <p className="item-error" role="alert">
            {storeError}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2 className="panel__title">Privacy</h2>
        <p className="muted">
          QRDrop keeps no history. Session data lives in memory only and is
          discarded when the session ends — it is never written to IndexedDB, the
          Cache API or localStorage.
        </p>
      </section>

      {exporting ? (
        <ExportModal
          onClose={() => {
            setExporting(false)
          }}
        />
      ) : null}
    </main>
  )
}

/** Byte counts for a stats line: exact under 1 KiB, one decimal above it. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function importFailedMessage(cause: unknown): string {
  // An unknown export version, a wrong password and a foreign file all arrive here
  // with their own sentence (`lib/export.ts` owns those words) — repeating them is
  // more useful than a generic wrapper.
  if (cause instanceof Error && cause.message.trim() !== '') return `Import failed: ${cause.message}`
  return 'Import failed.'
}

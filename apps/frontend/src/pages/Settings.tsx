/**
 * Settings page (PLAN.md §5, §14, §16 Phase 7) — library export, library import and
 * the library's own size.
 *
 * Upgraded with Mantine UI: sleek cards, clear typographic hierarchy,
 * refined buttons, and Tabler icons.
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Box, Button, Card, Group, Stack, Text, Title } from '@mantine/core'
import { IconDatabase, IconDownload, IconFileImport, IconLock, IconShieldCheck } from '@tabler/icons-react'

import { ExportModal } from '../components/ExportModal'
import { AppLayout } from '../components/layout/AppLayout'
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
      await refresh()
    } catch (cause: unknown) {
      setError(importFailedMessage(cause))
    }

    setBusy(false)
  }

  return (
    <AppLayout
      showVault={false}
      mainContent={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)' }}>
          <header className="page__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Link className="link" to="/" style={{ textDecoration: 'none', color: 'var(--accent)', fontWeight: 550 }}>
              ← QRDrop
            </Link>
            <h1 className="page__title" style={{ margin: 0, fontSize: '1.25rem' }}>
              Settings
            </h1>
          </header>

          <section className="panel" style={{ background: '#141517', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '1.25rem' }}>
            <Group justify="space-between" mb="xs">
              <h2 className="panel__title" style={{ margin: 0, fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <IconDownload size={18} color="#4ade80" />
                Export &amp; import
              </h2>
            </Group>
            <p className="muted" style={{ marginBottom: '1rem', color: '#909296', fontSize: '0.875rem' }}>
              Exporting writes the library to one file on this device — nothing is uploaded. Locked
              items stay encrypted inside that file whether or not you encrypt the file itself
              (PLAN.md §14).
            </p>

            <Group gap="sm" mb="md">
              <button
                type="button"
                className="button"
                onClick={() => setExporting(true)}
                style={{ flex: 1 }}
              >
                Export Library
              </button>
            </Group>

            <label className="library-modal__field" style={{ display: 'block', marginTop: '1rem' }}>
              <span className="library-modal__field-label" style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: '#a6a7ab' }}>
                Import Library
              </span>
              <input
                className="library-modal__input"
                type="file"
                accept={EXPORT_FILE_EXTENSION}
                aria-label="Import Library"
                disabled={busy}
                onChange={(event) => {
                  const chosen = event.currentTarget.files?.[0] ?? null
                  event.currentTarget.value = ''
                  chooseFile(chosen)
                }}
                style={{ width: '100%', padding: '0.5rem', background: '#0d0e11', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '8px', color: '#f2f2f2' }}
              />
            </label>

            {file !== null ? (
              <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
                {`Chosen file: ${file.name}`}
              </p>
            ) : null}

            {needsPassword ? (
              <label className="library-modal__field" style={{ display: 'block', marginTop: '0.75rem' }}>
                <span className="library-modal__field-label" style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: '#a6a7ab' }}>
                  Password
                </span>
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
                  style={{ width: '100%', padding: '0.6rem', background: '#0d0e11', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '8px', color: '#f2f2f2' }}
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
                style={{ marginTop: '0.75rem' }}
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
            ) : null}

            {status !== null ? (
              <p className="muted" role="status" style={{ marginTop: '0.5rem', color: '#4ade80' }}>
                {status}
              </p>
            ) : null}

            {problems.length > 0 ? (
              <ul className="muted" style={{ marginTop: '0.5rem' }}>
                {problems.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            ) : null}

            {error !== null ? (
              <p className="item-error" role="alert" style={{ marginTop: '0.5rem', color: '#f87171' }}>
                {error}
              </p>
            ) : null}
          </section>

          <section className="panel" style={{ background: '#141517', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '1.25rem' }}>
            <Group justify="space-between" mb="xs">
              <h2 className="panel__title" style={{ margin: 0, fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <IconDatabase size={18} color="#4ade80" />
                Library
              </h2>
            </Group>
            {storeError !== null ? (
              <p className="item-error" role="alert">
                {storeError}
              </p>
            ) : null}
            <p className="muted">{`Folders: ${folders.length}`}</p>
            <p className="muted">{`Items: ${items.length}`}</p>
            <p className="muted">{`File and image data: ${formatBytes(blobBytes)}`}</p>
          </section>

          <section className="panel" style={{ background: '#141517', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '1.25rem' }}>
            <h2 className="panel__title" style={{ margin: 0, fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <IconShieldCheck size={18} color="#4ade80" />
              Privacy
            </h2>
            <p className="muted" style={{ color: '#909296', fontSize: '0.875rem', lineHeight: 1.6 }}>
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
        </div>
      }
    />
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function importFailedMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return `Import failed: ${error.message}`
  }
  return 'Import failed.'
}

/**
 * Settings (PLAN.md §5, §14, §16 Phase 7) — the page that says what this device keeps,
 * and lets you move it somewhere else.
 *
 * ## Why it is grouped the way it is
 *
 * The old page was four boxes of buttons in the order they happened to be written. This
 * one is grouped by intent, which is also the order a visitor asks about them:
 * `Appearance` (the only preference the product has), `Library` (what is in here, and how
 * it leaves and comes back), `What is kept, and where` (the product's actual promise,
 * stated as facts rather than as a slogan), and `Connection` (the one network endpoint this
 * app talks to, and what crosses it).
 *
 * ## Rules this file obeys
 *
 * DESIGN.md, "The No Raw Hex Rule": every colour, space and radius below is a `--qrbit-*`
 * token or a Mantine semantic slot that `theme.ts` points at one. "The Mono Means Data
 * Rule": `.qrbit-text-data` is only on counts, byte sizes, an extension and an origin.
 * "The Floating Only Rule": a panel here is `Raised` with a 1px `--qrbit-border` and no
 * shadow; nothing on this page floats, so nothing here is shadowed. There is no eyebrow
 * above any heading, and no heading carries a section number.
 *
 * `Paper` deliberately does not use Mantine's `withBorder`: that prop paints the
 * `default-border` slot, which theme.ts maps to `--qrbit-border-strong` — the outline of a
 * control a user must find. A panel divides content, it is not a control, so its edge is
 * stated from `--qrbit-border` (DESIGN.md, "Shapes").
 *
 * ## What this page does NOT have
 *
 * No "Clear library" control. Deleting the vault needs one IndexedDB transaction spanning
 * every store; the library layer has no such function (`lib/library.ts` deletes one folder,
 * item or file at a time), and a clear composed here would be a non-transactional delete of
 * the user's whole vault. That seam is the library lane's to add; this page does not offer a
 * button it cannot honour.
 *
 * The export and import paths are behaviour-unchanged: the same `lib/export.ts` calls with
 * the same arguments, the same four-byte header check before a password is asked for, the
 * same re-read of the store after a merge. Only their markup and copy changed here.
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import {
  Alert,
  Button,
  Code,
  FileInput,
  Group,
  PasswordInput,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import {
  IconAlertTriangle,
  IconCheck,
  IconDownload,
  IconExclamationCircle,
  IconUpload,
} from '@tabler/icons-react'

import { ExportModal } from '../components/ExportModal'
import { AppLayout } from '../components/layout/AppLayout'
import { ThemeToggle } from '../components/common/ThemeToggle'
import { SIGNALING_WS_URL } from '../config'
import { formatByteSize } from '../lib/byteSize'
import { EXPORT_FILE_EXTENSION, importLibrary, isEncryptedExport } from '../lib/export'
import { useLibraryStore } from '../store/libraryStore'

/**
 * DESIGN.md's panel, in two properties: `Raised` on the `Canvas` the page paints, divided by
 * a 1px `--qrbit-border` hairline. Radius `lg` (10px, containers) and padding `lg` come from
 * the theme, so they are props rather than a re-declaration.
 */
const PANEL_STYLES: Record<'root', CSSProperties> = {
  root: {
    backgroundColor: 'var(--qrbit-raised)',
    border: '1px solid var(--qrbit-border)',
    boxShadow: '0 1px 0 rgba(255, 255, 255, 0.05) inset, var(--qrbit-shadow-sheet)',
  },
}

/** A value that is literally data: the sunken well of DESIGN.md's "code wells, insets". */
const CODE_WELL_STYLES: Record<'root', CSSProperties> = {
  root: {
    backgroundColor: 'var(--qrbit-sunken)',
    border: '1px solid var(--qrbit-border)',
    color: 'var(--qrbit-ink)',
    font: 'var(--qrbit-text-data)',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: 'var(--qrbit-text-data-tracking)',
    paddingInline: 'var(--qrbit-space-sm)',
    paddingBlock: 'var(--qrbit-space-xxs)',
    borderRadius: 'var(--qrbit-radius-sm)',
    overflowWrap: 'anywhere',
  },
}

/** The same data treatment inside a running sentence, without the well's border. */
const CODE_INLINE_STYLES: Record<'root', CSSProperties> = {
  root: {
    backgroundColor: 'var(--qrbit-sunken)',
    color: 'var(--qrbit-ink)',
    font: 'var(--qrbit-text-data)',
    letterSpacing: 'var(--qrbit-text-data-tracking)',
    paddingInline: 'var(--qrbit-space-xs)',
    borderRadius: 'var(--qrbit-radius-xs)',
  },
}

/**
 * DESIGN.md's Inputs table puts a field label in the Label role (12px/600). Mantine's
 * InputWrapper label is 13px at weight 500 — off the seven-role ladder, and unreachable
 * through the theme object (see the note at the foot of theme.ts) — so the role is applied to
 * the label element through the styles API. Same treatment as `ExportModal.tsx`.
 */
const FIELD_LABEL_STYLE: Record<'label', CSSProperties> = {
  label: {
    font: 'var(--qrbit-text-label)',
    letterSpacing: 'var(--qrbit-text-label-tracking)',
  },
}

/**
 * The 44px thumb target (DESIGN.md, "Do's": 44px minimum for anything a thumb hits). Above
 * the mobile breakpoint these controls take the table's 36px height from `size="sm"`;
 * `max-md:min-h-11` is the same control at arm's length on a phone, which is this product's
 * primary usage scene. It is a Tailwind min-height rather than a Mantine size because
 * Mantine's size ladder has no 44px step and no per-breakpoint `size` (theme.ts records that
 * limit). The trailing `!` is load-bearing: Mantine ships unlayered CSS and Tailwind v4 ships
 * layered, and an unlayered declaration beats a layered one at any specificity — which is
 * exactly what `Input`'s root does with `min-height`.
 */
const THUMB_TARGET = 'max-md:min-h-11!'

export function Settings(): ReactElement {
  const folders = useLibraryStore((state) => state.folders)
  const items = useLibraryStore((state) => state.items)
  const files = useLibraryStore((state) => state.files)
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
      setError(`That is not a ${EXPORT_FILE_EXTENSION} file. Choose a QRward export.`)
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
        <Stack gap="xl" className="settings-page">
          <Stack gap="xxs">
            <Title order={1} className="qrbit-text-display settings__display-title">
              Settings
            </Title>
            <Text className="qrbit-text-body-secondary settings__subtitle" c="dimmed">
              Local preferences, storage, and privacy on this device.
            </Text>
          </Stack>

          {/* ---------------------------------------------------------- appearance -- */}
          <Section heading="Appearance">
            <Group justify="space-between" gap="md" wrap="nowrap">
              <Text className="qrbit-text-body font-medium">Colour scheme</Text>
              <ThemeToggle />
            </Group>
          </Section>

          {/* ------------------------------------------------------------ library -- */}
          <Section heading="Library">
            {storeError !== null ? (
              <Alert
                color="danger"
                role="alert"
                title="The library could not be read"
                icon={<IconAlertTriangle size={18} aria-hidden="true" />}
              >
                <Text className="qrbit-text-body-secondary">{storeError}</Text>
              </Alert>
            ) : null}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Measure label="Folders" value={String(folders.length)} />
              <Measure label="Dossiers" value={String(files.length)} />
              <Measure label="Items" value={String(items.length)} />
              <Measure label="Image and file data in items" value={formatByteSize(blobBytes)} />
            </div>

            <div className="pt-2">
              <Group justify="space-between" align="center" wrap="wrap" gap="sm">
                <Text className="qrbit-text-body-secondary" c="dimmed">
                  Export entire library into a single{' '}
                  <Code styles={CODE_INLINE_STYLES}>{EXPORT_FILE_EXTENSION}</Code> file. Nothing is uploaded.
                </Text>
                <Button
                  variant="default"
                  size="sm"
                  className={`${THUMB_TARGET} tactile-btn`}
                  leftSection={<IconDownload size={16} aria-hidden="true" />}
                  onClick={() => {
                    setExporting(true)
                  }}
                >
                  Export library
                </Button>
              </Group>
            </div>

            <Stack gap="sm" pt="sm" style={{ borderTop: '1px solid var(--qrbit-border)' }}>
              <FileInput
                label="Import file"
                description={`Restore folders and dossiers from a ${EXPORT_FILE_EXTENSION} file.`}
                placeholder={`Choose a ${EXPORT_FILE_EXTENSION} file`}
                accept={EXPORT_FILE_EXTENSION}
                styles={FIELD_LABEL_STYLE}
                value={file}
                onChange={chooseFile}
                disabled={busy}
                withAsterisk={false}
                size="sm"
                className={THUMB_TARGET}
              />

              {needsPassword ? (
                <PasswordInput
                  className="settings__import-password"
                  label="Password"
                  description="Enter the password for this encrypted backup file."
                  placeholder="Password for this export file"
                  styles={FIELD_LABEL_STYLE}
                  autoComplete="off"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.currentTarget.value)
                  }}
                  disabled={busy}
                  size="sm"
                />
              ) : null}

              {file !== null ? (
                <Group gap="sm" wrap="wrap">
                  <Button
                    variant="default"
                    size="sm"
                    className={THUMB_TARGET}
                    loading={busy}
                    loaderProps={{ size: 14, color: 'var(--qrbit-signal)' }}
                    disabled={busy || headerReading || (needsPassword && password === '')}
                    leftSection={busy ? undefined : <IconUpload size={16} aria-hidden="true" />}
                    onClick={() => {
                      void runImport()
                    }}
                  >
                    {busy ? 'Importing…' : 'Import into library'}
                  </Button>
                  {headerReading ? (
                    <Text className="qrbit-text-body-secondary" c="dimmed">
                      Reading the file header…
                    </Text>
                  ) : null}
                </Group>
              ) : null}

              {status !== null ? (
                <Alert
                  color="success"
                  role="status"
                  aria-live="polite"
                  icon={<IconCheck size={18} aria-hidden="true" />}
                >
                  <Text className="qrbit-text-body">{status}</Text>
                </Alert>
              ) : null}

              {problems.length > 0 ? (
                <Alert
                  color="warning"
                  role="status"
                  aria-live="polite"
                  title="Some of that file could not be stored"
                  icon={<IconExclamationCircle size={18} aria-hidden="true" />}
                >
                  <Stack gap="xs">
                    {problems.map((problem) => (
                      <Text key={problem} className="qrbit-text-body-secondary">
                        {problem}
                      </Text>
                    ))}
                  </Stack>
                </Alert>
              ) : null}

              {error !== null ? (
                <Alert
                  color="danger"
                  role="alert"
                  icon={<IconAlertTriangle size={18} aria-hidden="true" />}
                >
                  <Text className="qrbit-text-body">{error}</Text>
                </Alert>
              ) : null}
            </Stack>
          </Section>

          {/* ------------------------------------------------------------ privacy -- */}
          <Section heading="What is kept, and where">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Card 1: Stored locally */}
              <div
                className="p-4 rounded-lg flex flex-col gap-3.5"
                style={{
                  background: 'var(--qrbit-sunken)',
                  border: '1px solid var(--qrbit-border)',
                  borderRadius: 'var(--qrbit-radius-md)',
                }}
              >
                <div
                  className="flex items-center justify-between pb-2"
                  style={{ borderBottom: '1px solid var(--qrbit-border)' }}
                >
                  <Text fw={600} className="qrbit-text-body font-medium" style={{ color: 'var(--qrbit-ink)' }}>
                    Stored on this device
                  </Text>
                  <span
                    className="qrbit-text-data text-xs px-2 py-0.5 rounded font-mono"
                    style={{
                      backgroundColor: 'color-mix(in srgb, var(--qrbit-signal) 12%, transparent)',
                      color: 'var(--qrbit-signal)',
                    }}
                  >
                    Local only
                  </span>
                </div>

                <div className="space-y-3">
                  <div>
                    <Text className="qrbit-text-body font-medium text-xs">
                      Folders, dossiers & items
                    </Text>
                    <Text className="qrbit-text-body-secondary text-xs" c="dimmed">
                      Kept directly in this browser’s IndexedDB database.
                    </Text>
                  </div>

                  <div>
                    <Text className="qrbit-text-body font-medium text-xs">
                      Colour scheme
                    </Text>
                    <Text className="qrbit-text-body-secondary text-xs" c="dimmed">
                      Saved in localStorage (<Code styles={CODE_INLINE_STYLES}>qrbit:theme</Code>).
                    </Text>
                  </div>
                </div>
              </div>

              {/* Card 2: Never stored */}
              <div
                className="p-4 rounded-lg flex flex-col gap-3.5"
                style={{
                  background: 'var(--qrbit-sunken)',
                  border: '1px solid var(--qrbit-border)',
                  borderRadius: 'var(--qrbit-radius-md)',
                }}
              >
                <div
                  className="flex items-center justify-between pb-2"
                  style={{ borderBottom: '1px solid var(--qrbit-border)' }}
                >
                  <Text fw={600} className="qrbit-text-body font-medium" style={{ color: 'var(--qrbit-ink)' }}>
                    Never stored anywhere
                  </Text>
                  <span
                    className="qrbit-text-data text-xs px-2 py-0.5 rounded font-mono"
                    style={{
                      backgroundColor: 'color-mix(in srgb, var(--qrbit-locked) 12%, transparent)',
                      color: 'var(--qrbit-locked)',
                    }}
                  >
                    Zero retention
                  </span>
                </div>

                <div className="space-y-3">
                  <div>
                    <Text className="qrbit-text-body font-medium text-xs">
                      Session keys & transit items
                    </Text>
                    <Text className="qrbit-text-body-secondary text-xs" c="dimmed">
                      Held in volatile memory only; destroyed when closed.
                    </Text>
                  </div>

                  <div>
                    <Text className="qrbit-text-body font-medium text-xs">
                      Accounts & telemetry
                    </Text>
                    <Text className="qrbit-text-body-secondary text-xs" c="dimmed">
                      None. No remote servers track you or collect data.
                    </Text>
                  </div>
                </div>
              </div>
            </div>

            <div
              className="p-3 rounded flex items-center gap-2.5 text-xs"
              style={{
                backgroundColor: 'var(--qrbit-sunken)',
                border: '1px solid var(--qrbit-border)',
                borderRadius: 'var(--qrbit-radius-md)',
                color: 'var(--qrbit-ink-secondary)',
              }}
            >
              <IconExclamationCircle size={16} style={{ flex: 'none', color: 'var(--qrbit-ink-muted)' }} />
              <span>
                All library data exists only on this device. Back up your library with an export before clearing browser site data or switching machines.
              </span>
            </div>
          </Section>

          {/* --------------------------------------------------------- connection -- */}
          <Section heading="Connection">
            <FactRow
              subject="Signaling worker"
              detail={<Code styles={CODE_WELL_STYLES}>{SIGNALING_WS_URL}</Code>}
            />
            <Text className="qrbit-text-body-secondary" c="dimmed">
              Signaling worker coordinates discovery and exchange only. All file transfer is direct and end-to-end encrypted with AES-256-GCM.
            </Text>
          </Section>

          {exporting ? (
            <ExportModal
              onClose={() => {
                setExporting(false)
              }}
            />
          ) : null}
        </Stack>
      }
    />
  )
}

/* ------------------------------------------------------------------ sections -- */

interface SectionProps {
  heading: string
  /** The one line under a heading. Supporting copy, never a kicker above one. */
  description?: string
  children: ReactNode
}

/**
 * One group of intent. `aria-labelledby` ties the landmark to its own heading, so a screen
 * reader lands on "Library" before it lands on the numbers, and the `<section>` is why the
 * landmark exists at all.
 */
function Section({ heading, description, children }: SectionProps): ReactElement {
  const headingId = `settings-${heading
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-+|-+$/g, '')}`

  return (
    <Paper component="section" aria-labelledby={headingId} radius="lg" p="lg" className="settings-section-panel" styles={PANEL_STYLES}>
      <Stack gap="md">
        <Stack gap="xxs">
          <Title order={2} id={headingId} className="qrbit-text-headline">
            {heading}
          </Title>
          {description ? (
            <Text className="qrbit-text-body-secondary settings__section-desc" c="dimmed" maw="68ch">
              {description}
            </Text>
          ) : null}
        </Stack>
        {children}
      </Stack>
    </Paper>
  )
}

/** A counted or measured value: label one side, the Data role on the other. */
function Measure({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div
      className="settings__measure flex flex-col p-3 rounded"
      style={{
        background: 'var(--qrbit-sunken)',
        border: '1px solid var(--qrbit-border)',
        borderRadius: 'var(--qrbit-radius-md)',
      }}
    >
      <Text className="qrbit-text-label" c="dimmed" truncate>
        {label}
      </Text>
      <Text
        className="qrbit-text-data"
        fw={600}
        style={{ color: 'var(--qrbit-ink)', fontSize: '13px', marginTop: '2px' }}
      >
        {value}
      </Text>
    </div>
  )
}

/**
 * A thing and where it lives. The detail is prose — except when it names a literal (a
 * storage key, an origin), which is what the Data role and the sunken well are for.
 */
function FactRow({ subject, detail }: { subject: string; detail: ReactNode }): ReactElement {
  return (
    <Group justify="space-between" gap="sm" align="baseline" wrap="wrap">
      <Text className="qrbit-text-body font-medium">{subject}</Text>
      <Text className="qrbit-text-body-secondary" c="dimmed">
        {detail}
      </Text>
    </Group>
  )
}

/* ------------------------------------------------------------------- helpers -- */

function importFailedMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return `Import failed: ${error.message}`
  }
  return 'Import failed.'
}

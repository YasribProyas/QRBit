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
      setError(`That is not a ${EXPORT_FILE_EXTENSION} file. Choose a QRBit export.`)
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
        <Stack gap="xl">
          <Stack gap="xs">
            <Title order={1} className="qrbit-text-display">
              Settings
            </Title>
            <Text className="qrbit-text-body-secondary" c="dimmed" maw="68ch">
              What this device is holding, how the app looks, and how to get the library onto
              another one.
            </Text>
          </Stack>

          {/* ---------------------------------------------------------- appearance -- */}
          <Section
            heading="Appearance"
            description="One preference, applied to every screen in the app, stored on this device."
          >
            <Group justify="space-between" gap="md" wrap="wrap">
              <Stack gap="xxs" maw="46ch">
                <Text className="qrbit-text-label">Colour scheme</Text>
                <Text className="qrbit-text-body-secondary" c="dimmed">
                  Press the control to cycle light, dark, and follow the device. Light is the
                  default; the two schemes are the same layout with different surface values.
                </Text>
              </Stack>
              <ThemeToggle />
            </Group>
          </Section>

          {/* ------------------------------------------------------------ library -- */}
          <Section
            heading="Library"
            description="Everything below is written by this browser to this device. Export and import are how it moves."
          >
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

            <Stack gap="xs">
              <Measure label="Folders" value={String(folders.length)} />
              <Measure label="Dossiers" value={String(files.length)} />
              <Measure label="Items" value={String(items.length)} />
              <Measure label="Image and file data in items" value={formatByteSize(blobBytes)} />
              <Text className="qrbit-text-body-secondary" c="dimmed" maw="68ch">
                A dossier keeps its own attachments inside it, so they are not in that byte
                total.
              </Text>
            </Stack>

            <Stack gap="md">
              <Title order={3} className="qrbit-text-title">
                Take the library with you
              </Title>
              <Text className="qrbit-text-body-secondary" c="dimmed" maw="68ch">
                Export writes the whole library into one{' '}
                <Code styles={CODE_INLINE_STYLES}>{EXPORT_FILE_EXTENSION}</Code> file that you
                choose where to save. Nothing is uploaded, and locked items stay encrypted
                inside that file whether or not you encrypt the file itself (PLAN.md §14).
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
            </Stack>

            <Stack gap="md">
              <Title order={3} className="qrbit-text-title">
                Bring a library in
              </Title>
              <FileInput
                label="Import file"
                description={`Adds the folders and items from a ${EXPORT_FILE_EXTENSION} export to this device. Anything already here is kept as it is.`}
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
                  description="This export file is encrypted. Without its password nothing in it can be read, and there is no way to recover one."
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
          <Section
            heading="What is kept, and where"
            description="No account, no history, no cloud copy. These are the only two places this app writes."
          >
            <Group gap="huge" align="flex-start" wrap="wrap">
              <Stack gap="sm" maw="30rem">
                <Title order={3} className="qrbit-text-title">
                  Kept on this device
                </Title>
                <FactRow subject="Folders, dossiers, items" detail="in this browser's IndexedDB" />
                <FactRow
                  subject="Colour scheme"
                  detail={
                    <>
                      in localStorage, under one key{' '}
                      <Code styles={CODE_INLINE_STYLES}>qrbit:theme</Code>
                    </>
                  }
                />
              </Stack>

              <Stack gap="sm" maw="30rem">
                <Title order={3} className="qrbit-text-title">
                  Never kept
                </Title>
                <FactRow
                  subject="Session keys, safety phrase, items in transit"
                  detail="memory only — gone when the tab closes"
                />
                <FactRow
                  subject="Accounts, analytics, crash reports, backups"
                  detail="none; there is no server that would hold them"
                />
              </Stack>
            </Group>

            <Text className="qrbit-text-body-secondary" c="dimmed" maw="68ch">
              Nothing here survives on its own: clear the site's data in the browser and the
              library is gone with it. That is why the export above is worth running before you
              leave a device behind.
            </Text>
          </Section>

          {/* --------------------------------------------------------- connection -- */}
          <Section
            heading="Connection"
            description="Two devices pair through one small signaling worker. This is the only origin the app contacts."
          >
            <FactRow
              subject="Signaling worker"
              detail={<Code styles={CODE_WELL_STYLES}>{SIGNALING_WS_URL}</Code>}
            />
            <Text className="qrbit-text-body-secondary" c="dimmed" maw="68ch">
              The worker carries codes, public keys and ICE candidates. It never holds the
              session key: both devices derive it from a handshake of their own, so file bytes
              travel between them already encrypted — over a relay if the network needs one,
              which is still ciphertext. A relay is asked for per session and dropped with it,
              so this page has no session to report.
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
  description: string
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
    <Paper component="section" aria-labelledby={headingId} radius="lg" p="lg" styles={PANEL_STYLES}>
      <Stack gap="lg">
        <Stack gap="xs">
          <Title order={2} id={headingId} className="qrbit-text-headline">
            {heading}
          </Title>
          <Text className="qrbit-text-body-secondary" c="dimmed" maw="68ch">
            {description}
          </Text>
        </Stack>
        {children}
      </Stack>
    </Paper>
  )
}

/** A counted or measured value: label one side, the Data role on the other. */
function Measure({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <Group className="settings__measure" justify="space-between" gap="md" wrap="nowrap">
      <Text className="qrbit-text-body">{label}</Text>
      <Text className="qrbit-text-data" c="dimmed" style={{ textAlign: 'right' }}>
        {value}
      </Text>
    </Group>
  )
}

/**
 * A thing and where it lives. The detail is prose — except when it names a literal (a
 * storage key, an origin), which is what the Data role and the sunken well are for.
 */
function FactRow({ subject, detail }: { subject: string; detail: ReactNode }): ReactElement {
  return (
    <Group gap="sm" align="flex-start" wrap="wrap">
      <Text className="qrbit-text-body">{subject}</Text>
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

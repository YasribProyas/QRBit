import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core'
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconFolder,
  IconLibrary,
  IconRefresh,
} from '@tabler/icons-react'
import { AddItemBar } from './AddItemBar'
import { QRDisplay } from '../QRDisplay'
import { SafetyPhraseOverlay } from './SafetyPhraseOverlay'
import { SessionBoard, isSenderRole } from './SessionBoard'
import { SaveToLibraryModal } from '../library/SaveToLibraryModal'
import { FolderPickerModal } from '../library/FolderPickerModal'
import { WithMantine } from '../common/WithMantine'
import { sessionItemsToLibraryFile } from '../../lib/dossier'
import { ROOT_FOLDER_ID } from '../../lib/library'
import { ITEM_TYPE_ICONS, ITEM_TYPE_MARK_STYLE } from '../../lib/itemType'
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
export function SessionView(props: SessionViewProps) {
  return (
    <WithMantine>
      <SessionViewInner {...props} />
    </WithMantine>
  )
}

/** A resting panel: Raised, 1px Border, radius lg, no shadow (DESIGN.md, Panels and Rows). */
const PANEL_STYLE = {
  background: 'var(--qrbit-raised)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-lg)',
} as const

function SessionViewInner({ session, showConnectingCode = true }: SessionViewProps) {
  const { notifyUnload, phase } = session
  // What the code can actually state about the phrase: this device confirmed, or the peer's
  // confirmation arrived. Neither is "the words matched" — that comparison is the human's.
  const phraseConfirmed = isSenderRole(session.role)
    ? session.phraseConfirmed
    : session.peerConfirmed

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

      {session.safetyPhrase !== null ? (
        <Paper p="md" radius="lg" style={PANEL_STYLE}>
          <Group justify="space-between" gap="md" wrap="wrap">
            <Group gap="sm" wrap="nowrap">
              <span
                aria-hidden="true"
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: 'var(--qrbit-radius-full)',
                  flex: 'none',
                  // Green only once a confirmation exists; neutral while it does not.
                  background: phraseConfirmed
                    ? 'var(--qrbit-success)'
                    : 'var(--qrbit-border-strong)',
                }}
              />
              <Text span className="qrbit-text-label" c="dimmed">
                Safety phrase
              </Text>
              <Text span className="qrbit-text-body-secondary" c="dimmed">
                {phraseConfirmed ? 'confirmed on this screen' : 'not confirmed yet'}
              </Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
              {session.safetyPhrase.map((word) => (
                <Text
                  key={word}
                  span
                  className="qrbit-text-data"
                  style={{
                    background: 'var(--qrbit-sunken)',
                    border: '1px solid var(--qrbit-border)',
                    borderRadius: 'var(--qrbit-radius-sm)',
                    padding: '2px 8px',
                    color: 'var(--qrbit-ink)',
                  }}
                >
                  {word}
                </Text>
              ))}
            </Group>
          </Group>
        </Paper>
      ) : null}

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
          <p
            className="code qrbit-text-data"
            // Data role exactly (13px mono, tabular figures): `.code` alone would leave the
            // session code on the pre-token 24px/0.18em treatment.
            style={{ font: 'var(--qrbit-text-data)', letterSpacing: 'var(--qrbit-text-data-tracking)' }}
          >{session.sessionCode}</p>
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
          <p
            className="code qrbit-text-data"
            // Data role exactly (13px mono, tabular figures): `.code` alone would leave the
            // session code on the pre-token 24px/0.18em treatment.
            style={{ font: 'var(--qrbit-text-data)', letterSpacing: 'var(--qrbit-text-data-tracking)' }}
          >{session.sessionCode}</p>
          <p className="muted">
            On the other device, open <code>/session?code={session.sessionCode}</code>
          </p>
          <Group justify="center">
            <Button
              component={Link}
              to="/"
              variant="default"
              size="sm"
              leftSection={<IconArrowRight size={16} aria-hidden="true" />}
              onClick={() => session.abort()}
            >
              Cancel &amp; Return Home
            </Button>
          </Group>
        </section>
      ) : null}

      {session.errorMessage !== null ? (
        <section className="panel panel--error home__qr-error" role="alert">
          <Group gap="sm" wrap="nowrap">
            <IconAlertTriangle size={18} aria-hidden="true" style={{ color: 'var(--qrbit-danger)' }} />
            <h2 className="panel__title">Error</h2>
          </Group>
          <p className="muted">Could not reach the signaling server.</p>
          <p className="item-error">{session.errorMessage}</p>
          <Group gap="sm">
            <Button
              size="sm"
              color="signal"
              leftSection={<IconRefresh size={16} aria-hidden="true" />}
              onClick={session.restart}
            >
              Try again
            </Button>
            <Button component={Link} to="/" variant="subtle" size="sm" c="dimmed">
              Go to home
            </Button>
          </Group>
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
export function SessionEnded({ api }: { api: UseSessionResult }) {  const folders = useLibraryStore((state) => state.folders)
  const error = useLibraryStore((state) => state.error)
  const refresh = useLibraryStore((state) => state.refresh)
  const saveFromSession = useLibraryStore((state) => state.saveFromSession)
  const createFolder = useLibraryStore((state) => state.createFolder)
  const saveFile = useLibraryStore((state) => state.saveFile)

  /** Session item ids this device has already stored; the dialog shows them as 'Saved'. */
  const [savedIds, setSavedIds] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dossierPickerOpen, setDossierPickerOpen] = useState(false)
  const [dossierSaved, setDossierSaved] = useState(false)

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
            {rows.map((row) => {
              const { Icon, label } = ITEM_TYPE_ICONS[row.type]

              return (
                <li
                  className="library-modal__item"
                  key={row.id}
                  data-saved={savedIds.includes(row.id) ? 'true' : undefined}
                >
                  {/*
                    The receive sheet has to distinguish a locked item from a text note on
                    more than a picture: the glyph is decorative and the word names the type.
                  */}
                  <span className="library-item__icon" style={ITEM_TYPE_MARK_STYLE}>
                    <Icon size={16} aria-hidden="true" />
                    <Text span className="qrbit-text-label" c="dimmed">
                      {label}
                    </Text>
                  </span>
                  <span className="library-modal__item-name">{row.name}</span>
                  {savedIds.includes(row.id) ? (
                    <Badge
                      className="library-modal__saved"
                      variant="light"
                      color="success"
                      radius="full"
                      ff="sans"
                      leftSection={<IconCheck size={13} aria-hidden="true" />}
                    >
                      Saved
                    </Badge>
                  ) : null}
                  {!row.complete ? (
                    /* Caution, not failure: the transfer stopped, nothing here says it broke. */
                    <span className="library-modal__item-note qrbit-text-label" style={{ color: 'var(--qrbit-warning)' }}>
                      Transfer did not finish
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <Group gap="sm" wrap="wrap">
            {/*
              One primary per screen (DESIGN.md, "The One Blue Rule"): the item-by-item save
              dialog is the affirmative action, the whole-dossier export is its quieter sibling.
            */}
            <Button
              className="session-ended__save"
              size="sm"
              color="signal"
              leftSection={<IconLibrary size={16} aria-hidden="true" />}
              onClick={() => {
                setPickerOpen(true)
              }}
            >
              Save to Library →
            </Button>
            <Button
              className="session-ended__save-dossier"
              variant="default"
              size="sm"
              leftSection={<IconFolder size={16} aria-hidden="true" />}
              disabled={dossierSaved}
              onClick={() => {
                setDossierPickerOpen(true)
              }}
            >
              {dossierSaved ? 'Dossier file saved' : 'Save as dossier file'}
            </Button>
            {dossierSaved ? (
              <Text span className="qrbit-text-body-secondary" c="success">
                Saved to the library on this device.
              </Text>
            ) : null}
          </Group>
        </>
      )}

      {error !== null ? (
        <p className="library-modal__error item-error" role="alert">
          {error}
        </p>
      ) : null}

      <Stack gap="sm" mt="md">
        {api.errorMessage === null ? (
          <Button
            variant="default"
            size="sm"
            leftSection={<IconRefresh size={16} aria-hidden="true" />}
            onClick={api.restart}
          >
            Start a new session
          </Button>
        ) : null}
        <Link
          className="link"
          to="/"
          style={{ textDecoration: 'none' }}
        >
          Return to Home
        </Link>
      </Stack>

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

      {dossierPickerOpen ? (
        <FolderPickerModal
          isOpen={dossierPickerOpen}
          onClose={() => setDossierPickerOpen(false)}
          folders={folders}
          fileName="Incoming Dossier"
          onSelectFolder={async (choice) => {
            let targetFolderId = choice.folderId || folders[0]?.id || ROOT_FOLDER_ID
            if (choice.isNew && choice.folderName) {
              const newFolder = await createFolder(choice.folderName, null)
              targetFolderId = newFolder.id
            }
            const completeItems = received.filter((r) => r.status === 'complete')
            const file = sessionItemsToLibraryFile('Incoming Dossier', targetFolderId, completeItems)
            await saveFile(file)
            setDossierSaved(true)
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

/**
 * The sender's live session screen (PLAN.md §7, §8, §9; ORCHESTRATION D16).
 *
 * This is what the host device shows while a session is active and this side is the sender: the
 * dossier that was queued when the peer joined, plus a bar to put something else on the channel
 * mid-flight.
 *
 * The mid-flight bar used to be the defect. Picking a type *sent invented content immediately* —
 * an invented heading, an invented key/value pair, an invented note, and for a locked item a
 * fabricated token encrypted under the same guessable password every block shared. A product that
 * puts words on the wire nobody typed is not a cosmetic bug, and the invented token was the worst
 * of it: a "secret" whose content and password both came from the source. Nothing is invented here
 * any more, and nothing is sent until the user has written it:
 *
 *   - a text-bearing block opens a compose form; submitting sends **exactly the characters in the
 *     form**, and an empty form is refused with a message rather than a placeholder payload;
 *   - an image or file block opens the same form around a real file input, so the bytes are the
 *     user's choice (`addFileItem`) or nothing is sent;
 *   - a locked block opens `LockedItemComposeModal` — the app's one locked-item composer, with
 *     label, inner type, the password twice (decision D7) and content — and `addLockedItem` does
 *     the PBKDF2 + AES-256-GCM work (PLAN.md §11.4). This file imports no crypto and holds no
 *     password.
 *   - a divider carries no payload, so it says so instead of appending a row that would be
 *     counted as a thing that was sent.
 *
 * Status claims come from the session store now. Each row this screen created remembers the item
 * id the items API returned, so its pill is that item's real `status`; the blocks that arrived
 * with the queued dossier have no such link on this side and therefore show **no** pill, rather
 * than the old index arithmetic (`idx < sentCount ? 'sent' : 'in_progress'`) that announced
 * "Delivered" for whichever rows happened to sit above the count. The header ratio is the same
 * correction: complete items over items, both read from the store.
 *
 * The two honesty fixes in the copy are the other half of why this file changed. `safetyPhrase` is
 * `null` until the keys have been exchanged; rendering `['COBALT', 'TIMBER', 'FALCON']` in its
 * place put three invented verification words under the label the safety phrase exists to earn
 * (PLAN.md §11.6), so it now says the phrase is not available yet. And the channel is
 * end-to-end-encrypted WebRTC over the data connection — P2P when ICE allows it, TURN when it does
 * not (PLAN.md §12) — never an air gap, so the subtitle stopped claiming one.
 *
 * ## Design-system conversion (DESIGN.md)
 *
 * This was the last hand-styled screen in the app, and it is now the sender twin of
 * `ReceiverSessionView` rather than its opposite number: the same `WithMantine` wrapper, the same
 * resting panel style (Raised, 1px Border, radius lg, no shadow), the same Title/body-secondary
 * header line, the same Label-plus-Data rows, and the same `variant="default"` + `color="danger"`
 * `IconPower` end-session control. The dark ink-coloured slab carrying white labels that opened
 * this screen is gone: DESIGN.md decides the scheme once at `:root` and "never per component", so
 * a component may not paint itself a dark world inside a light page, and the shadow under its
 * sticky header broke "The Floating Only Rule" while nothing was floating. Every hand-written
 * button element became a Mantine `Button` from the variant table, every literal colour value and
 * palette utility class became a `--qrbit-*` token or a semantic Mantine colour, the icon package
 * this app was told to drop became `@tabler/icons-react`, and the type comes from the seven roles
 * — which is also why the counts and the phrase are `qrbit-text-data` with tabular figures: a
 * header ratio whose digits change width as items complete makes the line beside it jump
 * mid-transfer.
 *
 * Three claims went with the styling, because nothing on this side of the wire can verify them:
 * the `peerName` default of `'Connected peer'` (there is no name field on the wire — the screen
 * now says "Other device", the same correction the receiver twin took); the ungated green
 * `animate-radar-ping` dot, which asserted a live peer connection on every paint of this screen
 * while the receiver twin's dot is driven by `peerConfirmed` and this component's props carry no
 * liveness signal at all; and the word "delivered" on the header ratio, since a sender's item
 * reaches `complete` when its last frame is handed to the data channel (`useSession` also creates
 * text items `complete`), which means *sent*, not *received*. The ratio's arithmetic is unchanged
 * and still read from the store — only the claim in its label moved down to what is measured.
 */

import { useId, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core'
import { IconDeviceMobile, IconPower, IconPlus, IconSend } from '@tabler/icons-react'
import type { UseSessionResult } from '../../hooks/useSession'
import type { BlockType, FileBlock, LibraryFile } from '../../lib/library'
import { useSessionStore } from '../../store/sessionStore'
import type { SessionItem } from '../../store/sessionStore'
import { BlockItem } from '../library/BlockItem'
import { AddBlockModal } from '../library/AddBlockModal'
import { LockedItemComposeModal } from './LockedItemComposeModal'
import type { LockedItemInput } from './LockedItemComposeModal'
import { WithMantine } from '../common/WithMantine'

export interface SenderSessionViewProps {
  /**
   * The slice of the session this screen drives, declared as a `Pick` so the component's reach is
   * visible in its type: three ways to put something on the channel and the verification words to
   * show. `pages/Home.tsx` hands it the whole `useSession` result.
   */
  session: SenderSessionApi
  sessionFile?: LibraryFile | null
  /**
   * What to call the other device. The app never learns a peer's name — there is no such
   * field on the wire — so this is optional and there is no invented default: without it the
   * screen says "Other device", which is the truth. `pages/Home.tsx` passes nothing.
   */
  peerName?: string
  onEndSession: () => void
}

/** What this screen may ask a session to do — and nothing else. */
export type SenderSessionApi = Pick<
  UseSessionResult,
  'addTextItem' | 'addFileItem' | 'addLockedItem' | 'safetyPhrase'
>

/** One row of this screen's board, and the session item behind it when there is one. */
interface SenderRow {
  block: FileBlock
  /** The id the items API returned for what this row sent; `null` for a queued dossier block. */
  itemId: string | null
}

/** A resting panel: Raised, 1px Border, radius lg, no shadow at rest (DESIGN.md). */
const PANEL_STYLE = {
  background: 'var(--qrbit-raised)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-lg)',
} as const

/**
 * A verification word, drawn exactly as `ReceiverSessionView` and `SessionView` draw it, so the
 * words a user reads across from the other device look like the same object on both screens.
 */
const PHRASE_WORD_STYLE = {
  background: 'var(--qrbit-sunken)',
  border: '1px solid var(--qrbit-border)',
  borderRadius: 'var(--qrbit-radius-sm)',
  padding: '2px 8px',
  color: 'var(--qrbit-ink)',
} as const

/**
 * DESIGN.md's Inputs rule — Raised fill, 1px Border Strong, radius sm — on the one field the
 * browser draws itself. The 16px floor is left to `styles.css`'s `input` rule rather than set
 * here: a file field under it makes iOS zoom the page on focus.
 */
const FILE_FIELD_STYLE = {
  width: '100%',
  background: 'var(--qrbit-raised)',
  border: '1px solid var(--qrbit-border-strong)',
  borderRadius: 'var(--qrbit-radius-sm)',
  padding: '8px 12px',
  color: 'var(--qrbit-ink)',
} as const

/** The kinds the compose form takes text for. A rich-text item's content is Tiptap JSON, which a
 * one-line form cannot honestly produce, so all three go out as plain text items. */
const TEXT_BLOCK_TYPES: readonly BlockType[] = ['heading', 'shortText', 'richText']

function isTextType(type: BlockType): boolean {
  return TEXT_BLOCK_TYPES.some((candidate) => candidate === type)
}

function isFileType(type: BlockType): boolean {
  return type === 'image' || type === 'fileAttachment'
}

/**
 * The pill a row wears, from the store's own item.
 *
 * `undefined` status means the item id was not on the board (a session that ended underneath the
 * send), which is rendered as no pill at all rather than as a delivery claim.
 */
function pillFor(item: SessionItem | undefined): 'pending' | 'in_progress' | 'sent' | 'error' | undefined {
  if (item === undefined) return undefined
  // The store's vocabulary and the row's are not the same words for the same state, and
  // `'complete'` is not a status a row can render: it is the frame having arrived, which is what
  // "sent" means here.
  if (item.status === 'transferring') return 'in_progress'
  if (item.status === 'complete') return 'sent'
  return item.status
}

export function SenderSessionView(props: SenderSessionViewProps) {
  return (
    <WithMantine>
      <SenderSessionViewInner {...props} />
    </WithMantine>
  )
}

function SenderSessionViewInner({
  session,
  sessionFile,
  peerName,
  onEndSession,
}: SenderSessionViewProps) {
  const [rows, setRows] = useState<SenderRow[]>(() =>
    (sessionFile?.blocks ?? []).map((block) => ({ block, itemId: null })),
  )
  const [isAddBlockOpen, setIsAddBlockOpen] = useState(false)
  /** The block type the compose form is filling in; `null` closes the form. */
  const [composing, setComposing] = useState<BlockType | null>(null)
  const [draftText, setDraftText] = useState('')
  const [draftFile, setDraftFile] = useState<File | null>(null)
  /** Why a send was refused, in words the user can act on. Cleared by the next edit. */
  const [composeError, setComposeError] = useState<string | null>(null)
  const [isLockedComposeOpen, setLockedComposeOpen] = useState(false)
  const fileFieldId = useId()

  const items = useSessionStore((state) => state.items)

  const handleAddBlock = (type: BlockType): void => {
    setIsAddBlockOpen(false)
    setComposeError(null)
    setDraftText('')
    setDraftFile(null)

    if (type === 'divider') {
      // Nothing to send, so nothing is appended: a divider on a board whose header counts
      // delivered items would be counted as one.
      setComposing(null)
      setComposeError('A divider carries no payload, so there is nothing to send.')
      return
    }

    if (type === 'locked') {
      setComposing(null)
      setLockedComposeOpen(true)
      return
    }

    setComposing(type)
  }

  /**
   * Send what the form holds, or refuse.
   *
   * The item's content is `draftText` itself — no heading marker, no `label: value` scaffold, no
   * default. An empty or whitespace-only form is the refusal case, which is what replaced the
   * auto-sent placeholder.
   */
  const handleSendText = (): void => {
    if (composing === null || !isTextType(composing)) return
    const content = draftText
    if (content.trim() === '') {
      setComposeError('Write what the peer should receive. Nothing was sent.')
      return
    }

    const itemId = session.addTextItem(content)
    if (itemId === '') {
      // `useSession` refuses outside an active session; a row here would claim a send that
      // never reached the wire.
      setComposeError('The session is no longer active, so nothing was sent.')
      return
    }

    setRows((current) => [...current, { block: { id: itemId, type: composing, content }, itemId }])
    closeForm()
  }

  /** Send the file the user chose, through the ordinary chunk pipeline. */
  const handleSendFile = (): void => {
    if (composing === null || !isFileType(composing)) return
    const file = draftFile
    if (file === null) {
      setComposeError('Choose a file first. Nothing was sent.')
      return
    }

    const itemId = session.addFileItem(file)
    if (itemId === '') {
      setComposeError('The session is no longer active, so nothing was sent.')
      return
    }

    const block: FileBlock = {
      id: itemId,
      // The bytes decide the kind, the same way the store's item does: what a camera hands over as
      // `image/*` is an image row, and everything else is an attachment.
      type: file.type.startsWith('image/') ? 'image' : 'fileAttachment',
      fileName: file.name,
      mimeType: file.type,
      // Measured from the file, never typed in.
      fileSize: file.size,
      blob: file,
    }
    setRows((current) => [...current, { block, itemId }])
    closeForm()
  }

  const closeForm = (): void => {
    setComposing(null)
    setDraftText('')
    setDraftFile(null)
    setComposeError(null)
  }

  /**
   * The compose modal's `onAdd`: encrypt and send through the items API, then wear the row that
   * item's real tuple produced.
   *
   * The tuple is read back out of the store because it is the payload that left the device — this
   * component never holds the plaintext, the password, or a copy of anything that would need
   * zeroing (PLAN.md §11.4, §17; AGENTS.md: no session data persisted). Rejects pass straight
   * through to the modal, which is where the reason belongs, and no row is appended.
   */
  const handleAddLockedItem = async (input: LockedItemInput): Promise<string> => {
    const itemId = await session.addLockedItem(input)
    const item = useSessionStore.getState().items.find((candidate) => candidate.id === itemId)

    if (item !== undefined && item.type === 'locked') {
      const block: FileBlock = {
        id: itemId,
        type: 'locked',
        label: item.label,
        isLocked: true,
        isUnlocked: false,
        lockedData: {
          ciphertext: item.ciphertext,
          iv: item.iv,
          salt: item.salt,
          innerType: item.innerType === 'file' ? 'fileAttachment' : 'shortText',
        },
      }
      setRows((current) => [...current, { block, itemId }])
    }

    setLockedComposeOpen(false)
    return itemId
  }

  const completedCount = items.filter((item) => item.status === 'complete').length
  const safetyWords = session.safetyPhrase
  const isFileDialog = composing !== null && isFileType(composing)

  return (
    // `maw="36rem"` is the `max-w-xl` column this screen already used, kept as a token-scale
    // number rather than a Tailwind utility; the canvas colour and the viewport height come from
    // `body` in styles.css, so a component no longer paints its own page background.
    <Stack gap="lg" p="lg" maw="36rem" className="session-board" style={{ marginInline: 'auto' }}>
      {/*
        The channel header: the same resting panel `ReceiverSessionView` opens with — Title role
        for the screen's name, Body Secondary for what the channel is, and the end-session control
        on the right. There is no status dot here. The receiver's is driven by `peerConfirmed`, and
        this screen's props (`SenderSessionApi`) carry no liveness signal, so a green pulse would
        have been the component asserting a connection it cannot observe.
      */}
      <Paper component="header" p="md" radius="lg" style={PANEL_STYLE}>
        <Group justify="space-between" gap="md" wrap="wrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <IconSend
              size={16}
              aria-hidden="true"
              style={{ color: 'var(--qrbit-ink-secondary)', flex: 'none' }}
            />
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text className="qrbit-text-title">Active channel</Text>
              <Text span className="qrbit-text-body-secondary" c="dimmed">
                End-to-end encrypted over the peer data channel
              </Text>
            </Stack>
          </Group>

          {/*
            DESIGN.md's Danger row is for a destructive confirmation that names the data it
            destroys, and ending a session destroys none of the user's own: the dossier stays in
            the library and the peer keeps what already arrived. So it is the Default variant —
            Raised fill, 1px Border Strong — carrying the danger hue on the label and the power
            glyph, exactly the control the receiver twin puts in the same place.
          */}
          <Button
            variant="default"
            color="danger"
            size="sm"
            leftSection={<IconPower size={16} aria-hidden="true" />}
            onClick={onEndSession}
          >
            End session
          </Button>
        </Group>
      </Paper>

      {/*
        What the store can actually say about this channel, one Label-plus-value row each, in the
        receiver twin's order: who is on the other end, how much has left, and the words the key
        exchange produced (or that it has not).
      */}
      <Paper p="md" radius="lg" style={PANEL_STYLE}>
        <Stack gap="sm">
          <Group gap="xs" wrap="nowrap">
            <IconDeviceMobile
              size={16}
              aria-hidden="true"
              style={{ color: 'var(--qrbit-ink-muted)', flex: 'none' }}
            />
            <Text span className="qrbit-text-body-secondary">
              {peerName ?? 'Other device'}
            </Text>
          </Group>

          {/*
            "Sent", not "delivered": `complete` on this side is the last frame being handed to the
            data channel, which says nothing about the peer having received it. The numbers are the
            store's, and the Data role keeps their width fixed as they change mid-transfer.
          */}
          <Group justify="space-between" wrap="nowrap">
            <Text span className="qrbit-text-label" c="dimmed">
              Items sent
            </Text>
            <Text span className="qrbit-text-data">
              {completedCount} / {items.length}
            </Text>
          </Group>

          {/* Verification words, or the honest absence of them (PLAN.md §11.6). */}
          <Stack gap="xs">
            <Text span className="qrbit-text-label" c="dimmed">
              Safety phrase
            </Text>
            {safetyWords === null ? (
              <Text className="qrbit-text-body-secondary" c="dimmed" data-safety-phrase="absent">
                Not available until both keys are exchanged.
              </Text>
            ) : (
              <Group gap="xs" wrap="nowrap">
                {safetyWords.map((word) => (
                  <Text key={word} span className="qrbit-text-data" style={PHRASE_WORD_STYLE}>
                    {word}
                  </Text>
                ))}
              </Group>
            )}
          </Stack>
        </Stack>
      </Paper>

      <Stack component="main" gap="md" style={{ flex: 1 }}>
        {/* The dossier on the channel, and the way to put another block on it. */}
        <Group justify="space-between" gap="sm" wrap="nowrap">
          <Text
            className="qrbit-text-title"
            style={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}
          >
            {sessionFile?.name || 'Ad-hoc sends'}
          </Text>

          <Button
            variant="default"
            size="sm"
            leftSection={<IconPlus size={16} aria-hidden="true" />}
            onClick={() => {
              setIsAddBlockOpen(true)
            }}
          >
            Add block
          </Button>
        </Group>

        {/*
          The mid-session compose form: text or file, and nothing leaves without being written.
          A real `<form>`, so Enter on the field runs the same submit path as the Send button.
        */}
        {composing !== null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (isFileDialog) handleSendFile()
              else handleSendText()
            }}
            style={{
              ...PANEL_STYLE,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--qrbit-space-md)',
              padding: 'var(--qrbit-space-lg)',
            }}
          >
            {isFileDialog ? (
              <>
                <Text
                  component="label"
                  htmlFor={fileFieldId}
                  className="qrbit-text-label"
                  c="dimmed"
                  display="block"
                >
                  File to send
                </Text>
                {/* The helper names the kind that was asked for; the bytes stay the user's choice. */}
                <Text className="qrbit-text-body-secondary" c="dimmed">
                  {`Choose the ${composing === 'image' ? 'image' : 'file'} to send.`}
                </Text>
                <input
                  id={fileFieldId}
                  type="file"
                  aria-label="File to send"
                  accept={composing === 'image' ? 'image/*' : undefined}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    setDraftFile(event.currentTarget.files?.[0] ?? null)
                    setComposeError(null)
                  }}
                  style={FILE_FIELD_STYLE}
                />
              </>
            ) : (
              <Textarea
                autoFocus
                rows={3}
                resize="vertical"
                label="Text to send"
                // DESIGN.md's Label role is 12px/600; Mantine's field label is 12px/500 and the
                // weight is not a theme slot, so it is set here (as in `NewFolderModal`). The field
                // itself keeps the 16px floor a focused field needs not to zoom iOS Safari.
                description="Write what the peer should receive. Nothing is sent until you press Send."
                styles={{ label: { fontWeight: 600 }, input: { fontSize: '16px' } }}
                aria-label="Text to send"
                value={draftText}
                onChange={(event) => {
                  setDraftText(event.target.value)
                  setComposeError(null)
                }}
              />
            )}

            {composeError !== null ? (
              <p className="item-error" role="alert" data-compose-error="true">
                {composeError}
              </p>
            ) : null}

            {/* Dialog actions: quieter control first, then the one primary (DESIGN.md, Dialogs). */}
            <Group justify="end" gap="sm">
              <Button variant="subtle" size="sm" c="dimmed" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" size="sm" color="signal">
                Send
              </Button>
            </Group>
          </form>
        ) : null}

        {/*
          The board. Rows are siblings on the canvas, not cards inside a panel: `BlockItem` draws
          its own 1px border, and DESIGN.md forbids a bordered card in a bordered card.
        */}
        <Stack gap="md">
          {composeError !== null && composing === null ? (
            <p className="item-error" role="alert" data-compose-error="true">
              {composeError}
            </p>
          ) : null}

          {rows.length === 0 ? (
            <Stack gap="xs" py="xl" align="center">
              <Text className="qrbit-text-body" c="dimmed">
                Nothing has been sent on this channel yet.
              </Text>
              <Text className="qrbit-text-body-secondary" c="dimmed">
                Use “Add block” to compose an item on the live channel. Nothing is sent until you
                write it.
              </Text>
            </Stack>
          ) : (
            rows.map((row, index) => {
              const item = row.itemId === null ? undefined : items.find((candidate) => candidate.id === row.itemId)
              // Only the chunked types report progress (PLAN.md §9); text and locked items go out
              // in one frame, so there is no percentage to draw for them.
              const progress =
                item !== undefined && (item.type === 'image' || item.type === 'file')
                  ? item.progress
                  : 0

              return (
                <BlockItem
                  key={row.block.id}
                  block={row.block}
                  index={index}
                  totalBlocks={rows.length}
                  mode="sender"
                  {...(row.itemId === null ? {} : { transferStatus: pillFor(item) })}
                  transferProgress={progress}
                />
              )
            })
          )}
        </Stack>
      </Stack>

      {/* Add Block Modal */}
      <AddBlockModal
        isOpen={isAddBlockOpen}
        onClose={() => setIsAddBlockOpen(false)}
        onSelectType={handleAddBlock}
      />

      {/*
        A locked item goes through the app's one composer (PLAN.md §16 Phase 4, decisions D6 and
        D7): it collects label, inner type, the password twice and the content, refuses an
        over-cap or empty payload before encrypting, and calls `addLockedItem`. Mounted only while
        open, so the draft and the password exist for as long as the user is composing and no
        longer.
      */}
      {isLockedComposeOpen ? (
        <LockedItemComposeModal
          onAdd={handleAddLockedItem}
          onClose={() => {
            setLockedComposeOpen(false)
          }}
        />
      ) : null}
    </Stack>
  )
}

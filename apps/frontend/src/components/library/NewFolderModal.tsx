/**
 * New folder dialog (PLAN.md §6.4's "+ New Folder", §16 Phase 5).
 *
 * The parent is fixed by the browser: a new folder is created inside the folder the
 * user is looking at, with the root as `null` (PLAN.md §6.3's `createFolder(name,
 * parentId: string | null)`). The dialog says which folder that is, so "created
 * inside the folder I am looking at" is never a guess.
 *
 * Validation is deliberately one rule: a folder needs a non-empty name. The name is
 * trimmed before it is handed over — a name that is only whitespace is not a name,
 * and a trailing space is invisible in the tree. The rule is stated twice on purpose
 * and tested twice on purpose: the submit control is disabled while the field is blank,
 * and `submit()` refuses the same state, because a disabled button is a affordance and
 * an Enter key is a shortcut around it.
 *
 * The create callback is the store's, so it can be asynchronous (IndexedDB). The dialog
 * stays open and busy until it settles, and reports a rejection instead of closing and
 * leaving the user to wonder whether the folder exists. While it is busy nothing dismisses
 * it — not Escape, not the backdrop, not Cancel — because a folder that arrives after the
 * dialog has gone looks like a folder that was never asked for.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Group, Modal, TextInput } from '@mantine/core'

import { WithMantine } from '../common/WithMantine'

export interface NewFolderModalProps {
  /** The folder the new one goes inside; `null` is the tree's Root. */
  parentId: string | null
  /** The parent's display name, shown in the title. */
  parentName: string
  onCreate: (name: string, parentId: string | null) => Promise<void> | void
  onClose: () => void
}

export function NewFolderModal({ parentId, parentName, onCreate, onClose }: NewFolderModalProps) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()

  const dismiss = (): void => {
    if (busy) return
    onClose()
  }

  const submit = async (): Promise<void> => {
    if (busy || trimmed === '') return

    setBusy(true)
    setError(null)

    try {
      await onCreate(trimmed, parentId)
    } catch (cause: unknown) {
      setBusy(false)
      setError(failureMessage(cause))
      return
    }

    setBusy(false)
    onClose()
  }

  return (
    <WithMantine>
      <Modal
        opened
        onClose={dismiss}
        title={`New folder in ${parentName}`}
        size="sm"
        centered
        padding="lg"
        withCloseButton={false}
      >
        <form
          aria-busy={busy}
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            void submit()
          }}
        >
          <TextInput
            label="Folder name"
            // DESIGN.md's Label role is 12px/600; Mantine's input label is 12px/500, and
            // the weight is not a theme slot, so it is set at the call site (see theme.ts).
            styles={{ label: { fontWeight: 600 } }}
            type="text"
            value={name}
            autoComplete="off"
            autoFocus
            disabled={busy}
            error={error ?? undefined}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />

          <Group justify="flex-end" mt="lg" gap="sm" wrap="nowrap">
            <Button variant="subtle" size="sm" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              // The one affirmative action in this dialog, so it wears the one accent
              // (DESIGN.md, "The One Blue Rule").
              color="signal"
              size="sm"
              loading={busy}
              disabled={trimmed === ''}
            >
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </Group>
        </form>
      </Modal>
    </WithMantine>
  )
}

function failureMessage(cause: unknown): string {
  const detail = cause instanceof Error && cause.message.trim() !== '' ? ` (${cause.message})` : ''
  return `Could not create the folder${detail}.`
}

/**
 * The dossier editor's real file picker (ORCHESTRATION D16, attachments).
 *
 * It exists because nothing else in the editor can put bytes on a block. Until now an
 * `image` or `fileAttachment` block was created with an invented filename, an invented
 * resolution and an invented `2.4 MB`, and `lib/dossier.ts` transmitted 100 null bytes for it.
 * This is the only place a block's `blob` comes from, so the two refusals that matter —
 * a picture-shaped block holding a non-picture, and an attachment large enough to threaten
 * memory — happen here, before anything is written into the draft.
 *
 * The component owns no state and writes no block: it validates a `File` and reports it, or
 * reports why it refused. A refused choice leaves the draft exactly as it was — that is the
 * whole reason `onReject` exists instead of a value with `blob: null` in it.
 *
 * What is stored is the `File` itself (`File extends Blob`, and `parseBlock` accepts anything
 * `instanceof Blob`), so the bytes go into IndexedDB by structured clone with their name and
 * type attached. Nothing is read into memory here: an attachment is streamed from the block's
 * blob at send time (`lib/chunker.ts`) and only decrypted bytes are ever buffered.
 */

import { useRef } from 'react'
import { IconPaperclip, IconPhoto } from '@tabler/icons-react'
import { formatByteSize } from '../../lib/byteSize'

/**
 * The cap on a library attachment: 64 MiB.
 *
 * Stated and justified because it is a decision, not a constant someone liked:
 *
 *  - It is NOT D6's 3 MiB. That cap exists because a `locked-payload` travels in ONE frame
 *    under `WIRE_MAX_FRAME_BYTES` (4 MiB) and has no room for overhead. A plain attachment
 *    travels as an `image`/`file` item through the chunk pipeline (`lib/chunker.ts`), so the
 *    frame size says nothing about it.
 *  - It is a memory cap. Blobs chosen here are held in volatile memory by the editor's draft
 *    for as long as the dossier is open, are cloned into IndexedDB on Save, and are read back
 *    on every `getFile`. A dossier of a dozen screenshots, a CSV export and a weights file
 *    fits inside 64 MiB each with room to spare; a 2 GiB video does not belong in a dossier
 *    that a phone is going to hold, save and re-read.
 *  - 64 MiB is ~21x the D6 cap and ~16x `WIRE_MAX_FRAME_BYTES`, i.e. deliberately generous for
 *    "a file I am carrying between two devices on my desk", and low enough that several
 *    attachments in one dossier cannot quietly exhaust a mobile browser.
 *
 * A locked attachment is capped far below this, at `LOCKED_ITEM_MAX_PLAINTEXT_BYTES`, and the
 * caller passes that number in — see `BlockItem`, which picks the cap per block state.
 */
export const LIBRARY_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024

/** One chosen file, already validated, ready to be written onto a block. */
export interface AttachmentSelection {
  fileName: string
  blob: Blob
  mimeType: string
  /** `blob.size` — the number the display string must be derived from. */
  sizeInBytes: number
}

export interface AttachmentPickerProps {
  /** Decides `accept` and the type check. Only the two byte-carrying block types pick files. */
  blockType: 'image' | 'fileAttachment'
  /** Button label, e.g. `Choose image` or `Replace file`. */
  label: string
  /** Refusal ceiling for this block. Defaults to the library cap; a locked block passes D6's. */
  maxBytes?: number
  /** Called only with a file that passed both checks. */
  onSelect: (attachment: AttachmentSelection) => void
  /** Called with the sentence to show when a file is refused. The draft is untouched. */
  onReject: (message: string) => void
}

/** A non-image offered to an image block, or an oversized file: named, refused, explained. */
function tooLargeMessage(maxBytes: number): string {
  return `That file is larger than the ${formatByteSize(maxBytes)} an attachment can hold. Send it as a plain file item in the session instead, or split it up.`
}

function notAnImageMessage(fileName: string): string {
  return `"${fileName}" is not an image (${formatMediaType(fileName)}). An image block only accepts a file whose type starts with "image/".`
}

/** How a refused file is described: by the extension the user sees in the picker. */
function formatMediaType(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? `.${fileName.slice(dot + 1)}` : 'no extension'
}

export function AttachmentPicker({
  blockType,
  label,
  maxBytes = LIBRARY_ATTACHMENT_MAX_BYTES,
  onSelect,
  onReject,
}: AttachmentPickerProps) {
  const input = useRef<HTMLInputElement | null>(null)

  const isImage = blockType === 'image'
  const Icon = isImage ? IconPhoto : IconPaperclip

  const handleFiles = (chosen: FileList | null): void => {
    const file = chosen?.[0] ?? null
    if (file === null) return

    // Size first: an oversized file must never reach the draft, and measuring it is free.
    if (file.size > maxBytes) {
      onReject(tooLargeMessage(maxBytes))
      return
    }

    // `accept` is a hint the OS may ignore (a camera roll, a renamed file, a desktop picker
    // set to "All files"), so the type is asserted, not trusted.
    if (isImage && !file.type.startsWith('image/')) {
      onReject(notAnImageMessage(file.name))
      return
    }

    onSelect({
      fileName: file.name,
      blob: file,
      // An unknown extension leaves `File.type` blank; the block keeps whatever the browser
      // announced and `lib/dossier.ts` falls back to the blob's own type at send time.
      mimeType: file.type,
      sizeInBytes: file.size,
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          input.current?.click()
        }}
        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#1D4ED8] bg-white border border-[#D1D9E4] rounded hover:bg-blue-50 tactile-btn cursor-pointer"
      >
        <Icon size={14} aria-hidden="true" />
        <span>{label}</span>
      </button>
      <input
        ref={input}
        type="file"
        accept={isImage ? 'image/*' : undefined}
        hidden
        tabIndex={-1}
        data-attachment-input={blockType}
        aria-label={label}
        onChange={(event) => {
          handleFiles(event.currentTarget.files)
          // Cleared so picking the same file twice in a row still fires a change (the same
          // rule `session/AddItemBar.tsx` follows).
          event.currentTarget.value = ''
        }}
      />
    </>
  )
}

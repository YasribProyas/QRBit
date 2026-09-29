/**
 * Byte counts for display (ORCHESTRATION D16, dossier attachments).
 *
 * This exists because a size on screen has to come from somewhere real. `FileBlock.fileSize`
 * is `string | number`: a number is a measured byte count (`blob.size`), a string is a legacy
 * stored label (the demo dossiers carry `'24.8 KB'` written by hand, and pre-existing records
 * cannot be re-measured). Formatting lives here so the editor row, the library's first-block
 * preview and the too-large message all say the same thing about the same number, instead of
 * each keeping a literal that can drift into a lie.
 */

const BYTES_PER_KIB = 1024
const BYTES_PER_MIB = 1024 * BYTES_PER_KIB
const BYTES_PER_GIB = 1024 * BYTES_PER_MIB

/**
 * A real byte count as the app writes it out.
 *
 * Binary units (KiB/MiB/GiB, 1024-step) because every cap in this app is counted in them —
 * D6's 3 MiB locked cap and the library attachment cap alike — and a decimal-KB label next to
 * a binary cap is how a file that "should have fit" gets refused.
 */
export function formatByteSize(bytes: number): string {
  if (bytes < BYTES_PER_KIB) return `${bytes} B`
  if (bytes < BYTES_PER_MIB) return `${(bytes / BYTES_PER_KIB).toFixed(1)} KiB`
  if (bytes < BYTES_PER_GIB) return `${(bytes / BYTES_PER_MIB).toFixed(1)} MiB`
  return `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`
}

/**
 * The size of a stored attachment as display text, or `null` when nothing measured it.
 *
 * `null` is the point of the function: an attachment block with no file has no size, and every
 * caller must then say so instead of filling the gap with a plausible-looking literal. A number
 * is a byte count and gets formatted; a non-empty string is a legacy label and is shown as it
 * was stored, because rewriting somebody else's prose into a number would be its own fiction.
 */
export function fileSizeText(value: string | number | undefined): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? formatByteSize(value) : null
  }
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

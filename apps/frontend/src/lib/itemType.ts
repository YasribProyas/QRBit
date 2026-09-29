/**
 * The display vocabulary for a library item's type (PLAN.md §6.4).
 *
 * `ITEM_TYPE_ICONS` used to be exported from `components/library/LibraryItemRow.tsx`, which
 * was deleted along with the row it rendered (nothing mounted it any more — ORCHESTRATION D16
 * replaced that item UI with the dossier/block editor). The map outlived the row: the session
 * surfaces list library items and name their type beside the item's own name, and one thing
 * must not have two marks depending on which screen reads it.
 *
 * The marks were Unicode characters (pilcrow, pencil, framed picture, paperclip, lock) until
 * the icon rule was enforced: DESIGN.md prescribes one icon style — `@tabler/icons-react`,
 * one stroke weight, 16–20px — and the craft floor refuses "Unicode glyphs or emoji
 * standing in for an icon system". So every entry is now a drawn component plus the word
 * that names the type.
 *
 * The word is part of the mark, not a caption for it. DESIGN.md's badge rule ("a badge never
 * relies on colour alone") applies to glyphs too: a row whose type is carried by a picture
 * alone tells a screen reader nothing, and tells a user nothing either if the picture is the
 * only thing distinguishing a locked item from a text note. Every surface that renders
 * `Icon` renders `label` beside it, with the glyph `aria-hidden` so the word is the single
 * thing assistive tech reads for the type rather than the word twice.
 *
 * The types themselves are NOT restated here. `lib/library.ts` owns `LibraryItem` and
 * `LibraryItemType`; a component that mirrors them drifts, so the components import them.
 */

import type { CSSProperties } from 'react'
import {
  IconBlockquote,
  IconLock,
  IconNotes,
  IconPaperclip,
  IconPhoto,
} from '@tabler/icons-react'
import type { TablerIcon } from '@tabler/icons-react'
import type { LibraryItemType } from './library'

/** One type's mark: the drawn glyph and the word that names the type. */
export interface ItemTypeMark {
  /**
   * Drawn by `@tabler/icons-react` (DESIGN.md's one icon style). Surfaces render it at 16px
   * with `aria-hidden="true"`; the name is `label`'s job.
   */
  Icon: TablerIcon
  /**
   * The type as a word, in the same vocabulary the session board's type column uses
   * (`Text`, `Rich text`, `Image`, `File`, `Locked`) — one concept, one spelling.
   */
  label: string
}

/**
 * PLAN.md §6.4's type marks, keyed by the §6.1 `type` value.
 *
 * Every key must exist: an item whose type has no mark would render an empty cell, which is
 * how a row ends up looking like it holds nothing when it holds a locked payload.
 */
export const ITEM_TYPE_ICONS: Record<LibraryItemType, ItemTypeMark> = {
  text: { Icon: IconNotes, label: 'Text' },
  richtext: { Icon: IconBlockquote, label: 'Rich text' },
  image: { Icon: IconPhoto, label: 'Image' },
  file: { Icon: IconPaperclip, label: 'File' },
  locked: { Icon: IconLock, label: 'Locked' },
}

/**
 * The layout the three session surfaces share for a mark: the glyph tight against its word,
 * so the pair reads as one chip instead of two beats in the row's gap rhythm.
 *
 * Exported rather than repeated per surface for the reason this module exists at all: one
 * vocabulary read three ways is drift, and a row's type mark is the kind of thing a later
 * screen quietly re-indents.
 */
export const ITEM_TYPE_MARK_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--qrbit-space-xs)',
  flex: 'none',
} as const satisfies CSSProperties

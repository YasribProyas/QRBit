/**
 * The display vocabulary for a library item's type (PLAN.md §6.4).
 *
 * `ITEM_TYPE_ICONS` used to be exported from `components/library/LibraryItemRow.tsx`, which
 * was deleted along with the row it rendered (nothing mounted it any more — ORCHESTRATION D16
 * replaced that item UI with the dossier/block editor). The map outlived the row: the session
 * surfaces list library items and name their type with these same marks, and one thing must
 * not have two glyphs depending on which screen reads it.
 *
 * The values are the characters the surfaces already print inside a `aria-hidden` span next
 * to a real SVG icon, so a screen reader hears the type as a word and a text-only rendering
 * still says something. They are deliberately unchanged by the move: DESIGN.md's icon rule
 * ("`@tabler/icons-react`, one stroke weight, 16–20px") is about the SVG layer, and these
 * strings sit beside it rather than instead of it. Retiring them means editing every reader
 * of the map at once, which is a decision for the lanes that own those surfaces.
 *
 * The types themselves are NOT restated here. `lib/library.ts` owns `LibraryItem` and
 * `LibraryItemType`; a component that mirrors them drifts, so the components import them.
 */

import type { LibraryItemType } from './library'

/**
 * PLAN.md §6.4's type marks, keyed by the §6.1 `type` value.
 *
 * Every key must exist: an item whose type has no mark would render an empty cell, which is
 * how a row ends up looking like it holds nothing when it holds a locked payload.
 */
export const ITEM_TYPE_ICONS: Record<LibraryItemType, string> = {
  text: '¶',
  richtext: '✎',
  image: '🖼',
  file: '📎',
  locked: '🔒',
}

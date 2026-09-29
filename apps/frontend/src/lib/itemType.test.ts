/**
 * Tests for `lib/itemType.ts` — the type vocabulary the session surfaces share.
 *
 * The thing worth pinning here is the reason the map changed shape: a type may not be
 * carried by a Unicode character. `ITEM_TYPE_ICONS` used to hand back pilcrow / pencil /
 * framed-picture / paperclip / lock strings, which the surfaces printed inside an
 * `aria-hidden` span — so the only statement of "this row holds a locked payload" was a
 * pictograph that assistive tech never heard and that reads as tofu in any font without
 * the glyph. These tests hold the two halves of the replacement:
 *
 *   - every `LibraryItemType` maps to a mark whose `Icon` renders a real drawn `<svg>` from
 *     `@tabler/icons-react` (DESIGN.md's one icon style), not a character;
 *   - every mark carries the word for its type, in the same wording the session board's
 *     type column uses, so the surfaces cannot quietly relabel the same concept.
 *
 * Default node environment: this renders through `react-dom/server` rather than a live DOM,
 * because the assertion is about what the map hands back, not about layout.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ITEM_TYPE_ICONS, ITEM_TYPE_MARK_STYLE } from './itemType'
import type { LibraryItemType } from './library'

/**
 * The types the marks must cover.
 *
 * `itemType.ts`'s own `Record<LibraryItemType, ItemTypeMark>` literal is what fails to
 * compile when a type is added without a mark; this list is what fails the *tests* when the
 * map gains a key that these assertions do not follow — and a row that lost its mark used to
 * print an empty cell beside a payload that was actually there.
 */
const ALL_TYPES: readonly LibraryItemType[] = ['text', 'richtext', 'image', 'file', 'locked']

/**
 * The retired marks, as escapes so this file does not itself contain the characters it
 * forbids: pilcrow, pencil, framed picture, paperclip, lock.
 */
const RETIRED_GLYPHS = ['\u00B6', '\u270E', '\u{1F5BC}', '\u{1F4CE}', '\u{1F512}']

describe('ITEM_TYPE_ICONS', () => {
  it('covers every library item type with a drawn icon and a word', () => {
    // The map and this list describe the same set of types; neither may grow alone.
    expect(Object.keys(ITEM_TYPE_ICONS).sort()).toEqual([...ALL_TYPES].sort())

    for (const type of ALL_TYPES) {
      const mark = ITEM_TYPE_ICONS[type]

      expect(mark, `${type} has no mark`).toBeDefined()
      expect(mark.label.length, `${type} has no word`).toBeGreaterThan(0)
    }

    expect(ALL_TYPES.map((type) => ITEM_TYPE_ICONS[type].label)).toEqual([
      'Text',
      'Rich text',
      'Image',
      'File',
      'Locked',
    ])
  })

  it('draws each mark from @tabler/icons-react rather than printing a character', () => {
    for (const type of ALL_TYPES) {
      const { Icon } = ITEM_TYPE_ICONS[type]
      const markup = renderToStaticMarkup(createElement(Icon, { size: 16 }))

      // A real SVG element, the library's own class hook, and no text content of its own.
      expect(markup.startsWith('<svg'), `${type} did not render an svg`).toBe(true)
      expect(markup).toContain('tabler')
      expect(markup).not.toMatch(/>[^<]+</)
    }
  })

  it('keeps the retired Unicode glyphs out of the vocabulary entirely', () => {
    for (const type of ALL_TYPES) {
      const { Icon, label } = ITEM_TYPE_ICONS[type]
      const rendered = label + renderToStaticMarkup(createElement(Icon, { size: 16 }))

      for (const glyph of RETIRED_GLYPHS) {
        expect(rendered).not.toContain(glyph)
      }
    }
  })
})

describe('ITEM_TYPE_MARK_STYLE', () => {
  it('groups the glyph and its word as one mark', () => {
    // The pair sits tighter than the row's own gap rhythm, so it reads as a single chip.
    expect(ITEM_TYPE_MARK_STYLE.display).toBe('inline-flex')
    expect(ITEM_TYPE_MARK_STYLE.alignItems).toBe('center')
    expect(ITEM_TYPE_MARK_STYLE.gap).toBe('var(--qrbit-space-xs)')
    // It never grows: the name is the flexible part of a row.
    expect(ITEM_TYPE_MARK_STYLE.flex).toBe('none')
  })
})

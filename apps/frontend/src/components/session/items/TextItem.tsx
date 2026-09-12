/**
 * Text item (PLAN.md §9).
 *
 * One item, two views, driven by the same store shape:
 *   - SENDER (`editable`) — an input whose keystrokes go straight to the items API.
 *     The 100ms debounce (PLAN.md §19 decision 8) belongs to the API, so there is
 *     deliberately none here: a second debounce would add another 100ms and make
 *     the peer's copy lag behind what the sender sees.
 *   - RECEIVER — the store's live `content`, updated by `text-delta` frames as the
 *     sender types. Read-only: the receiver never authors this item.
 */

import { useState } from 'react'
import type { TextItem as TextItemModel } from '../../../store/sessionStore'

export interface TextItemViewProps {
  /** The store's copy of this item. */
  item: TextItemModel
  /** True on the device that authored the item (PLAN.md §9's sender view). */
  editable: boolean
  /** Fires on every keystroke; debouncing and the wire delta are the API's job. */
  onChange: (id: string, content: string) => void
}

export function TextItem({ item, editable, onChange }: TextItemViewProps) {
  /*
   * Local draft, not the store value. The store only catches up once the API's
   * debounced update lands, and a controlled input fed from a store that trails
   * the keyboard drops keystrokes. Seeded from the item so a store copy that
   * already carries content (for example after a re-render) is what the sender
   * starts editing.
   */
  const [draft, setDraft] = useState(item.content)

  if (!editable) {
    return <p className="text-item text-item--received" aria-label="Text item">{item.content}</p>
  }

  return (
    <input
      className="text-item text-item__input"
      type="text"
      value={draft}
      placeholder="Type to send…"
      aria-label="Text item"
      onChange={(event) => {
        const content = event.target.value
        setDraft(content)
        onChange(item.id, content)
      }}
    />
  )
}

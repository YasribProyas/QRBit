/**
 * Rich-text item (PLAN.md §9), backed by Tiptap.
 *
 * The item's `content` is the Tiptap JSON document as a string; that is exactly
 * what travels in a `richtext-delta` frame (PLAN.md §10), so both views agree on
 * one representation and no HTML conversion happens anywhere.
 *
 *   - SENDER (`editable`) — a real editor. Every update serialises the document
 *     and hands it to the items API, which owns the 100ms debounce (PLAN.md §19
 *     decision 8).
 *   - RECEIVER — the same editor with `editable: false`, its document replaced
 *     whenever the store's JSON changes.
 *
 * Feedback loop (the failure that matters here): the receiver's document is set
 * with `emitUpdate: false`, so applying the peer's content cannot be mistaken for
 * a local edit and echoed back. The `editable` guard on the update subscription
 * is the second line of that defence.
 *
 * The editor's lifecycle is Tiptap's: `useEditor` creates the instance and
 * destroys it when the component unmounts (pinned by RichTextItem.test.tsx), and
 * it is StrictMode-aware, which matters because main.tsx renders the app inside
 * StrictMode. Destroying it here as well would kill the instance React 19's
 * throwaway development effect cycle still needs.
 */

import { useEffect } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { RichTextItem as RichTextItemModel } from '../../../store/sessionStore'

export interface RichTextItemViewProps {
  /** The store's copy of this item. */
  item: RichTextItemModel
  /** True on the device that authored the item (PLAN.md §9's sender view). */
  editable: boolean
  /** Fires on every local edit; debouncing and the wire delta are the API's job. */
  onChange: (id: string, json: string) => void
}

/**
 * Reads a Tiptap document out of the item's JSON string.
 *
 * The string comes off the wire, so it is treated as untrusted: anything that is
 * not a JSON object with a `type` is reported as "no content" and the editor
 * starts empty instead of throwing mid-render.
 */
export function parseRichTextContent(json: string): JSONContent | undefined {
  if (json.trim() === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) return undefined
  if (typeof parsed['type'] !== 'string') return undefined

  // The shape check above is the whole contract Tiptap needs to parse a document.
  return parsed as JSONContent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function RichTextItem({ item, editable, onChange }: RichTextItemViewProps) {
  const editor = useEditor({
    extensions: [StarterKit],
    editable,
    // Explicit: this app is client-rendered only, and being explicit keeps Tiptap
    // from warning about a hydration mismatch it cannot have here.
    immediatelyRender: true,
    content: parseRichTextContent(item.content),
  })

  /*
   * Subscribed through the editor rather than the `onUpdate` option so the handler
   * is always the current render's — `onUpdate` would be frozen at the render that
   * created the editor, and it has to see the latest `onChange` and `editable`.
   */
  useEffect(() => {
    if (editor === null) return

    const handleUpdate = (): void => {
      if (!editable) return
      onChange(item.id, JSON.stringify(editor.getJSON()))
    }

    editor.on('update', handleUpdate)
    return () => {
      editor.off('update', handleUpdate)
    }
  }, [editor, editable, item.id, onChange])

  useEffect(() => {
    // Sender keeps its own document: pushing the store's (debounced, therefore
    // trailing) copy back into the editor would fight the caret.
    if (editor === null || editable) return

    const next = item.content
    if (next === JSON.stringify(editor.getJSON())) return

    const doc = parseRichTextContent(next)
    if (doc === undefined) return

    editor.commands.setContent(doc, { emitUpdate: false })
  }, [editor, editable, item.content])

  return (
    <EditorContent
      className={`richtext-item${editable ? '' : ' richtext-item--received'}`}
      editor={editor}
      aria-label="Rich text item"
    />
  )
}

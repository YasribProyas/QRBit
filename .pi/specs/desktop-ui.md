# Desktop-native UI pass (ORCHESTRATION D16)

Owner request, verbatim intent: "as desktop native as it is mobile native" — a two-panel
home (Local Library left, QR right), real folder management, real drag-reordering, a way to
delete files, and Settings reachable from the top bar.

## Findings that shape this spec

1. **Folder/file CRUD already exists and is invisible.** `components/library/LibraryBrowser.tsx`
   takes `onCreateFolder / onRenameFolder / onDeleteFolder / onRenameItem / onMoveItem /
   onDeleteItem`, and `pages/Home.tsx` renders it inside an `sr-only` div labelled "Hidden test
   harness container". The buttons exist; the design pass orphaned them. That hidden mount is
   also an accessibility problem: interactive content clipped to 0×0 is still focusable.
2. **The drag handles are a lie.** `BlockItem.tsx:228` renders `GripVertical`, and the editor's
   meta bar literally says "Drag handle or arrows to reorder", but there is **no** drag
   implementation anywhere in the repo (no `draggable`, `onDragStart`, `onDrop`, `dataTransfer`,
   no dnd library). Only `onMoveUp` / `onMoveDown` arrows work.
3. **`FileEditView` has no Save button.** Every keystroke calls `onSaveFile`, which is
   `updateFile` — it is permanently auto-saving, and the only visible action is "Send File".
4. **New dossiers ignore the folder the user is looking at.** `Home.tsx:handleCreateNewFile`
   writes to `folders[0]?.id || 'f-1'` — a hardcoded first folder and a mock-id fallback.
5. **Two models coexist.** `LibraryItem` (PLAN §6.1: text/richtext/image/file/locked) drives
   `LibraryBrowser`; `LibraryFile { blocks }` (the dossier model) drives `HomeView`. This spec
   builds the visible library on **files**, because that is what the owner sees and edits.
   `LibraryItem` stays for the receive path; merging the models is out of scope.
6. **No ordering field exists.** `LibraryFile` has `createdAt/updatedAt` only, and records are
   validated against a strict field list (`BASE_FIELDS`, `TYPE_FIELDS`). Drag-reordering the
   library therefore needs a `sortOrder` addition at the data layer, not just in a component.

## Target layout

Desktop (≥ 64rem), two panels, no page-level scroll for the shell:

```
┌──────────────────────────────────────────────────────────────┐
│ QRBit  Air-gapped structured transfer            [Settings]  │
├───────────────────────────┬──────────────────────────────────┤
│ LOCAL LIBRARY             │  BEACON READY                    │
│ [+ New Folder]            │      ▛▛▛▛▛▛▛▛▛▛▛                 │
│ ▸ ▾ Credentials   (3)  ⋮  │      code H7K2MQ4P               │
│     [+ New file]          │  Host — waiting for a peer       │
│   ⠿ API keys   Encrypted  │  [ Scan & Send ]                 │
│   ⠿ Recovery tokens       │  ── or type a code ──            │
│ ▸ ▾ Notes          (0)  ⋮  │  [________] [Join]              │
└───────────────────────────┴──────────────────────────────────┘
```

Below 64rem it collapses to a single column, QR first, library second, in flow — no drawer.
The drawer pattern was the mobile answer; a stacked column is simpler, always visible, and
does not hide the primary object behind a tap.

## Behaviour changes

| # | Change |
|---|---|
| 1 | Top bar: `Scan & Send` **removed**, replaced by `Settings` → `/settings`. `Scan & Send` moves into the QR panel as the primary action there. |
| 2 | Library header button becomes **`+ New Folder`** (was `New File`). |
| 3 | Each folder gets a `+ New file` row **at the top of its own file list**, and creating a file writes to *that* folder. |
| 4 | Folder rows get a menu: **Rename**, **Delete** (cascade, reusing `ConfirmDelete`), **New file here**. |
| 5 | File rows get a menu: **Rename**, **Move to…** (folder picker), **Delete** (confirm). |
| 6 | File rows and blocks are **drag-reorderable** via the grip, within a folder, and a file can be dropped onto a folder header to move it there. |
| 7 | `FileEditView`: explicit **Save** button, dirty indicator, folder picker, restyled Send. Editing no longer writes on every keystroke. |
| 8 | Leaving a dirty editor asks for confirmation rather than silently keeping or losing edits. |

## Decisions taken here (flagged for the owner)

- **D16.1 Explicit save replaces per-keystroke autosave.** The owner asked for a Save button;
  a Save button next to "already saved on every keystroke" would be theatre. So the editor holds
  a local draft, `Save` persists it, and Back/Close while dirty asks. Consequence: a crash or a
  tab close mid-edit now loses the draft — an explicit trade against the current behaviour which
  cannot lose edits. The confirm-on-exit is what makes that acceptable.
- **D16.2 Drag is pointer-events based, not HTML5 DnD.** HTML5 drag-and-drop does not fire on
  touch, so it cannot serve the mobile half of "desktop native *and* mobile native". A pointer
  implementation serves mouse, pen and touch with one code path, and is testable in jsdom by
  driving the synthetic events.
- **D16.3 Every drag has a keyboard twin.** Grip drag is mouse-only by nature, so each row keeps
  up/down controls with visible labels and `aria-label`s; `sortOrder` is written by the same
  reducer either way.
- **D16.4 The hidden `sr-only` `LibraryBrowser` mount is deleted,** not re-styled. Its unit tests
  target the component directly and keep running; the page stops shipping a duplicate,
  invisible copy of the library.

## Out of scope

Merging `LibraryItem` and `LibraryFile`; nested subfolders in the visible panel (the data layer
supports `parentId`, the panel shows one level and Root); changing the wire or crypto layers.

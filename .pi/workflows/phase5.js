// QRDrop Phase 5 — Local Library (PLAN.md §16 Phase 5, spec §6).
//
// Wave shape:
//   wave 1 (parallel): library.ts IDB layer (real tests via fake-indexeddb) || library UI
//                      components against a pinned store contract
//   wave 2:            libraryStore + ALL integration (Home wiring, save-from-session,
//                      from-library send, send-selected queue)
//   wave 3:            fresh-context review with a hard focus on the IDB boundary
//
// THE CENTRAL INVARIANT of this phase: the library is the ONE place IndexedDB is
// allowed (§6: persistent, device-local, never synced). Session artifacts — keys,
// phrases, in-flight items, unsaved received items — must NEVER touch it. The
// review is explicitly instructed to hunt for boundary violations.
//
// Binding decisions: D8 (send-selected starts a host session directly; Phase 6
// swaps the entry point) and D9 (sending a locked item needs no password).

const MODEL_CHAIN = [
  "agentrouter/deepseek-v4-flash",
  "omnirouter/agy/gemini-3.8-flash-high",
  null
];

function runOpts(key, opts, idx) {
  const i = idx === undefined ? 0 : idx;
  const model = MODEL_CHAIN[i];
  const o = Object.assign({}, opts);
  if (model) { o.model = model; } else { delete o.model; }
  const suffix = i === 0 ? "" : "-fb" + i;
  const retry = function () {
    if (i + 1 >= MODEL_CHAIN.length) { return null; }
    emit("lane " + key + " failed on " + String(model) + "; retrying on " + String(MODEL_CHAIN[i + 1] || "inherited session model"));
    return runOpts(key, opts, i + 1);
  };
  return runs.run(key + suffix, o).then(function (r) {
    if (r && r.ok) { return r; }
    const next = retry();
    return next === null ? r : next;
  }, function (err) {
    const next = retry();
    if (next === null) { return { ok: false, output: "", error: String(err) }; }
    return next;
  });
}

const COMMON = [
  "PROJECT: QRDrop — symmetric, browser-based E2EE P2P file transfer. Repo root: /mnt/warehouse/source/QRDrop",
  "Phases 1-4 are COMPLETE and committed: encrypted transport, safety-phrase gating, the session board",
  "(text/richtext/file/image items with async independence), and locked items (PBKDF2+AES-GCM secrets",
  "with compose/unlock UI). 543 tests pass. Do not redo earlier phases.",
  "",
  "READ FIRST (mandatory):",
  "  1. AGENTS.md — TypeScript strict everywhere. No third-party crypto (Web Crypto only). THE CRITICAL",
  "     RULE FOR THIS PHASE: 'Never store session data in IndexedDB, Cache API, or localStorage.' The",
  "     LIBRARY is the one sanctioned IndexedDB user (PLAN.md §6: persistent, device-local, never synced",
  "     to any server). Everything session-scoped — keys, the safety phrase, in-flight items, received",
  "     items the user has NOT explicitly saved — stays memory-only. When in doubt, it does not go in IDB.",
  "  2. ORCHESTRATION.md — decisions D1-D9 are BINDING; D8 and D9 govern this phase. Toolchain:",
  "     TypeScript v7.0.2 ('baseUrl' REMOVED), vitest 5 (jsdom via docblock on line 1).",
  "  3. PLAN.md — the specification. §6 is the library's constitution. Your sections are named below.",
  "",
  "SCOPE: PHASE 5 ONLY (PLAN.md §16 'Phase 5 — Local Library'). Do NOT implement Phase 6+ work: no QR",
  "generation or camera scanning (Phase 6), no PWA/manifest (Phase 6), no export/import (Phase 7).",
  "The 'Scan & Send' button's scanner entry is Phase 6 — see decision D8 for what Phase 5 builds instead.",
  "",
  "HARD RULES:",
  "  - context is fresh: you have NO prior conversation. Everything you need is on disk — read it.",
  "  - You are a WORKER, not the orchestrator. Never narrate the parent's plan or write status updates.",
  "  - Create or edit ONLY the paths listed under YOUR FILES. Other lanes run concurrently here.",
  "  - Parent-owned, NEVER edit: package.json, pnpm-workspace.yaml, tsconfig*, vite.config.ts,",
  "    vitest.config.ts, wrangler.toml, index.html, apps/frontend/public/**, worker-configuration.d.ts,",
  "    PLAN.md, AGENTS.md, ORCHESTRATION.md, TODO.md. Report a blocker instead of changing these.",
  "  - Run NO git commands. Do NOT run 'pnpm install' or add dependencies — everything needed is",
  "    installed (idb, fake-indexeddb as a DEV dep for tests, zustand).",
  "  - Do NOT start 'wrangler dev', 'workerd' or any blocking server.",
  "  - Never weaken the build: no relaxed strictness, no @ts-ignore / @ts-expect-error, no 'any' casts,",
  "    no deleted or .skip-ed tests.",
  "  - No console.* in production code; never log key material, passwords, or locked-item plaintext.",
  "",
  "FINAL OUTPUT: files created/changed, what you verified (exact results with test counts), every",
  "deviation from PLAN.md and why, and any blocker. Be concise; no large listings."
].join("\n");

const LIBRARY_TYPES = [
  "",
  "=== LIBRARY TYPES (§6.1 — Lane A owns these in library.ts; everyone else imports) ===",
  "export interface LibraryFolder { id: string; name: string; parentId: string | null;",
  "  createdAt: number; updatedAt: number }   // id: crypto.randomUUID()",
  "export type LibraryItemType = 'text' | 'richtext' | 'image' | 'file' | 'locked'",
  "export interface LibraryItemBase { id: string; folderId: string; name: string;",
  "  type: LibraryItemType; createdAt: number; updatedAt: number }",
  "export interface LibraryTextItem     extends LibraryItemBase { type: 'text';     content: string }",
  "export interface LibraryRichTextItem extends LibraryItemBase { type: 'richtext'; content: string }",
  "export interface LibraryImageItem    extends LibraryItemBase { type: 'image';    blob: Blob;",
  "  mimeType: string; size: number }",
  "export interface LibraryFileItem     extends LibraryItemBase { type: 'file';     blob: Blob;",
  "  mimeType: string; size: number }",
  "export interface LibraryLockedItem   extends LibraryItemBase { type: 'locked';   label: string;",
  "  innerType: 'text' | 'richtext' | 'file';",
  "  ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }",
  "export type LibraryItem = LibraryTextItem | LibraryRichTextItem | LibraryImageItem |",
  "  LibraryFileItem | LibraryLockedItem",
  "Note the §6.1 detail: a locked library item has BOTH a name (base, user-editable like every item)",
  "AND a label (the §9 session-locked-item field). On save-from-session, name defaults to the label.",
  "=== END TYPES ==="
].join("\n");

const STORE_CONTRACT = [
  "",
  "=== LIBRARY STORE CONTRACT (Lane B implements; Lane C consumes) ===",
  "// apps/frontend/src/store/libraryStore.ts — a zustand store wrapping library.ts",
  "interface LibraryState {",
  "  folders: LibraryFolder[]",
  "  items: LibraryItem[]",
  "  loading: boolean",
  "  error: string | null",
  "  // actions",
  "  refresh(): Promise<void>                     // reload folders+items from IDB",
  "  createFolder(name: string, parentId: string | null): Promise<LibraryFolder>",
  "  renameFolder(id: string, name: string): Promise<void>",
  "  deleteFolder(id: string): Promise<void>      // cascades items",
  "  renameItem(id: string, name: string): Promise<void>",
  "  deleteItem(id: string): Promise<void>",
  "  moveItem(id: string, targetFolderId: string): Promise<void>",
  "  saveItem(item: LibraryItem): Promise<void>   // create or update by id",
  "  itemsIn(folderId: string): LibraryItem[]     // selector helper",
  "}",
  "The store is the UI's ONLY route to IndexedDB — components never call library.ts directly.",
  "=== END CONTRACT ==="
].join("\n");

// ------------------------------------------------------------- wave 1, lane A
const LANE_IDB = [
  COMMON,
  LIBRARY_TYPES,
  "",
  "YOU ARE: Lane A — the IndexedDB library layer. Pure data access, no UI, no hooks, no store.",
  "",
  "PLAN.md sections to implement: §6.1 (the data model above), §6.2 (encryption at rest — locked",
  "items store ONLY {ciphertext, iv, salt}; the key is NEVER stored, re-derived on every unlock),",
  "§6.3 (the exact schema and the exact function signatures — follow them precisely).",
  "",
  "YOUR FILES (create only these, under apps/frontend/src/lib/):",
  "  library.ts",
  "  library.test.ts",
  "",
  "REQUIREMENTS:",
  "1. Use the installed `idb` package (promise-based IDB wrapper). Database 'qrdrop-library',",
  "   version 1. Object stores exactly per §6.3: 'folders' keyPath 'id'; 'items' keyPath 'id' with",
  "   indexes on 'folderId', 'type', and 'updatedAt'.",
  "2. Implement the §6.3 API EXACTLY (same names, same signatures):",
  "     getFolders(): Promise<LibraryFolder[]>",
  "     createFolder(name: string, parentId: string | null): Promise<LibraryFolder>",
  "     renameFolder(id: string, name: string): Promise<void>",
  "     deleteFolder(id: string): Promise<void>   // also deletes all items inside, recursively for",
  "                                             // subfolders — a folder tree dies whole",
  "     getItemsInFolder(folderId: string): Promise<LibraryItem[]>",
  "     getItem(id: string): Promise<LibraryItem | undefined>",
  "     saveItem(item: LibraryItem): Promise<void>",
  "     updateItem(id: string, patch: Partial<LibraryItem>): Promise<void>  // preserves type fields",
  "     deleteItem(id: string): Promise<void>",
  "     moveItem(id: string, targetFolderId: string): Promise<void>",
  "     saveFromSession(item: SessionItem, folderId: string): Promise<LibraryItem>",
  "   SessionItem is the store's §9 type (import it — do not redeclare).",
  "3. saveFromSession conversion rules (this is where session meets library — be precise):",
  "     TextItem      -> LibraryTextItem     { content }",
  "     RichTextItem  -> LibraryRichTextItem { content }",
  "     ImageItem     -> LibraryImageItem    { blob (the assembled blob; for the SENDER's item the",
  "                                            source File), mimeType, size }",
  "     FileItem      -> LibraryFileItem     { same }",
  "     LockedItem    -> LibraryLockedItem   { label, innerType, ciphertext, iv, salt — the tuple",
  "                                            travels AS-IS; never decrypted, never re-encrypted",
  "                                            (§14's principle: locked items stay locked) }",
  "   name defaults sensibly: text/richtext -> 'Text note'/'Rich text note' or first words of",
  "   content; image/file -> the fileName; locked -> the label. id: a NEW uuid for the library item",
  "   (session item ids and library ids are different namespaces — do not reuse).",
  "   CRITICAL: an item whose transfer never completed (status !== 'complete', no blob for",
  "   image/file) must throw a clear error — never save a half-transfer.",
  "4. Structural validation on save/update: an item written to IDB must match its declared type's",
  "   shape (a 'text' item with no content, a 'locked' item missing any of ciphertext/iv/salt, an",
  "   image/file without blob/mimeType/size -> throw). IDB is untyped at runtime; this layer is the",
  "   boundary that keeps garbage out. Also validate folderId references an existing folder.",
  "5. Uint8Array handling: IDB CAN store Uint8Array natively, but structured-clone round-trips can",
  "   return it in subtly different forms across engines. Normalise on read (ensure ciphertext/iv/",
  "   salt are true Uint8Array after retrieval) and assert byte-equality in tests. Same for Blob.",
  "6. NO session data beyond explicit saveItem/saveFromSession calls: this module never touches the",
  "   session store, keys, or the wire. It is a plain data layer.",
  "",
  "TESTS: use fake-indexeddb (installed as a dev dep) — import 'fake-indexeddb/auto' at the top of",
  "the test file (or use IDBFactory from it per-test for isolation; per-test isolation is better:",
  "each test gets a fresh DB). Cover: folder CRUD incl. recursive delete with nested folders and",
  "items; every saveFromSession conversion (incl. locked stays byte-identical ciphertext — compare",
  "all three fields byte-for-byte); the incomplete-transfer rejection; the structural validation",
  "rejections; move/rename/update preserving type fields; byte-equality of Uint8Array and Blob",
  "round-trips; and the items index queries (by folderId, by type). NOTE: fake-indexeddb runs in",
  "the plain node vitest environment — no jsdom docblock needed for this file."
].join("\n");

// ------------------------------------------------------------- wave 1, lane C
const LANE_UI = [
  COMMON,
  LIBRARY_TYPES,
  STORE_CONTRACT,
  "",
  "YOU ARE: Lane C — the library UI. You run CONCURRENTLY with the IDB lane, so src/lib/library.ts",
  "does NOT exist yet, and with the store arriving only in wave 2. Do not create or import either:",
  "your components are presentational and take the store's data + action callbacks as props, per the",
  "contract below. Code against the contract exactly.",
  "",
  "PLAN.md sections to implement: §6.4 (Library Browser UI — the ASCII layout, collapsible folders,",
  "type icons, lock badge, '···' menu, multi-select via long-press, inline preview/download, locked",
  "tap -> password prompt -> reveal), §7 (the Home screen's 'Your Library' section and the",
  "multi-select 'Send selected' button), §16 Phase 5's component list.",
  "",
  "YOUR FILES (create or edit only these, under apps/frontend/):",
  "  src/components/library/LibraryBrowser.tsx        (REPLACE the Phase 1 stub)",
  "  src/components/library/FolderNode.tsx            (new)",
  "  src/components/library/LibraryItemRow.tsx        (new)",
  "  src/components/library/NewFolderModal.tsx        (new)",
  "  src/components/library/SaveToLibraryModal.tsx    (new — folder picker for save-from-session)",
  "  src/styles.css                                   (edit — APPEND only)",
  "  matching *.test.tsx files",
  "",
  "REQUIREMENTS:",
  "1. LibraryBrowser — renders the folder tree (FolderNode, recursive, collapsible — collapsed state",
  "   is component-local) and the item list of the CURRENT folder, per §6.4's layout. Header row with",
  "   '+ New Folder'. Empty states for an empty folder and an empty library. Props: folders, items,",
  "   the current folder id + a setter, and action callbacks (create/rename/delete folder,",
  "   rename/move/delete item, onSendItems). The multi-select pattern per §6.4: long-press (or a",
  "   right-click / shift-click on desktop — implement long-press + a checkbox fallback) enters",
  "   selection mode; checkboxes appear on every row; a 'Send selected (N)' button appears in the",
  "   header; selecting the '···' menu exits it. Escape exits selection mode.",
  "2. FolderNode — one folder row: expand/collapse chevron, folder name, an inline rename affordance",
  "   (per §6.4 the '···' menu holds rename/move/delete), and a count badge of items directly",
  "   inside. Children render recursively when expanded.",
  "3. LibraryItemRow — type icon (text ¶, richtext ✎, image 🖼, file 📎, locked 🔒 + the §6.4 lock",
  "   badge), name, updatedAt (relative, e.g. '2h ago'), '···' menu (rename, move, delete, send).",
  "   Tapping a text/richtext item previews inline (expanded row); image shows a thumbnail (object",
  "   URL from blob, revoked properly); file offers download (object URL, revoked). Locked: tap ->",
  "   password prompt -> on correct password reveal inline (text shows, file downloads, richtext",
  "   renders read-only) -> 'Lock again' re-hides. The row NEVER holds the plaintext after",
  "   re-lock/umount; object URLs revoked. In selection mode the row shows its checkbox and the tap",
  "   toggles selection instead.",
  "   The locked unlock uses the §11.4 crypto directly (import { decryptItem } from '../../lib/crypto'",
  "   — that EXISTS since Phase 4, you may import it): the row owns its unlock because the library",
  "   is not session-scoped. Wrong password: inline error, input cleared, no crash (§17). NOTE the",
  "   ~300ms PBKDF2: show the subtle spinner.",
  "4. NewFolderModal — name input, parent = the current folder, cancel/create.",
  "5. SaveToLibraryModal — used on the session's ended screen: takes a list of receivable items",
  "   (id, name/type summary), shows a folder picker (tree with 'Root' option), and calls back with",
  "   (itemId, folderId) per item or 'save all' — presentational; the page owns the actual saving.",
  "6. NO direct library.ts or IDB access from components — data and actions arrive as props.",
  "   NO session-store access either (these components are library-domain).",
  "7. styles.css — APPEND only, existing dark theme idiom. Mobile-first: the §6.4 layout is a",
  "   mobile pattern (long-press). Keep rows thumb-friendly.",
  "",
  "TESTS (jsdom docblock convention): folder tree renders and collapses; item rows render type",
  "icons + badges; '···' menu actions fire callbacks; long-press/checkbox enters selection mode and",
  "'Send selected (N)' fires with the right ids; NewFolderModal validation; SaveToLibraryModal picks",
  "a folder and calls back per item; locked row unlock: right password reveals (spinner during the",
  "async decrypt), wrong password shows an error and clears the input, 'Lock again' re-hides; image/",
  "file rows create object URLs and revoke them on unmount (spy URL.createObjectURL/revokeObjectURL).",
  "For the locked unlock test use the REAL §11.4 crypto (encryptItem from lib/crypto to make a",
  "fixture, decryptItem path through the row) — it exists and is fast enough for a handful of items."
].join("\n");

// ------------------------------------------------------------- wave 2, lane B
const LANE_INTEGRATION = [
  COMMON,
  LIBRARY_TYPES,
  STORE_CONTRACT,
  "",
  "YOU ARE: Lane B — the library store and ALL integration wiring. Both wave-1 lanes have FINISHED:",
  "src/lib/library.ts (the IDB layer) and the library UI components exist on disk. READ THEIR ACTUAL",
  "EXPORTS AND PROPS FIRST and code against what is really there.",
  "",
  "PLAN.md sections: §6 (all), §7 (Home + the two send flows), §8 Phase 4 'Session Ended' (save to",
  "library with folder picker), §9, §16 Phase 5, and §17.",
  "",
  "YOUR FILES (create or edit only these, under apps/frontend/):",
  "  src/store/libraryStore.ts               (new — the contract above, wrapping library.ts)",
  "  src/store/libraryStore.test.ts          (new)",
  "  src/pages/Home.tsx                      (edit — live library + send-selected flow D8)",
  "  src/pages/Session.tsx                   (edit — save-to-library on the ended screen)",
  "  src/hooks/useSession.ts                 (edit — ONLY the additions the from-library send needs)",
  "  src/components/session/AddItemBar.tsx   (edit — add the 📚 button + sheet)",
  "  matching *.test.tsx files for the above",
  "",
  "WHAT TO BUILD:",
  "1. libraryStore.ts — the contract above, exactly. zustand wrapping library.ts. refresh() loads",
  "   folders + ALL items once (the library is device-local and small; client-side filtering per",
  "   folder is fine — but do use the IDB indexes where library.ts exposes them). Every mutating",
  "   action updates the store state from the IDB result (no stale copies). Errors surface in the",
  "   store's error field, never thrown into React render.",
  "2. Home.tsx — replace the Phase 1 library stub with the REAL LibraryBrowser wired to the store",
  "   (refresh on mount; folder navigation state; all CRUD callbacks). Multi-select 'Send selected'",
  "   implements decision D8: it navigates to /session in HOST mode carrying the selected library",
  "   item ids (e.g. via router state or a session-scoped module queue — NOT localStorage, NOT IDB:",
  "   session data never touches persistence), and those items send once the session goes active.",
  "3. The send-selected queue + the 📚 from-library sheet (AddItemBar) share ONE mechanism: a",
  "   session-scoped pending-send queue of library items. Add a useSession method (additive):",
  "     sendLibraryItem(item: LibraryItem): void",
  "   which converts a library item to session traffic per its type — text/richtext: announce +",
  "   delta with the stored content; image/file: the existing chunk pipeline from the stored blob",
  "   (construct a File from the Blob + name + mimeType); locked: item-announce (label, innerType)",
  "   + locked-payload with the STORED {ciphertext, iv, salt} — decision D9: NO password, NO",
  "   decryption, the tuple travels as-is. Respect D6's cap for locked (the tuple is already within",
  "   it by construction, but assert defensively). All of it under the existing active gate.",
  "   The 📚 button in AddItemBar opens a bottom sheet with the library browser (lightweight:",
  "   folders + items, tap to send immediately, multi-tap allowed, 'Done' closes).",
  "4. Session.tsx ended screen — per §8 Phase 4: for each RECEIVED item (items this device did not",
  "   create — the store knows role; sender-created items are already in the sender's library or",
  "   their business), a 'Save to Library →' affordance. Use the wave-1 SaveToLibraryModal: pick a",
  "   folder, then save via libraryStore.saveItem(library.saveFromSession(item, folderId)) — one",
  "   call per item, plus 'Save all'. Saved items show a saved state (a check or 'Saved' label);",
  "   unsaved items remain discardable (they already die with the session per §1). Locked received",
  "   items save their ciphertext tuple as-is (D9). A transfer that never completed cannot be saved",
  "   — disable its save button with a reason.",
  "5. Home.tsx ALSO: the 'Scan & Send' button stays for Phase 6 (disabled with its existing hint)",
  "   — D8's 'Send selected' is the library-driven entry that works NOW.",
  "",
  "THE IDB BOUNDARY (the review will hunt this): ONLY library.ts writes IDB, and ONLY via explicit",
  "saveItem/saveFromSession from user action (save-to-library, library CRUD). Nothing else — no",
  "session items, no keys, no phrases, no queue state, no preferences — is persisted anywhere. The",
  "send-selected queue is module/session-scoped memory only.",
  "",
  "TESTS: libraryStore against fake-indexeddb (per-test fresh DB): refresh/create/rename/delete",
  "cascade/move/save round-trips and error surfacing. sendLibraryItem: a text item announces +",
  "deltas its stored content; a file item runs the chunk pipeline from the stored blob (assert the",
  "receiver assembles byte-identical); a LOCKED item sends announce + locked-payload with the stored",
  "tuple and — the D9 test — NO decryption ever occurs (spy that decryptItem is never called) and",
  "the receiver's item ciphertext is byte-identical to the library's. Home: library renders from the",
  "store; send-selected navigates with the ids and the items send on active (two-party test).",
  "Session ended screen: received items save to the chosen folder via the modal (assert the IDB",
  "contents after), 'Save all' works, locked items save their tuple as-is, incomplete items cannot",
  "be saved. And the boundary test: spy on indexedDB (fake-indexeddb) and assert NO put occurs",
  "during a session that never saves — keys, phrases, items and queue state never touch IDB."
].join("\n");

const wave1 = await Promise.all([
  runOpts("p5-lane-a-idb", { label: "Build IndexedDB library layer", agent: "worker", context: "fresh", task: LANE_IDB }),
  runOpts("p5-lane-c-ui", { label: "Build library browser UI", agent: "worker", context: "fresh", task: LANE_UI })
]);

emit("Phase 5 wave 1: idb=" + String(wave1[0].ok) + " ui=" + String(wave1[1].ok));

if (!wave1[0].ok) {
  return {
    aborted: "IDB lane failed — wave 2 not launched",
    idbReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 6000),
    uiReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4000)
  };
}

const wave2 = await runOpts("p5-lane-b-integration", {
  label: "Wire library store + save/send flows",
  agent: "worker",
  context: "fresh",
  task: LANE_INTEGRATION
});

emit("Phase 5 wave 2: integration=" + String(wave2.ok));

const review = await runOpts("p5-review", {
  label: "Review Phase 5 library + IDB boundary",
  agent: "reviewer",
  context: "fresh",
  task: [
    "You are a fresh-context reviewer with NO prior conversation. Read the code yourself. You are",
    "READ-ONLY: no edits, no file creation, no git commands, no servers.",
    "",
    "TARGET: QRDrop Phase 5 — the local library (PLAN.md §16 Phase 5, spec §6). Repo root:",
    "/mnt/warehouse/source/QRDrop. The parent has verified typecheck/tests/build. Review design,",
    "correctness, and above all THE IDB BOUNDARY.",
    "",
    "READ: AGENTS.md (the 'never store session data in IndexedDB/Cache/localStorage' rule is the",
    "phase's central constraint), ORCHESTRATION.md (D1-D9 binding — D8 and D9 govern this phase),",
    "PLAN.md §6 (the library's constitution), §7, §8 Phase 4, §9, §14 (locked items stay locked),",
    "§16 Phase 5, §17. Code: src/lib/library.ts, src/store/libraryStore.ts, src/store/sessionStore.ts",
    "(for what counts as session data), components/library/**, pages/Home.tsx, pages/Session.tsx,",
    "hooks/useSession.ts, components/session/AddItemBar.tsx, and the tests.",
    "",
    "JUDGE, in priority order:",
    "  P0 — THE IDB BOUNDARY (this is why the review exists):",
    "   - Enumerate EVERY path that writes IndexedDB. Is every one of them an explicit user-initiated",
    "     library action (save-to-library, folder/item CRUD)? Trace the send-selected queue, the",
    "     session store, the wire handlers, the hooks — does ANY session artifact (session key, safety",
    "     phrase, session items, received-but-unsaved items, pending-send queue, connection state)",
    "     reach IDB, localStorage, sessionStorage, or Cache API?",
    "   - Does the send-selected queue survive ONLY in memory (module scope or router state)? A",
    "     persisted queue would be a session-data violation.",
    "   - Locked items in IDB: ONLY {ciphertext, iv, salt} + label/innerType/name — never plaintext,",
    "     never a derived key, never the password, never an unlock cache?",
    "   - Does D9 hold on the send path: sendLibraryItem for a locked item never calls decryptItem,",
    "     never needs the password, and the wire tuple is byte-identical to the stored one?",
    "  P0 — DATA INTEGRITY:",
    "   - saveFromSession: every §9-to-§6.1 conversion correct? Locked tuple travels as-is? An",
    "     incomplete transfer is rejected, never saved half? Ids are fresh (no collision with the",
    "     session id namespace)?",
    "   - Folder delete cascades recursively (subfolders + their items)? Orphaned items impossible?",
    "   - Structural validation: can garbage (a 'text' item without content, a locked item missing",
    "     iv) enter IDB through ANY public function?",
    "   - Uint8Array/Blob round-trips byte-identical through IDB?",
    "  P1 — UI CORRECTNESS:",
    "   - Multi-select: long-press enters selection, checkboxes appear, 'Send selected (N)' carries",
    "     the right ids, Escape exits, no way to select a folder?",
    "   - Locked row unlock in the LIBRARY (not session): right password reveals, wrong password",
    "     errors + clears + stays, 'Lock again' re-hides, plaintext gone after re-lock, object URLs",
    "     revoked, spinner over the ~300ms PBKDF2?",
    "   - Save-to-library on the ended screen: per-item folder picker, Save all, saved state shown,",
    "     incomplete items unsaveable with a reason, locked items save as-is?",
    "   - Home: the real LibraryBrowser replaces the stub, store-backed, CRUD wired end to end?",
    "  P1 — SCOPE:",
    "   - Phase 6+ work built early (QR generation, camera, PWA/manifest, export)? Early",
    "     implementation is a FINDING.",
    "   - Any @ts-ignore / 'any' / skipped tests / third-party crypto?",
    "",
    "Cite file:line for every finding. Verify by reading code, not comments. State explicitly what",
    "you confirmed correct. Do not pad.",
    "",
    "Label findings P0/P1/P2. End with EXACTLY one line: 'Merge verdict: BLOCK' or 'Merge verdict:",
    "OK' or 'Merge verdict: OK with notes'."
  ].join("\n")
});

return {
  idbOk: wave1[0].ok ?? null,
  idbReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 4500),
  uiOk: wave1[1].ok ?? null,
  uiReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4500),
  integrationOk: wave2.ok ?? null,
  integrationReport: String(wave2.output ?? wave2.error ?? "").slice(0, 7000),
  reviewOk: review.ok ?? null,
  reviewReport: String(review.output ?? review.error ?? "").slice(0, 14000)
};

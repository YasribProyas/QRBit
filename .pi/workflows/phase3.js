// QRDrop Phase 3 — Session Board + Item Types (PLAN.md §16 Phase 3).
//
// Same wave shape as Phase 2, which worked well:
//   wave 1 (parallel): protocol+chunker (pure) || session-board UI (drives the
//                      existing §9 store types, consumes a pinned items-API contract)
//   wave 2:            transport integration, reading protocol.ts's real exports
//   wave 3:            fresh-context review
//
// Carried from the Phase 2 review (binding): a transport-level gate that rejects
// item frames until the session is 'active', and 'verified' must stay unreachable.

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
  "Phases 1-2 are COMPLETE and committed: signaling + WebRTC transport with a fully encrypted DataChannel",
  "(P-256 ECDH -> HKDF -> AES-256-GCM), the safety-phrase overlay, and both-sides confirmation gating",
  "('active' only after both encrypted phrase-confirms). 267 tests pass. Do not redo earlier phases.",
  "",
  "READ FIRST (mandatory):",
  "  1. AGENTS.md — TypeScript strict everywhere. NEVER use a third-party crypto library. NEVER store",
  "     session data in IndexedDB, Cache API or localStorage. Session items and their Blobs live in",
  "     MEMORY ONLY.",
  "  2. ORCHESTRATION.md — decisions D1-D5 are BINDING. Note the toolchain facts: TypeScript v7.0.2",
  "     ('baseUrl' REMOVED), vitest 5 (jsdom via docblock on line 1).",
  "  3. PLAN.md — the specification. Your sections are named below.",
  "",
  "SCOPE: PHASE 3 ONLY (PLAN.md §16 'Phase 3 — Session Board + Item Types'). Do NOT implement Phase 4+",
  "work: locked-item encryption/compose UI is Phase 4 (the crypto.ts §11.4 functions do not exist yet —",
  "do not add them); the library picker in AddItemBar is Phase 5; QR/camera/PWA is Phase 6. The 🔒",
  "button in AddItemBar is rendered but disabled with a visible 'coming later' hint — nothing more.",
  "",
  "HARD RULES:",
  "  - context is fresh: you have NO prior conversation. Everything you need is on disk — read it.",
  "  - You are a WORKER, not the orchestrator. Never narrate the parent's plan or write status updates.",
  "  - Create or edit ONLY the paths listed under YOUR FILES. Other lanes run concurrently here.",
  "  - Parent-owned, NEVER edit: package.json, pnpm-workspace.yaml, tsconfig*, vite.config.ts,",
  "    vitest.config.ts, wrangler.toml, index.html, apps/frontend/public/**, worker-configuration.d.ts,",
  "    PLAN.md, AGENTS.md, ORCHESTRATION.md, TODO.md. Report a blocker instead of changing these.",
  "  - Run NO git commands. Do NOT run 'pnpm install' or add dependencies — everything needed is",
  "    installed (@msgpack/msgpack, @tiptap/react, @tiptap/starter-kit, @tiptap/core).",
  "  - Do NOT start 'wrangler dev', 'workerd' or any blocking server. Verify only with commands that",
  "    terminate on their own.",
  "  - Never weaken the build: no relaxing tsconfig strictness, no @ts-ignore / @ts-expect-error,",
  "    no 'any' casts, no deleting or .skip-ing tests.",
  "  - No console.* in production code; never log key material or session payloads.",
  "",
  "FINAL OUTPUT: files created/changed, what you verified (exact results with test counts), every",
  "deviation from PLAN.md and why, and any blocker. Be concise; no large listings."
].join("\n");

const ITEMS_API_CONTRACT = [
  "",
  "=== ITEMS API CONTRACT (Lane B implements on useSession; Lane C consumes) ===",
  "The store's SessionItem union (§9) ALREADY EXISTS in apps/frontend/src/store/sessionStore.ts —",
  "read it; do not redefine it. Lane C builds components against these hook methods, which are no-ops",
  "(or throw nothing) unless phase === 'active':",
  "",
  "addTextItem(initialContent?: string): string          // returns the new item id; announces it",
  "addRichTextItem(initialJson?: string): string",
  "addFileItem(file: File): string                       // classifies 'image' vs 'file' by mimeType",
  "updateTextItem(id: string, content: string): void     // debounced 100ms, streams text-delta",
  "updateRichTextItem(id: string, json: string): void    // debounced 100ms, streams richtext-delta",
  "deleteItem(id: string): void                          // sends item-delete, removes locally",
  "",
  "Receiver-side items appear in the store automatically via the same wire messages — no receiver",
  "action is needed. Every item id is a crypto.randomUUID() generated by the SENDER.",
  "=== END CONTRACT ==="
].join("\n");

// ------------------------------------------------------------- wave 1, lane A
const LANE_PROTOCOL = [
  COMMON,
  "",
  "YOU ARE: Lane A — the wire protocol and file chunker. Pure library code, no UI, no hooks.",
  "",
  "PLAN.md sections to implement: §10 (Wire Protocol — the exact message union and the msgpack-then-",
  "encrypt envelope) and §12's chunking half (chunkFile + FileAssembler, CHUNK_SIZE 16 KiB). Also read",
  "§9 (the item types your announce fields describe) and §19 decision 7 (msgpack over JSON precisely",
  "because it carries Uint8Array natively).",
  "",
  "YOUR FILES (create only these, under apps/frontend/src/lib/):",
  "  protocol.ts        — WireMessage union + msgpack encode/decode",
  "  chunker.ts         — chunkFile generator + FileAssembler",
  "  protocol.test.ts",
  "  chunker.test.ts",
  "",
  "REQUIREMENTS:",
  "1. protocol.ts — export the WireMessage union EXACTLY as PLAN.md §10 defines it:",
  "     item-announce: id, type (ItemType), label?, fileName?, mimeType?, totalSize?, totalChunks?,",
  "                    innerType?",
  "     text-delta:     id, content (string)",
  "     richtext-delta: id, content (string — the Tiptap JSON document)",
  "     file-chunk:     id, index (number), data (Uint8Array)",
  "     file-done:      id",
  "     locked-payload: id, ciphertext, iv, salt (all Uint8Array)   // TYPE ONLY — Phase 4 sends it",
  "     item-delete:    id",
  "     phrase-confirm: (no fields)",
  "     session-end:    (no fields)",
  "   ItemType is the §9 union 'text' | 'richtext' | 'image' | 'file' | 'locked'. Import it from the",
  "   store's existing definition (or re-export it) — do not declare a second copy.",
  "   Also export an isWireMessage(value: unknown): value is WireMessage validator for inbound frames,",
  "   defensive against malformed or hostile input: unknown 't', missing required fields, wrong field",
  "   types, non-integer or negative chunk index, and crucially data/iv/salt/ciphertext that are not",
  "   Uint8Array. It must never throw — return false instead.",
  "2. Serialization: use @msgpack/msgpack (installed). Export encodeWire(message: WireMessage):",
  "   Uint8Array and decodeWire(bytes: Uint8Array): WireMessage (throwing a clear error on anything",
  "   that is not a valid WireMessage). msgpack preserves Uint8Array natively — verify a file-chunk's",
  "   data round-trips as a Uint8Array with identical bytes, NOT as an array of numbers or a string.",
  "   Bound the input: reject decoded structures that are unreasonably large or deep — a hostile peer",
  "   could send a crafted frame; document the limit you choose.",
  "3. chunker.ts — exactly per PLAN.md §12:",
  "     const CHUNK_SIZE = 16 * 1024",
  "     async function* chunkFile(id: string, file: File): AsyncGenerator<WireMessage>",
  "   yielding item-announce first (with fileName, mimeType, totalSize, totalChunks), then file-chunk",
  "   per CHUNK_SIZE slice (index 0..N-1, using file.slice().arrayBuffer()), then file-done. Empty",
  "   files must produce a valid sequence (announce with totalChunks 0, then file-done).",
  "     class FileAssembler { addChunk(index, data): void; has(index): boolean; isComplete(total):",
  "     boolean; assemble(mimeType: string): Blob; chunkCount(): number }",
  "   addChunk must tolerate out-of-order, duplicate (ignored), and unknown-index chunks without",
  "   corrupting state. assemble() throws if incomplete. Chunk memory is held in a Map keyed by index.",
  "4. No crypto, no DOM, no hooks — this lane is pure and runs in the plain node test environment.",
  "",
  "TESTS: msgpack round-trip for EVERY message variant (especially file-chunk binary identity and",
  "locked-payload's three Uint8Array fields); isWireMessage rejecting each kind of malformed input;",
  "chunker yields announce -> N chunks -> done with correct indices/sizes for a file whose size is an",
  "exact multiple of CHUNK_SIZE, one that is not, and a zero-byte file; assembler handles out-of-order",
  "and duplicate chunks and refuses assemble() when incomplete; assemble() reproduces the original",
  "bytes (compare via arrayBuffer())."
].join("\n");

// ------------------------------------------------------------- wave 1, lane C
const LANE_UI = [
  COMMON,
  ITEMS_API_CONTRACT,
  "",
  "YOU ARE: Lane C — the session board UI. You run CONCURRENTLY with the protocol lane, so",
  "src/lib/protocol.ts and chunker.ts DO NOT EXIST YET. Do not create, stub or import them: your",
  "components talk to the STORE (which exists) and to the items API contract below, which Lane B",
  "implements in wave 2. Code against the contract exactly.",
  "",
  "PLAN.md sections to implement: §9 (Session Data Model + the Session Board UI table), §16 Phase 3",
  "list (SessionBoard, AddItemBar, TextItem live sync, RichTextItem with Tiptap, ImageItem, FileItem,",
  "multiple items in flight), §5 (file layout — put components where it says), §8 Phase 3 (active",
  "session = the board).",
  "",
  "YOUR FILES (create or edit only these, under apps/frontend/):",
  "  src/components/session/SessionBoard.tsx        (new — ordered item list)",
  "  src/components/session/AddItemBar.tsx          (new)",
  "  src/components/session/items/TextItem.tsx      (new)",
  "  src/components/session/items/RichTextItem.tsx  (new)",
  "  src/components/session/items/ImageItem.tsx     (new)",
  "  src/components/session/items/FileItem.tsx      (new)",
  "  src/components/ProgressRing.tsx                (new)",
  "  src/pages/Session.tsx                          (edit — see below)",
  "  src/styles.css                                 (edit — APPEND only)",
  "  matching *.test.tsx files for the above",
  "",
  "REQUIREMENTS:",
  "1. SessionBoard — renders the store's items in order (§9: items are an ordered array). Each row",
  "   delegates to the right item component. Both roles see the same board: the SENDER'S copy of an",
  "   item and the RECEIVER'S copy are driven by the same store shape. Show a small role or status",
  "   indicator per item (pending / transferring / complete / error).",
  "2. AddItemBar (sender only — PLAN.md §9: 'Add item bar (sender only)') — buttons: T (text), ¶ (rich",
  "   text), 🖼 (image — file input accept='image/*'), 📎 (file — file input, multiple), 🔒 (locked —",
  "   RENDERED BUT DISABLED with a visible 'Phase 4' hint; do not implement locked compose UI). The",
  "   library picker (📚) is Phase 5 — do not render it. Each action calls the contract API and the",
  "   new item appears on the board immediately. Image and file inputs must support MULTIPLE selected",
  "   files — each becomes its own item.",
  "3. TextItem — SENDER: a single-line (or auto-growing) input bound to updateTextItem, so typing",
  "   streams to the peer with the 100ms debounce handled by the hook — do NOT debounce in the",
  "   component too. RECEIVER: live text that updates as deltas arrive (read-only). If the local store",
  "   item already carries content, the sender's input initialises from it.",
  "4. RichTextItem — SENDER: a Tiptap editor (@tiptap/react + @tiptap/starter-kit, both installed),",
  "   onUpdate -> updateRichTextItem(id, JSON.stringify(editor.getJSON())). RECEIVER: read-only Tiptap",
  "   editor (editable: false) whose content is set from the item's JSON string as it changes. Guard",
  "   against feedback loops: receiver content updates must not emit deltas back. Destroy editors",
  "   properly on unmount (editor.destroy()) — this is a real leak if missed.",
  "5. ImageItem — thumbnail + ProgressRing while transferring; on complete, the assembled image",
  "   (item.blob) via an object URL. For 'progressive reveal' re-create the preview from the PARTIAL",
  "   blob only at a bounded number of steps (e.g. at most 8 updates across the transfer), revoking",
  "   each previous object URL. Sender shows the local preview immediately. object URLs MUST be",
  "   revoked on unmount and on item removal — blobs never touch IndexedDB (AGENTS.md).",
  "6. FileItem — filename + ProgressRing while transferring; on complete, a download button (anchor",
  "   with the object URL and a download attribute). Same revoke rules.",
  "7. ProgressRing — small SVG ring, props: progress (0-100), size, label (aria).",
  "8. Session.tsx — during phase 'active', render AddItemBar (sender only) + SessionBoard. REMOVE the",
  "   Phase 1/2 'channel check' hello panel: the encrypted phrase-confirm handshake already proves the",
  "   channel, and the board is now the active view. Keep the overlay, status bar, ended state and",
  "   error handling exactly as they are. The receiver (no AddItemBar) still sees the board live.",
  "9. The 'verified' SessionPhase must NOT be treated as reachable (an orchestrator decision carried",
  "   from the Phase 2 review) — the flow is connecting -> pairing -> active -> ended.",
  "10. styles.css — APPEND only, matching the existing dark theme and CSS variable idiom. Mobile-first.",
  "",
  "TESTS: jsdom docblock convention (see src/hooks/useWebRTC.test.tsx line 1). Use the existing store",
  "directly (it exists) and a STAND-IN for the items API (a plain object of jest-style mock functions",
  "passed as props or via a small context) — Lane B wires the real one. Cover: AddItemBar calls the",
  "right API per button and multi-file selection fans out; the board renders each item type and its",
  "status; TextItem receiver updates from store content; ImageItem/FileItem show progress then",
  "complete state and revoke object URLs on unmount; the disabled 🔒 button does nothing; Session.tsx",
  "renders the board in 'active' and NOT the old channel-check panel."
].join("\n");

// ------------------------------------------------------------- wave 2, lane B
const LANE_TRANSPORT = [
  COMMON,
  ITEMS_API_CONTRACT,
  "",
  "YOU ARE: Lane B — item transport. The protocol lane has FINISHED: src/lib/protocol.ts and chunker.ts",
  "exist on disk. READ THEIR ACTUAL EXPORTS FIRST and code against what is really there. The UI lane",
  "has also finished: SessionBoard/AddItemBar/item components exist and call the items API contract",
  "below on useSession — implement it exactly as specified, since consumers already exist.",
  "",
  "PLAN.md sections: §10 (Wire Protocol), §12 (chunking), §9 (item model + async independence), §16",
  "Phase 3, §19 decisions 7-9 (msgpack, 100ms debounce, PBKDF2 is Phase 4). Also §17: auth-tag",
  "failures drop frames silently.",
  "",
  "YOUR FILES (edit only these, under apps/frontend/):",
  "  src/lib/webrtc.ts          — Frame union -> protocol.ts WireMessage; msgpack envelope; active gate",
  "  src/hooks/useSession.ts    — items API + send/receive orchestration",
  "  src/hooks/useWebRTC.ts     — only what the above requires",
  "  src/store/sessionStore.ts  — only additive item helpers (e.g. progress updates) if needed",
  "  matching *.test.ts / *.test.tsx files",
  "",
  "WHAT TO BUILD:",
  "1. WIRE FORMAT SWITCH (§10). Replace the Phase 2 Frame union with protocol.ts's WireMessage. The",
  "   seam becomes: send -> encodeWire(msg) -> encrypt -> binary frame; inbound -> decrypt ->",
  "   decodeWire -> dispatch. Inbound frames failing isWireMessage/decode are dropped silently per",
  "   §17. The Phase 2 hello greeting is RETIRED — the encrypted phrase-confirm already proves the",
  "   channel (the UI lane has removed the channel-check panel accordingly). phrase-confirm and",
  "   session-end keep their existing behaviour.",
  "2. TRANSPORT GATE (binding decision, carried from the Phase 2 review): the session must be",
  "   structurally unable to carry item traffic before 'active'. PeerConnection (or the seam layer)",
  "   must reject item-bearing frames (item-announce, text-delta, richtext-delta, file-chunk,",
  "   file-done, item-delete, locked-payload) until it has been explicitly marked active — a method",
  "   like markActive() called once both phrase-confirms have landed. phrase-confirm and session-end",
  "   remain sendable at any time. Enforce the gate in ONE place, not in every call site.",
  "3. ITEM ORCHESTRATION — implement the items API contract exactly (Lane C's components already call",
  "   it): addTextItem/addRichTextItem announce + create the local store item; updateTextItem/",
  "   updateRichTextItem debounce 100ms (§19 decision 8) and stream deltas carrying the full content;",
  "   addFileItem classifies image vs file by mimeType and starts the chunk pipeline; deleteItem sends",
  "   item-delete and removes locally. All are no-ops unless phase === 'active'.",
  "4. RECEIVE PATH — item-announce upserts a store item; text-delta/richtext-delta update content",
  "   live; file-chunk feeds a per-item FileAssembler and updates progress; file-done assembles the",
  "   Blob and marks complete (store the Blob on the item — memory only); item-delete removes.",
  "   Progress updates to the store should be THROTTLED (e.g. at most ~10 per item, or on a timer) —",
  "   a 1 GiB transfer is ~65k chunks and a store write per chunk would thrash React.",
  "5. ASYNC INDEPENDENCE (§9: 'a large file in-flight does not block text items added after it').",
  "   Do NOT enqueue an entire file's chunks at once: that would put a text-delta behind 65k frames.",
  "   Design: keep ONE ordered outbound queue, but feed file chunks into it lazily — a per-file pump",
  "   awaits the previous chunk's completion AND channel.bufferedAmount below a threshold (e.g. 256",
  "   KiB) before enqueueing the next chunk, resuming on the channel's bufferedamountlow event. Control",
  "   frames (deltas, announces) enqueue immediately. Worst-case delay for a text-delta behind a file",
  "   is then ONE 16 KiB chunk, not the whole file. Multiple simultaneous files share the channel via",
  "   their own pumps. State the threshold you chose in a comment.",
  "6. TEARDOWN — session end/abort must: stop all pumps, revoke nothing here (UI owns object URLs",
  "   from store blobs — coordinate: revoking belongs to the components that created them), clear",
  "   per-item assemblers, and never leave a pending promise that writes to a closed channel. Pumps",
  "   must observe session state and exit when it is no longer 'active'.",
  "7. The 'verified' phase stays unreachable. LockedItem wire support is Phase 4 — protocol.ts has the",
  "   type; you neither send nor specially handle it beyond isWireMessage.",
  "",
  "SECURITY INVARIANTS (a reviewer will check):",
  "  - No item frame can be sent before markActive() — prove with a test.",
  "  - Every frame still passes through the single encrypt/decrypt seam; only ArrayBuffers on the wire.",
  "  - Assembler memory is bounded by the announced totalChunks; a hostile announce claiming huge",
  "    totalChunks with no data must not preallocate or crash.",
  "  - A hostile file-chunk for an unknown item id is dropped, not crash.",
  "  - Nothing is written to IndexedDB/Cache/localStorage; blobs are in-memory only.",
  "",
  "TESTS: a full two-party run against the REAL protocol code over the linked fake sockets the",
  "existing useSession tests use — sender adds a text item and types (deltas arrive debounced), a",
  "richtext item streams JSON, a multi-chunk file (use a small File with CHUNK_SIZE slices) transfers",
  "with progress reaching 100 and assembling byte-identical on the receiver, a second small file added",
  "DURING the first transfer completes without the text deltas being starved (assert interleaving: a",
  "text-delta sent after the file started is received before the file finishes), item-delete removes",
  "on both sides, and the gate rejects an item send before both confirms. Also: chunk arrives before",
  "announce (drop or buffer — your choice, tested), duplicate chunk ignored, wrong-key frame dropped",
  "silently, and teardown mid-transfer leaves no unhandled rejection."
].join("\n");

const wave1 = await Promise.all([
  runOpts("p3-lane-a-protocol", { label: "Build wire protocol + chunker", agent: "worker", context: "fresh", task: LANE_PROTOCOL }),
  runOpts("p3-lane-c-ui", { label: "Build session board UI", agent: "worker", context: "fresh", task: LANE_UI })
]);

emit("Phase 3 wave 1: protocol=" + String(wave1[0].ok) + " ui=" + String(wave1[1].ok));

if (!wave1[0].ok) {
  return {
    aborted: "protocol lane failed — wave 2 not launched",
    protocolReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 6000),
    uiReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4000)
  };
}

const wave2 = await runOpts("p3-lane-b-transport", {
  label: "Wire item transport + async fairness",
  agent: "worker",
  context: "fresh",
  task: LANE_TRANSPORT
});

emit("Phase 3 wave 2: transport=" + String(wave2.ok));

const review = await runOpts("p3-review", {
  label: "Review Phase 3 session board",
  agent: "reviewer",
  context: "fresh",
  task: [
    "You are a fresh-context reviewer with NO prior conversation. Read the code yourself. You are",
    "READ-ONLY: no edits, no file creation, no git commands, no servers.",
    "",
    "TARGET: QRDrop Phase 3 — session board + item types (PLAN.md §16 Phase 3). Repo root:",
    "/mnt/warehouse/source/QRDrop. The parent has verified typecheck/tests/build. Review design and",
    "correctness, not the build.",
    "",
    "READ: AGENTS.md, ORCHESTRATION.md (D1-D5 binding), PLAN.md §8, §9, §10, §12, §16, §17, §19. Code:",
    "apps/frontend/src/lib/protocol.ts, chunker.ts, webrtc.ts, hooks/useSession.ts, hooks/useWebRTC.ts,",
    "store/sessionStore.ts, components/session/** (SessionBoard, AddItemBar, items/*),",
    "components/ProgressRing.tsx, pages/Session.tsx, and the test files.",
    "",
    "JUDGE, in priority order:",
    "  P0 — WIRE AND SECURITY:",
    "   - Is the msgpack envelope faithful? Does file-chunk's Uint8Array survive encode->encrypt->",
    "     decrypt->decode byte-identically? Is isWireMessage genuinely defensive (unknown 't', wrong",
    "     types, negative index, non-Uint8Array data)?",
    "   - The ACTIVE GATE: can ANY item frame reach the wire before markActive()? Trace every send",
    "     path. Is the gate in one place or scattered?",
    "   - Do all frames still pass through the single encrypt/decrypt seam? Only ArrayBuffers on the",
    "     channel? No plaintext or JSON-text frames left over from Phase 2?",
    "   - Hostile-input handling: chunk for unknown item, duplicate chunk, huge announced totalChunks,",
    "     decode failure mid-transfer — dropped or crashed?",
    "   - Is ANY session item or blob written to IndexedDB/Cache/localStorage? (AGENTS.md forbids it.)",
    "  P0 — ASYNC CORRECTNESS (the core §9 promise: items are independent):",
    "   - Can a large file block a text-delta added after it? Trace the pump design: is chunk",
    "     enqueueing lazy, with backpressure, so worst-case head-of-line delay is ~one chunk?",
    "   - Do multiple simultaneous file transfers interleave correctly? Any pump starvation or",
    "     deadlock (e.g. two pumps each waiting on bufferedAmount)?",
    "   - Ordering: are announce-before-chunks and chunks-before-done guaranteed on the wire for a",
    "     single item, given the single ordered queue?",
    "   - Teardown mid-transfer: any unhandled rejection, any write to a closed channel, do pumps",
    "     actually exit? Do object URLs get revoked (by whoever created them)?",
    "   - Store thrash: is progress write-throttled for a 65k-chunk transfer?",
    "  P1 — UI CORRECTNESS:",
    "   - TextItem: does typing stream with the debounce owned by the hook (not double-debounced in",
    "     the component)? Does the receiver render live without an input?",
    "   - RichTextItem: feedback-loop guard on the receiver (content updates must not emit deltas)?",
    "     editor.destroy() on unmount for every mounted editor?",
    "   - ImageItem/FileItem: progress ring states, download/preview on complete, object URL revocation",
    "     on unmount and removal, bounded progressive-reveal re-renders?",
    "   - AddItemBar: sender-only? Multi-file fan-out? 🔒 disabled? Does the receiver see no bar but",
    "     a live board?",
    "   - Is the Phase 2 channel-check panel actually gone from Session.tsx?",
    "  P1 — SCOPE:",
    "   - Phase 4+ work built early (locked-item crypto/compose, library picker, QR/camera)?",
    "     Early implementation is a FINDING. §11.4 crypto functions must NOT exist yet.",
    "   - Any @ts-ignore / 'any' / skipped tests? Third-party crypto?",
    "",
    "Cite file:line for every finding. Verify by reading code, not comments. State explicitly what you",
    "confirmed correct. Do not pad.",
    "",
    "Label findings P0/P1/P2. End with EXACTLY one line: 'Merge verdict: BLOCK' or 'Merge verdict: OK'",
    "or 'Merge verdict: OK with notes'."
  ].join("\n")
});

return {
  protocolOk: wave1[0].ok ?? null,
  protocolReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 4500),
  uiOk: wave1[1].ok ?? null,
  uiReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4500),
  transportOk: wave2.ok ?? null,
  transportReport: String(wave2.output ?? wave2.error ?? "").slice(0, 7000),
  reviewOk: review.ok ?? null,
  reviewReport: String(review.output ?? review.error ?? "").slice(0, 14000)
};

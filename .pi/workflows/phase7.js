// QRDrop Phase 7 — Export / Import + TURN Hardening (PLAN.md §16 Phase 7).
//
// Rate limiting is ALREADY implemented (isRateLimited, KV-backed sliding window in
// signaling-worker/src/index.ts). No lane needed for it.
//
// Lanes:
//   A (parallel): lib/export.ts + ExportModal.tsx + Settings.tsx flesh-out
//   B (parallel): webrtc.ts ICE config fix (TCP-443 TODO.md item) + TURN credential
//                 end-to-end verification
//   Review (sequential, after both)
//
// Model chain: AGENTS.md rule 1 = gemini-3.8-flash-high, rule 2 = deepseek-v4-flash.
// ORCHESTRATION.md runOpts pattern: walk MODEL_CHAIN, retry on failure, distinct key suffix.

const MODEL_CHAIN = [
  "omnirouter/agy/gemini-3.8-flash-high",
  "agentrouter/deepseek-v4-flash",
  null, // inherit parent — never quota-excluded
]

function runOpts(key, opts, idx) {
  const i = idx === undefined ? 0 : idx
  const model = MODEL_CHAIN[i]
  const o = Object.assign({}, opts)
  if (model) { o.model = model } else { delete o.model }
  const suffix = i === 0 ? "" : ("-fb" + i)
  const retry = function () {
    if (i + 1 >= MODEL_CHAIN.length) return null
    emit("lane " + key + ": " + String(model) + " failed → retrying on " + String(MODEL_CHAIN[i + 1] || "inherited"))
    return runOpts(key, opts, i + 1)
  }
  return runs.run(key + suffix, o).then(
    function (r) {
      if (r && r.ok) return r
      const next = retry()
      return next === null ? r : next
    },
    function (err) {
      const next = retry()
      if (next === null) return { ok: false, output: "", error: String(err) }
      return next
    },
  )
}

// ─────────────────────────────────────────── shared preamble for all lanes ──
const COMMON = [
  "PROJECT: QRDrop — symmetric, browser-based E2EE P2P file transfer. Repo: /mnt/warehouse/source/QRDrop",
  "Phases 1–6 are COMPLETE and committed. 804 tests pass. Do NOT redo earlier phases.",
  "",
  "READ FIRST (mandatory, in order):",
  "  1. AGENTS.md — TS strict, no third-party crypto, no third-party session storage.",
  "  2. ORCHESTRATION.md — D1–D9 binding. TS 7.0.2 (no baseUrl). vitest 5 (jsdom docblock). Rate",
  "     limiting is ALREADY DONE in signaling-worker/src/index.ts — do not redo it.",
  "  3. PLAN.md §14 (export spec), §16 Phase 7 (scope), §17 (security checklist for TURN).",
  "",
  "SCOPE: Phase 7 ONLY. No Phase 8 work: no CSP headers, no Sec-Fetch-* checks, no",
  "beforeunload session-end, no IDB audit. Report those as out-of-scope if tempted.",
  "",
  "HARD RULES:",
  "  - Fresh context: you have NO prior conversation. Read everything from disk.",
  "  - You are a WORKER. Never narrate the orchestrator's plan or write status updates.",
  "  - Create/edit ONLY the paths listed under YOUR FILES. Other lanes run concurrently.",
  "  - Parent-owned, NEVER edit: package.json, pnpm-workspace.yaml, tsconfig*, vite.config.ts,",
  "    vitest.config.ts, wrangler.toml, index.html, public/**, PLAN.md, AGENTS.md,",
  "    ORCHESTRATION.md, TODO.md. Report a blocker instead of changing these.",
  "  - Run NO git commands. Do NOT run 'pnpm install'. Do NOT start wrangler dev or any server.",
  "  - No @ts-ignore / @ts-expect-error / 'any' casts. No .skip/.only on tests.",
  "  - Web Crypto API only — no third-party crypto libs.",
  "  - No console.* in production code.",
  "",
  "FINAL OUTPUT: files created/changed, exact validation results (test counts), deviations",
  "from PLAN.md, and any blockers. Be concise; no large code listings.",
].join("\n")

// ──────────────────────────────────────────────────────────────────── Lane A ──
const LANE_A = [
  COMMON,
  "",
  "YOU ARE: Lane A — export/import + Settings UI.",
  "",
  "PLAN.md sections: §14 (export/import spec in full), §16 Phase 7 (ExportModal, Settings page),",
  "§11.5 (encryptExport / decryptExport — already implemented in lib/crypto.ts; reuse it).",
  "",
  "CONTEXT — read these files before touching anything:",
  "  - apps/frontend/src/lib/crypto.ts        (encryptExport / decryptExport are there)",
  "  - apps/frontend/src/lib/library.ts       (IDB CRUD — getFolders, getItemsInFolder, saveItem,",
  "                                             deleteItem, etc. — reuse, do not re-implement)",
  "  - apps/frontend/src/store/libraryStore.ts (Zustand wrapper — check what it already exposes)",
  "  - apps/frontend/src/pages/Settings.tsx   (existing stub — replace the export section)",
  "  - apps/frontend/src/components/ tree     (naming conventions already established)",
  "",
  "YOUR FILES (create or edit only these):",
  "  apps/frontend/src/lib/export.ts             (new)",
  "  apps/frontend/src/lib/export.test.ts        (new)",
  "  apps/frontend/src/components/ExportModal.tsx   (new — PLAN.md §14 UI)",
  "  apps/frontend/src/components/ExportModal.test.tsx (new)",
  "  apps/frontend/src/pages/Settings.tsx        (replace stub with live UI)",
  "  apps/frontend/src/pages/Settings.test.tsx   (new)",
  "",
  "REQUIREMENTS:",
  "",
  "1. lib/export.ts — two functions matching PLAN.md §14 exactly:",
  "",
  "   exportLibrary(folderIds: string[] | 'all', options: { encrypt: boolean; password?: string }): Promise<Blob>",
  "   - Reads all folders + items from IDB via library.ts functions (never duplicate IDB logic).",
  "   - 'all' exports every folder and every item (including root-level items).",
  "   - folderIds[] exports only those folders and their items; items directly in root outside",
  "     the selected folders are excluded.",
  "   - Builds an ExportManifest (version:1, exportedAt, encrypted, folders[], items[]).",
  "   - LibraryItemExport: meta is the item minus blob; file/image blobs are base64 in blobData.",
  "   - Locked items ALWAYS export their {ciphertext, iv, salt} in encrypted form regardless",
  "     of the outer encrypt flag (§14, §19 decision 4). The ciphertext/iv/salt are Uint8Array",
  "     in IDB — serialize them as base64 strings in the JSON so they survive stringify/parse.",
  "   - If options.encrypt is true: serialize manifest to UTF-8, call encryptExport(password, bytes),",
  "     produce a binary Blob (application/octet-stream) with a 4-byte magic header 'QRDE' (so",
  "     importLibrary can detect encrypted vs JSON).",
  "   - If options.encrypt is false: produce a JSON Blob (application/json).",
  "   - Suggested file extension: .qrdrop (per §14).",
  "",
  "   importLibrary(file: File, options: { password?: string }): Promise<{ imported: number; errors: string[] }>",
  "   - Detects encrypted by reading first 4 bytes for 'QRDE' magic.",
  "   - Decrypts with decryptExport(password, data) if encrypted; throws a clear message",
  "     ('Wrong password or corrupted file') on DOMException.",
  "   - Parses the ExportManifest, validates version===1.",
  "   - Merges into IDB using saveItem; skips items whose id already exists (§14: 'skips",
  "     duplicates by id'). On per-item save failures, push a description to errors[] and",
  "     continue — never abort the whole import for one bad item.",
  "   - Base64 blobData → Uint8Array → Blob for file/image items.",
  "   - Locked items: reconstruct {ciphertext, iv, salt} from base64; save as LibraryLockedItem.",
  "   - Returns { imported: <count of successfully saved items>, errors: [] }.",
  "",
  "2. ExportModal.tsx — matches PLAN.md §14 UI exactly:",
  "   - Export scope: radio 'All' / 'Selected (N items)' (pass selectedCount prop; hide Selected",
  "     option when 0).",
  "   - 'Encrypt export file' checkbox; when checked: Password + Confirm fields with show/hide",
  "     toggle; submit disabled until both match and are non-empty.",
  "   - 'Note: Locked items stay locked regardless of this setting.' (§14 text verbatim).",
  "   - Cancel / Export buttons. Export calls exportLibrary, then triggers a browser download",
  "     of the resulting Blob with filename `qrdrop-export-<ISO-date>.qrdrop`.",
  "   - While exporting: button says 'Exporting…' and is disabled.",
  "   - On error: show the error message inline (do not crash; do not close the modal).",
  "   - Props: onClose(): void; selectedFolderIds?: string[]; selectedItemCount?: number.",
  "",
  "3. Settings.tsx — replace the export/import stub section with live UI:",
  "   - An 'Export Library' button that opens ExportModal.",
  "   - An 'Import Library' file input (accept='.qrdrop') with an optional password field",
  "     (shown after file selection if the file header is 'QRDE', otherwise hidden).",
  "   - 'Importing…' / 'Imported N items' / error states inline.",
  "   - Library stats section: total folders, total items, total size of blobs",
  "     (sum of size fields for image/file items). Read from libraryStore.",
  "   - Keep the existing Privacy section text.",
  "",
  "TESTS (jsdom docblock):",
  "  export.test.ts:",
  "    - exportLibrary 'all' roundtrip: export then reimport into a fresh mock IDB, all items",
  "      present, counts match.",
  "    - Locked items in an unencrypted export are still opaque (ciphertext survives).",
  "    - Encrypted export: wrong password on import rejects with 'Wrong password or corrupted file'.",
  "    - Duplicate import: re-importing the same export skips all items, errors [] but imported=0.",
  "    - 'QRDE' magic detection: a plain-JSON .qrdrop is correctly identified as unencrypted.",
  "  ExportModal.test.tsx:",
  "    - Encrypt checkbox shows/hides password fields; mismatched passwords disable submit.",
  "    - Successful export calls exportLibrary and triggers a download (mock exportLibrary,",
  "      spy on URL.createObjectURL).",
  "    - Error from exportLibrary shown inline without closing the modal.",
  "  Settings.test.tsx:",
  "    - Export button opens ExportModal.",
  "    - File input with a non-.qrdrop file is rejected gracefully.",
  "    - Library stats render from the store.",
].join("\n")

// ──────────────────────────────────────────────────────────────────── Lane B ──
const LANE_B = [
  COMMON,
  "",
  "YOU ARE: Lane B — TURN hardening + ICE config fix.",
  "",
  "PLAN.md sections: §12 (ICE config), §13 (TURN credentials), §17 (security checklist,",
  "TURN-related items). TODO.md records the specific open item to fix.",
  "",
  "CONTEXT — read these files before touching anything:",
  "  - apps/frontend/src/lib/webrtc.ts          (current ICE config and PeerConnection)",
  "  - apps/signaling-worker/src/turn.ts        (credential minting — already implemented)",
  "  - apps/signaling-worker/src/index.ts       (how creds flow from /session/new to response)",
  "  - apps/frontend/src/config.ts              (SIGNALING_URL, APP_URL)",
  "  - apps/frontend/src/hooks/useSession.ts    (how turnCredentials reach PeerConnectionOptions)",
  "  - TODO.md                                  (the exact TCP-443 open item)",
  "",
  "YOUR FILES (create or edit only these):",
  "  apps/frontend/src/lib/webrtc.ts             (edit — ICE config fix only; no other changes)",
  "  apps/frontend/src/lib/webrtc.test.ts        (edit — add/update ICE config tests)",
  "  apps/signaling-worker/src/turn.ts           (edit only if a bug is found; document any change)",
  "  apps/signaling-worker/src/turn.test.ts      (edit — add/update tests if turn.ts changes)",
  "",
  "WHAT TO FIX:",
  "",
  "1. TCP-443 ICE URL (the TODO.md / ORCHESTRATION.md flagged item):",
  "   Current webrtc.ts has `turns:turn.cloudflare.com:5349` with a comment noting the",
  "   TODO.md conflict between the port (5349 = standard TURNS) and PLAN.md §17's intent",
  "   ('TURN over TCP 443 — works on captive portals and DPI networks').",
  "   Fix: KEEP `turns:turn.cloudflare.com:5349` (it is the proper TURNS port and is",
  "   already there) AND ADD `turns:turn.cloudflare.com:443?transport=tcp` as a separate",
  "   entry in the TURN URL array. §17 explicitly wants TCP 443 for hostile-firewall",
  "   scenarios. Both URLs are needed: 5349 for standards-compliant TURNS, 443?transport=tcp",
  "   for captive portals that only pass port 443. The order in the array matters for ICE",
  "   priority — put 443?transport=tcp LAST (last resort, per §12 comment intent).",
  "",
  "2. Verify TURN credential wiring end-to-end (read-only trace, no code changes unless",
  "   a bug is found):",
  "   - /session/new mints credentials from TURN_SECRET → response body.",
  "   - useSession.ts hostSession bundle carries {code, turnCredentials}.",
  "   - Session.tsx passes the bundle; useSession picks up hostSession.turnCredentials.",
  "   - buildIceServers(options) receives turnUsername/turnCredential and embeds them.",
  "   - If any link in this chain is broken or the credentials are silently dropped,",
  "     FIX it. Otherwise document 'end-to-end verified' in your report.",
  "",
  "3. STUN-only graceful degradation: when no TURN secret is configured (local dev),",
  "   buildIceServers returns STUN only. Verify this path exists and is tested.",
  "",
  "TESTS:",
  "  webrtc.test.ts:",
  "    - buildIceServers with credentials returns all 4 TURN URLs (udp, tcp, turns:5349,",
  "      turns:443?transport=tcp) plus the STUN server; the 443?transport=tcp URL is the",
  "      last TURN URL in the array.",
  "    - buildIceServers without credentials returns STUN only.",
  "    - Username and credential appear on the TURN server entry, not the STUN entry.",
  "  (Update existing ICE config tests if they exist — do not skip them.)",
  "",
  "IMPORTANT: do NOT change the ICE transport policy ('all'), the STUN URL, or the",
  "existing UDP/TCP TURN URLs. Only add the 443?transport=tcp entry. This is a",
  "surgical one-line addition to the URL array.",
].join("\n")

// ──────────────────────────────────────────────────────────────────── Review ──
const REVIEW_TASK = [
  "You are a fresh-context READ-ONLY reviewer. No edits, no file creation, no git commands.",
  "Repo root: /mnt/warehouse/source/QRDrop. Phase 7 (Export/Import + TURN hardening) just landed.",
  "The parent ran typecheck + tests + build before you; focus on correctness, not mechanics.",
  "",
  "READ: AGENTS.md, ORCHESTRATION.md (D1–D9), PLAN.md §14, §16 Phase 7, §17 (TURN checklist),",
  "§19 decisions 3 and 4. Code to review:",
  "  apps/frontend/src/lib/export.ts",
  "  apps/frontend/src/lib/export.test.ts",
  "  apps/frontend/src/components/ExportModal.tsx",
  "  apps/frontend/src/components/ExportModal.test.tsx",
  "  apps/frontend/src/pages/Settings.tsx",
  "  apps/frontend/src/pages/Settings.test.tsx",
  "  apps/frontend/src/lib/webrtc.ts   (ICE config section only)",
  "  apps/frontend/src/lib/webrtc.test.ts",
  "",
  "JUDGE, in priority order:",
  "",
  "P0 — EXPORT SECURITY:",
  "  - Locked items MUST always export in their encrypted {ciphertext, iv, salt} form",
  "    regardless of the outer encrypt flag (§14, §19 decision 4). Does any code path",
  "    export a locked item's plaintext? Even conditionally?",
  "  - Does encryptExport / decryptExport use Web Crypto only (no third-party crypto)?",
  "  - Wrong password on encrypted import: does it surface 'Wrong password or corrupted file'",
  "    (or similar clear message) rather than leaking a DOMException stack or crashing?",
  "  - Import skips duplicates by id — not by name or content. Verified?",
  "",
  "P0 — TURN ICE CONFIG:",
  "  - Is `turns:turn.cloudflare.com:443?transport=tcp` present in the TURN URL array?",
  "  - Is it the LAST TURN URL (last resort for hostile firewalls)?",
  "  - Are the existing UDP/TCP/5349 entries still present and unmodified?",
  "  - STUN-only path when no credentials supplied — still intact?",
  "",
  "P1 — EXPORT CORRECTNESS:",
  "  - 'all' vs folderIds[] — does folderIds[] correctly exclude items in root outside the",
  "    selected folders?",
  "  - Base64 roundtrip for blob data: file/image Blobs survive export→import as identical",
  "    Blobs (same size, same mimeType)?",
  "  - Locked items: ciphertext/iv/salt are Uint8Array in IDB — are they serialized to",
  "    base64 in the JSON manifest and correctly reconstructed on import?",
  "  - QRDE magic 4-byte header: is it present in encrypted exports and absent in JSON",
  "    exports? Is detection in importLibrary correct?",
  "",
  "P1 — EXPORT UI:",
  "  - In ExportModal, when encrypt is checked: are Password + Confirm both non-empty AND",
  "    matching required before submit enables? What if only one is filled?",
  "  - Does the modal stay open on export error (requirement from spec)?",
  "  - Does Settings show the import password field only when needed (QRDE header detected",
  "    after file selection), or always?",
  "",
  "P1 — SCOPE:",
  "  - Any Phase 8 work built early (CSP, Sec-Fetch-*, beforeunload, IDB audit)?",
  "  - Any @ts-ignore / 'any' / skipped tests?",
  "",
  "Cite file:line for every finding. Verify by reading code, not comments.",
  "State explicitly what you confirmed correct.",
  "Label every finding P0 / P1 / P2.",
  "End with EXACTLY one line: 'Merge verdict: BLOCK' or 'Merge verdict: OK'",
  "or 'Merge verdict: OK with notes'.",
].join("\n")

// ─────────────────────────────────────────────────────────── orchestration ──

emit("Phase 7: launching Lane A (export/import/Settings) and Lane B (TURN ICE fix) in parallel")

const wave1 = await Promise.all([
  runOpts("p7-lane-a-export", {
    label: "Phase 7 Lane A: export/import + Settings",
    agent: "worker",
    context: "fresh",
    task: LANE_A,
  }),
  runOpts("p7-lane-b-turn", {
    label: "Phase 7 Lane B: TURN ICE config fix",
    agent: "worker",
    context: "fresh",
    task: LANE_B,
  }),
])

emit("Wave 1 done: A=" + String(wave1[0].ok) + " B=" + String(wave1[1].ok))

if (!wave1[0].ok || !wave1[1].ok) {
  return {
    aborted: "a wave-1 lane failed — review not launched",
    laneAReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 6000),
    laneBReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 6000),
  }
}

emit("Launching Phase 7 review")

const review = await runOpts("p7-review", {
  label: "Phase 7 review",
  agent: "reviewer",
  context: "fresh",
  task: REVIEW_TASK,
})

return {
  laneAOk: wave1[0].ok ?? null,
  laneAReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 6000),
  laneBOk: wave1[1].ok ?? null,
  laneBReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 6000),
  reviewOk: review.ok ?? null,
  reviewReport: String(review.output ?? review.error ?? "").slice(0, 14000),
}

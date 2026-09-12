// QRDrop Phase 4 — Locked Items (PLAN.md §16 Phase 4).
//
// Wave shape (proven over Phases 2-3):
//   wave 1 (parallel): crypto §11.4 (pure) || compose + unlock UI (store types exist; pinned contract)
//   wave 2:            wire integration (locked-payload send/receive, unlock flow)
//   wave 3:            fresh-context review
//
// Binding decisions for this phase: D6 (3 MiB locked-file cap) and D7 (confirm
// password field). Carried invariants: locked plaintext is MEMORY ONLY; the
// label travels plaintext BY DESIGN (§9); wrong password must never crash.

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
  "Phases 1-3 are COMPLETE and committed: encrypted transport (P-256 ECDH -> HKDF -> AES-256-GCM over",
  "msgpack frames), safety-phrase gating, and the session board with live text/richtext/file/image items.",
  "472 tests pass. Do not redo earlier phases.",
  "",
  "READ FIRST (mandatory):",
  "  1. AGENTS.md — TypeScript strict everywhere. NEVER a third-party crypto library: Web Crypto only.",
  "     NEVER store session data in IndexedDB, Cache API or localStorage — locked-item plaintext lives in",
  "     MEMORY ONLY, exactly like every other session artifact.",
  "  2. ORCHESTRATION.md — decisions D1-D7 are BINDING. D6 and D7 govern this phase directly. Toolchain:",
  "     TypeScript v7.0.2 ('baseUrl' REMOVED), vitest 5 (jsdom via docblock on line 1).",
  "  3. PLAN.md — the specification. Your sections are named below.",
  "",
  "SCOPE: PHASE 4 ONLY (PLAN.md §16 'Phase 4 — Locked Items (Session)'). Do NOT implement Phase 5+",
  "work: no library/IndexedDB (Phase 5), no QR/camera/PWA (Phase 6), no export (Phase 7).",
  "",
  "HARD RULES:",
  "  - context is fresh: you have NO prior conversation. Everything you need is on disk — read it.",
  "  - You are a WORKER, not the orchestrator. Never narrate the parent's plan or write status updates.",
  "  - Create or edit ONLY the paths listed under YOUR FILES. Other lanes run concurrently here.",
  "  - Parent-owned, NEVER edit: package.json, pnpm-workspace.yaml, tsconfig*, vite.config.ts,",
  "    vitest.config.ts, wrangler.toml, index.html, apps/frontend/public/**, worker-configuration.d.ts,",
  "    PLAN.md, AGENTS.md, ORCHESTRATION.md, TODO.md. Report a blocker instead of changing these.",
  "  - Run NO git commands. Do NOT run 'pnpm install' or add dependencies.",
  "  - Do NOT start 'wrangler dev', 'workerd' or any blocking server.",
  "  - Never weaken the build: no relaxed strictness, no @ts-ignore / @ts-expect-error, no 'any' casts,",
  "    no deleted or .skip-ed tests.",
  "  - SECURITY: the password is NEVER stored, cached in a ref that outlives the operation, or logged.",
  "    The safety phrase, keys, and plaintext are never logged. No console.* in production code.",
  "",
  "FINAL OUTPUT: files created/changed, what you verified (exact results with test counts), every",
  "deviation from PLAN.md and why, and any blocker. Be concise; no large listings."
].join("\n");

const LOCKED_API_CONTRACT = [
  "",
  "=== LOCKED ITEMS API CONTRACT (Lane B implements on useSession; Lane C consumes) ===",
  "The store's LockedItem type (§9) ALREADY EXISTS in store/sessionStore.ts — read it, do not",
  "redefine it. Note its receiver-side-only fields: unlocked?: boolean and plaintextContent?:",
  "string | Blob. New hook methods (Lane C codes against these):",
  "",
  "  addLockedItem(input: {",
  "    label: string",
  "    innerType: 'text' | 'richtext' | 'file'",
  "    password: string",
  "    content: string | File        // string for text/richtext (Tiptap JSON), File for file",
  "  }): Promise<string>             // resolves with the item id AFTER encryption + send",
  "",
  "  unlockItem(id: string, password: string): Promise<boolean>",
  "  // true  -> item.unlocked = true and plaintextContent set (memory only)",
  "  // false -> wrong password; item untouched; NEVER throws for a wrong password",
  "  // rejects only for unexpected infrastructure errors (item missing, channel dead)",
  "",
  "  lockItemAgain(id: string): void // re-hides: unlocked = false, plaintextContent cleared",
  "",
  "A locked item's status is 'complete' once its locked-payload frame has been sent/arrived (it is",
  "atomic, never chunked). addLockedItem is a no-op that rejects unless phase === 'active'.",
  "=== END CONTRACT ==="
].join("\n");

// ------------------------------------------------------------- wave 1, lane A
const LANE_CRYPTO = [
  COMMON,
  "",
  "YOU ARE: Lane A — the §11.4 locked-item crypto. Phase 2 built §11.1-11.3 in src/lib/crypto.ts;",
  "you are ADDING to that file, not rewriting it. This is the same high-stakes class of code:",
  "precision over speed.",
  "",
  "PLAN.md sections to implement: §11.4 (Locked Item Encryption: PBKDF2 + AES-256-GCM) — used both",
  "for in-session locked items now and for library locked items at rest in Phase 5. Also read §2",
  "(threat model rows for locked items), §6.2 (key never stored — re-derived on every unlock), §9",
  "(LockedItem), §16 Phase 4, §19 decision 9 (600,000 iterations, ~300ms, spinner is worth it).",
  "",
  "YOUR FILES (edit/create only these, under apps/frontend/src/lib/):",
  "  crypto.ts            — EDIT: add §11.4 to the existing module (keep everything else intact)",
  "  crypto.test.ts       — EDIT: extend",
  "",
  "EXACT API TO ADD (PLAN.md §11.4 — match these signatures):",
  "  deriveItemKey(password: string, salt: Uint8Array): Promise<CryptoKey>",
  "      // PBKDF2: hash SHA-256, 600_000 iterations, 256-bit output, imported as AES-GCM key",
  "      // with encrypt+decrypt usages, non-extractable.",
  "  encryptItem(password: string, plaintext: Uint8Array):",
  "      Promise<{ ciphertext: Uint8Array; iv: Uint8Array; salt: Uint8Array }>",
  "      // 1. Generate a 16-byte random salt (crypto.getRandomValues)",
  "      // 2. deriveItemKey(password, salt)",
  "      // 3. AES-256-GCM with a fresh random 12-byte IV — never a caller-supplied IV",
  "  decryptItem(password: string, salt: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array):",
  "      Promise<Uint8Array>",
  "      // MUST let the wrong-password DOMException propagate — callers distinguish failure",
  "      // from success by catching it (§16 Phase 4: wrong password shows an error, never crashes).",
  "",
  "Also export const PBKDF2_ITERATIONS = 600_000 (a named constant, test-pinned) and a",
  "LOCKED_ITEM_MAX_PLAINTEXT_BYTES = 3 * 1024 * 1024 constant implementing decision D6 — see below.",
  "",
  "REQUIREMENTS:",
  "  - Web Crypto only. Use the file's existing helpers (toBufferSourceView etc.) rather than",
  "    duplicating buffer juggling — read crypto.ts first and match its style.",
  "  - Every encryptItem call uses a FRESH salt AND a fresh IV. Two calls with the same password and",
  "    the same plaintext must produce entirely different outputs (salt and IV differ).",
  "  - The password is consumed and dropped — never stored on any object, never returned, never logged.",
  "  - Update the file-header comment that currently says §11.4 is Phase 4's to add — it has arrived.",
  "  - DO NOT touch encryptExport/decryptExport (§11.5) — that is Phase 7.",
  "",
  "DECISION D6 (binding): export LOCKED_ITEM_MAX_PLAINTEXT_BYTES = 3 MiB. A locked file item is",
  "capped at 3 MiB plaintext at COMPOSE time because locked-payload is a single frame under the",
  "4 MiB WIRE_MAX_FRAME_BYTES ceiling (ciphertext + iv + salt + msgpack overhead need headroom).",
  "Larger content goes as a regular file item, which chunks. The UI lane enforces the cap at compose;",
  "crypto.ts just exports the constant. Document D6's rationale in a comment.",
  "",
  "TESTS (extend crypto.test.ts):",
  "  1. Round-trip: encryptItem -> decryptItem returns identical bytes, for text bytes, a ~64 KiB",
  "     payload, and empty plaintext.",
  "  2. Wrong password: decryptItem rejects (assert it throws — a DOMException/OperationError), and",
  "     the error is NOT swallowed. Assert the rejection type/message mentions the operation failing.",
  "  3. Salt and IV uniqueness: two encryptItem calls with identical inputs produce different salts,",
  "     different IVs, different ciphertexts.",
  "  4. Iterations pinned: spy on crypto.subtle.deriveBits (or deriveKey) and assert PBKDF2 is",
  "     invoked with exactly 600_000 iterations and SHA-256 — so nobody can silently weaken it later.",
  "  5. Salt length is exactly 16, IV exactly 12.",
  "  6. Tamper detection: flip a bit in the ciphertext and in the IV; both must reject.",
  "  7. The D6 constant equals 3 * 1024 * 1024.",
  "  8. deriveItemKey returns a non-extractable key with exactly encrypt+decrypt usages.",
  "",
  "NOTE ON TEST SPEED: PBKDF2 at 600k iterations takes ~300ms per call (that is the point — §19.9).",
  "Keep the number of round-trips in tests proportionate; do not run hundreds of them or the suite",
  "will crawl. A dozen real derivations is plenty.",
  "",
  "VERIFY: pnpm --filter @qrdrop/frontend typecheck and pnpm --filter @qrdrop/frontend test must",
  "pass. Errors in files belonging to the concurrent UI lane are expected — ignore only those."
].join("\n");

// ------------------------------------------------------------- wave 1, lane C
const LANE_UI = [
  COMMON,
  LOCKED_API_CONTRACT,
  "",
  "YOU ARE: Lane C — the locked-item UI: compose modal, board row, and unlock modal. You run",
  "CONCURRENTLY with the crypto lane, so the §11.4 functions do NOT exist yet in crypto.ts. Do not",
  "import or stub them: the hook methods in the contract above encapsulate ALL crypto for you",
  "(addLockedItem encrypts; unlockItem decrypts). Code against the contract exactly.",
  "",
  "PLAN.md sections to implement: §16 Phase 4 (compose UI: label, type, password, content, PBKDF2",
  "spinner; receive UI: label only + Unlock -> password modal -> inline reveal; wrong password: show",
  "error, clear input, never crash), §9 (the LockedItem row in the board table and its",
  "sender/receiver views), §19 decision 9 (~300ms PBKDF2, subtle spinner worth it).",
  "",
  "YOUR FILES (create or edit only these, under apps/frontend/):",
  "  src/components/session/LockedItemComposeModal.tsx   (new)",
  "  src/components/session/items/LockedItem.tsx         (new — the board row)",
  "  src/components/session/UnlockModal.tsx              (new)",
  "  src/components/session/AddItemBar.tsx               (edit — enable the 🔒 button)",
  "  src/styles.css                                      (edit — APPEND only)",
  "  matching *.test.tsx files for the new components",
  "",
  "REQUIREMENTS:",
  "1. AddItemBar — the 🔒 button is no longer disabled: it opens LockedItemComposeModal. Keep the",
  "    existing hint text updated (no longer 'arrives in Phase 4').",
  "2. LockedItemComposeModal — fields per §16 Phase 4 plus decision D7 (binding): label (required),",
  "    innerType selector (text / rich text / file), password AND confirm-password (mismatch disables",
  "    submit; there is no recovery, so a typo must not lock the user out), and the content input that",
  "    adapts to innerType: textarea for text, a Tiptap editor for richtext (reuse how",
  "    items/RichTextItem.tsx sets up its editor), file picker for file. For file: enforce D6 — reject",
  "    a file larger than LOCKED_ITEM_MAX_PLAINTEXT_BYTES with a clear message saying to send large",
  "    files as a regular (still E2EE) file item instead. Read the constant from the contract lane's",
  "    future export via the hook? NO — the UI must not import crypto.ts (it does not exist yet for",
  "    you): hard-code 3 * 1024 * 1024 locally with a comment referencing D6, and Lane B will import",
  "    the constant and pass it as a prop (see the contract note below).",
  "    On submit: show a subtle spinner (PBKDF2 takes ~300ms, §19.9) while awaiting addLockedItem,",
  "    then close. Submission failures surface as an inline error, not a crash.",
  " 3. LockedItem (board row) — SENDER view: the 🔒 badge, label, inner-type indicator, and its own",
  "    unlock affordance (the sender encrypted it and may want to verify — unlocking locally is the",
  "    same unlockItem flow; the sender knows the password). RECEIVER view: label + 🔒 + 'Unlock'",
  "    button. When unlocked: inline reveal — text renders the decrypted text, richtext renders a",
  "    read-only Tiptap view, file renders a download button (object URL from plaintextContent,",
  "    revoked on re-lock/unmount). A 'Lock again' action calls lockItemAgain and re-hides.",
  " 4. UnlockModal — password input, spinner during unlockItem (again ~300ms), and on false (wrong",
  "    password): show an error, CLEAR the password input, keep the modal open for retry. It must",
  "    never crash on rejection of the wrong-password kind — but if unlockItem rejects for an",
  "    infrastructure reason, show that as a distinct error message.",
  " 5. The label travels plaintext BY DESIGN (§9) — do not encrypt or hide it in the UI.",
  " 6. The plaintextContent for an unlocked item is MEMORY ONLY — no persistence anywhere, and clear",
  "    it via lockItemAgain on unmount? No — clearing on unmount would lose the unlock across",
  "    re-renders; instead ensure object URLs are revoked on unmount and leave unlocked state to the",
  "    store (session lifetime only, dies with the session per §1).",
  " 7. styles.css — APPEND only, existing dark-theme idiom.",
  "",
  "CONTRACT NOTE FOR D6: Lane C should accept the max-bytes limit as a prop on the compose modal",
  "(default 3 * 1024 * 1024) so Lane B can pass crypto.ts's constant without the UI importing crypto.",
  "",
  "TESTS (jsdom docblock convention): compose modal validation (label required, password mismatch",
  "blocks submit, D6 rejection message for an oversized File, spinner shown while the async add runs,",
  "modal closes on success); AddItemBar opens it; the LockedItem row's sender and receiver views and",
  "the unlocked reveal for each innerType; UnlockModal wrong-password flow (error shown, input",
  "cleared, stays open, retry works) and lock-again re-hiding. Use a stand-in for the hook methods",
  "(mock functions) per the contract — Lane B wires the real ones."
].join("\n");

// ------------------------------------------------------------- wave 2, lane B
const LANE_TRANSPORT = [
  COMMON,
  LOCKED_API_CONTRACT,
  "",
  "YOU ARE: Lane B — wire integration for locked items. Both wave-1 lanes have FINISHED: crypto.ts",
  "now contains §11.4 (read its actual exports) and the UI components exist (read how they call the",
  "contract). The UI's compose modal takes the D6 max-bytes limit as a prop — pass crypto.ts's",
  "LOCKED_ITEM_MAX_PLAINTEXT_BYTES constant into it from the page/hook wiring.",
  "",
  "PLAN.md sections: §10 (locked-payload message), §11.4, §9 (LockedItem), §16 Phase 4, §17 (wrong",
  "password: catch DOMException, show UI error, clear input fields).",
  "",
  "YOUR FILES (edit only these, under apps/frontend/):",
  "  src/hooks/useSession.ts          — addLockedItem / unlockItem / lockItemAgain + receive path",
  "  src/hooks/useWebRTC.ts           — only if the above requires",
  "  src/pages/Session.tsx            — wire the compose modal's limit prop and any modal open state",
  "  src/components/session/AddItemBar.tsx — only if the modal-opening prop needs adjusting",
  "  matching *.test.ts / *.test.tsx files",
  "",
  "WHAT TO BUILD:",
  "1. SEND (addLockedItem per the contract): validate phase === 'active'; enforce D6 for File content",
  "   (crypto.ts exports the constant — import it here, do not re-declare); encode content — for",
  "   text/richtext it is the string's UTF-8 bytes, for file the File's bytes (await arrayBuffer());",
  "   run encryptItem (the ~300ms PBKDF2 happens here — the UI's spinner covers it); create the local",
  "   store item (status 'complete'; the SENDER's item carries label, innerType, ciphertext/iv/salt —",
  "   NOT the plaintext: the sender's row unlocks via unlockItem like anyone else); then send",
  "   item-announce with type 'locked' (label, innerType) followed by locked-payload (ciphertext, iv,",
  "   salt) — announce first, then the payload, both through the existing gated send path. The id is",
  "   a crypto.randomUUID() as with every item.",
  "2. RECEIVE: item-announce of type 'locked' upserts a locked item (status 'transferring' until the",
  "   payload lands, then 'complete'); locked-payload fills ciphertext/iv/salt. A payload for an",
  "   unknown id, or a second payload for the same id, is dropped. Hostile values (non-Uint8Array",
  "   fields) are already rejected by isWireMessage — do not duplicate that.",
  "3. UNLOCK (unlockItem per the contract): read the item's ciphertext/iv/salt, run decryptItem, and",
  "   on success set unlocked = true with plaintextContent (string for text/richtext — decode",
  "   UTF-8; Blob for file — with the item's remembered mimeType). On wrong password, catch the",
  "   DOMException and return false — NEVER let it escape as an unhandled rejection. The password",
  "   parameter is used once and dropped; never stored anywhere.",
  "4. lockItemAgain: unlocked = false, plaintextContent = undefined.",
  "5. Session.tsx wiring: pass LOCKED_ITEM_MAX_PLAINTEXT_BYTES to the compose modal; ensure the",
  "   receiver's board shows the locked row with its Unlock button (the components handle rendering).",
  "",
  "SECURITY INVARIANTS (a reviewer will check each):",
  "  - The password never appears in the store, in any ref that outlives the call, in a wire frame,",
  "    or in a log. After addLockedItem/unlockItem returns, no closure retains it.",
  "  - The SENDER's local item holds ciphertext only — the sender must not keep the plaintext blob",
  "    around (unlike regular file items where the sender keeps the source File for preview).",
  "  - plaintextContent is memory-only, session-scoped, cleared by lockItemAgain and by session end.",
  "  - A locked-payload frame exceeds no wire bound: with D6 enforced at compose, ciphertext <= ~3 MiB",
  "    + overhead fits WIRE_MAX_FRAME_BYTES; if an oversized frame somehow arrives, decodeWire's",
  "    existing bound drops it — verify that holds and note it.",
  "  - Wrong password returns false and the UI shows an error; nothing crashes (§16, §17).",
  "",
  "TESTS: full two-party run over the real crypto + protocol + linked fakes: sender composes a locked",
  "text item (assert announce-then-payload order on the wire, both under the active gate), receiver's",
  "store item reaches 'complete' with ciphertext/iv/salt and NO plaintextContent; unlockItem with the",
  "right password reveals; with a wrong password returns false and the item stays locked; a locked",
  "FILE within the D6 cap transfers and unlocks byte-identically; a file OVER the cap is rejected by",
  "addLockedItem before any frame is sent (assert nothing hit the channel); lockItemAgain re-hides;",
  "locked frames are refused before both confirms (the existing gates); and a second locked-payload",
  "for the same id is dropped. Also assert the sender's own item carries no plaintext."
].join("\n");

const wave1 = await Promise.all([
  runOpts("p4-lane-a-crypto", { label: "Build PBKDF2 locked-item crypto", agent: "worker", context: "fresh", task: LANE_CRYPTO }),
  runOpts("p4-lane-c-ui", { label: "Build locked compose + unlock UI", agent: "worker", context: "fresh", task: LANE_UI })
]);

emit("Phase 4 wave 1: crypto=" + String(wave1[0].ok) + " ui=" + String(wave1[1].ok));

if (!wave1[0].ok) {
  return {
    aborted: "crypto lane failed — wave 2 not launched",
    cryptoReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 6000),
    uiReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4000)
  };
}

const wave2 = await runOpts("p4-lane-b-transport", {
  label: "Wire locked-payload + unlock flow",
  agent: "worker",
  context: "fresh",
  task: LANE_TRANSPORT
});

emit("Phase 4 wave 2: transport=" + String(wave2.ok));

const review = await runOpts("p4-review", {
  label: "Security review of locked items",
  agent: "reviewer",
  context: "fresh",
  task: [
    "You are a fresh-context reviewer with NO prior conversation. Read the code yourself. You are",
    "READ-ONLY: no edits, no file creation, no git commands, no servers.",
    "",
    "TARGET: QRDrop Phase 4 — locked items (PLAN.md §16 Phase 4). Repo root: /mnt/warehouse/source/QRDrop.",
    "The parent has verified typecheck/tests/build. Review SECURITY and correctness of the locked-item",
    "flow. This phase handles user passwords — be adversarial.",
    "",
    "READ: AGENTS.md, ORCHESTRATION.md (D1-D7 binding — D6 and D7 govern this phase), PLAN.md §2, §6.2,",
    "§9, §10, §11.4, §16 Phase 4, §17, §19 decision 9. Code: apps/frontend/src/lib/crypto.ts (§11.4",
    "additions), hooks/useSession.ts, hooks/useWebRTC.ts, pages/Session.tsx,",
    "components/session/LockedItemComposeModal.tsx, components/session/UnlockModal.tsx,",
    "components/session/items/LockedItem.tsx, components/session/AddItemBar.tsx, and the tests.",
    "",
    "JUDGE, in priority order:",
    "  P0 — PASSWORD HANDLING (the whole point of this phase):",
    "   - Trace the password from every entry point (compose modal, unlock modal) to every use. Does",
    "     it EVER reach: the store, a ref/state that outlives the async operation, a wire frame, a",
    "     log/console call, localStorage/IndexedDB/Cache? It must be consumed and dropped.",
    "   - Is the sender's local item ciphertext-only (unlike regular file items, where the sender",
    "     keeps the source File)? A sender-side plaintext copy would defeat the feature.",
    "   - PBKDF2 parameters: exactly SHA-256, 600_000 iterations, 256-bit, per §11.4 and §19.9? Is",
    "     the iteration count test-pinned so it cannot be silently weakened?",
    "   - Fresh salt (16 bytes) and fresh IV (12 bytes) per encryptItem, CSPRNG-sourced? Any",
    "     caller-supplied IV or salt anywhere?",
    "   - decryptItem propagates the wrong-password DOMException rather than swallowing it, and",
    "     unlockItem converts it to a clean false — never an unhandled rejection, never a crash?",
    "   - Does the UI clear the password input on wrong password and keep the modal open (§16)?",
    "  P0 — PLAINTEXT DISCIPLINE:",
    "   - plaintextContent: memory-only, set only on successful unlock, cleared by lockItemAgain and",
    "     on session end? Grep for any persistence path.",
    "   - Does any unlocked plaintext leak into a log, the store's persisted shape, or an object URL",
    "     that is not revoked?",
    "  P1 — WIRE AND GATING:",
    "   - Announce-then-payload order guaranteed? Both frames under the active gate (no locked frame",
    "     before both confirms)? Oversized payload impossible (D6 at compose) and dropped if it",
    "     somehow arrives (WIRE_MAX_FRAME_BYTES)?",
    "   - Receiver: payload for unknown id dropped; duplicate payload dropped; hostile field types",
    "     already rejected by isWireMessage (no duplication)?",
    "   - Status lifecycle: transferring -> complete on payload arrival; locked items never enter the",
    "     chunk pipeline?",
    "  P1 — UI CORRECTNESS:",
    "   - Compose modal: label required, password confirm enforced (D7), D6 rejection message for",
    "     oversized files, spinner during the ~300ms PBKDF2, no crash on failure?",
    "   - Unlock flow for each innerType (text render, richtext read-only view, file download with",
    "     revoked object URLs)? Lock-again re-hides?",
    "   - Does the receiver see the label (plaintext BY DESIGN, §9) without the payload?",
    "  P1 — SCOPE:",
    "   - Phase 5+ work built early (library/IndexedDB, export, QR)? §11.5 export crypto must NOT",
    "     exist. Early implementation is a FINDING.",
    "   - Any @ts-ignore / 'any' / skipped tests / third-party crypto?",
    "",
    "Cite file:line for every finding. Verify by reading code, not comments. State explicitly what you",
    "confirmed correct. Do not pad.",
    "",
    "Label findings P0/P1/P2. End with EXACTLY one line: 'Merge verdict: BLOCK' or 'Merge verdict: OK'",
    "or 'Merge verdict: OK with notes'."
  ].join("\n")
});

return {
  cryptoOk: wave1[0].ok ?? null,
  cryptoReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 4500),
  uiOk: wave1[1].ok ?? null,
  uiReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4500),
  transportOk: wave2.ok ?? null,
  transportReport: String(wave2.output ?? wave2.error ?? "").slice(0, 7000),
  reviewOk: review.ok ?? null,
  reviewReport: String(review.output ?? review.error ?? "").slice(0, 14000)
};

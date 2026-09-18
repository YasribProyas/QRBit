// QRDrop Phase 10 — the three gaps the owner found by actually using it.
//
//   1. The library can only hold RECEIVED items. Folders are creatable; items are not.
//      saveItem() exists in the store and nothing in the UI calls it. A file explorer you
//      can only fill by receiving into it is not a file explorer.
//   2. The QR should be visible the moment the app opens, and joinable at that moment.
//   3. The 3-word safety phrase should gate on the SENDER, not on both sides.
//
// Waves: 1 = lane-items || lane-phrase (disjoint files). 2 = lane-live-qr (touches
// Home/Session/useSession, which lane-phrase edits). 3 = review.

const MODEL_CHAIN = [
  "omnirouter/agy/gemini-3.8-flash-high",
  "agentrouter/deepseek-v4-flash",
  null,
]

function runOpts(key, opts, idx) {
  const i = idx === undefined ? 0 : idx
  const model = MODEL_CHAIN[i]
  const o = Object.assign({}, opts)
  if (model) { o.model = model } else { delete o.model }
  const suffix = i === 0 ? "" : ("-fb" + i)
  const retry = function () {
    if (i + 1 >= MODEL_CHAIN.length) return null
    emit("lane " + key + ": " + String(model) + " failed -> retrying on " + String(MODEL_CHAIN[i + 1] || "inherited"))
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

const COMMON = [
  "PROJECT: QRDrop — symmetric browser-based E2EE P2P file transfer. LIVE at",
  "https://qrdrop-app.proyas.workers.dev. All 8 build phases plus security hardening are",
  "committed; 932 tests pass. Repo: /mnt/warehouse/source/QRDrop",
  "",
  "READ FIRST (mandatory):",
  "  1. AGENTS.md — TS strict; Web Crypto only; NEVER store session data in IndexedDB,",
  "     Cache API or localStorage. (Library data IS allowed in IDB — it is the only thing",
  "     that belongs there.)",
  "  2. ORCHESTRATION.md — decisions D1-D13 are BINDING. Read D13 (the receiving flow and why",
  "     the QR lives where it does), D6 (locked-item 3 MiB cap), D7 (password typed twice),",
  "     and the toolchain notes (TS 7.0.2 has NO baseUrl; vitest 5 jsdom docblock on line 1).",
  "  3. PLAN.md — §6 (library data model + browser UI), §8/§9 (session, phrase, board).",
  "",
  "HOW THE APP WORKS TODAY: routes are / (Home: minted code + library browser + Scan & Send",
  "+ manual code entry), /session (the live session; ?code= means guest, no code means host;",
  "the HOST's QR renders here — see D13) and /settings. Items enter the library only by",
  "receiving them in a session or by import.",
  "",
  "HARD RULES:",
  "  - Fresh context. You have NO prior conversation; read what you need from disk.",
  "  - You are a WORKER. No narration, no orchestrator voice.",
  "  - Create/edit ONLY paths under YOUR FILES. Other lanes run concurrently.",
  "  - Parent-owned, never edit: package.json, pnpm-workspace.yaml, tsconfig*, vite.config.ts,",
  "    vitest.config.ts, wrangler.toml, index.html, public/**, styles.css, PLAN.md, AGENTS.md,",
  "    ORCHESTRATION.md, TODO.md, README.md. styles.css being off-limits means: use EXISTING",
  "    class names and inline styles for anything new (React applies those via the CSSOM, so",
  "    the strict CSP allows them). Report needed CSS as a note for the parent instead.",
  "  - No git. No pnpm install. No wrangler. No dev servers. No real camera/network in tests.",
  "  - No @ts-ignore / @ts-expect-error / 'any' / .skip / .only. No console.* in prod code.",
  "  - Never weaken or delete a test to get green. If a test asserts behaviour you are",
  "    deliberately changing, update the ASSERTION to the new contract and say so in your",
  "    report — that is a contract change, not a fix.",
  "",
  "FINAL OUTPUT: files changed, exact validation results with test counts, every deviation",
  "and every needed-but-disallowed edit (especially CSS). Concise.",
].join("\n")

// ───────────────────────────── Lane 1: author library items ─────────────────
const LANE_ITEMS = [
  COMMON,
  "",
  "YOU ARE: Lane 1 — make the library usable offline. The owner's words: \"even without",
  "connecting I should be able to make files where I can store data — what is the use of the",
  "file explorer otherwise\". They are right: the UI can create FOLDERS and nothing else.",
  "",
  "YOUR FILES:",
  "  apps/frontend/src/components/library/NewItemBar.tsx        (new)",
  "  apps/frontend/src/components/library/NewItemBar.test.tsx   (new)",
  "  apps/frontend/src/components/library/TextComposeModal.tsx  (new)",
  "  apps/frontend/src/components/library/TextComposeModal.test.tsx (new)",
  "  apps/frontend/src/components/library/RichTextComposeModal.tsx (new)",
  "  apps/frontend/src/components/library/RichTextComposeModal.test.tsx (new)",
  "  apps/frontend/src/components/library/LibraryBrowser.tsx    (edit — mount the bar)",
  "  apps/frontend/src/components/library/LibraryBrowser.test.tsx (edit)",
  "  apps/frontend/src/store/libraryStore.ts                    (edit ONLY if a helper is needed)",
  "",
  "WHAT TO BUILD — a second row of actions beside the existing '+ New Folder', creating",
  "items directly into the CURRENT folder with no session involved:",
  "",
  "1. NewItemBar: text · rich text · image · file · locked. Mirror the iconography and",
  "   aria-label style of components/session/AddItemBar.tsx (read it first — it is the",
  "   in-session equivalent) so the two bars feel like one product. Difference that must be",
  "   obvious: this one SAVES, it does not send. No send happens here.",
  "2. text and richtext need a compose modal each. Reuse the existing editor components —",
  "   read components/session/items/TextItem.tsx and RichTextItem.tsx and the Tiptap wiring",
  "   in components/session/ first, and reuse rather than reinvent; richtext must serialize",
  "   to the SAME Tiptap JSON string shape that LibraryRichTextItem.content already uses",
  "   (§6.1), or previews of imported items will diverge from ones authored locally.",
  "3. image and file: a hidden <input type=file accept='image/*'> / accept='*'> and a",
  "   FileReader/arrayBuffer read. Store the native Blob as §6.1 prescribes, with mimeType",
  "   and size from the File. Default the item name to the filename, editable before save.",
  "4. locked: REUSE the existing compose modal used in-session (find it:",
  "   components/session/LockedItemComposeModal.tsx). It must produce the same",
  "   { ciphertext, iv, salt } tuple via lib/crypto encryptItem, and honour D6's 3 MiB",
  "   plaintext cap and D7's type-password-twice rule. If that modal is written tightly to",
  "   the session path, add an optional prop for the save target rather than duplicating it.",
  "5. Every created item goes through libraryStore.saveItem (or saveFromSession if that is",
  "   the right existing seam — read it) into the folder currently open, and appears in the",
  "   list without a manual refresh. ids are crypto.randomUUID(), createdAt/updatedAt set.",
  "6. Locked-item caveat that MUST be surfaced in the UI: there is no recovery. If the",
  "   password is lost the item is gone forever (§6.2, §19.3). A one-line reminder in the",
  "   compose step is required, not optional.",
  "",
  "INVARIANTS: nothing session-related may be written to IDB. These are LIBRARY items, which",
  "is exactly what IDB is for. Do not touch sessionStore, useSession, or the wire protocol.",
  "",
  "TESTS (jsdom docblock; real fake-indexeddb, not mocked storage, following the pattern in",
  "LibraryBrowser.test.tsx): creating a text item writes a LibraryTextItem that survives a",
  "reload from IDB; richtext round-trips to the same JSON shape the session renderer expects;",
  "an image and a file store a Blob with correct mimeType and size; the locked path stores",
  "ONLY the ciphertext tuple and the plaintext is provably absent from the stored row, and",
  "the stored tuple still decrypts with the password; a cancelled compose writes nothing;",
  "items land in the folder currently open, not at root.",
].join("\n")

// ─────────────────────── Lane 2: sender-only phrase confirm ─────────────────
const LANE_PHRASE = [
  COMMON,
  "",
  "YOU ARE: Lane 2 — the safety phrase must be confirmed by the SENDER only. PLAN.md §8",
  "currently says \"Session does not proceed until confirmed on both sides\"; the owner has",
  "changed that requirement. This is a deliberate product decision, recorded as D14.",
  "",
  "YOUR FILES:",
  "  apps/frontend/src/hooks/useSession.ts          (+ useSession.test.tsx)",
  "  apps/frontend/src/components/session/SafetyPhraseOverlay.tsx (+ its test)",
  "  apps/frontend/src/store/sessionStore.ts        (+ its test, if the state shape changes)",
  "  apps/frontend/src/pages/Session.tsx            (edit minimally — the overlay call site)",
  "  apps/frontend/src/pages/Session.test.tsx       (update assertions only where needed)",
  "",
  "BEHAVIOUR TO IMPLEMENT:",
  "1. Only the sender (role 'guest' — the device that scanned; see SENDER_ROLE in",
  "   components/session/SessionBoard.tsx) gates the session on confirming the phrase. Until",
  "   the sender confirms, no session item may be sent and the board must not accept input.",
  "2. The receiver (host) must STILL SEE the three words, prominently, while the sender is",
  "   being asked to confirm. This is the part not to lose: the phrase exists to let a human",
  "   detect a key-substitution MITM, and a receiver who is never shown the words cannot",
  "   notice a mismatch even though the sender might. Non-blocking display, no confirm",
  "   button that gates anything.",
  "3. The existing 'phrase-confirm' wire message: read how it is used today before changing",
  "   anything. Keep the receiver INFORMED that the sender confirmed (so the receiver's UI",
  "   can move from 'waiting for the sender to confirm' to the active board) but the",
  "   receiver's own confirmation must no longer be a precondition for proceeding. If today",
  "   BOTH sides must send phrase-confirm and the session waits for two, change the gate to",
  "   one — and make sure a receiver-side confirm (if the UI still offers one) cannot leave",
  "   the session stuck waiting for a sender who will never send it again.",
  "4. Keep the Abort path working for both roles. The receiver may still abort; they just do",
  "   not have to approve.",
  "5. If the sender aborts or the session ends before confirming, the receiver must exit the",
  "   overlay rather than sit on it forever.",
  "",
  "DO NOT touch lib/protocol.ts message type definitions unless the gate genuinely cannot be",
  "implemented without it — if you must, keep the change additive and flag it loudly,",
  "because another lane is editing library files at the same time (not the protocol, but",
  "keep the surface small).",
  "",
  "TESTS: sender sees the overlay with a confirm control; receiver sees the words but has no",
  "gating control; the session does NOT become active on a receiver-side confirm alone; it",
  "becomes active when the sender confirms; items cannot be sent before the sender confirms;",
  "abort by either role ends the session and clears the overlay; the phrase derivation",
  "itself is unchanged (do not touch lib/crypto.ts or lib/safetyPhrase.ts).",
].join("\n")

// ─────────────────── Lane 3 (wave 2): live QR shown by default ──────────────
const LANE_LIVE = [
  COMMON,
  "",
  "YOU ARE: Lane 3 — the QR must be visible AND joinable the moment the app opens, with no",
  "tap in between. The owner: \"qrcode should be by default shown\".",
  "",
  "READ D13 IN ORCHESTRATION.md FIRST. It explains why the QR currently lives on /session",
  "rather than Home: Home drew a QR that nothing was listening on, so scanning it did",
  "nothing. Do NOT reintroduce that bug. A QR is only allowed to appear where a host is",
  "actually joined to that code and waiting.",
  "",
  "Lane 2 has ALREADY FINISHED and changed the safety-phrase flow. Read its actual code in",
  "useSession.ts / Session.tsx / SafetyPhraseOverlay.tsx before editing; the sender-only",
  "confirm gate is now the behaviour and must keep working.",
  "",
  "YOUR FILES:",
  "  apps/frontend/src/pages/Home.tsx               (+ Home.test.tsx)",
  "  apps/frontend/src/pages/Session.tsx            (+ Session.test.tsx)",
  "  apps/frontend/src/hooks/useSession.ts          (+ useSession.test.tsx)",
  "  apps/frontend/src/components/session/SessionView.tsx (new, if you extract the UI)",
  "  apps/frontend/src/App.tsx                      (only if routing must change)",
  "",
  "DESIGN (deliberate — this avoids the hard problem):",
  "Home BECOMES the host. The reason we cannot show a live QR on Home today is that the",
  "session lives inside a hook mounted by /session, so displaying on Home means either",
  "hoisting the live peer across a route change (fragile: StrictMode double-mount, teardown,",
  "restart, and D13's no-double-mint rule) or duplicating the session UI. Do neither. Instead:",
  "",
  "1. Home mounts the host session itself (role 'host', its own minted code) and renders the",
  "   QR for it immediately, with the honest status line the peer is really producing",
  "   ('Waiting for a device to scan…' becomes true because Home is now genuinely listening).",
  "2. When that session starts pairing / becomes active, Home renders the session surface IN",
  "   PLACE of the library — recommended: extract the session UI out of pages/Session.tsx",
  "   into components/session/SessionView.tsx and use it from both pages, so there is one",
  "   implementation of the board, phrase overlay, status and end-of-session save flow.",
  "3. /session keeps working for the GUEST path (?code=) and for direct visits and reloads",
  "   (a reload of /session must still work — deep link, PLAN.md §7 Flow B).",
  "4. After a session ENDS on Home, return to the library view and mint a fresh code, so the",
  "   next peer gets a joinable QR rather than a burned one (D10 burns codes on pairing).",
  "   Show 'New code' / auto-recover — but never show a QR that is not live.",
  "5. The library must remain reachable while waiting. If the session surface replaces it",
  "   only once a peer has joined, the owner keeps §7's single-screen shape: open app, QR",
  "   visible, library below it.",
  "",
  "CONSTRAINTS THAT MUST NOT BREAK:",
  "  - D13: no QR anywhere that is not live. Home's is now live because Home hosts.",
  "  - D8/D10: one user intent, one mint. Home holding the session removes the need for the",
  "    router-state hostSession bundle on the receive path; if it becomes dead code, remove",
  "    it and its tests properly rather than leaving two half-used paths.",
  "  - D4/§19.10: sessions are single-use; no reconnect. Ending means mint a new code.",
  "  - D1: a pre-pairing disconnect releases the role slot but the code stays joinable to",
  "    the 300s TTL.",
  "  - StrictMode: Home mounts twice in dev. The mint effect already defers a tick with a",
  "    cancelled flag for exactly this reason; a real host join must not open two sockets.",
  "    Prove it with a test.",
  "",
  "TESTS: opening Home shows a QR for a code it has actually joined as host (assert the join",
  "happened, not just that a canvas exists — that is the assertion that failed to catch",
  "D13); a peer can join that code and the session proceeds to the sender-only phrase gate",
  "(reuse the two-party harness in the session tests); Home renders the session surface when",
  "active; the library is visible while waiting; ending a session returns to the library with",
  "a FRESH live code; a guest arriving at /session?code= is unaffected; StrictMode opens",
  "exactly one signaling socket and mints exactly one code.",
].join("\n")

const REVIEW_TASK = [
  "Fresh-context READ-ONLY reviewer. No edits, no git, no servers. Repo:",
  "/mnt/warehouse/source/QRDrop. The parent runs typecheck/tests/build separately.",
  "",
  "REVIEW: QRDrop Phase 10 — three product gaps the owner found by using the app:",
  "  (1) library items can now be CREATED offline (not just received),",
  "  (2) the safety phrase is confirmed by the SENDER only,",
  "  (3) the QR is visible AND joinable on first paint, because Home now hosts.",
  "",
  "READ: AGENTS.md, ORCHESTRATION.md D1-D14 (D13 especially: no QR may be displayed that is",
  "not live. D8/D10: one user intent, one mint. D6/D7 locked-item rules. D1/D4 lifecycle),",
  "PLAN.md §6, §8, §9, §14, §17.",
  "",
  "Code: components/library/{NewItemBar,TextComposeModal,RichTextComposeModal,LibraryBrowser}.tsx,",
  "components/session/{SafetyPhraseOverlay,SessionView}.tsx, hooks/useSession.ts,",
  "pages/{Home,Session}.tsx, store/libraryStore.ts, store/sessionStore.ts, and the tests.",
  "",
  "JUDGE:",
  "P0 — CRYPTO / DATA LOSS:",
  "  - Locally-authored LOCKED items must store ONLY {ciphertext, iv, salt} via encryptItem,",
  "    never plaintext, and must use Web Crypto only. Verify no plaintext can reach IDB on any",
  "    path (including a save-after-error). D6 cap and D7 confirm-password enforced?",
  "  - Rich text authored locally must serialize to the SAME shape the session renderer and",
  "    export/import already use. A divergent shape silently breaks previews and exports.",
  "  - Is 'there is no password recovery' surfaced?",
  "  - Anything session-related written to IndexedDB? (Forbidden by AGENTS.md — library data",
  "    is fine, session data is not.)",
  "P0 — LIVE QR (D13):",
  "  - Does EVERY rendered QR correspond to a code the device has actually joined as host?",
  "    Trace it; do not trust the component name or a comment.",
  "  - StrictMode double mount: one mint, one signaling socket?",
  "  - After a session ends, is the next displayed code genuinely fresh and joinable (D10",
  "    burns codes)? Could a stale/burned QR be shown again?",
  "  - Guest path /session?code= and deep-link reload unaffected?",
  "P0 — PHRASE GATE:",
  "  - Session must not proceed, and no item may be sendable, before the SENDER confirms.",
  "  - Does the RECEIVER still SEE the three words? Losing this is a real security",
  "    regression, not a simplification — the phrase is the only MITM defence.",
  "  - Can either role still abort, and does a sender abort clear the receiver's overlay?",
  "  - Any path where the receiver's now-non-gating confirm leaves a session stuck?",
  "P1 — REGRESSION QUALITY:",
  "  - Were tests updated to assert the NEW contract rather than deleted or weakened? Check",
  "    the diff of any test that changed. Flag any .skip/.only/@ts-ignore/'any'.",
  "  - Does D13's own lesson repeat: tests asserting a component rendered rather than the",
  "    user's goal being achievable? Call it out if the new tests only assert presence.",
  "  - Scope creep into other phases? styles.css edits (parent-owned)?",
  "",
  "Cite file:line. State what you confirmed correct. Label P0/P1/P2. End with EXACTLY one",
  "line: 'Merge verdict: BLOCK' or 'Merge verdict: OK' or 'Merge verdict: OK with notes'.",
].join("\n")

emit("Phase 10 wave 1: library authoring (L1) || sender-only phrase (L2)")

const wave1 = await Promise.all([
  runOpts("p10-items", {
    label: "Create library items offline",
    agent: "worker",
    context: "fresh",
    task: LANE_ITEMS,
  }),
  runOpts("p10-phrase", {
    label: "Sender-only safety phrase confirm",
    agent: "worker",
    context: "fresh",
    task: LANE_PHRASE,
  }),
])

emit("Wave 1: items=" + String(wave1[0].ok) + " phrase=" + String(wave1[1].ok))

if (!wave1[0].ok || !wave1[1].ok) {
  return {
    aborted: "a wave-1 lane failed — the live-QR lane needs the phrase lane's code",
    itemsReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 6000),
    phraseReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 6000),
  }
}

const wave2 = await runOpts("p10-liveqr", {
  label: "Live QR on first paint (Home hosts)",
  agent: "worker",
  context: "fresh",
  task: LANE_LIVE,
})

emit("Wave 2: live-qr=" + String(wave2.ok))

const review = await runOpts("p10-review", {
  label: "Phase 10 review",
  agent: "reviewer",
  context: "fresh",
  task: REVIEW_TASK,
})

return {
  itemsOk: wave1[0].ok ?? null,
  itemsReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 6000),
  phraseOk: wave1[1].ok ?? null,
  phraseReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 6000),
  liveOk: wave2.ok ?? null,
  liveReport: String(wave2.output ?? wave2.error ?? "").slice(0, 8000),
  reviewOk: review.ok ?? null,
  reviewReport: String(review.output ?? review.error ?? "").slice(0, 14000),
}

// QRDrop Phase 9 — security/cost hardening + deferred TODO burn-down.
//
// Context: the owner authenticated wrangler, created the RATE_LIMIT KV namespace and
// subscribed to Cloudflare TURN. That surfaced two real problems:
//   1. turn.ts implements the self-hosted coturn HMAC scheme; Cloudflare TURN does NOT
//      accept client-computed HMACs (D11) — TURN would silently never engage.
//   2. /session/new handed out paid relay credentials from an UNMETERED public endpoint.
//      Time-limited TURN creds are not single-use, and Cloudflare has no hard spending
//      cap for TURN — so that endpoint is a direct cost threat against the operator (D10).
//
// Waves:
//   1 (parallel, disjoint files):
//        A — worker: Cloudflare TURN API rewrite + rate limits + burned-code registry
//        D — frontend: destructive-delete confirmation
//        E — frontend: export memory/streaming + Safari IDB Blob fallback
//   2 (needs A's real contract):
//        B — frontend: consume the new credential route + GET share target
//   3: review
//
// Model chain per AGENTS.md (gemini primary, deepseek fallback, inherit last).

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

const COMMON = [
  "PROJECT: QRDrop — symmetric browser-based E2EE P2P file transfer, all 8 build phases committed.",
  "865 tests pass (783 frontend + 82 worker). Repo: /mnt/warehouse/source/QRDrop",
  "",
  "READ FIRST (mandatory):",
  "  1. AGENTS.md — TS strict; no third-party crypto (Web Crypto only); NEVER store session data",
  "     in IndexedDB, Cache API or localStorage.",
  "  2. ORCHESTRATION.md — decisions D1-D12 are BINDING. Read D10, D11, D12 carefully: they are",
  "     new and describe exactly the architecture this phase implements. Note the toolchain facts",
  "     (TS 7.0.2 has NO baseUrl; vitest 5 uses a jsdom docblock).",
  "  3. PLAN.md — the spec. §13 (signaling/TURN), §15 (PWA), §17 (security checklist).",
  "",
  "STATE OF THE CLOUDFLARE ACCOUNT (relevant to you):",
  "  - wrangler is authenticated; RATE_LIMIT KV namespace exists with a REAL id in wrangler.toml.",
  "  - Cloudflare TURN is subscribed but the TURN KEY IS NOT YET CREATED, so TURN_KEY_ID in",
  "    wrangler.toml is deliberately an empty string and TURN_KEY_SECRET is not set. Every code",
  "    path MUST therefore keep working with credentials absent (STUN-only fallback). Do not",
  "    make a missing key a hard error.",
  "  - Deploy targets chosen by the owner: worker qrdrop-signaling.proyas.workers.dev and",
  "    Pages qrdrop.pages.dev. Do NOT run any wrangler deploy/login command.",
  "",
  "HARD RULES:",
  "  - Fresh context: you have NO prior conversation. Everything is on disk — read it.",
  "  - You are a WORKER. Never narrate the orchestrator's plan.",
  "  - Create/edit ONLY paths listed under YOUR FILES. Other lanes run concurrently.",
  "  - Parent-owned, NEVER edit: package.json, pnpm-workspace.yaml, tsconfig*, vite.config.ts,",
  "    vitest.config.ts, wrangler.toml, index.html, public/**, PLAN.md, AGENTS.md,",
  "    ORCHESTRATION.md, TODO.md. Report a blocker instead of changing these.",
  "  - No git commands. No pnpm install. No wrangler commands. No blocking dev servers.",
  "  - No @ts-ignore / @ts-expect-error / 'any' / .skip / .only. No console.* in production code.",
  "  - Never weaken a test to make it pass.",
  "",
  "FINAL OUTPUT: files changed, exact validation results with test counts, every deviation from",
  "PLAN.md/ORCHESTRATION.md and why, blockers. Concise; no large listings.",
].join("\n")

// ─────────────────────────────────── Lane A: worker security (the big one) ──
const LANE_A = [
  COMMON,
  "",
  "YOU ARE: Lane A — signaling-worker security and cost hardening. Three interlocking changes,",
  "all inside the worker package. Read D10 and D11 in ORCHESTRATION.md before writing anything.",
  "",
  "YOUR FILES:",
  "  apps/signaling-worker/src/turn.ts            (rewrite for the Cloudflare API)",
  "  apps/signaling-worker/src/turn.test.ts       (rewrite tests)",
  "  apps/signaling-worker/src/index.ts           (routes, rate limits, burn check)",
  "  apps/signaling-worker/src/index.test.ts      (tests for new behaviour)",
  "  apps/signaling-worker/src/types.ts           (response shapes)",
  "  apps/signaling-worker/src/env-extra.d.ts     (Env: TURN_KEY_ID / TURN_KEY_SECRET)",
  "  apps/signaling-worker/src/session.ts         (write the burn marker on pairing)",
  "",
  "CHANGE 1 — rewrite TURN credential minting for Cloudflare (D11).",
  "The current implementation computes base64(HMAC-SHA256(secret, username)) itself. Cloudflare",
  "Realtime TURN does not accept that. Replace it with the documented API call:",
  "  POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate",
  "  headers: Authorization: Bearer {TURN_KEY_SECRET}, Content-Type: application/json",
  "  body:    { \"ttl\": <seconds>, \"customIdentifier\": <string, max 128 chars> }",
  "  -> 201 { \"iceServers\": { \"urls\": string[], \"username\": string, \"credential\": string } }",
  "Constraints and behaviour:",
  "  - ttl must be an integer in 1..172800; Cloudflare rejects anything larger. Default to 600s",
  "    (the wrangler.toml TURN_TTL_SECONDS value already says 600 — read it, do not hardcode).",
  "  - customIdentifier MUST carry the session code so TURN analytics can attribute abuse.",
  "    Keep it within 128 chars (an 8-char code plus a short prefix is fine).",
  "  - Return null (no credentials) when TURN_KEY_ID or TURN_KEY_SECRET is missing/blank, when",
  "    the HTTP call fails, or when the response shape is unexpected. NEVER let a TURN failure",
  "    break session creation — STUN-only fallback is the documented, tested behaviour.",
  "  - Filter any URL containing ':53?' out of the returned urls (Chrome/Firefox block port 53).",
  "  - Accept an injectable fetch (defaulting to globalThis.fetch) so tests never hit the network.",
  "  - Keep the exported turnCredentialExpiresAt only if it still makes sense; Cloudflare's",
  "    username is now an opaque hex string, so the old timestamp-parsing helper is probably",
  "    dead — remove it and its tests rather than keeping a misleading export.",
  "  - Update env-extra.d.ts: replace TURN_SECRET with TURN_KEY_SECRET (optional string).",
  "    TURN_KEY_ID arrives via wrangler.toml [vars] and is already typed by the generated",
  "    worker-configuration.d.ts — do not edit that generated file; if the generated type lacks",
  "    TURN_KEY_ID, declare it optional in env-extra.d.ts and say so in your report.",
  "",
  "CHANGE 2 — move credentials off /session/new and rate-limit both routes (D10).",
  "  - GET /session/new now returns { code } ONLY. No credentials in that response.",
  "  - New route GET /session/:code/turn -> { iceServers: string[], username, credential } or",
  "    503-style empty body when credentials are unavailable. It validates the code format",
  "    (reuse isValidSessionCode), checks the burn registry (change 3), and rate-limits per IP.",
  "  - Add the same Sec-Fetch-* browser-CSRF guard the other routes have (mode must be 'cors'",
  "    when the header is present; absent header passes for non-browser clients).",
  "  - Security headers (CSP/nosniff/frame-options/referrer) must appear on every response,",
  "    matching the existing securityHeaders() behaviour.",
  "  - Rate limits, reusing the existing KV binding helper and its documented fail-open policy:",
  "      * /session/new        key new:<ip>     cap 20 per 60s",
  "      * /session/:code/turn key turn:<ip>    cap 20 per 60s",
  "      * /session/:code/ws   key join:<ip>    cap 10 per 60s  (unchanged)",
  "    Keep them as named constants so the caps are auditable in one place.",
  "",
  "CHANGE 3 — durable burned-code registry (closes the 'expired codes return 404' gap).",
  "Today code identity is pure idFromName(code): after DO eviction a paired/burned code can",
  "become joinable again, because restore() finds no createdAt and re-arms a fresh 300s alarm.",
  "  - When a session reaches pairing completion (the point the DO currently marks DONE /",
  "    destroys itself), write a KV marker burned:<code> so the code can never be rejoined.",
  "    Give it an expirationTtl comfortably longer than SESSION_TTL_SECONDS (e.g. 86400).",
  "  - On BOTH /session/:code/ws and /session/:code/turn, check the marker FIRST and reject a",
  "    burned code (410 Gone, or 404 — match the existing rejection vocabulary) before any DO",
  "    lookup or credential mint.",
  "  - The DO cannot reach KV unless you give it the binding: prefer writing the marker from",
  "    the DO if it already has an env with RATE_LIMIT, otherwise add the binding to the DO",
  "    class via its constructor env parameter. Do NOT edit wrangler.toml (parent-owned) — if",
  "    a new binding is genuinely required, report it as a blocker instead.",
  "  - Fail-open on KV errors, consistent with the rate limiter's documented policy.",
  "",
  "TESTS (plain vitest, node env — no jsdom docblock):",
  "  - turn.ts: success path returns urls/username/credential from a stubbed fetch; the request",
  "    URL carries the key id, the Authorization header carries the secret, and the body has",
  "    ttl + customIdentifier containing the session code; ttl is clamped/validated; port-53",
  "    urls are filtered; missing key id or secret returns null; non-2xx returns null; a",
  "    malformed body returns null; a thrown fetch returns null (never rejects).",
  "  - index.ts: /session/new response has NO turnCredentials field and IS rate-limited;",
  "    /session/:code/turn requires a valid code, is rate-limited, rejects a burned code, and",
  "    returns the credential bundle plus urls on success; /session/:code/ws rejects a burned",
  "    code; Sec-Fetch rejection on the new route; security headers present on each response.",
  "  - Update any existing test that asserted the OLD shape (e.g. a /session/new test expecting",
  "    turnCredentials). Adjust the assertion to the new contract and say so in your report —",
  "    that is a contract change, not a weakened test.",
].join("\n")

// ───────────────────────── Lane D: destructive delete confirmation ──
const LANE_D = [
  COMMON,
  "",
  "YOU ARE: Lane D — destructive-delete confirmation (TODO: 'Destructive deletes have no",
  "confirmation', Phase 5 review P2). Deleting a folder cascades its entire subtree out of",
  "IndexedDB permanently — one mis-tap on a phone is total, unrecoverable data loss.",
  "",
  "YOUR FILES:",
  "  apps/frontend/src/components/ConfirmDelete.tsx   (new — a small, reusable confirm dialog)",
  "  apps/frontend/src/components/ConfirmDelete.test.tsx (new)",
  "  apps/frontend/src/components/library/LibraryBrowser.tsx  (edit — route deletes through it)",
  "  apps/frontend/src/components/library/LibraryBrowser.test.tsx (edit — test the gate)",
  "",
  "REQUIREMENTS:",
  "1. ConfirmDelete.tsx: a modal with a title, a message, a destructive-styled confirm button,",
  "   and a cancel. Keyboard accessible: Escape cancels, focus moves into the dialog on open",
   " and returns to the trigger on close, role='dialog' aria-modal='true', labelled by its title.",
  "   Confirm button text and the danger styling must make the irreversible nature obvious.",
  "2. Folder deletes: the message MUST state the cascade concretely — the number of folders and",
  "   items that will be permanently deleted, not just 'delete this folder?'. Read the counts",
  "   from the store subtree. Reference PLAN.md §6.4 ('a folder tree dies whole').",
  "3. Item deletes: confirm too, but the message is simply the item name.",
  "4. CRITICAL: do NOT use window.confirm()/alert(). Both are blocked in cross-origin iframes",
  "   and are poor UX in a PWA. This must be a real React dialog.",
  "5. The existing delete behaviour after confirmation (store calls, cascade, selection cleanup,",
  "   'root' folder handling fixed in Phase 5) must not change. Only the gate is added.",
  "6. Do not regress the onSelectionChange prop added in Phase 6.",
  "",
  "TESTS: opening a folder delete shows the cascade counts; cancel performs no store call;",
  "confirm performs exactly the deletion that used to happen immediately; Escape cancels; an",
  "item delete asks for the item by name; focus returns to the trigger after close.",
].join("\n")

// ─────────────── Lane E: export memory + Safari IDB Blob fallback ───────────
const LANE_E = [
  COMMON,
  "",
  "YOU ARE: Lane E — two storage-efficiency/correctness items from TODO.md.",
  "",
  "YOUR FILES:",
  "  apps/frontend/src/lib/crypto.ts     (base64 helpers only)",
  "  apps/frontend/src/lib/crypto.test.ts",
  "  apps/frontend/src/lib/export.ts",
  "  apps/frontend/src/lib/export.test.ts",
  "  apps/frontend/src/lib/library.ts    (Blob persistence fallback)",
  "  apps/frontend/src/lib/library.test.ts",
  "",
  "TASK 1 — stop building base64 one character at a time (TODO: export memory usage).",
  "toBase64 in crypto.ts assembles its output by concatenating onto a string in a loop",
  "(reviewer note: '3 bytes at a time'). For multi-megabyte library exports that is both slow",
  "and memory-hungry on phones. Rewrite it to build a character array (or chunks of a typed",
  "array) and join once, keeping the output byte-for-byte identical to today — the existing",
  "tests pin the alphabet and padding, do not change them. Measure before/after on a synthetic",
  "payload (e.g. 4 MiB) and report the numbers. If you touch fromBase64 as well, its strict",
  "validation errors must stay identical.",
  "",
  "TASK 2 — Safari/IndexedDB Blob persistence fallback.",
  "library.ts stores image/file items with a native Blob, which PLAN.md §6.1 prescribes and",
  "which works in Chrome/Firefox and modern Safari; older Safari could silently store the Blob",
  "as an empty object. We cannot test on a real Safari here, so implement a defensive, tested",
  "fallback rather than a claim of verified behaviour:",
  "  - Keep storing Blobs (do not change the primary path or the §6.1 data model).",
  "  - On WRITE, also record the blob's byte length so a later integrity check is possible.",
  "    LibraryImageItem/LibraryFileItem already carry a `size` field — use it, do not add a field",
  "    unless strictly necessary, and if you must add one, keep IDB at version 1-compatible by",
  "    making the new field optional on read (older rows must still parse).",
  "  - On READ, if the returned blob is missing or its size disagrees with the stored `size`, do",
  "    NOT throw and do NOT silently hand back a corrupt item: surface it as a readable error",
  "    state so the UI can say the item could not be loaded. Keep the check cheap.",
  "  - Add a test that simulates the broken-Safari shape (a row whose blob field comes back as an",
  "    empty object) and asserts the graceful path rather than a crash.",
  "  - This must not violate AGENTS.md: it is persistent LIBRARY data, which is exactly what IDB",
  "    is for. Never write session data here.",
  "",
  "Both tasks: preserve every existing exported symbol and its contract. Report exact timings",
  "for task 1 and any deviation.",
].join("\n")

// ─────────────── Lane B (wave 2): frontend consumption + share target ───────
const LANE_B = [
  COMMON,
  "",
  "YOU ARE: Lane B — frontend consumption of the reworked credential flow, plus the GET share",
  "target. Lane A has ALREADY FINISHED on the worker side: read its actual implementation in",
  "apps/signaling-worker/src/index.ts and types.ts first and code against the real shapes.",
  "",
  "YOUR FILES:",
  "  apps/frontend/src/hooks/useSession.ts       (+ useSession.test.tsx)",
  "  apps/frontend/src/lib/webrtc.ts             (+ webrtc.test.ts)",
  "  apps/frontend/src/pages/Home.tsx            (+ Home.test.tsx)",
  "  apps/frontend/src/pages/Session.tsx         (+ Session.test.tsx)",
  "  apps/frontend/src/config.ts                 (+ a config test if useful)",
  "",
  "TASK 1 — credentials now come from a separate route (D10).",
  "  - GET /session/new returns { code } only. mintHostSession must stop expecting",
  "    turnCredentials there.",
  "  - GET /session/:code/turn returns the credential bundle (username, credential and the",
  "    worker-filtered iceServers URL list). Fetch it at connect time for BOTH roles — the",
  "    guest knows the code from the URL, and under D8 the host already knows its own minted",
  "    code — and re-fetch on restart(). A failure to fetch credentials must NOT fail the",
  "    session: fall back to STUN-only, which is the existing documented path.",
  "  - The HostSession bundle threaded through router state may keep or drop its credentials",
  "    field; prefer dropping it so there is one source of truth (the turn route). Update",
  "    Session.tsx and Home.tsx consistently, including the D8 send-selected path.",
  "",
  "TASK 2 — use Cloudflare's authoritative ICE list (D11).",
  "  - buildIceServers currently hardcodes the TURN URL array. Change it to PREFER the urls",
  "    supplied with the credentials, and fall back to the existing hardcoded array when none",
  "    are supplied (that keeps the STUN-only and pre-change paths working).",
  "  - Never pass port 53 urls to the peer connection (the worker filters them, but defend in",
  "    depth since the list is now server-supplied data).",
  "  - Keep iceTransportPolicy 'all'. Keep the STUN entry.",
  "",
  "TASK 3 — GET share target (D12).",
  "  - The manifest now declares share_target as GET with title/text/url params pointing at",
    "/session. (Parent already changed public/manifest.webmanifest — do not edit it.)",
  "  - Session.tsx must read ?title/?text/?url on mount, and when any is present, compose it as",
  "    a session item ready to send (prefer the most substantial of url > text > title; a URL",
  "    shares better as a text item). Respect the existing role rules: a share landing with no",
  "    ?code is a host session, so the shared text becomes an outgoing item.",
  "  - Replace the existing 'your shared file was not captured' ?share=1 hint with the accurate",
  "    state: text/link shares now work; file shares are a documented limitation (needs an owner",
  "    decision to relax the no-session-persistence rule). Keep the copy honest — do not claim",
  "    file capture works.",
  "  - No session data may be written to IndexedDB, the Cache API or localStorage. Query params",
  "    only.",
  "",
  "TESTS: mintHostSession no longer requires credentials; credentials are fetched from the turn",
  "route for both roles and re-fetched on restart; a credential fetch failure degrades to",
  "STUN-only without failing the session; buildIceServers prefers server urls, filters :53, and",
  "falls back to the hardcoded list when no urls arrive; a ?text/?url landing composes an item;",
  "the share copy does not overstate file support.",
].join("\n")

const REVIEW_TASK = [
  "You are a fresh-context READ-ONLY reviewer for QRDrop Phase 9 (TURN/credential security,",
  "delete confirmation, storage efficiency, share target). No edits, no git, no servers.",
  "Repo: /mnt/warehouse/source/QRDrop. The parent verifies typecheck/tests/build separately.",
  "",
  "READ: AGENTS.md, ORCHESTRATION.md D1-D12 (D10 TURN off the mint route, D11 Cloudflare TURN",
  "is an API not an HMAC, D12 share target GET-not-POST), PLAN.md §13, §15, §17.",
  "",
  "Code: apps/signaling-worker/src/{turn.ts,index.ts,session.ts,types.ts,env-extra.d.ts} and",
  "their tests; apps/frontend/src/{hooks/useSession.ts,lib/webrtc.ts,lib/export.ts,lib/crypto.ts,",
  "lib/library.ts,pages/Home.tsx,pages/Session.tsx,components/ConfirmDelete.tsx,",
  "components/library/LibraryBrowser.tsx} and their tests; public/manifest.webmanifest.",
  "",
  "JUDGE in priority order:",
  "",
  "P0 — OPERATOR COST EXPOSURE (this is what the phase exists for):",
  "  - Is turnCredentials truly gone from /session/new? Any other route that hands out relay",
  "    credentials without a rate limit?",
  "  - Are /session/new, /session/:code/turn and the ws join ALL rate-limited per IP, with the",
  "    caps as named constants? Does the fail-open-on-KV-error policy remain documented?",
  "  - Does the TTL actually come from TURN_TTL_SECONDS (600) rather than a hardcoded 3600?",
  "  - Is customIdentifier set, does it contain the session code, and is it within 128 chars?",
  "  - Can a credential be minted for a code that does not exist / is expired / is burned?",
  "",
  "P0 — CORRECTNESS OF THE CLOUDFLARE CALL (D11):",
  "  - URL, Authorization bearer, body shape, ttl bounds 1..172800, response parsing of both the",
  "    flat and nested iceServers shapes, port-53 filtering.",
  "  - Does every failure mode (missing key, network throw, non-2xx, bad JSON) return null and",
  "    keep the session working STUN-only? A thrown TURN error escaping into session creation",
  "    would be a P0 regression.",
  "  - Is any secret (key id, credential, session code) written to logs?",
  "",
  "P0 — BURNED CODE (the §17 'expired codes return 404' gap):",
  "  - Is the marker written when a session completes pairing, with a TTL well beyond the 300s",
  "    session life?",
  "  - Is it checked on BOTH the ws and turn routes BEFORE any DO lookup or mint?",
  "  - Does a KV failure fail open without breaking joins?",
  "",
  "P0 — FRONTEND CREDENTIAL FLOW:",
  "  - Does the guest still get credentials, and does the host under D8?",
  "  - Does restart() re-fetch (credentials may have expired between attempts)?",
  "  - Does a failed credential fetch degrade to STUN-only rather than ending the session?",
  "",
  "P1 — DATA SAFETY:",
  "  - Do folder deletes show real cascade counts and gate through ConfirmDelete (not",
  "    window.confirm)? Does cancel make zero store calls?",
  "  - Is toBase64's output still byte-identical (alphabet, padding) after the rewrite?",
  "  - Does the Safari fallback keep older IDB rows parseable, and is the broken-blob path",
  "    graceful rather than a crash?",
  "",
  "P1 — INVARIANTS:",
  "  - Nothing new writes session data to IDB/Cache/localStorage (AGENTS.md).",
  "  - Share target copy must not claim file capture works.",
  "  - No Phase-10/deferred features smuggled in; no @ts-ignore/'any'/skipped tests.",
  "",
  "Cite file:line for every finding and say explicitly what you confirmed correct.",
  "Label P0/P1/P2. End with EXACTLY one line: 'Merge verdict: BLOCK' or 'Merge verdict: OK' or",
  "'Merge verdict: OK with notes'.",
].join("\n")

// ─────────────────────────────────────────────────────────── execute ────────
emit("Phase 9 wave 1: worker security (A) || delete confirm (D) || storage efficiency (E)")

const wave1 = await Promise.all([
  runOpts("p9-lane-a-worker", {
    label: "Worker: Cloudflare TURN API + rate limits + burn registry",
    agent: "worker",
    context: "fresh",
    task: LANE_A,
  }),
  runOpts("p9-lane-d-confirm", {
    label: "Frontend: destructive-delete confirmation",
    agent: "worker",
    context: "fresh",
    task: LANE_D,
  }),
  runOpts("p9-lane-e-storage", {
    label: "Frontend: export base64 perf + Safari IDB fallback",
    agent: "worker",
    context: "fresh",
    task: LANE_E,
  }),
])

emit("Wave 1: A=" + String(wave1[0].ok) + " D=" + String(wave1[1].ok) + " E=" + String(wave1[2].ok))

if (!wave1[0].ok) {
  return {
    aborted: "Lane A (worker security) failed — wave 2 depends on its contract",
    laneA: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 4000),
    laneD: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4000),
    laneE: String(wave1[2].output ?? wave1[2].error ?? "").slice(0, 4000),
  }
}

emit("Wave 2: frontend credential consumption + share target")

const wave2 = await runOpts("p9-lane-b-frontend", {
  label: "Frontend: consume turn route + GET share target",
  agent: "worker",
  context: "fresh",
  task: LANE_B,
})

emit("Wave 2: B=" + String(wave2.ok))

if (!wave2.ok) {
  return {
    aborted: "Lane B failed — review not launched",
    laneA: String(wave1[0].output ?? "").slice(0, 5000),
    laneB: String(wave2.output ?? wave2.error ?? "").slice(0, 5000),
  }
}

const review = await runOpts("p9-review", {
  label: "Phase 9 review",
  agent: "reviewer",
  context: "fresh",
  task: REVIEW_TASK,
})

return {
  laneAOk: wave1[0].ok ?? null,
  laneAReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 7000),
  laneDOk: wave1[1].ok ?? null,
  laneDReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4000),
  laneEOk: wave1[2].ok ?? null,
  laneEReport: String(wave1[2].output ?? wave1[2].error ?? "").slice(0, 4000),
  laneBOk: wave2.ok ?? null,
  laneBReport: String(wave2.output ?? wave2.error ?? "").slice(0, 7000),
  reviewOk: review.ok ?? null,
  reviewReport: String(review.output ?? review.error ?? "").slice(0, 14000),
}

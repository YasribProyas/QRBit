// QRDrop Phase 8 — Polish + Security Hardening (PLAN.md §16 Phase 8, §17).
//
// Two parallel lanes:
//   A (worker): CSP headers + Sec-Fetch-* checks on all routes
//   B (frontend): beforeunload → session-end, connection state UI polish,
//                 IDB/Cache API audit + any fixes
// Then: review.
//
// Model chain: AGENTS.md rule 1 = gemini-3.8-flash-high (may be cooling down),
// rule 2 = deepseek-v4-flash. runOpts() walks the chain and retries on failure.

const MODEL_CHAIN = [
  "omnirouter/agy/gemini-3.8-flash-high",
  "agentrouter/deepseek-v4-flash",
  null, // inherit parent session model — never quota-excluded
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

// ────────────────────────────────────────── shared preamble ──
const COMMON = [
  "PROJECT: QRDrop — completed symmetric E2EE P2P file-transfer PWA. Repo: /mnt/warehouse/source/QRDrop",
  "Phases 1-7 are COMPLETE and committed. 842 tests pass. Do NOT redo earlier phases.",
  "",
  "READ FIRST (mandatory):",
  "  1. AGENTS.md — TS strict, no third-party crypto, no session data in IDB/Cache/localStorage.",
  "  2. ORCHESTRATION.md — D1-D9. TS 7.0.2 (no baseUrl). vitest 5 (jsdom via docblock).",
  "  3. PLAN.md §16 Phase 8 (scope list) and §17 (security checklist).",
  "",
  "ALREADY DONE — do NOT redo:",
  "  - AES-GCM auth tag failures: already dropped silently with dev-only warn (webrtc.ts noteDroppedFrame).",
  "  - Server-side session code format validation: isValidSessionCode called on both routes.",
  "  - CORS allowlist: allowedOrigins() never reflects wildcard.",
  "  - Rate limiting: KV-backed sliding window in index.ts isRateLimited.",
  "",
  "SCOPE: Phase 8 ONLY. No new features, no export/import changes, no TURN changes.",
  "",
  "HARD RULES:",
  "  - Fresh context: you have NO prior conversation. Read everything from disk.",
  "  - You are a WORKER. No narration, no status updates.",
  "  - Create/edit ONLY the paths listed under YOUR FILES.",
  "  - Parent-owned, never edit: package.json, pnpm-workspace.yaml, tsconfig*, vite.config.ts,",
  "    vitest.config.ts, wrangler.toml, index.html, public/**, PLAN.md, AGENTS.md,",
  "    ORCHESTRATION.md, TODO.md.",
  "  - No git commands. No pnpm install. No wrangler dev / blocking servers.",
  "  - No @ts-ignore / @ts-expect-error / 'any'. No .skip/.only.",
  "  - Web Crypto API only.",
  "  - No console.* in production code (console.warn in noteDroppedFrame is already gated",
  "    on import.meta.env.DEV and is the ONLY permitted exception).",
  "",
  "FINAL OUTPUT: files changed, exact test counts, deviations from PLAN.md, blockers.",
].join("\n")

// ───────────────────────────────────────────────────────── Lane A (worker) ──
const LANE_A = [
  COMMON,
  "",
  "YOU ARE: Lane A — signaling worker security hardening.",
  "",
  "READ FIRST:",
  "  - apps/signaling-worker/src/index.ts   (all routes, corsHeaders, json helper)",
  "  - apps/signaling-worker/src/env-extra.d.ts  (Env interface — add nothing here unless",
  "    adding a new wrangler var; secrets go via 'wrangler secret put')",
  "  - apps/signaling-worker/wrangler.toml  (DO NOT EDIT — parent-owned)",
  "",
  "YOUR FILES:",
  "  apps/signaling-worker/src/index.ts          (edit — CSP + Sec-Fetch checks)",
  "  apps/signaling-worker/src/index.test.ts     (edit or create — tests for new checks)",
  "",
  "REQUIREMENTS:",
  "",
  "1. CSP headers on ALL responses (PLAN.md §17, §16 Phase 8).",
  "   Add a helper `securityHeaders(): Headers` that returns the headers below,",
  "   then merge them into every Response. The exact CSP from PLAN.md §17:",
  "     Content-Security-Policy:",
  "       default-src 'self';",
  "       connect-src wss://*.workers.dev https://turn.cloudflare.com;",
  "       worker-src 'self'",
  "   Additional hardening headers to add alongside CSP:",
  "     X-Content-Type-Options: nosniff",
  "     X-Frame-Options: DENY",
  "     Referrer-Policy: strict-origin-when-cross-origin",
  "   IMPORTANT: CSP is on the *signaling worker* responses only. The Vite/Pages",
  "   frontend CSP is out of scope for this lane (Pages headers are configured via",
  "   _headers file or Pages config — parent decision for post-launch). Do NOT try to",
  "   inject CSP into the frontend build.",
  "   WebSocket upgrade responses (101 Switching Protocols) MUST NOT carry",
  "   Content-Security-Policy — browsers silently discard it and some reject the",
  "   upgrade. Add security headers only to the non-upgrade JSON responses and the",
  "   OPTIONS preflight. The WS tunnel itself is protected by the E2EE layer.",
  "",
  "2. Sec-Fetch-* checks (PLAN.md §16 Phase 8: 'Sec-Fetch-* checks on worker routes').",
  "   Browsers always send Sec-Fetch-Mode and Sec-Fetch-Site on cross-origin fetch():",
  "   a) GET /session/new — the frontend calls this with fetch().",
  "      Accept only: Sec-Fetch-Mode: cors AND Sec-Fetch-Site: cross-site (or same-origin",
  "      in local dev where they share the origin). Reject other modes (e.g. 'navigate',",
  "      'no-cors') with 403. Missing headers (non-browser clients, curl, Postman) pass",
  "      through — rejection is a browser-CSRF defence, not an API authentication gate.",
  "   b) GET /session/:code/ws — WebSocket upgrade.",
  "      WebSocket from a browser always sends Sec-Fetch-Mode: websocket.",
  "      Reject if the header is present but is NOT 'websocket' (a CSRF fetch() trying",
  "      to hit the WS endpoint). Missing → allow (non-browser clients, wrangler dev).",
  "   Both checks: if Sec-Fetch-Mode is absent, skip the check entirely (non-browser).",
  "",
  "3. Keep the CORS allowlist behaviour exactly as-is (non-wildcard reflected origin).",
  "   Merge security headers AFTER the cors headers so CORS values are not overwritten.",
  "",
  "TESTS (vitest, no docblock needed — worker env, not jsdom):",
  "  - GET /session/new with Sec-Fetch-Mode: navigate → 403.",
  "  - GET /session/new with Sec-Fetch-Mode: cors → proceeds normally (returns 200 or",
  "    503 depending on whether SESSION DO is present — stub if needed).",
  "  - GET /session/new without Sec-Fetch-Mode → proceeds normally.",
  "  - GET /session/:code/ws with Sec-Fetch-Mode: cors (non-websocket) → 403.",
  "  - GET /session/:code/ws with Sec-Fetch-Mode: websocket → proceeds (may return 426",
  "    if no Upgrade header, which is fine — the Sec-Fetch check passed).",
  "  - GET /session/:code/ws without Sec-Fetch-Mode → proceeds.",
  "  - JSON response includes X-Content-Type-Options: nosniff and X-Frame-Options: DENY.",
  "  - WebSocket upgrade response (101) does NOT include Content-Security-Policy.",
  "    (Test this by checking the 426 'Expected WebSocket upgrade' response instead,",
  "    which is easier to inspect — or stub the DO stub to return a WS response.)",
].join("\n")

// ──────────────────────────────────────────────────────── Lane B (frontend) ──
const LANE_B = [
  COMMON,
  "",
  "YOU ARE: Lane B — frontend security polish.",
  "",
  "READ FIRST (in order):",
  "  - apps/frontend/src/hooks/useSession.ts  (session lifecycle, phase transitions,",
  "    send(), endSession())",
  "  - apps/frontend/src/pages/Session.tsx    (page lifecycle, how session is used)",
  "  - apps/frontend/src/store/sessionStore.ts (phase/connectionState/items state)",
  "  - apps/frontend/src/lib/webrtc.ts        (PeerConnection, DataChannel, close())",
  "  - apps/frontend/src/lib/library.ts       (IDB access — to audit session data doesn't",
  "    leak into it)",
  "",
  "YOUR FILES:",
  "  apps/frontend/src/pages/Session.tsx          (edit — beforeunload handler)",
  "  apps/frontend/src/pages/Session.test.tsx     (edit — test beforeunload)",
  "  apps/frontend/src/hooks/useSession.ts        (edit only if a bug fix is needed;",
  "    document any change in deviations)",
  "  apps/frontend/src/hooks/useSession.test.tsx  (edit only if useSession changes)",
  "",
  "REQUIREMENTS:",
  "",
  "1. beforeunload → session-end (PLAN.md §16 Phase 8, §17).",
  "   When the user navigates away or closes the tab while the session is active",
  "   (phase === 'active' or phase === 'pairing'), send a 'session-end' wire message",
  "   to the peer BEFORE the page unloads. The send must be SYNCHRONOUS with respect",
  "   to the browser's unload — use the 'beforeunload' event (not 'unload', which is",
  "   deprecated and unreliable). The DataChannel send() in webrtc.ts is synchronous",
  "   at the socket level (it queues immediately); encryption is async but the",
  "   ciphertext races the close — this is best-effort. Wire it in Session.tsx via",
  "   a useEffect cleanup, OR in useSession's own effect as appropriate. In either",
  "   case: the handler must be removed when the session ends cleanly (the peer already",
  "   got session-end via the wire message; no double-send).",
  "   CONSTRAINT: do NOT call `session.restart()` or anything that triggers React state",
  "   changes inside the beforeunload handler — the page is tearing down. Only send().",
  "",
  "2. Connection state UI audit (PLAN.md §16 Phase 8: 'Connection state UI').",
  "   Read Session.tsx and find the status bar. The session hook already exposes",
  "   `session.status: { label: string; tone: 'neutral'|'ok'|'warn'|'error' }`.",
  "   Verify describeSessionStatus (useSession.ts) covers these RTCPeerConnectionState",
  "   values with appropriate labels and tones:",
  "     'failed'       → tone:'error',  label naming the problem clearly",
  "     'disconnected' → tone:'warn',   label hinting it may recover",
  "     'connected'    → tone:'ok'",
  "     'connecting'   → tone:'neutral'",
  "   If any state produces a misleading label, fix it. If all are fine, document",
  "   'verified correct' with line references in your report. No UI component changes",
  "   needed if the data is already correct.",
  "",
  "3. IDB / Cache API / localStorage audit (PLAN.md §17, AGENTS.md rule).",
  "   Confirm that NO session runtime data (items, Blobs, SDP, ICE, keys, chunks)",
  "   is written to IndexedDB, Cache API, or localStorage. Read:",
  "     - sessionStore.ts: does it persist? (Zustand persist middleware would be a bug)",
  "     - webrtc.ts: any Cache/IDB writes?",
  "     - protocol.ts / chunker.ts: any IDB writes?",
  "     - useSession.ts: any IDB writes beyond library saves on session end?",
  "   Report findings. If a bug is found, fix it in the minimal enclosing file.",
  "   If everything is clean, say so explicitly with file:line evidence.",
  "",
  "TESTS:",
  "  Session.test.tsx:",
  "    - beforeunload fires session-end: mount with an active phase, spy on the send",
  "      function; fire a 'beforeunload' event on window; assert send was called with",
  "      { t: 'session-end' } (or that the underlying channel.send / encodeFrame was",
  "      called — use whatever spy is feasible in jsdom). Test that a second",
  "      beforeunload does NOT double-send if the session already ended cleanly.",
  "    - beforeunload does NOT fire during 'connecting' phase (only active/pairing).",
  "",
  "IMPORTANT CONSTRAINTS:",
  "  - Do NOT add a console.* call anywhere in production code paths.",
  "  - Do NOT read or write IDB from inside useSession (except library saves, which",
  "    already exist).",
  "  - Do NOT change the session wire protocol — { t: 'session-end' } is already defined.",
].join("\n")

// ────────────────────────────────────────────────────────── Review ──
const REVIEW_TASK = [
  "You are a fresh-context READ-ONLY reviewer for QRDrop Phase 8 (Polish + Security",
  "Hardening). No edits, no file creation, no git commands, no servers.",
  "Repo: /mnt/warehouse/source/QRDrop. The parent ran typecheck + tests + build; focus",
  "on correctness, completeness and security — not mechanics.",
  "",
  "READ: AGENTS.md, ORCHESTRATION.md (D1-D9), PLAN.md §16 Phase 8, §17 (full checklist).",
  "Code to review:",
  "  apps/signaling-worker/src/index.ts         (CSP + Sec-Fetch changes)",
  "  apps/signaling-worker/src/index.test.ts    (new/updated tests)",
  "  apps/frontend/src/pages/Session.tsx        (beforeunload handler)",
  "  apps/frontend/src/pages/Session.test.tsx   (beforeunload tests)",
  "  apps/frontend/src/hooks/useSession.ts      (if changed)",
  "  apps/frontend/src/store/sessionStore.ts    (IDB audit target)",
  "  apps/frontend/src/lib/webrtc.ts            (IDB audit target)",
  "  apps/frontend/src/lib/protocol.ts          (IDB audit target)",
  "",
  "JUDGE, in priority order:",
  "",
  "P0 — SECURITY HARDENING:",
  "  - CSP: is Content-Security-Policy present on JSON responses? Does it match",
  "    PLAN.md §17 exactly: `default-src 'self'; connect-src wss://*.workers.dev",
  "    https://turn.cloudflare.com; worker-src 'self'`?",
  "  - CSP: is Content-Security-Policy ABSENT from WebSocket upgrade (101) responses?",
  "    (A CSP on a WS upgrade can break the browser connection.)",
  "  - Sec-Fetch-*: does /session/new reject Sec-Fetch-Mode values other than 'cors'",
  "    and 'same-origin'? Does /session/:code/ws reject non-'websocket' Sec-Fetch-Mode",
  "    when the header is present? Do both routes PASS when the header is absent",
  "    (non-browser clients)?",
  "  - IDB/Cache/localStorage audit: is there ANY path that writes session runtime data",
  "    (items, Blobs, keys, SDP, ICE) to IDB, Cache API, or localStorage? A Zustand",
  "    persist() call in sessionStore.ts would be a P0 bug.",
  "",
  "P0 — beforeunload:",
  "  - Does the beforeunload handler send { t: 'session-end' } to the peer?",
  "  - Is it installed only when the session is active or pairing (not during connecting",
  "    or ended — sending to a dead channel is noise, and during connecting there is no",
  "    peer to notify)?",
  "  - Is it cleaned up when the session ends normally (no double-send)?",
  "",
  "P1 — CONNECTION STATE UI:",
  "  - Do 'failed', 'disconnected', 'connected', 'connecting' RTCPeerConnectionState",
  "    values all produce correct labels and tones in describeSessionStatus?",
  "",
  "P1 — SCOPE:",
  "  - Any Phase 7 or earlier work changed? Any new features?",
  "  - Any @ts-ignore / 'any' / skipped tests?",
  "",
  "Cite file:line for every finding. Verify by reading code, not comments.",
  "State explicitly what you confirmed correct.",
  "Label every finding P0 / P1 / P2.",
  "End with EXACTLY one line: 'Merge verdict: BLOCK' or 'Merge verdict: OK'",
  "or 'Merge verdict: OK with notes'.",
].join("\n")

// ──────────────────────────────────────────────────────── orchestration ──
emit("Phase 8: launching Lane A (worker hardening) and Lane B (frontend polish) in parallel")

const wave1 = await Promise.all([
  runOpts("p8-lane-a-worker", {
    label: "Phase 8 Lane A: CSP + Sec-Fetch hardening on worker",
    agent: "worker",
    context: "fresh",
    task: LANE_A,
  }),
  runOpts("p8-lane-b-frontend", {
    label: "Phase 8 Lane B: beforeunload + connection UI + IDB audit",
    agent: "worker",
    context: "fresh",
    task: LANE_B,
  }),
])

emit("Wave 1: A=" + String(wave1[0].ok) + " B=" + String(wave1[1].ok))

if (!wave1[0].ok || !wave1[1].ok) {
  return {
    aborted: "a wave-1 lane failed — review not launched",
    laneAReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 6000),
    laneBReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 6000),
  }
}

emit("Launching Phase 8 review")

const review = await runOpts("p8-review", {
  label: "Phase 8 review",
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

// QRDrop Phase 1 — finish: apply the orchestrator's DO-lifecycle decision, then fresh-context review.
//
// WHY THIS IS A SEPARATE WORKFLOW: the original phase1.js integration lane FAILED, but not on code.
// The `worker` agent defaults to context:"fork", so it inherited the parent transcript and continued
// the parent's own narration instead of executing ("Waiting on integration -> fresh-context review...").
// It ran zero build commands and emitted no acceptance report -> "Structured acceptance report not found".
// FIX 1: every child here is context:"fresh".
// FIX 2: runOpts() retries on REJECTION, not just ok:false. Acceptance/model exclusions THROW, so a
//        .then()-only chain (as in phase1.js) never reached the fallback and killed the whole workflow.
// FIX 3: no acceptance gate on the writer lane. The parent independently runs typecheck/test/build,
//        which is stronger evidence than a self-attested fence.
//
// Parent-verified state at time of writing: typecheck clean, 118/118 tests pass, both packages build.

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

const GUARDRAILS = [
  "",
  "HARD RULES (another lane violated these last run - do not):",
  "  - context is fresh: you have NO prior conversation. Everything you need is on disk. Read it.",
  "  - You are a WORKER, not the orchestrator. Never narrate the parent's plan, never describe what",
  "    'the integration lane' or 'the reviewer' will do next, never write a status update about the",
  "    project. Execute your task and report what YOU did.",
  "  - Run NO git commands. The parent owns git and commits after you finish.",
  "  - Do NOT run 'pnpm install'. Dependencies are installed and the lockfile is final.",
  "  - Do NOT start 'wrangler dev', 'workerd', or any blocking/long-running server. They orphan",
  "    processes and hold port 8787. Verify ONLY with commands that terminate on their own:",
  "    pnpm -r typecheck / pnpm -r test / pnpm -r build.",
  "  - Do NOT edit PLAN.md, AGENTS.md, ORCHESTRATION.md or TODO.md. Report findings instead.",
  "  - Never weaken the build to get green: no relaxing tsconfig strictness, no @ts-ignore,",
  "    no @ts-expect-error, no 'any' casts, no deleting or .skip-ing tests.",
  "  - TypeScript is v7.0.2: the 'baseUrl' option is REMOVED and must never be reintroduced."
].join("\n");

const DECISION_D1 = [
  "",
  "=== ORCHESTRATOR DECISION D1 — session code lifecycle on pre-pairing disconnect ===",
  "This is a binding design decision. Implement it exactly.",
  "",
  "CURRENT (wrong) BEHAVIOUR in apps/signaling-worker/src/session.ts:",
  "handleSocketClosed() calls destroy() when the last socket closes BEFORE pairing, and destroy() sets",
  "phase = 'DONE' permanently. The session code is therefore burned by a single transient disconnect and",
  "every later join gets 404.",
  "",
  "WHY IT IS WRONG: React 19 StrictMode deliberately mounts, unmounts and remounts effects in dev, so the",
  "Session page's first socket close happens before any peer joins - which permanently kills the session",
  "and makes Phase 1 untestable in development. In production a mobile network blip does the same.",
  "PLAN.md section 17 defines expiry as 'QR URL session codes expire 5 min from creation' - the TTL is the",
  "expiry mechanism, NOT the first socket close. PLAN.md section 19 decision 10 ('no reconnect') governs",
  "the CLIENT (it must not try to resume a dead session); it does not obligate the server to burn an",
  "unused code.",
  "",
  "REQUIRED BEHAVIOUR:",
  "  1. A socket closing BEFORE pairing completes must RELEASE that role's slot and keep the Durable Object",
  "     alive and joinable. It must NOT set phase='DONE' and must NOT destroy().",
  "  2. The DO is destroyed only when either:",
  "       (a) pairing HAS completed and both sockets are closed, or",
  "       (b) the TTL alarm fires (createdAt + SESSION_TTL_SECONDS).",
  "  3. While alive and unpaired, a fresh connection may take the released role's slot again - this is what",
  "     makes StrictMode remount work.",
  "  4. All existing guarantees must still hold: at most one host socket and one guest socket CONCURRENTLY,",
  "     a third participant is refused, joins are refused after pairing, and the 300s TTL still applies.",
  "  5. Preserve the property that the DO persists only a numeric createdAt (no session material), per",
  "     PLAN.md section 17 'logs nothing'.",
  "",
  "ADD TESTS for: slot release on pre-pairing close; a re-join after that close SUCCEEDS; close after",
  "pairing destroys; TTL expiry destroys; a second concurrent host is still refused after a release.",
  "=== END DECISION D1 ==="
].join("\n");

const fix = await runOpts("p1-fix-do-lifecycle", {
  label: "Apply DO lifecycle decision D1",
  agent: "worker",
  context: "fresh",
  task: [
    "TASK: Apply one binding orchestrator design decision to the QRDrop Phase 1 signaling worker, then",
    "prove the whole repo is still green.",
    "",
    "Repo root: /mnt/warehouse/source/QRDrop",
    "",
    "READ FIRST: AGENTS.md, ORCHESTRATION.md (toolchain + operational gotchas), PLAN.md sections 13",
    "(Signaling Server), 17 (Security Checklist) and 19 (Key Design Decisions). Then read",
    "apps/signaling-worker/src/session.ts, sessionState.ts and session.test.ts - the code already exists,",
    "is complete and passes 53 tests. You are making a TARGETED change, not a rewrite. Do not refactor",
    "anything unrelated to the decision below.",
    DECISION_D1,
    "",
    "SECOND, SMALLER ITEM - pin an implicit contract with a test (do NOT change the wire protocol):",
    "In apps/frontend/src/hooks/, the host currently sends its SDP offer when it receives a 'pubkey'",
    "signaling message, using that message as the 'peer has joined' cue. PLAN.md section 13 has no explicit",
    "peer-joined frame, and in Phase 2 'pubkey' will carry a real key so the cue becomes semantically",
    "correct. KEEP this design. But it is load-bearing and implicit, so add a comment at that call site",
    "explaining that 'pubkey' means 'peer joined', and add a unit test asserting the host does not send an",
    "offer before that cue arrives (a premature offer is rejected by the worker as 'peer-not-connected').",
    "If a suitable pure helper already exists, test that; do not build a DOM/React test harness.",
    "",
    "OPTIONAL, only if time permits and it does not risk the above: the pure helpers in",
    "apps/frontend/src/config.ts and hooks/useSession.ts (e.g. origin/URL builders and response parsers)",
    "have no coverage. Add focused unit tests for them.",
    GUARDRAILS,
    "",
    "VERIFY - all three must pass before you report done:",
    "  pnpm -r typecheck",
    "  pnpm -r test",
    "  pnpm -r build",
    "",
    "FINAL OUTPUT: what you changed and why, the new/updated test names, the exact final result of all",
    "three verify commands (with test counts), and anything you could not do. Keep it concise; do not",
    "paste large source listings."
  ].join("\n")
});

emit("D1 fix lane ok=" + String(fix.ok));

const review = await runOpts("p1-review", {
  label: "Fresh-context review of Phase 1",
  agent: "reviewer",
  context: "fresh",
  task: [
    "You are a fresh-context reviewer. You have NO prior conversation and must not assume anything:",
    "read the code yourself. You are READ-ONLY - do not edit, create or delete any file, and run no git",
    "commands. Do not start any server.",
    "",
    "TARGET: QRDrop Phase 1 (PLAN.md section 16, 'Phase 1 - Signaling + Bare WebRTC').",
    "Repo root: /mnt/warehouse/source/QRDrop. Code lives in apps/signaling-worker/src and",
    "apps/frontend/src. The parent has already verified: typecheck clean, 118 tests passing, both",
    "packages build. Do not re-litigate the build; review the DESIGN and CORRECTNESS.",
    "",
    "READ: AGENTS.md, PLAN.md sections 2 (Threat Model), 7 (Home), 8 (Session Flow), 12 (WebRTC),",
    "13 (Signaling Server), 16 (Phase 1 checklist), 17 (Security Checklist), 19 (Key Design Decisions),",
    "and ORCHESTRATION.md. Note ORCHESTRATION.md records an orchestrator decision 'D1' about session-code",
    "lifecycle on pre-pairing disconnect - verify the code actually implements D1.",
    "",
    "JUDGE THESE, in priority order:",
    "  P0 SECURITY / PRIVACY:",
    "   - Does the Durable Object log or persist anything sensitive (SDP, ICE, public keys, payloads)?",
    "     PLAN.md section 17 requires it logs nothing and destroys state after pairing.",
    "   - Is ANY session data written to IndexedDB, Cache API or localStorage? AGENTS.md forbids this",
    "     absolutely. Grep for it, do not assume.",
    "   - Any third-party crypto library? Only Web Crypto is permitted; Phase 1 should contain none.",
    "   - Is the session code format validated server-side BEFORE any DO lookup? Can a malformed or",
    "     attacker-chosen string reach idFromName()? Is code generation unbiased and CSPRNG-based?",
    "   - Can a client inject or forge a 'paired' message, or otherwise drive the state machine illegally?",
    "   - Does the rate limiter fail safe when the KV binding is absent, without crashing the worker?",
    "   - Is the CORS allowlist actually enforced, or does it reflect arbitrary Origins?",
    "  P0 CORRECTNESS:",
    "   - D1: does a pre-pairing socket close release the slot WITHOUT burning the code? Is a re-join",
    "     possible? Is destroy still guaranteed after pairing and on TTL? Any way to get a stuck DO?",
    "   - Can a second concurrent host attach? A third participant? Is the 300s expiry enforced?",
    "   - WebRTC: are ICE candidates arriving before the remote description buffered and flushed?",
    "   - Are all event subscriptions torn down? Any leak or double-connect under React 19 StrictMode?",
    "     Is close() idempotent?",
    "   - Any unhandled promise rejection, or any throw from inside an event callback?",
    "  P1 ARCHITECTURE / READINESS FOR PHASE 2:",
    "   - Is the Phase 2 encryption seam real - does ALL DataChannel traffic pass through exactly one",
    "     encode and one decode function in webrtc.ts, so AES-256-GCM can be inserted without touching",
    "     call sites? A prior lane warned that send() must become async for AES-GCM while PLAN.md section 12",
    "     specifies send(msg): void. Assess whether the current shape supports an internal promise queue",
    "     without a public signature change, and say so concretely.",
    "   - Does SessionState match PLAN.md section 9 exactly, so Phase 2/3 need no store rewrite?",
    "   - Do SignalingClient and PeerConnection match PLAN.md sections 12 and 13?",
    "  P1 SCOPE DISCIPLINE:",
    "   - Was anything from Phase 2-8 built early (crypto, tiptap, msgpack, IndexedDB, real QR, camera)?",
    "     Early implementation is a FINDING, not a bonus.",
    "   - Are there stubs that silently do nothing where Phase 1 required real behaviour?",
    "   - Any @ts-ignore / @ts-expect-error / 'any' used to silence the strict compiler?",
    "",
    "METHOD: cite file and line for every finding. Distinguish a real defect from stylistic preference",
    "and do not pad the list. Where you verified something is CORRECT, say so explicitly - a clean bill",
    "of health on a specific risk is as useful as a finding. Do not invent issues to seem thorough.",
    "",
    "Label findings P0 / P1 / P2. End with EXACTLY one line, verbatim:",
    "'Merge verdict: BLOCK' or 'Merge verdict: OK' or 'Merge verdict: OK with notes'."
  ].join("\n")
});

return {
  fixOk: fix.ok ?? null,
  fixReport: String(fix.output ?? fix.error ?? "").slice(0, 7000),
  reviewOk: review.ok ?? null,
  reviewReport: String(review.output ?? review.error ?? "").slice(0, 12000)
};

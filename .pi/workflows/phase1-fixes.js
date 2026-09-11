// QRDrop Phase 1 — review remediation.
// Applies the orchestrator's decision D4 (fail fast, no client re-offer) plus four
// cheap, high-value P2 findings from the fresh-context review.
//
// Verdict was "OK with notes"; every P0 came back clean. These are the findings worth
// fixing BEFORE Phase 2 builds on them — notably P2 #3, because `paired` becomes the
// safety-phrase gate in Phase 2.
//
// Deliberately NOT in scope (deferred to TODO.md): issued-code registry (Phase 8),
// @cloudflare/vitest-pool-workers DO harness (parent-owned config/dep change), and
// metering /session/new (Phase 7).

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

const fix = await runOpts("p1-remediate", {
  label: "Apply D4 + four P2 review fixes",
  agent: "worker",
  context: "fresh",
  task: [
    "TASK: Apply five specific, well-scoped fixes to QRDrop Phase 1, all derived from a completed",
    "code review plus one binding orchestrator decision. The code already exists, typechecks clean,",
    "and passes 153 tests. You are making TARGETED changes. Do not rewrite or refactor anything",
    "unrelated to the five items below.",
    "",
    "Repo root: /mnt/warehouse/source/QRDrop",
    "",
    "READ FIRST: AGENTS.md, ORCHESTRATION.md (especially the 'Orchestrator decisions log' — decisions",
    "D1 through D4 are binding), PLAN.md sections 13, 17 and 19 (decision 10 matters for item 1).",
    "Then read the specific files named in each item.",
    "",
    "=== ITEM 1 (P1, decision D4) — fail fast instead of hanging when a peer re-joins ===",
    "THE BUG: the host latches offerSent for the lifetime of its effect. Per decision D1 the Durable",
    "Object releases a role slot on pre-pairing disconnect and keeps the code joinable, so a guest that",
    "disconnects and taps 'Try again' re-joins the same code. The DO accepts it and sends a second",
    "'pubkey' cue, but shouldHostSendOffer() returns false because offerSent is already true, so the",
    "rejoined guest never receives an offer. Both UIs then sit on 'Connecting…' until the 300s TTL alarm",
    "closes the sockets. Files: apps/frontend/src/hooks/useSession.ts (the offerSent latch and the",
    "case 'pubkey' handler), apps/frontend/src/lib/signaling.ts (shouldHostSendOffer),",
    "apps/frontend/src/pages/Session.tsx (status rendering), apps/frontend/src/store/sessionStore.ts.",
    "",
    "THE DECISION (D4, binding — do not deviate): fail fast. Do NOT re-offer and do NOT rebuild the",
    "PeerConnection. PLAN.md section 19 decision 10 is explicit that sessions are single-use and that",
    "reconnect logic is not worth the complexity. Implement:",
    "  a) In apps/frontend/src/lib/signaling.ts add an exported PURE predicate alongside the existing",
    "     isPeerJoinedCue / shouldHostSendOffer, e.g.",
    "       isPeerRejoinedCue(message, role, offerSent): boolean",
    "     true exactly when role === 'host' && offerSent === true && isPeerJoinedCue(message).",
    "     Keep shouldHostSendOffer's existing behaviour unchanged (at most one offer per host attempt).",
    "  b) In useSession.ts's case 'pubkey', when isPeerRejoinedCue is true, end the session with a clear,",
    "     user-facing reason instead of returning silently. Route the reason through the store's existing",
    "     errorMessage field (added in Phase 1) and the existing endSession action — do not invent new store",
    "     state. The message must tell the user the other device reconnected and to start a new session.",
    "  c) Confirm Session.tsx actually renders that errorMessage in its Error status; wire it if not.",
    "  d) In apps/signaling-worker/src/sessionState.ts, narrow the comment that justifies slot release as",
    "     letting 'a mobile network blip recover in production'. That claim is only half true: the server",
    "     keeps the code joinable until the TTL (correct per PLAN.md section 17), but the client deliberately",
    "     does not resume (D4, per section 19 decision 10). Also do NOT justify slot release with React",
    "     StrictMode — that rationale is obsolete because useSession defers connect with setTimeout(…, 0)",
    "     plus a cancelled flag, so the throwaway StrictMode mount never opens a socket.",
    "  e) Add unit tests for isPeerRejoinedCue and for the host ending the session on a rejoined cue.",
    "",
    "=== ITEM 2 (P2) — SessionState.connectionState is never written ===",
    "PLAN.md section 9 declares connectionState on SessionState and the store exposes setConnectionState,",
    "but the only writer is hook-local useState in apps/frontend/src/hooks/useWebRTC.ts, so any Phase 3",
    "component reading useSessionStore(s => s.connectionState) gets a permanently stale 'new'. Make the",
    "store authoritative: have useWebRTC call the store action when the peer connection state changes.",
    "You may keep the local state if the hook needs it, but the store must be updated too. Do not delete",
    "the field — Phase 3 depends on it.",
    "",
    "=== ITEM 3 (P2, security-relevant) — applyRelay does not check role/type coherence ===",
    "In apps/signaling-worker/src/sessionState.ts, applyRelay sets offerRelayed / answerRelayed from the",
    "message type alone and only verifies that the sender has joined. It never checks that an 'offer' came",
    "from the host or that an 'answer' came from the guest. So a single joined participant can send",
    "{type:'offer'} then {type:'answer'} (or answer first) and drive phase to DONE: announcePaired() fires",
    "at both peers, stored public keys are nulled, and all later SDP/pubkey relays are refused as",
    "'session-done'. Today that is only a self-inflicted DoS, but in Phase 2 'paired' is the gate for the",
    "safety-phrase overlay, so fix it now. Add an explicit coherence check with its OWN rejection reason",
    "(do not reuse 'sender-not-joined', which would be misleading) and reject: offer not sent by host,",
    "answer not sent by guest. Add tests for both, plus a test that the legitimate host-offer/guest-answer",
    "sequence still pairs.",
    "",
    "=== ITEM 4 (P2) — rate limiter 500s when KV is present but failing ===",
    "In apps/signaling-worker/src/index.ts, isRateLimited awaits kv.get / kv.put with no try/catch. The",
    "absent-binding path already degrades gracefully, but a present-but-throwing binding propagates out of",
    "the fetch handler and 500s every /session/:code/ws upgrade. That is live-reachable because",
    "wrangler.toml currently ships a placeholder KV namespace id. Wrap the KV read/write so a failure",
    "degrades to 'rate limiting disabled' (return false), matching the documented absent-binding policy,",
    "and state in a comment that this is a DELIBERATE fail-open choice for availability. Do not change",
    "wrangler.toml — it is parent-owned.",
    "",
    "=== ITEM 5 (P2) — one emit path can throw out of a callback ===",
    "In apps/frontend/src/lib/webrtc.ts, the onDataChannelOpen pre-subscription replay calls handler()",
    "bare inside a microtask, while every other emit path goes through invokeSafely. A throwing subscriber",
    "therefore surfaces as an uncaught microtask exception. Route that replay through invokeSafely too,",
    "preserving the existing cancelled / this.closed guards.",
    "",
    "HARD RULES:",
    "  - context is fresh: you have NO prior conversation. Everything you need is on disk. Read it.",
    "  - You are a WORKER, not the orchestrator. Never narrate the parent's plan or write a project status",
    "    update. Execute these five items and report what YOU changed.",
    "  - Run NO git commands. The parent owns git.",
    "  - Do NOT run 'pnpm install' or add dependencies.",
    "  - Do NOT start 'wrangler dev', 'workerd' or any blocking server. Verify only with commands that",
    "    terminate on their own.",
    "  - Parent-owned, DO NOT EDIT: package.json, tsconfig*, vite.config.ts, vitest.config.ts,",
    "    wrangler.toml, index.html, apps/frontend/public/**, worker-configuration.d.ts, PLAN.md,",
    "    AGENTS.md, ORCHESTRATION.md, TODO.md.",
    "  - Never weaken the build: no relaxing tsconfig strictness, no @ts-ignore / @ts-expect-error,",
    "    no 'any' casts, no deleting or .skip-ing tests. TypeScript is v7.0.2 ('baseUrl' is removed).",
    "  - No third-party crypto libraries (AGENTS.md). Phase 1 must still contain no crypto at all.",
    "  - Stay in scope. Items deferred by the parent (issued-code registry, a pool-workers DO test harness,",
    "    metering /session/new) must NOT be implemented.",
    "",
    "VERIFY — all three must pass before you report done:",
    "  pnpm -r typecheck",
    "  pnpm -r test",
    "  pnpm -r build",
    "",
    "FINAL OUTPUT: for each of the five items, what you changed (file + brief description) and the names",
    "of tests you added. Then the exact final result of all three verify commands including test counts.",
    "Flag anything you could not complete. Be concise; do not paste large source listings."
  ].join("\n")
});

return {
  fixOk: fix.ok ?? null,
  fixReport: String(fix.output ?? fix.error ?? "").slice(0, 9000)
};

// QRDrop Phase 3 — review remediation.
// Verdict: "OK with notes". One P1 (a genuine cross-lane integration gap: the UI lane
// rendered partial/local blobs the transport lane was never told to publish) plus two
// P2s worth fixing. The fourth P2 (same-tick board order) is documented and report-only.

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

const fix = await runOpts("p3-remediate", {
  label: "Fix blob publication + receive gate + pump release",
  agent: "worker",
  context: "fresh",
  task: [
    "TASK: Apply three specific fixes to QRDrop Phase 3, all from a completed code review. Phase 3 is",
    "otherwise complete: typecheck clean, 465 tests passing, both packages build. TARGETED changes only.",
    "",
    "Repo root: /mnt/warehouse/source/QRDrop",
    "",
    "READ FIRST: AGENTS.md, ORCHESTRATION.md (decisions D1-D5 are BINDING), PLAN.md sections 9 (Session",
    "Data Model — the item shapes and the board UI table), 12 (chunker), 16 (Phase 3 checklist), 17.",
    "Then read the files named below. The two most important are hooks/useSession.ts and",
    "components/session/items/ImageItem.tsx.",
    "",
    "=== FIX 1 (P1, REQUIRED) — the blob data-flow was never wired between the lanes ===",
    "",
    "THE BUG (a genuine integration gap): components/session/items/ImageItem.tsx and FileItem.tsx were",
    "built expecting (a) the SENDER's item to carry the source File's blob so a local preview/download",
    "exists immediately, and (b) the RECEIVER's item to receive PARTIAL blobs as chunks arrive, for the",
    "progressive reveal. But hooks/useSession.ts only ever writes a blob at file-done on the receive",
    "path (around lines 565-573) and never on the send path (addFileItem, around lines 828-838). So:",
    "the sender's image row shows 'Waiting for the first bytes…' for the whole transfer AND after",
    "completion; the receiver's progressive reveal (MAX_PREVIEW_STEPS in ImageItem.tsx) is dead code;",
    "and FileItem's sender-side download anchor never renders. The component comments claim behaviour",
    "the transport never implemented, and neither lane's tests caught it because each tested its own",
    "half with hand-injected blobs.",
    "",
    "THE FIX (exactly this):",
    "  a) In addFileItem, put the source file on the item: blob: file. A File IS a Blob — no copy, no",
    "     arrayBuffer() call. The sender's components then have their local preview immediately.",
    "  b) Add an assemblePrefix(): Blob method to FileAssembler in src/lib/chunker.ts that returns the",
    "     contiguous run of chunks from index 0 (i.e. bytes for indices 0..k-1 where k is the length of",
    "     the unbroken prefix present). It must NOT throw when incomplete (unlike assemble()) and must",
    "     return an empty Blob when nothing contiguous is present.",
    "  c) In the receive path's chunk handler, publish a partial blob onto the store item at the SAME",
    "     10% progress boundaries the existing progress throttle already uses (do not add a second",
    "     throttle cadence — reuse the same boundary decision so at most ~10 partial blobs per item are",
    "     published, keeping MAX_PREVIEW_STEPS meaningful). The item update should set the partial blob",
    "     WITHOUT an objectURL — components derive their own object URLs and are responsible for",
    "     revoking them (see the existing ImageItem.tsx revoke logic; do not create a double-revoke",
    "     hazard).",
    "  d) The sender's own item must NOT be overwritten by echo: if you receive frames for an item id",
    "     you created locally, verify sender items are excluded from the receive-path blob/progress",
    "     writes (read how announce/chunk handlers discriminate; keep it that way).",
    "  e) INTEGRATION TESTS (required — this gap existed precisely because both halves were tested",
    "     only with injected blobs): extend the sender-side file test so that after addFileItem the",
    "     local store item carries the source blob, and the receiver-side test asserts the store item's",
    "     blob grows at a partial boundary DURING the transfer (before file-done) and is byte-identical",
    "     after completion. Keep the existing hand-injected component tests; these new assertions are",
    "     the ones that pin the wiring.",
    "",
    "=== FIX 2 (P2) — the receive path accepts item frames during 'pairing' ===",
    "",
    "Only the send direction is gated (the markActive gate in webrtc.ts). The inbound dispatch in",
    "useSession.ts (around lines 575-630) processes item-announce/text-delta/richtext-delta/file-chunk/",
    "file-done with no confirmation check, so a peer holding the session key can populate the store",
    "before the human confirms the phrase; those items then appear on the board the instant the phase",
    "flips to 'active'.",
    "",
    "THE FIX: ignore inbound item frames unless bothConfirmed() — read it from the store inside the",
    "handler, do not cache it in a ref that can go stale. IMPORTANT SUBTLETY (from the review): gate on",
    "bothConfirmed(), NOT on sessionIsActive()/phase === 'active' — the peer legitimately reaches",
    "'active' a tick before this device's phase-transition effect runs, and a phase-based gate would",
    "drop legitimate frames arriving in that window. Add a test: an item-announce delivered while only",
    "one side has confirmed is ignored, and the same announce after both confirms is accepted.",
    "",
    "=== FIX 3 (P2) — pumps cancelled by stopItemWork are not released from waitForBackpressure ===",
    "",
    "stopItemWork (useSession.ts around lines 427-436) sets each pump's cancelled flag but does not",
    "wake the parked promise in webrtc.ts (around lines 303-320), whose only wakers are",
    "bufferedamountlow, channel.onclose and close(). On the inbound session-end path no close() runs,",
    "so a parked pump's closure — and the File it holds — stays alive until the channel closes or the",
    "component unmounts. No correctness impact (the pump re-checks cancelled before every frame), but",
    "it retains memory. FIX: give useWebRTC (and/or PeerConnection) a releaseBackpressure() that wakes",
    "parked waiters, and call it from stopItemWork so cancelled pumps exit promptly. Add a test that a",
    "pump parked under held backpressure exits (its File can be collected) when the session ends",
    "cleanly — you can assert via a released spy/flag or by checking the pump promise settles.",
    "",
    "OUT OF SCOPE (do not touch):",
    "  - Same-tick board order divergence between sender and receiver (documented, report-only).",
    "  - Anything Phase 4+ (locked-item crypto, library picker, QR/camera, PBKDF2 functions).",
    "  - The 4 MiB WIRE_MAX_FRAME_BYTES ceiling (a noted Phase 4 consideration for locked-payload,",
    "    already documented in protocol.ts).",
    "",
    "HARD RULES:",
    "  - context is fresh: NO prior conversation. Read everything from disk.",
    "  - You are a WORKER, not the orchestrator. Execute; do not narrate the parent's plan.",
    "  - Run NO git commands. Do NOT run 'pnpm install' or add dependencies.",
    "  - Do NOT start 'wrangler dev'/'workerd' or any blocking server.",
    "  - Parent-owned, NEVER edit: package.json, tsconfig*, vite.config.ts, vitest.config.ts,",
    "    wrangler.toml, index.html, apps/frontend/public/**, worker-configuration.d.ts, PLAN.md,",
    "    AGENTS.md, ORCHESTRATION.md, TODO.md.",
    "  - Never weaken the build: no relaxed strictness, no @ts-ignore/@ts-expect-error, no 'any', no",
    "    deleted or .skip-ed tests. TypeScript is v7.0.2 ('baseUrl' removed).",
    "  - Session blobs live in MEMORY ONLY — never IndexedDB/Cache/localStorage (AGENTS.md).",
    "  - No console.* in production code.",
    "",
    "VERIFY — all three must pass:",
    "  pnpm -r typecheck",
    "  pnpm -r test",
    "  pnpm -r build",
    "",
    "FINAL OUTPUT: per fix, what changed (file + description) and tests added/extended with names.",
    "For FIX 1, state explicitly that the new integration assertions fail without the blob wiring.",
    "Then exact verify results with test counts. Be concise."
  ].join("\n")
});

return {
  fixOk: fix.ok ?? null,
  fixReport: String(fix.output ?? fix.error ?? "").slice(0, 9000)
};

// QRDrop Phase 5 — review remediation (small).
// Verdict "OK with notes", zero P0/P1. Three of the five P2s are worth fixing now:
// the FolderPicker root display, the IV/salt length validation at the IDB boundary,
// and the mid-drain queue loss. The other two (picker shape deviation, delete confirm)
// are product decisions recorded in TODO.md by the parent.

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

const fix = await runOpts("p5-remediate", {
  label: "Fix picker root display + IV/salt lengths + drain remainder",
  agent: "worker",
  context: "fresh",
  task: [
    "TASK: Apply three small fixes to QRDrop Phase 5 (the library), all from a code review that found",
    "no P0/P1 issues. The repo is green: typecheck clean, 720 tests passing, both packages build.",
    "TARGETED changes only.",
    "",
    "Repo root: /mnt/warehouse/source/QRDrop",
    "",
    "READ FIRST: AGENTS.md, ORCHESTRATION.md (D1-D9), PLAN.md §6.1, §6.4, §8 Phase 4, §11.4, §17.",
    "",
    "=== FIX 1 (P2) — FolderPicker shows no selection for an item living at Root ===",
    "In components/library/FolderNode.tsx, FolderPicker defines Root as value === null (around lines",
    "263-268), but LibraryItemRow.tsx (around line 453) passes item.folderId, which for root items is",
    "the library sentinel 'root' (library.ts around line 111) — so every option renders unselected.",
    "FIX: in FolderPicker, treat a value matching no known folder as Root:",
    "  selected={value === null || !folders.some((f) => f.id === value)}",
    "(matching itemsInFolder's existing unknown-id-is-root rule). Add a test: an item with folderId",
    "'root' shows Root as the selected option in its Move picker.",
    "",
    "=== FIX 2 (P2) — IV/salt byte lengths not validated at the IDB boundary ===",
    "PLAN.md §6.1 declares iv 12 bytes and salt 16 bytes, but library.ts's readBytes (around lines",
    "258-263) only rejects non-bytes and zero-length. A hostile peer's locked-payload is validated",
    "only as instanceof Uint8Array by protocol.ts, so a 1-byte IV or 5000-byte salt can flow into a",
    "session item, then saveFromSession, then IDB — permanently. It then raises OperationError on",
    "every unlock attempt, which BOTH unlock paths classify as 'wrong password': the exact",
    "misdiagnosis §17 exists to avoid, now persisted.",
    "FIX: in library.ts's locked-item parse/validation path, assert iv.byteLength === 12 and",
    "salt.byteLength === 16 (per §6.1 and §11.4's encryptItem output), rejecting with a clear error.",
    "Ciphertext length is NOT constrained (it is plaintext+tag, variable). Add tests: a locked item",
    "with a 1-byte IV is rejected on save; a 16-byte salt but 12-byte-IV tuple saves fine; the",
    "existing byte-for-byte round-trip tests still pass.",
    "IMPORTANT: this validation applies to WRITES (saveItem/updateItem/saveFromSession). Existing",
    "valid library data is unaffected (encryptItem always emits 12/16).",
    "",
    "=== FIX 3 (P2) — queued sends silently dropped if the session ends mid-drain ===",
    "In hooks/useSession.ts (around lines 1813-1819), the active-phase drain empties the queue with",
    "takeQueuedLibrarySends() then calls sendLibraryItem per item — but sendLibraryItem returns early",
    "and SILENTLY when the session is no longer active (around 1349-1353). A session ending between",
    "two queued items loses the remainder with no notice; D8's 'selected items flow into a session",
    "and send once active' is only partly honoured.",
    "FIX: in the drain loop, stop as soon as the session is no longer active and RE-QUEUE the",
    "untaken remainder (the queue functions queueLibrarySends/takeQueuedLibrarySends are module-",
    "scoped — add an internal requeue, or restructure so the loop only takes items it will actually",
    "send). The items survive in the library either way, but the queue should not be silently",
    "destroyed by a race. Add a test: a queued pair where the session ends after the first send",
    "leaves the second item still in the queue (and it sends if a new session goes active, or is at",
    "least observable as queued — assert whichever your structure makes natural, but assert",
    "SOMETHING; the current behaviour is unobservable loss).",
    "",
    "OUT OF SCOPE: the shared-vs-per-item save picker shape (accepted reading of §8 Phase 4 —",
    "per-item targets remain reachable); a delete confirmation dialog (spec-literal §6.4 menu;",
    "product decision for the owner, not a code fix tonight).",
    "",
    "HARD RULES:",
    "  - context is fresh: NO prior conversation. Read everything from disk.",
    "  - You are a WORKER, not the orchestrator. Execute; do not narrate the parent's plan.",
    "  - Run NO git commands. Do NOT run 'pnpm install'. No blocking servers.",
    "  - Parent-owned, NEVER edit: package.json, tsconfig*, vite.config.ts, vitest.config.ts,",
    "    wrangler.toml, index.html, apps/frontend/public/**, worker-configuration.d.ts, PLAN.md,",
    "    AGENTS.md, ORCHESTRATION.md, TODO.md.",
    "  - Never weaken the build: no relaxed strictness, no @ts-ignore, no 'any', no deleted or",
    "    .skip-ed tests. TypeScript v7.0.2. No third-party crypto. The IDB boundary rules stand.",
    "",
    "VERIFY — all three must pass:",
    "  pnpm -r typecheck",
    "  pnpm -r test",
    "  pnpm -r build",
    "",
    "FINAL OUTPUT: per fix, what changed and the tests added (names). Exact verify results with test",
    "counts. Concise."
  ].join("\n")
});

return { fixOk: fix.ok ?? null, fixReport: String(fix.output ?? fix.error ?? "").slice(0, 8000) };

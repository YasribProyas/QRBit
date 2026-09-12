// QRDrop Phase 4 — review remediation.
// Verdict "OK with notes": no P0 password/plaintext defects. One P1 (D6 cap only
// enforced for files — a locked text/richtext over the cap is silently dropped
// mid-wire while the sender's row says complete) plus two P2s.

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

const fix = await runOpts("p4-remediate", {
  label: "Fix D6 text cap + stale draft + late unlock",
  agent: "worker",
  context: "fresh",
  task: [
    "TASK: Apply three specific fixes to QRDrop Phase 4 (locked items), all from a completed code",
    "review. Phase 4 is otherwise complete: typecheck clean, 534 tests passing, both packages build.",
    "TARGETED changes only — do not refactor anything unrelated.",
    "",
    "Repo root: /mnt/warehouse/source/QRDrop",
    "",
    "READ FIRST: AGENTS.md, ORCHESTRATION.md (decisions D1-D7 binding — D6 is directly relevant),",
    "PLAN.md sections 9, 10, 11.4, 16 Phase 4, 17. Then read the files named below.",
    "",
    "=== FIX 1 (P1, REQUIRED) — the D6 3 MiB cap is enforced only for file content ===",
    "",
    "THE BUG: lockedPlaintextFor in apps/frontend/src/hooks/useSession.ts (around lines 178-198)",
    "checks LOCKED_ITEM_MAX_PLAINTEXT_BYTES only inside the innerType === 'file' branch. For text and",
    "richtext it returns the unbounded string bytes. The compose modal",
    "(components/session/LockedItemComposeModal.tsx, around lines 107-143) likewise caps only the",
    "picked File; the textarea has no maxlength. crypto.ts's constant documentation (around lines",
    "255-268) says the cap applies to the plaintext of ANY locked item.",
    "",
    "CONSEQUENCE: a ~4 MiB locked text/richtext item produces a locked-payload frame just over",
    "WIRE_MAX_FRAME_BYTES (4 MiB). The sender's row is written status 'complete' BEFORE the send",
    "(useSession.ts around 1170-1179), the receiver's decodeWire drops the oversized frame silently",
    "(protocol.ts around 331-336) and its row stays 'transferring' forever with NO error on either",
    "side. The sender believes the secret was delivered. This is the worst failure mode a transfer",
    "tool can have.",
    "",
    "THE FIX: in lockedPlaintextFor, apply the cap to the ENCODED bytes for every inner type — after",
    "const bytes = new TextEncoder().encode(content) for text/richtext, reject when",
    "bytes.byteLength > LOCKED_ITEM_MAX_PLAINTEXT_BYTES with the same error message the file path",
    "uses (adapted: tell the user to send long text as a regular text item instead). Surface the",
    "same limit in the compose modal for text/richtext — either a live counter/warning near the cap",
    "or rejecting on submit with the clear message; pick the minimal approach consistent with how",
    "the file path reports it.",
    "",
    "TEST (required, and the review notes the existing cap test at useSession.test.tsx around",
    "1592-1638 covers ONLY the file path): a locked TEXT item whose encoded content exceeds the cap",
    "is rejected by addLockedItem BEFORE any frame is sent (assert nothing reached the channel), and",
    "a locked RICHTEXT item likewise. A just-under-the-cap text item still sends successfully.",
    "",
    "=== FIX 2 (P2) — the compose modal can submit content that is no longer on screen ===",
    "",
    "THE BUG: in components/session/LockedItemComposeModal.tsx, richTextJson and file are component",
    "state (around lines 92-93) that SURVIVES an inner-type switch, while the widgets that display",
    "them are conditionally mounted (richtext editor around 258-263, file input around 265-272) and",
    "the radio onChange only sets the type (around 234-236). Switching richtext -> text -> richtext",
    "remounts the editor EMPTY, switching file -> text -> file remounts an empty file input — but",
    "canSubmit still passes because the stale file state is non-null (around 106-107) and content is",
    "read from the retained state (around 132-147). The sender can transmit a secret whose content",
    "they cannot see, and locked content has no recovery path by design.",
    "",
    "THE FIX: clear the non-selected content state in the radio onChange (set richTextJson/file to",
    "their empty values when switching AWAY from that type), keeping canSubmit/missingFile consistent",
    "so submit disables until real content exists for the newly selected type. TEST: switch",
    "file -> text -> file and assert the file state is cleared and submit is disabled until a new",
    "file is picked; same for richtext.",
    "",
    "=== FIX 3 (P2) — a late unlock writes plaintext after the session ended ===",
    "",
    "THE BUG: unlockItem in useSession.ts (around lines 1275-1279) awaits ~300ms of PBKDF2 and then",
    "unconditionally writes unlocked: true, plaintextContent: revealed with no phase guard. The",
    "cleanup (discardUnlockedPlaintext) runs exactly once at the phase === 'ended' transition",
    "(around 1585-1587 -> stopItemWork around 936-947 -> discardUnlockedPlaintext around 284-296),",
    "and endSession does NOT clear items. If the peer's session-end lands inside the unlock window,",
    "the plaintext is written AFTER the cleanup and stays in the store until reset/unmount — breaking",
    "the in-code claim that an unlock cannot outlive its own row (around 1273-1274).",
    "",
    "THE FIX: after the await in unlockItem, re-check the store: if",
    "useSessionStore.getState().phase !== 'active', do NOT write the reveal — still resolve true",
    "(the password WAS correct) but leave the item locked. TEST: start an unlock, end the session",
    "before it resolves (you control timing in the test), assert the item is NOT unlocked and has no",
    "plaintextContent afterwards.",
    "",
    "OUT OF SCOPE (do not touch):",
    "  - The browser maxMessageSize question for 3 MiB single frames (a real-device check for the",
    "    owner, already noted in the review's residual risks — it is in TODO territory, not code).",
    "  - locked-payload field-length validation beyond the existing 4 MiB frame bound (the review",
    "    explicitly declined to raise it: a peer can send nothing at all for the same effect).",
    "  - Any Phase 5+ work (library, IDB, export, QR).",
    "",
    "HARD RULES:",
    "  - context is fresh: NO prior conversation. Read everything from disk.",
    "  - You are a WORKER, not the orchestrator. Execute; do not narrate the parent's plan.",
    "  - Run NO git commands. Do NOT run 'pnpm install' or add dependencies.",
    "  - Do NOT start 'wrangler dev'/'workerd' or any blocking server.",
    "  - Parent-owned, NEVER edit: package.json, tsconfig*, vite.config.ts, vitest.config.ts,",
    "    wrangler.toml, index.html, apps/frontend/public/**, worker-configuration.d.ts, PLAN.md,",
    "    AGENTS.md, ORCHESTRATION.md, TODO.md.",
    "  - Never weaken the build: no relaxed strictness, no @ts-ignore/@ts-expect-error, no 'any',",
    "    no deleted or .skip-ed tests. TypeScript v7.0.2 ('baseUrl' removed).",
    "  - SECURITY unchanged: the password is never stored/cached/logged; plaintext is memory-only.",
    "",
    "VERIFY — all three must pass:",
    "  pnpm -r typecheck",
    "  pnpm -r test",
    "  pnpm -r build",
    "",
    "FINAL OUTPUT: per fix, what changed (file + description) and the tests added with names.",
    "For FIX 1, confirm the new text-cap test fails against the pre-fix code. Then exact verify",
    "results with test counts. Concise."
  ].join("\n")
});

return {
  fixOk: fix.ok ?? null,
  fixReport: String(fix.output ?? fix.error ?? "").slice(0, 9000)
};

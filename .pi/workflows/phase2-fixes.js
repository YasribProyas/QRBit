// QRDrop Phase 2 — review remediation.
// Verdict was "OK with notes": no P0s, no E2EE break. One P1 that is timing-dependent
// and therefore latent rather than currently-fatal, plus two cheap P2s.

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

const fix = await runOpts("p2-remediate", {
  label: "Fix P1 cue discriminator + two P2s",
  agent: "worker",
  context: "fresh",
  task: [
    "TASK: Apply three specific fixes to QRDrop Phase 2, all derived from a completed code review.",
    "Phase 2 is otherwise complete: typecheck clean, 262 tests passing, both packages build. Make",
    "TARGETED changes only. Do not refactor anything unrelated.",
    "",
    "Repo root: /mnt/warehouse/source/QRDrop",
    "",
    "READ FIRST: AGENTS.md, ORCHESTRATION.md (decisions D1-D4 are BINDING; D4 is directly relevant),",
    "PLAN.md sections 8, 11.6, 13, 17 and 19 (decision 10). Then read the files named below.",
    "",
    "=== FIX 1 (P1, REQUIRED) — the D4 re-join discriminator is over-broad and can abort a healthy session ===",
    "",
    "THE BUG. The Durable Object provably delivers TWO copies of the same 'pubkey' cue to whichever",
    "participant joins second: apps/signaling-worker/src/session.ts sends the peer key directly",
    "(around lines 213-217) and then flushes the copy that was buffered when the first peer joined",
    "(around line 220, via flushBuffered at roughly lines 277-284). READ THAT CODE AND CONFIRM IT.",
    "",
    "When the GUEST joins first, the second joiner is the HOST. The host sends its offer on the first",
    "cue, so offerSent becomes true. The duplicate cue then arrives and isPeerRejoinedCue()",
    "(apps/frontend/src/lib/signaling.ts, around lines 122-128) returns true purely because it is a",
    "second cue after offerSent - it ignores message.publicKey entirely. useSession.ts (around lines",
    "441-446) then calls endSession(PEER_REJOINED_REASON), showing 'The other device reconnected -",
    "start a new session' when no re-join ever happened.",
    "",
    "It does not always fire today, because whether the false abort happens depends on whether the async",
    "ECDH/HKDF derivation completed between the two dispatched message events. If it has not, the",
    "duplicate re-runs performKeyExchange (benign, identical key material) and shouldHostSendOffer",
    "absorbs it. So this is a LATENT, timing-dependent bug - it works by accident, not by design.",
    "",
    "WHY THE OLD JUSTIFICATION IS NOW STALE. The comment in signaling.ts (around lines 117-121) says the",
    "two cues are indistinguishable because 'both carry an empty publicKey'. That was true in Phase 1.",
    "In Phase 2 it is false: a DUPLICATE cue carries the SAME key the host just derived from, whereas a",
    "GENUINE re-join always carries a NEW ephemeral key, because useSession's run() regenerates the",
    "keypair on every attempt (around line 506). Peer public key identity is therefore a correct and",
    "available discriminator. Update that stale comment.",
    "",
    "THE FIX. Make isPeerRejoinedCue compare the cue's publicKey against the peer key this host already",
    "completed a key exchange with. Keep it a PURE exported predicate so it stays unit-testable - add",
    "the previously-exchanged peer public key as a parameter (string | null, or equivalent). Semantics:",
    "  - role === 'host' AND offerSent AND the cue is a peer-joined cue AND the cue's publicKey DIFFERS",
    "    from the already-exchanged peer key  ->  true (a genuine re-join: fail fast per D4)",
    "  - a same-key duplicate  ->  false (ignore it; the host must NOT abort)",
    "Track the exchanged peer key in useSession.ts (a ref alongside the existing keysExchangedRef) and",
    "pass it in. Do NOT change decision D4's outcome for a genuine re-join: a new key must still end the",
    "session with the existing PEER_REJOINED_REASON message. Do not change the wire protocol.",
    "",
    "REGRESSION TEST (required): deliver the SAME 'pubkey' message twice to a host and assert the session",
    "does NOT end and the offer was sent exactly once. Then deliver a DIFFERENT key as the second cue and",
    "assert the session DOES end with PEER_REJOINED_REASON. Note that the existing test at roughly",
    "useSession.test.tsx:495-517 already uses two DIFFERENT keys, which is why it never caught this.",
    "",
    "=== FIX 2 (P2) — the 'already exchanged' guard is set after the first await ===",
    "In apps/frontend/src/hooks/useSession.ts, keysExchangedRef is read at roughly line 381 but only",
    "written at roughly line 396, so two cues delivered before the first derivation resolves BOTH run the",
    "key exchange. Benign with an honest DO (identical key material) but it is free defence-in-depth:",
    "set the guard BEFORE the first await so a concurrent second cue cannot start a second derivation.",
    "Make sure this does not break the genuine re-join path or leave the guard stuck true if derivation",
    "throws - reset it on failure so a retry can proceed.",
    "",
    "=== FIX 3 (P2, small) — diversify the closest wordlist cluster ===",
    "The safety phrase is the ONLY authentication of an unauthenticated pubkey exchange, so human",
    "comparability matters. In apps/frontend/src/lib/wordlist.ts the entries at indices 241-243 are",
    "'whisk', 'whisper', 'whistle' - three words sharing a four-letter prefix, which is the hardest",
    "comparison a hurried user has to make. They pass the existing minimum-edit-distance invariant, so",
    "this is a readability improvement, not a defect. Replace two of the three with short common words",
    "that are maximally distinct from their neighbours. Scan the whole list for any other adjacent-index",
    "cluster sharing a prefix of 4+ characters and diversify those too. HARD CONSTRAINTS: the array must",
    "remain EXACTLY 256 entries, all unique, all lowercase, each 3-8 characters, and the existing test",
    "enforcing a minimum pairwise Levenshtein distance of 3 (in crypto.test.ts, around line 409) must",
    "still pass. Do not change bytesToPhrase or the index-equals-byte-value mapping.",
    "",
    "OUT OF SCOPE - DO NOT IMPLEMENT (the parent has deferred these to Phase 3):",
    "  - A transport-level gate that rejects non-confirm frames until the session is 'active'. In Phase 2",
    "    the 'blocked until both confirm' invariant holds only structurally, because the Frame union",
    "    cannot express item traffic yet. Leave it; Phase 3 owns it.",
    "  - Anything making the unused 'verified' SessionPhase reachable.",
    "  - Anything raising the 24-bit safety-phrase strength (PLAN.md sections 11.6 and 19 sanction three",
    "    words; changing it would deviate from the plan).",
    "",
    "HARD RULES:",
    "  - context is fresh: you have NO prior conversation. Read everything from disk.",
    "  - You are a WORKER, not the orchestrator. Do not narrate the parent's plan or write status updates.",
    "  - Run NO git commands. Do NOT run 'pnpm install' or add dependencies.",
    "  - Do NOT start 'wrangler dev', 'workerd' or any blocking server.",
    "  - Parent-owned, NEVER edit: package.json, tsconfig*, vite.config.ts, vitest.config.ts,",
    "    wrangler.toml, index.html, apps/frontend/public/**, worker-configuration.d.ts, PLAN.md,",
    "    AGENTS.md, ORCHESTRATION.md, TODO.md.",
    "  - Never weaken the build: no relaxing tsconfig strictness, no @ts-ignore / @ts-expect-error,",
    "    no 'any' casts, no deleting or .skip-ing tests. TypeScript is v7.0.2 ('baseUrl' is removed).",
    "  - No third-party crypto libraries. Never log key material or the safety phrase.",
    "",
    "VERIFY - all three must pass before you report done:",
    "  pnpm -r typecheck",
    "  pnpm -r test",
    "  pnpm -r build",
    "",
    "FINAL OUTPUT: for each of the three fixes, what you changed (file + description) and the names of",
    "tests added. Confirm the new same-key-duplicate regression test FAILS against the pre-fix code and",
    "passes after. Then the exact result of all three verify commands with test counts. Be concise."
  ].join("\n")
});

return {
  fixOk: fix.ok ?? null,
  fixReport: String(fix.output ?? fix.error ?? "").slice(0, 9000)
};

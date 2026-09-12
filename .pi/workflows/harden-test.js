// QRDrop — harden one load-sensitive async-ordering test so the phase verification
// gate cannot flake. The test "preserves inbound order although decryption is
// asynchronous" (webrtc.test.ts) failed once under concurrent load across ~8 full-suite
// runs tonight. Every future phase runs the same gate, so a ~10% flake would cause
// spurious remediation cycles.

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

const fix = await runOpts("harden-inbound-order-test", {
  label: "Harden flaky inbound-order test",
  agent: "worker",
  context: "fresh",
  task: [
    "TASK: One small, targeted job — make a single timing-sensitive test deterministic.",
    "",
    "Repo root: /mnt/warehouse/source/QRDrop",
    "",
    "BACKGROUND: the test 'preserves inbound order although decryption is asynchronous' in",
    "apps/frontend/src/lib/webrtc.test.ts failed exactly once tonight, under concurrent load,",
    "while passing in isolation and in 7 other full-suite runs. It tests that inbound frames",
    "delivered to the (fake) DataChannel are handled in arrival order even though each frame's",
    "decryption is asynchronous (the inbound queue serialises them — enqueueInbound in",
    "src/lib/webrtc.ts).",
    "",
    "DO THIS:",
    "1. Read the test and the enqueueInbound/inbound-queue implementation in src/lib/webrtc.ts.",
    "2. Identify the timing assumption that made it load-sensitive — typically either (a) the test",
    "   resolves via a fixed number of awaited microtasks/timers that the queue does not guarantee,",
    "   or (b) it collects results after a race instead of awaiting a completion signal.",
    "3. Make it deterministic WITHOUT weakening what it verifies: wait on an explicit completion",
    "   signal (e.g. all N handlers having run, via a promise the test controls or a drain() call)",
    "   rather than a timing guess. If PeerConnection exposes a drain() or the inbound queue is",
    "   inspectable, use it; if nothing suitable exists, you may add a minimal test-only drain hook",
    "   ONLY if it does not weaken the production path (an idle-queue promise resolved when the",
    "   chain settles is fine; a public flush that changes semantics is not).",
    "4. Do not change the production inbound-ordering behaviour, only the test's waiting strategy.",
    "   Do not add sleeps/retries as a band-aid.",
    "5. Run the single test 20 times: npx vitest run src/lib/webrtc.test.ts -t 'preserves inbound order' --repeat 20",
    "   (if --repeat is unsupported in this vitest version, loop the command 20 times in bash).",
    "   Then run the FULL frontend suite 3 times and 'pnpm -r test' twice. All must be green.",
    "",
    "HARD RULES:",
    "  - context is fresh. You are a WORKER; do not narrate the parent's plan.",
    "  - Edit ONLY apps/frontend/src/lib/webrtc.test.ts and, if truly necessary for a drain hook,",
    "    the minimal addition to src/lib/webrtc.ts. Nothing else.",
    "  - Run NO git commands. No 'pnpm install'. No blocking servers. No test deletions or .skip.",
    "  - No @ts-ignore/@ts-expect-error/'any'. TypeScript v7.0.2 ('baseUrl' removed).",
    "",
    "FINAL OUTPUT: what the timing assumption was, what you changed, and the exact pass counts of",
    "the repeat runs. Concise."
  ].join("\n")
});

return { fixOk: fix.ok ?? null, fixReport: String(fix.output ?? fix.error ?? "").slice(0, 4000) };

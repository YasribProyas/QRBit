# Orchestration Notes — QRDrop

Operating doc for the orchestrator (parent agent). Read this before spawning lanes.
Source of truth for model routing is `AGENTS.md` → "If you're the orchestrator".

## Model routing policy (VERIFIED 2026-09-12)

| Role | Model | Status |
|---|---|---|
| Parent / orchestrator | `qwen-token-plan-individual/qwen3.8-max` (session default) | ✅ working |
| **Sub-agent primary** | `agentrouter/deepseek-v4-flash` | ✅ verified — tools + bash OK |
| **Sub-agent secondary** | `omnirouter/agy/gemini-3.8-flash-high` | ⚠️ EXCLUDED until 2026-09-12T20:56:32Z |
| **Sub-agent last resort** | *(omit `model:`)* → inherits `qwen3.8-max` | ✅ always available |

### 2026-09-12 incident — read this
AGENTS.md prefers gemini-3.8-flash-high (rule 1) then deepseek-v4-flash (rule 2).
The omnirouter gemini route failed twice with `Connection error.` and Pi then
**hard-excluded it for ~18 hours** with the message "cannot be replaced by a
fallback". A workflow pinned to it lost all 3 lanes + integration at 0s each.

Consequences baked into `.pi/workflows/*.js`:
- Every lane goes through the `runOpts()` helper, which walks `MODEL_CHAIN`
  `[deepseek-v4-flash, gemini-3.8-flash-high, null]` and retries the next entry
  when a child returns `ok:false`. `null` means omit `model:` so the child
  inherits the parent session model — that entry can never be quota-excluded,
  so **a lane can never dead-end on a provider outage**.
- Retries use a distinct workflow key suffix (`-fb1`, `-fb2`) to keep identity
  unambiguous.
- Do NOT pin a single `model:` on a lane again. Always use the chain.

Rules:
- Judge a child by `ok` + actual tool output, never by its self-reported identity.
  `agentrouter/deepseek-v4-flash` claims to be "qwen3.8-max" when asked — an
  artifact of the inherited session env, not a routing failure.
- deepseek has a WAF/content filter; plain coding tasks pass fine (AGENTS.md rule 2).

### Models confirmed DEAD — do not use, do not retry
- `agentrouter/claude-opus-5` → 402 budget pool exhausted
- `agentrouter/gpt-5.6-sol` → 402 budget pool exhausted
- `openrouter/anthropic/claude-sonnet-4.6` → 402 billing_error (~2666 tokens affordable)
- Everything else under `openrouter/*` → assume no credits unless proven otherwise

## Fan-out budget
64 concurrent child slots per parent session. Spend them deliberately; sequential
phases (AGENTS.md) mean wide fan-out is only useful *within* a phase.

## Toolchain facts discovered the hard way
- **TypeScript resolved to 7.0.2** (native Go rewrite). `baseUrl` is REMOVED —
  `paths` must use relative values (`"./src/*"`). Do not reintroduce `baseUrl`.
- pnpm 11 uses `allowBuilds:` (map of name→bool) in `pnpm-workspace.yaml`, not
  the old `onlyBuiltDependencies` list. `esbuild` + `workerd` must be `true`.
- vitest 5 removed `test.environmentMatchGlobs`. Per-file DOM opt-in is a
  docblock: `/** @vitest-environment jsdom */` on line 1.
- A `.d.ts` sharing a basename with a `.ts` file is treated as shadowed build
  output and silently dropped from the program. Name ambient decls distinctly
  (e.g. `worker-configuration.d.ts`, not `foo.d.ts` beside `foo.ts`).
- Installed: vite 8.3.0, react 19.3, react-router-dom 7.18, tiptap 3.31,
  zustand 5, @msgpack/msgpack 3.1.3, idb 8, wrangler 4.131, vitest 5.
- `react-router-dom` is an addition not listed in PLAN.md §4 — required because
  PLAN.md §8 drives session role off URL params (`/session?code=...`).

## Parent-side operational gotchas
- NEVER run `pkill -f <pattern>` when the pattern also appears in your own command
  line — `pkill -f` matches full command lines, including the shell running it, so it
  kills your own session mid-run and silently truncates the output. Use
  `pkill -x <exact-process-name>` instead (e.g. `pkill -x workerd`).
- Lanes that verify with a live `wrangler dev` leave orphaned `workerd` processes
  holding port 8787 and `.wrangler` state locks. After any phase where a lane ran a
  dev server, confirm with `ss -ltn | grep 8787` and `pkill -x workerd` before the
  parent runs its own build verification.
- `wrangler dev` is a blocking server. Lanes must not use it for verification —
  prefer `pnpm -r typecheck` / `test` / `build` (all non-blocking), or note the need
  for a live check in the report instead. One lane burned a 180s timeout and spawned
  two orphaned servers learning this.

## Child-context policy — the most expensive lesson tonight

**Always pass `context: "fresh"` to every lane.** The builtin `worker` agent
defaults to `context: fork`, which injects the *entire parent transcript* into
the child.

What that caused: the Phase 1 integration lane inherited my own narration
(including the literal sentence "Waiting on integration → fresh-context review…
I'll independently run `pnpm -r typecheck`"), then **continued writing as me**
instead of executing. It ran zero build commands, produced no acceptance report,
and failed with "Structured acceptance report not found" — after 26s, having done
nothing but kill stray processes and edit this file.

Why the three writer lanes survived fork anyway: their prompts were long and
highly specific, which dominated the inherited context. The integration prompt
was *meta* ("three lanes just wrote…"), which invited role confusion. So the
failure is prompt-shape-dependent and will recur unpredictably. Don't gamble on it.

Corollaries:
- Fresh children lose nothing here: every prompt tells them to read AGENTS.md,
  PLAN.md and this file from disk. That is better grounding than my transcript.
- **Do not put an `acceptance` gate on a lane whose work the parent verifies
  anyway.** I re-run `pnpm -r typecheck && pnpm -r test && pnpm -r build` myself
  after every phase; that is stronger evidence than a self-attested JSON fence,
  and the gate adds a way to fail that has nothing to do with code quality.
- `runs.run()` **REJECTS** (throws) on acceptance failure and on model exclusion;
  it does not resolve with `ok:false`. A fallback chain written as `.then()` only
  will never reach its fallback and will kill the whole workflow. Always handle
  both fulfillment and rejection (see `runOpts` in `.pi/workflows/phase1-finish.js`).

## Orchestrator decisions log

### D1 — session code lifecycle on pre-pairing disconnect (Phase 1)
A socket closing **before** pairing must release that role's slot and keep the
Durable Object alive and joinable. It must NOT set `phase='DONE'` or `destroy()`.
The DO is destroyed only when (a) pairing completed and both sockets closed, or
(b) the 300s TTL alarm fires.

Reason: PLAN.md §17 defines expiry as "5 min from creation", so the TTL is the
expiry mechanism, not a disconnect. §19 decision 10 ("no reconnect") governs the
*client*, not the server's duty to keep an unused code joinable.

**Correction after review (see D4).** The original StrictMode justification is
*obsolete*: Lane C defers connect via `setTimeout(…, 0)` + a `cancelled` flag
(`useSession.ts:369`), so the throwaway StrictMode mount never opens a socket at
all. D1 therefore rests only on §17's TTL semantics — which is still correct, but
the claim that slot release "lets a mobile blip recover" was **half-true**: the
server kept the code joinable while the client could not complete a re-join,
producing a 5-minute hang. D1 stays as written (server-side); D4 fixes the client.
Do not re-justify D1 with StrictMode.

### D4 — no client-side re-offer; fail fast (Phase 1)
The host latches `offerSent` for the lifetime of its effect. Under D1 a guest that
disconnects and taps "Try again" re-joins the same code; the DO accepts and re-sends
the `pubkey` cue, but the host refuses to re-offer, so guest #2 never receives an
offer. Both UIs then sit on "Connecting…" until the 300s TTL alarm closes them.

**Decision: fail fast, do NOT re-offer.** When the host sees a peer-joined cue after
it has already offered, it ends the session with an explicit message ("the other
device reconnected — start a new session") surfaced through the store's
`errorMessage` and rendered in the Session status bar.

Rationale: PLAN.md §19 decision 10 is explicit — "sessions are single-use. If the
connection drops, start a new session. Reconnect logic adds complexity that isn't
worth it for a quick transfer tool." Rebuilding the `PeerConnection` and re-offering
*is* reconnect logic, and it risks interleaving ICE candidates from the discarded
peer. A clear immediate failure is both plan-aligned and better UX than a silent
five-minute spinner.

### D5 — pubkey identity as the D4 re-join discriminator (Phase 2)
D4's `isPeerRejoinedCue()` originally returned true for *any* second `pubkey` cue
after `offerSent`, regardless of whether the key changed. The DO provably delivers
two copies of the same cue to the second joiner: one direct send and one flushed
from the buffer. With a guest-first join the host gets the duplicate after it has
already offered, triggering a false D4 abort — "the other device reconnected" —
with no re-join having occurred. Latent today (timing-dependent: fires only if HKDF
completed before the duplicate arrives) but fragile.

Fix: pass the previously-exchanged peer public key (string) into `isPeerRejoinedCue`.
A same-key duplicate → false (ignore). A new key → true (genuine re-join, fail fast).
This discriminator is correct because `run()` regenerates the keypair on every
attempt, so a real re-join always carries a new ephemeral key.


The host sends its SDP offer only on receiving `pubkey`, because the worker
rejects a premature offer as `peer-not-connected`. PLAN.md §13 has no explicit
`peer-joined` frame. Keeping this: in Phase 2 `pubkey` carries a real key, so the
cue becomes semantically correct. Pinned with a comment + test rather than
changing the wire protocol mid-phase.

### D3 — `send()` stays `void` in Phase 2
PLAN.md §12 specifies `send(msg): void`, but AES-256-GCM encryption is async.
Resolution for Phase 2: keep the public `void` signature and serialise through an
internal promise queue inside the `encodeFrame` seam. Do not broaden the signature.

### D6 — locked file items capped at 3 MiB plaintext (Phase 4)
`locked-payload` carries the whole item in ONE frame, and `WIRE_MAX_FRAME_BYTES` is
4 MiB (ciphertext + iv + salt + msgpack overhead needs headroom). Chunking an
encrypted blob would add a second chunk pipeline for a rare case. Capped at
compose time with a clear error; larger content goes as a regular file item
(already E2EE in transit — locked exists for at-rest/double encryption, which
is for secrets like passwords and keys, not media). decodeWire's existing 4 MiB
bound is the defensive backstop.

### D7 — locked compose asks for the password twice (Phase 4)
§16 Phase 4 says "label, type, password, content" — one field. A password that
provides the ONLY decryption path and cannot be recovered deserves a
confirmation field; mismatch disables submit. Disclosed deviation from PLAN.md.

### D8 — Phase 5 "send selected" starts a host session directly (Phase 5)
§16 puts "'Scan & Send': QRScanner opens after multi-select" in Phase 5's checklist, but
the scanner component is Phase 6. Phase 5 owns the QUEUEING MECHANISM: selected
library items flow into a new session and send once it goes active. The entry
point is a direct host-session start (the flow that exists since Phase 1);
Phase 6's scanner replaces the entry point without touching the queue.

### D9 — sending a locked library item requires NO password (Phase 5)
The {ciphertext, iv, salt} tuple is what travels; the password never does. A
sender can therefore forward a locked library item without unlocking it — the
receiver needs the password to unlock. This is the double-encryption property
§2 promises and it means the send path must never "helpfully" decrypt.

## Concurrency contract for parallel lanes
Phases are strictly sequential (AGENTS.md). Within a phase, lanes run in the
**shared cwd** with **disjoint file ownership** — each lane may only create or
edit the paths named in its task. Shared config (package.json, tsconfig,
vite.config, wrangler.toml) is parent-owned; lanes must not touch it.
No worktrees: avoids overnight merge risk on a greenfield repo.

## Verification gate per phase
`pnpm -r typecheck` → `pnpm -r test` → `pnpm -r build`, then git commit.
Commit at every phase boundary so a provider outage loses nothing.

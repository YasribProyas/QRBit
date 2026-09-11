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

## Concurrency contract for parallel lanes
Phases are strictly sequential (AGENTS.md). Within a phase, lanes run in the
**shared cwd** with **disjoint file ownership** — each lane may only create or
edit the paths named in its task. Shared config (package.json, tsconfig,
vite.config, wrangler.toml) is parent-owned; lanes must not touch it.
No worktrees: avoids overnight merge risk on a greenfield repo.

## Verification gate per phase
`pnpm -r typecheck` → `pnpm -r test` → `pnpm -r build`, then git commit.
Commit at every phase boundary so a provider outage loses nothing.

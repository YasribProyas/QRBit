# Orchestration Notes — QRDrop

Operating doc for the orchestrator (parent agent). Read this before spawning lanes.
Source of truth for model routing is `AGENTS.md` → "If you're the orchestrator".

## Model routing policy (VERIFIED 2026-09-12)

| Role | Model | Status |
|---|---|---|
| Parent / orchestrator | `qwen-token-plan-individual/qwen3.8-max` (session default) | ✅ working |
| **All sub-agents (primary)** | `omnirouter/agy/gemini-3.8-flash-high` | ✅ verified — tools + bash OK |
| **Sub-agent fallback** | `agentrouter/deepseek-v4-flash` | ✅ verified — tools + bash OK |

Rules:
- Every `runs.run` / `runs.all` child gets an explicit `model:` — primary first.
- If a child fails with a provider/connection/402 error, retry that lane on
  `agentrouter/deepseek-v4-flash`. deepseek has a WAF/content filter but plain
  coding tasks pass fine.
- `agentrouter/deepseek-v4-flash` self-reports as "qwen3.8-max" when asked its
  identity. That is a known artifact of the inherited session env, NOT a routing
  failure. Judge by `ok` + actual tool output, never by self-report.

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

## Concurrency contract for parallel lanes
Phases are strictly sequential (AGENTS.md). Within a phase, lanes run in the
**shared cwd** with **disjoint file ownership** — each lane may only create or
edit the paths named in its task. Shared config (package.json, tsconfig,
vite.config, wrangler.toml) is parent-owned; lanes must not touch it.
No worktrees: avoids overnight merge risk on a greenfield repo.

## Verification gate per phase
`pnpm -r typecheck` → `pnpm -r test` → `pnpm -r build`, then git commit.
Commit at every phase boundary so a provider outage loses nothing.

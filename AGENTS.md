# PairDrop Secure Agent Instructions

## If you're the orchestrator
Use the sub-agents for this app to work in parrellal.
### Rules and contexts for orchestrator
1. Use agy/gemini-3.8-flash-high [omnirouter] model for the sub-agents, I have pro so don't worry about token usage.
2. If still yoou run out of agy then use deepseek-v4-flash [agentrouter], i have so much credits there it alone can build this project 10 times over and I won't mind spending all of it. One thing to remember: it has some content blocking and WAF, but just coding will be just ok

## Rules
- TypeScript everywhere. Strict mode.
- pnpm workspaces: frontend in apps/frontend, worker in apps/signaling-worker.
- Complete one phase fully before starting the next.
- After each phase: run the build, fix any errors, then commit with a clear message.
- Never use third-party crypto libs \u2014 Web Crypto API only (see PLAN.md �8).
- Never store session data in IndexedDB, Cache API, or localStorage.

## Phase Order
Work through phases exactly as listed in PLAN.md �13.
Start with Phase 1. Do not skip ahead.

## When stuck
Write a TODO.md note and keep going. Don't stop the session. I'll handle if i have to do anything manually later.
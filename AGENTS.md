# QRBit Agent Instructions

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
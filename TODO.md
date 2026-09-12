# TODO — things needing manual/owner action

Items the agent cannot complete autonomously. Per AGENTS.md, work continues past these.

## Blocking real deployment

- [ ] **No Cloudflare credentials on this machine.** `wrangler` is installed but
      unauthenticated (no `~/.wrangler`, no `CLOUDFLARE_API_TOKEN`). Phase 1's
      "Deploy to Cloudflare Pages + Worker" and Phase 7's live hostile-network
      TURN testing **cannot be done**. Substituted with local `workerd`
      verification via `wrangler dev`. Owner must run `wrangler login` and deploy.
- [ ] **KV namespace ID is a placeholder.** `apps/signaling-worker/wrangler.toml`
      has `id = "REPLACE_WITH_KV_NAMESPACE_ID"` for the `RATE_LIMIT` binding.
      Create it with `wrangler kv namespace create RATE_LIMIT` and paste the real
      id. Rate-limiting code treats the binding as optional so local dev works.
- [ ] **`TURN_SECRET` not set.** Needed for Cloudflare TURN HMAC tokens
      (`wrangler secret put TURN_SECRET`).
- [ ] **Cloudflare TURN endpoint.** PLAN.md §12 hardcodes `turn.cloudflare.com`.
      Confirm the account's actual TURN hostname + credentials endpoint before
      Phase 7; Cloudflare TURN is a paid add-on in some plans.
- [ ] **App URL / domain.** PLAN.md assumes `https://qrdrop.app`. QR codes encode
      that origin. Set `VITE_APP_URL` per environment before Phase 6.

## Model / provider

- [x] Resolved: sub-agents run on `omnirouter/agy/gemini-3.8-flash-high`,
      fallback `agentrouter/deepseek-v4-flash`. See `ORCHESTRATION.md`.
- [ ] `agentrouter/claude-opus-5`, `agentrouter/gpt-5.6-sol` and
      `openrouter/*` are all 402 quota/billing-blocked. Not usable as fallback.

## Deferred design questions

- [ ] **Destructive deletes have no confirmation (Phase 5 review P2).** §6.4's menu spec is
      literal: rename/move/delete send immediately. Folder delete cascades the whole subtree
      permanently — total data loss on one mis-tap on a phone. Product decision: add a confirm
      dialog (recommended) or accept spec-literal behaviour. Left as-is tonight; the menu label
      does disclose the cascade ("Delete folder and contents").
- [ ] **Save-to-library dialog uses one shared folder picker, not §8 Phase 4's per-item picker.**
      Per-item targets remain reachable (pick → Save row 1 → re-pick → Save row 2; the dialog stays
      open), so this is a shape deviation from the spec's wording, not a functional loss. Accepted
      reading; revisit if the per-item flow feels clumsy in use.
- [ ] **DataChannel `maxMessageSize` on real devices (Phase 4 review residual).** A locked item is
      one frame up to ~3 MiB. If a browser rejects it, send() throws and the session ends rather
      than failing the item. Needs a real-device check (Chrome/Safari/Firefox).

- [ ] **No server-side registry of issued session codes** (Phase 8). `createSession`
      writes no record; identity is pure `idFromName(code)`. So PLAN.md §17's
      "expired codes return 404" only holds while the DO instance is alive — after
      eviction, `restore()` finds no `createdAt`, stamps a fresh one plus a fresh
      300s alarm, and the same code becomes joinable again. Not exploitable today
      (a client only joins the code it just minted, so there is no victim), but a
      paired/burned code is not *durably* burned. Needs a KV/D1 "issued" marker
      checked in `/session/:code/ws`. Belongs with Phase 8 server-side validation.
- [ ] **No DO-level integration test** (would need `@cloudflare/vitest-pool-workers`).
      `session.test.ts` covers the extracted pure state machine only, because
      `session.ts` imports `cloudflare:workers` which does not resolve under plain
      vitest. So `openSocket`'s 404/409, `handleSocketClosed` → `releaseRole`,
      `restore()`/`setAlarm` and `destroy()` — the exact code implementing D1 —
      are verified by source review and a live `workerd` run, not by the suite.
      153 green tests do not prove D1 end-to-end. Adding the pool-workers harness is
      a parent-owned config + dependency change; worth doing before Phase 7 hardening.
- [ ] **`/session/new` is unmetered.** The 10/min limiter guards only joins, so DO
      allocation (one storage write + one alarm each) is unbounded per IP. §13 only
      specified join limiting and Phase 7 covers broader rate limiting.

- [ ] `react-router-dom` was added (not in PLAN.md §4 tech table) because
      PLAN.md §8 derives session role from URL params. Confirm acceptable.
- [ ] PLAN.md §12 ICE config lists `turns:turn.cloudflare.com:5349` with a
      comment "TCP 443", but 5349 is the standard TURNS port. PLAN.md §17 asks
      for "TURN over TCP 443". Need `turns:...:443?transport=tcp` as well.
      Flagged for Phase 7.
- [ ] PLAN.md §6.1 stores `Blob` directly in IndexedDB for library image/file
      items. Works in IDB, but Phase 5 should confirm Safari's IDB Blob
      handling and add a fallback if needed.

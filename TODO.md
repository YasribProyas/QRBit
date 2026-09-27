# TODO — QRBit

Everything here is genuinely open. Items completed on 2026-09-18 were moved out rather than
left as stale checkboxes; the git log is the record.

## Needs the owner (not automatable from here)

- [ ] **Billing alerts at $5 and $20.** Cloudflare dashboard → Billing → Billable Usage.
      Cloudflare has **no hard spending cap for TURN** — alerts notify, they do not stop the
      meter. This is the only circuit breaker available, so it is worth doing before the
      TURN key exists.
- [ ] **Create the Cloudflare TURN key**, then:
      `wrangler secret put TURN_KEY_SECRET` and set `TURN_KEY_ID` in
      `apps/signaling-worker/wrangler.toml`. The `wrangler login` OAuth token does not carry
      the `calls` API scope, so this cannot be scripted from here. Until then the worker
      mints no credentials and every session is STUN-only — a degraded connection, not a
      failure, and deliberately not a hard error.
- [ ] **Real-device pass (~1 hour).** Nothing here can substitute for it, and it gates
      "shipped" rather than "code-complete". See README "Testing status" for the specific
      list: two-device transfer + safety phrase read aloud, TURN on a hotspot, 3 MiB locked
      item on Safari/Firefox, iOS/Android install + share sheet.
- [ ] **Custom domain.** When it lands, update `VITE_APP_URL` in
      `apps/frontend/.env.production` **and** `ALLOWED_ORIGINS` in
      `apps/signaling-worker/wrangler.toml`, redeploy both, then re-run the origin
      verification commands in README. Do not assume a hostname is yours because it
      resolves — `qrbit.pages.dev` belongs to an unrelated account.
- [ ] **Choose a license** (README has a placeholder section).

## Open engineering items

- [ ] **DO-level integration tests.** `@cloudflare/vitest-pool-workers@0.22` peers on
      vitest ^4.1; this repo is on vitest 5. Either pin the worker package to vitest 4 for a
      dedicated test project, or drive `miniflare` programmatically under vitest 5. This is
      the gap that leaves `alarm()` → `destroy()` → `markBurnedInKv()` — the durable
      burned-code fix — verified by source review and live curl only. Worth closing before
      any further DO state-machine change.
- [ ] **Share-target *file* capture.** Needs a deliberate owner decision to carve a bounded
      exception out of the AGENTS.md rule that session data never touches IndexedDB or the
      Cache API — a POST body is only readable by a custom service worker, and every way to
      hand it to the page is one of those two stores. Text/link sharing already works via a
      GET share target with query params, which needs neither. Currently stated honestly in
      the UI rather than silently no-oping.
- [ ] **Large-library export still buffers the whole library.** The base64 encoder is now
      16× faster with ~14× less heap churn (measured: 4 MiB 694ms→43ms, 170MB→12MB), but
      `exportLibrary` still assembles the entire manifest in memory before writing. A
      streaming encoder would matter only once real users have real libraries; leave it
      until someone hits it.
- [ ] **`/session/new` allocation is rate-limited per IP but not globally.** A distributed
      actor could still mint many DOs cheaply (each is one storage write + one alarm).
      Cloudflare bills DOs on requests + duration, not per-instance, so exposure is small;
      revisit if the numbers say otherwise.
- [ ] **`react-router-dom` is not in PLAN.md §4's tech table.** Kept because PLAN.md §8
      derives session role from URL params, which needs a router. Treated as accepted since
      deployment proceeded, but it is a spec deviation worth a yes from you.

## Deliberate decisions, recorded so they don't get "fixed"

- [ ] **`saveFolder` and `encryptExport`/`decryptExport` were added in Phase 7** under
      parent approval — the export format cannot preserve folder ids or encrypt its envelope
      through the existing API. Not oversights.
- [ ] **Host must open the session page for its QR to be joinable.** A code left on screen
      past the 300s TTL goes stale; "New code" and the retry panel are the recovery paths.
      This follows from Home being the single mint point (D8/D10) and is inherent to it.
- [ ] **Save-to-library uses one shared folder picker**, not §8 Phase 4's per-item picker.
      Per-item targets are still reachable (the dialog stays open). Accepted reading.
- [ ] **PLAN.md §12's `turns:turn.cloudflare.com:5349` annotated "TCP 443"** was resolved by
      keeping 5349 *and* adding `443?transport=tcp`. Now moot for the shipped path: the ICE
      list comes from Cloudflare's own credential response (D11), so the hardcoded array is
      only the STUN-era fallback.

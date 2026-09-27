# QRBit

**Scan a QR code. Files appear. No login. No cloud. No trace.**

Symmetric, browser-based, end-to-end-encrypted P2P file transfer. Every device is both
sender and receiver; the local library lives in IndexedDB and never leaves the device.

**Live:** https://qrbit-app.proyas.workers.dev
**Signaling:** https://qrbit-signaling.proyas.workers.dev

---

## What it is

| | |
|---|---|
| Transport | WebRTC DataChannel, DTLS, with app-layer AES-256-GCM on top |
| Key exchange | P-256 ECDH, HKDF-derived session key. **The signaling server never sees the shared secret.** |
| Pairing | QR encoding a full URL (`/session?code=XXXXXXXX`), or a typed 8-char code |
| MITM check | 3-word safety phrase derived from the shared secret, confirmed on both devices |
| Locked items | PBKDF2 (600k iterations) + AES-256-GCM, encrypted at rest *and* in transit |
| Signaling | Cloudflare Worker + one Durable Object per session; self-destructs after pairing |
| Relay | Cloudflare TURN (UDP, TCP, TURNS 5349, TURNS 443 for hostile networks) |
| Storage | IndexedDB for the library only. Session data is memory-only. |

No third-party crypto: everything is the Web Crypto API.

## Repository

```
apps/frontend/           React + Vite PWA
apps/signaling-worker/   Cloudflare Worker + Durable Object
PLAN.md                  the specification
ORCHESTRATION.md         build decisions D1-D12 (read this before changing behavior)
TODO.md                  open items, especially: needs a real device
```

## Develop

```bash
pnpm install
pnpm --filter @qrbit/frontend dev              # http://localhost:5173
pnpm --filter @qrbit/signaling-worker dev      # ws://localhost:8787 (local workerd)
```

The verification gate, in order — run all three before committing anything:

```bash
pnpm -r typecheck && pnpm -r test && pnpm -r build
```

Toolchain gotchas that cost real time (full list in `ORCHESTRATION.md`):
TypeScript is **7.0.2**, where `baseUrl` has been removed — `paths` must be relative.
vitest 5 dropped `environmentMatchGlobs`; opt a file into jsdom with
`/** @vitest-environment jsdom */` on **line 1**. A `.d.ts` sharing a basename with a
`.ts` file is silently dropped, which is why the ambient declarations are
`worker-configuration.d.ts` / `env-extra.d.ts`.

## Deploy

Both targets are already provisioned; these commands are the whole loop.

```bash
# 1. Frontend — builds dist/ AND dist/_headers, then uploads as static assets
pnpm --filter @qrbit/frontend build
(cd apps/frontend && ../signaling-worker/node_modules/.bin/wrangler deploy)

# 2. Signaling worker
(cd apps/signaling-worker && ./node_modules/.bin/wrangler deploy)
```

One-time setup, already done: `wrangler login`; `wrangler kv namespace create RATE_LIMIT`
(id committed in `apps/signaling-worker/wrangler.toml`); `wrangler secret put
TURN_KEY_SECRET` once a TURN key exists.

### The origin is one value in two places

Because PLAN.md §8 makes the QR encode the **full app origin**, the app origin must agree
across exactly two files — and both are also the source for CORS and CSP, which derive
from them at build/deploy time rather than hardcoding a host:

| File | Key | Must equal |
|---|---|---|
| `apps/frontend/.env.production` | `VITE_APP_URL` | the served app origin |
| `apps/signaling-worker/wrangler.toml` | `ALLOWED_ORIGINS` | …and that same origin |
| `apps/signaling-worker/wrangler.toml` | `TURN_TTL_SECONDS` | credential lifetime (600s) |

`VITE_SIGNALING_URL` (wss) also derives the app's own `connect-src`. **Moving to a custom
domain means editing both rows and redeploying both.**

> ### Verify any origin before encoding it in a QR
>
> `qrbit.pages.dev` is **not ours** — Cloudflare Pages project names are effectively
> global, and that hostname serves a stock Vite scaffold owned by an unrelated account.
> Deploying there would have shipped QR codes pointing at a stranger's site, and it fails
> *quietly*: the app's CORS and CSP would still look internally consistent.
>
> After any origin change, confirm the deployment is really yours:
>
> ```bash
> curl -s https://<origin>/ | grep -o "<title>[^<]*</title>"   # must print QRBit
> curl -s -D- -o /dev/null https://<origin>/ | grep -i content-security-policy
> curl -s -o /dev/null -w "%{http_code}\n" "https://<origin>/session?code=ABCDEFGH"  # 200 = SPA fallback
> ```

Note: `wrangler pages project create` now provisions a **Workers** project (Pages has been
folded into Workers). Static assets honor `_headers`, and
`not_found_handling = "single-page-application"` is what makes the `/session?code=` deep
link work — that is Flow B, the app's primary entry path.

### Cost protection (read before enabling TURN)

`GET /session/new` returns only a session code. Relay credentials come from
`GET /session/:code/turn`, which requires a code this worker actually issued and that has
not been burned, and is rate-limited per IP alongside the other two routes.

This is not theoretical: Cloudflare bills TURN egress at $0.05/GB after 1,000 GB/month and
**has no hard spending cap for TURN** — budget alerts are email only. A public unmetered
endpoint handing out time-limited (not single-use) credentials is a directly billable
denial-of-wallet, which is what this layout closes. Set billing alerts at $5 and $20.

Every credential carries `customIdentifier = "qrbit:<session code>"`, so Cloudflare's TURN
analytics attribute relay usage to the specific code that was used.

### Quick live checks

```bash
W=https://qrbit-signaling.proyas.workers.dev
curl -s $W/session/new                       # {"code":"XXXXXXXX"}
curl -s -o /dev/null -w "%{http_code}\n" -H 'Sec-Fetch-Mode: navigate' $W/session/new   # 403
curl -s -w "%{http_code}\n" -H 'Sec-Fetch-Mode: cors' $W/session/ABCDEFGH/turn  # 404 never issued
```

## Testing status — what is and isn't proven

931 automated tests pass (834 frontend, 97 worker), covering crypto, the wire protocol, the
chunker, the DO state machine as a pure function, the IDB library, export/import round trips,
and every route's security headers. **They run against fakes, not browsers.**

Explicitly unverified, and needing a human with a phone:

- A real two-device transfer, and reading the safety phrase aloud on both screens.
- TURN on a hostile network (mobile hotspot; UDP-blocked Wi-Fi). Every ICE test here uses a
  fake `RTCPeerConnection`.
- A 3 MiB locked item surviving `maxMessageSize` on Safari and Firefox.
- Safari's IndexedDB Blob serialization. A defensive read path exists and is tested against
  a simulated broken row, but no real Safari has run it.
- PWA install and the share sheet on iOS/Android.
- DO-level integration: `@cloudflare/vitest-pool-workers@0.22` requires vitest ^4.1 and this
  repo is on vitest 5, so `alarm()`/`destroy()`/`restore()` — including the burned-code write
  — are verified by source review and the live checks above, not by the suite.

Sharing **files** from the OS share sheet is not implemented: it needs a custom service
worker that would have to stash the body in the Cache API or IndexedDB, and both are forbidden
for session data. Text and link sharing work (GET share target, query params only).

## License

Not yet chosen.

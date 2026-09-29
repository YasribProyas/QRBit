#!/usr/bin/env bash
# QRBit deploy — build, ship, and PROVE it landed.
#
# The failure this script exists to prevent is a deploy that silently does nothing:
# a stale `dist/` gets shipped, or `pnpm --filter` matches no package after a rename
# (it prints "No projects matched the filters" and exits 0), and the live site keeps
# serving the previous bundle. Every symptom then reads like "the change didn't work"
# rather than "the deploy never happened". So we wipe dist/, build, deploy, and compare
# the served asset hashes against the ones we just produced. Mismatch = exit non-zero.
#
# Usage:
#   ./scripts/deploy.sh              frontend only (typecheck + tests + build + deploy + verify)
#   ./scripts/deploy.sh --worker     also deploy the signaling worker
#   ./scripts/deploy.sh --only-worker  signaling worker alone (no frontend deploy)
#   ./scripts/deploy.sh --fast       skip typecheck/tests (still verifies what got served)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_URL="${APP_URL:-https://qrbit-app.proyas.workers.dev}"
FRONTEND=1
WORKER=0
FAST=0

for arg in "$@"; do
  case "$arg" in
    --worker) WORKER=1 ;;
    --only-worker) WORKER=1; FRONTEND=0 ;;
    --fast) FAST=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# wrangler is a devDependency of the worker package; the frontend has no copy of it.
WRANGLER="$ROOT/apps/signaling-worker/node_modules/.bin/wrangler"
[ -x "$WRANGLER" ] || { echo "wrangler not found at $WRANGLER — run 'pnpm install' first" >&2; exit 1; }

echo "==> shipping commit $(git rev-parse --short HEAD) ($(git status --porcelain | wc -l | tr -d ' ') uncommitted path(s))"

if [ "$FAST" -eq 0 ]; then
  echo "==> typecheck"
  pnpm -r typecheck
  echo "==> tests"
  pnpm -r test
fi

if [ "$FRONTEND" -eq 1 ]; then
  # Wipe so a stale bundle cannot masquerade as a fresh one.
  rm -rf apps/frontend/dist
  echo "==> build frontend"
  BUILD_LOG="$(mktemp)"
  pnpm --filter @qrbit/frontend build 2>&1 | tee "$BUILD_LOG"
  grep -q "built in" "$BUILD_LOG" || { echo "BUILD DID NOT RUN (package filter matched nothing?)" >&2; exit 1; }
  # A renamed package makes the filter a silent no-op; this also catches a build that
  # forgot to emit the CSP file, which would ship the app with no Content-Security-Policy.
  [ -s apps/frontend/dist/_headers ] || { echo "dist/_headers missing or empty — the strict CSP would NOT ship" >&2; exit 1; }

  echo "==> deploy frontend"
  ( cd apps/frontend && "$WRANGLER" deploy )

  echo "==> verify the served page is the build we just made"
  LOCAL="$(grep -oE 'assets/[a-zA-Z0-9._-]+\.(js|css)' apps/frontend/dist/index.html | sort -u)"
  # A Workers static-assets deploy propagates for a minute or two, and the edge may serve the
  # previous index.html during that window. Re-check with a bounded wait instead of declaring
  # failure on the first read -- but keep failing loudly if it never converges, because a real
  # no-op deploy (the stale `--filter` case) must not be papered over by retrying until green.
  LIVE=""
  for attempt in 1 2 3 4 5 6; do
    LIVE="$(curl -s --max-time 45 "$APP_URL/" | grep -oE 'assets/[a-zA-Z0-9._-]+\.(js|css)' | sort -u)"
    [ "$LOCAL" = "$LIVE" ] && break
    echo "    attempt $attempt: still serving the previous bundle; waiting for propagation..."
    sleep 15
  done
  echo "$LOCAL" | sed 's/^/    local  /'
  echo "$LIVE"  | sed 's/^/    served /'
  if [ -n "$LIVE" ] && [ "$LOCAL" = "$LIVE" ]; then
    echo "    ==> MATCH: new bundle is live"
  else
    echo "    ==> MISMATCH after 6 reads: the deploy did not land." >&2
    echo "        If the local list is the OLD build, the build never ran (check for" >&2
    echo "        'No projects matched the filters'). If it is genuinely new, the edge is" >&2
    echo "        still serving a cached shell -- check cf-cache-status on the response." >&2
    exit 1
  fi

  # The old service worker is the usual reason a human still sees the previous UI after
  # a verified deploy, so say it out loud instead of letting them re-run the deploy.
  SW_HASHES="$(curl -s --max-time 45 "$APP_URL/sw.js" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | sort -u | tr '\n' ' ')"
  echo "    live service worker precaches: ${SW_HASHES:-none}"
  echo "    if your browser still shows the old design, that is the PREVIOUS service worker:"
  echo "    reload once more, or DevTools > Application > Service Workers > Unregister."
fi

if [ "$WORKER" -eq 1 ]; then
  echo "==> deploy signaling worker"
  ( cd apps/signaling-worker && "$WRANGLER" deploy )
  echo "==> verify worker is serving"
  curl -s --fail --max-time 45 -o /dev/null -w "    healthz -> %{http_code}\n" https://qrbit-signaling.proyas.workers.dev/healthz
  # Proves the D10 credential gate is intact, not just that the worker booted.
  curl -s --max-time 45 -o /dev/null -w "    unissued code /turn -> %{http_code} (expect 404)\n" \
    -H 'Sec-Fetch-Mode: cors' https://qrbit-signaling.proyas.workers.dev/session/ZZZZZZZZ/turn
  curl -s --max-time 45 -H 'Origin: '"$APP_URL" -H 'Sec-Fetch-Mode: cors' -H 'Sec-Fetch-Site: cross-site' \
    https://qrbit-signaling.proyas.workers.dev/session/new | sed 's/^/    mint -> /'
fi

echo "==> done: $APP_URL"

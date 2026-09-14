// QRDrop Phase 6 — QR + PWA (PLAN.md §16 Phase 6).
//
// Parent already did (config-owned): manifest.webmanifest, 192/512/maskable icons,
// vite-plugin-pwa wiring (app-shell precache, /session* denied from fallback),
// index.html links. Lanes do the components and integration.
//
// Wave 1 (parallel): QRDisplay (render) || QRScanner (camera + detection + fallback)
// Wave 2: integration (Home live QR, scan -> deep link, manual code entry, share target)
// Wave 3: review
//
// Key flows from PLAN.md §7: Flow A = pre-select then scan (Scan & Send); Flow B =
// any QR reader opens https://qrdrop.app/session?code=X directly. §19 decision 11:
// BarcodeDetector first, html5-qrcode fallback.

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

const COMMON = [
  "PROJECT: QRDrop — symmetric, browser-based E2EE P2P file transfer. Repo root: /mnt/warehouse/source/QRDrop",
  "Phases 1-5 are COMPLETE and committed: E2EE transport, session board with all item types, locked items,",
  "and the IndexedDB library with save/send flows. 726 tests pass. Do not redo earlier phases.",
  "",
  "READ FIRST (mandatory):",
  "  1. AGENTS.md — TypeScript strict everywhere. No third-party crypto. Never store session data in",
  "     IndexedDB, Cache API or localStorage.",
  "  2. ORCHESTRATION.md — decisions D1-D9 binding. Toolchain: TypeScript v7.0.2 ('baseUrl' REMOVED),",
  "     vitest 5 (jsdom via docblock on line 1).",
  "  3. PLAN.md — the specification. Your sections are named below.",
  "",
  "SCOPE: PHASE 6 ONLY (PLAN.md §16 'Phase 6 — QR + PWA'). Do NOT implement Phase 7+ work: no",
  "export/import, no Settings page beyond what exists, no TURN hardening beyond what Phase 1 built.",
  "",
  "HARD RULES:",
  "  - context is fresh: you have NO prior conversation. Everything you need is on disk — read it.",
  "  - You are a WORKER, not the orchestrator. Never narrate the parent's plan or write status updates.",
  "  - Create or edit ONLY the paths listed under YOUR FILES. Other lanes run concurrently here.",
  "  - Parent-owned, NEVER edit: package.json, pnpm-workspace.yaml, tsconfig*, vite.config.ts (already",
  "    configured with vite-plugin-pwa), vitest.config.ts, wrangler.toml, index.html, public/** (manifest",
  "    and icons already authored), worker-configuration.d.ts, PLAN.md, AGENTS.md, ORCHESTRATION.md,",
  "    TODO.md. Report a blocker instead of changing these.",
  "  - Run NO git commands. Do NOT run 'pnpm install' — everything needed is installed (qrcode,",
  "    html5-qrcode).",
  "  - Do NOT start 'wrangler dev', 'workerd' or any blocking server. No camera is available in this",
  "    environment: design for injectable camera/detector so tests run headless.",
  "  - Never weaken the build: no relaxed strictness, no @ts-ignore / @ts-expect-error, no 'any' casts,",
  "    no deleted or .skip-ed tests.",
  "  - No console.* in production code.",
  "",
  "FINAL OUTPUT: files created/changed, what you verified (exact results with test counts), every",
  "deviation from PLAN.md and why, and any blocker. Be concise; no large listings."
].join("\n");

// ------------------------------------------------------------- wave 1, lane A
const LANE_DISPLAY = [
  COMMON,
  "",
  "YOU ARE: Lane A — the QR display component. Small but user-critical: this is how every session starts.",
  "",
  "PLAN.md sections to implement: §16 Phase 6 ('QRDisplay.tsx: generate QR from session URL using the",
  "qrcode lib'), §7 (the Home QR panel: 'Tap to refresh / enlarge'), §3 (the QR encodes the FULL URL",
  "https://<app>/session?code=XXXXXXXX — not the bare code).",
  "",
  "CONTEXT: components/QRDisplay.tsx currently exists as the Phase 1 placeholder (renders the URL as",
  "text in a bordered box, with a comment saying Phase 6 swaps in a canvas from the 'qrcode' package",
  "without changing its props). REPLACE its internals; keep the props contract compatible with its",
  "existing callers (check pages/Home.tsx and pages/Session.tsx for how it is used) or extend them",
  "additively.",
  "",
  "YOUR FILES (create or edit only these, under apps/frontend/):",
  "  src/components/QRDisplay.tsx        (replace internals)",
  "  src/components/QRDisplay.test.tsx   (new)",
  "",
  "REQUIREMENTS:",
  "1. Render a real QR code to a <canvas> using the installed 'qrcode' package's toCanvas (or",
  "   equivalent). The QR encodes the full session URL per §3: build it from the app origin",
  "   (config.ts exposes VITE_APP_URL — read it and any existing URL-builder helpers in config.ts",
  "   first; reuse, do not duplicate).",
  "2. The canvas must remain scannable at phone-camera distance: dark modules on light background",
  "   (QR spec requires contrast in that polarity — a dark-theme UI must still render the QR itself",
  "   on a light panel), quiet zone included (the qrcode lib handles margin; verify visually sane",
  "   defaults), error-correction level M or higher.",
  "3. Props: the session URL or code (keep compatibility with existing callers), plus optional",
  "   size. While a QR is being generated (async), show a lightweight placeholder; on generation",
  "   error, fall back to rendering the URL as TEXT in the bordered box (the Phase 1 behaviour) so",
  "   the user can always hand-copy or type the code — a broken QR must never block pairing.",
  "4. Accessibility: the canvas gets a role='img' and aria-label naming what it is ('QR code pairing",
  "   for session <code>'); the raw code is ALSO rendered as visible text near the QR for the manual",
  "   fallback path (§16 Phase 6: 'Manual code entry fallback UI' — the display side of that is",
  "   showing the code legibly).",
  "5. Cleanup: cancel/ignore any in-flight async generation on unmount (no setState after unmount).",
  "",
  "TESTS (jsdom docblock; canvas 2D context does not exist in jsdom — stub getContext and capture",
  "the calls): the component calls the qrcode lib with the FULL URL (spy on the lib; assert the URL",
  "contains the origin and ?code=); error fallback renders the URL text; the code text is present",
  "for manual entry; aria-label present; no setState-after-unmount (spy console.error for the React",
  "warning or assert the stubbed context calls stop after unmount)."
].join("\n");

// ------------------------------------------------------------- wave 1, lane B
const LANE_SCANNER = [
  COMMON,
  "",
  "YOU ARE: Lane B — the QR scanner component. The most environment-hostile component in the app:",
  "no camera exists here, so testability through injection is a first-class requirement.",
  "",
  "PLAN.md sections to implement: §16 Phase 6 ('QRScanner.tsx: BarcodeDetector API with html5-qrcode",
  "fallback'), §19 decision 11 (BarcodeDetector first — Chrome/Android native, fast and",
  "battery-efficient; html5-qrcode for Safari and older browsers), §7 (Flow A: the scanner opens",
  "from Home's 'Scan & Send' after multi-select; scanning a peer's QR opens the session as GUEST).",
  "",
  "YOUR FILES (create only these, under apps/frontend/):",
  "  src/components/QRScanner.tsx        (new)",
  "  src/components/QRScanner.test.tsx   (new)",
  "  src/lib/barcode.ts                  (new — the detection abstraction)",
  "  src/lib/barcode.test.ts             (new)",
  "",
  "REQUIREMENTS:",
  "1. barcode.ts — an injectable detection layer, exported as a small interface so the component and",
  "   tests never touch real cameras:",
  "     export interface BarcodeSource { start(video: HTMLVideoElement): Promise<void>; stop(): void }",
  "     export interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> }",
  "     export function isBarcodeDetectorAvailable(): boolean   // 'BarcodeDetector' in globalThis",
  "     export function createNativeDetector(): BarcodeDetectorLike  // wraps globalThis.BarcodeDetector",
  "     export function createHtml5QrcodeSource(video): BarcodeSource // the fallback path",
  "   The html5-qrcode library is installed; use it ONLY behind the fallback (it is a large lib —",
  "   dynamic import so the native path never pays for it). Vite code-splits dynamic imports.",
  "2. QRScanner.tsx — a modal/fullscreen overlay: a <video> element (playsinline, muted — autoplay",
  "   policies require muted), a viewfinder frame, a cancel button, and clear error states for: no",
  "   camera permission (with a 'how to fix' hint), no camera found, and no BarcodeDetector +",
  "   fallback failure. Requests camera via getUserMedia({ video: { facingMode: 'environment' } })",
  "   — the REAR camera (phones).",
  "3. Detection loop: with the native path, requestAnimationFrame- or interval-driven detect() on the",
  "   video element; on a successful decode, validate the payload is a QRDrop session URL (origin",
  "   match against config's app origin, /session path, a well-formed 8-char code from the Phase 1",
  "   alphabet — reuse any exported validator if codes.ts exports one, else re-derive from",
  "   config/lib) and then call onScan(code) ONCE and stop the camera. A scanned non-QRDrop QR is",
  "   ignored (keep scanning) — do not navigate on arbitrary URLs.",
  "4. Lifecycle discipline — cameras are a scarce resource: stop ALL tracks on unmount, on cancel,",
  "   and on successful scan (MediaStreamTrack.stop()); no leaks, no camera-left-on. The detection",
  "   loop stops with the camera.",
  "5. Props: onScan(code: string): void, onCancel(): void, plus optional injection points for the",
  "   detector/source (used by tests). NO navigation inside the component — the caller decides what",
  "   a scan means (Home's Scan & Send flow vs a plain join).",
  "",
  "TESTS (jsdom docblock; jsdom has no getUserMedia, no BarcodeDetector, no real video — all",
  "injected): native path preferred when available (spy createNativeDetector); fallback selected when",
  "not; permission-denied error state with the hint; no-camera error state; a detected valid session",
  "URL fires onScan exactly once with the CODE (not the URL) and stops the source; a non-QRDrop QR",
  "does not fire onScan and scanning continues; cancel fires onCancel and stops; unmount stops the",
  "stream (assert track.stop called)."
].join("\n");

// ------------------------------------------------------------- wave 2
const LANE_INTEGRATION = [
  COMMON,
  "",
  "YOU ARE: the Phase 6 integration lane. Both component lanes have FINISHED: QRDisplay renders real",
  "QR codes (with a text fallback) and QRScanner scans with BarcodeDetector/html5-qrcode fallback.",
  "READ THEIR ACTUAL EXPORTS AND PROPS FIRST and code against what is really there.",
  "",
  "PLAN.md sections: §7 (Home + both send flows), §8 (session role rules — ?code= -> guest),",
  "§15 (share target: POST /session with a file, multipart), §16 Phase 6 (Home QR taps",
  "/session/new; scanning opens /session?code=... directly; manual code entry fallback; share target",
  "handler in Session page).",
  "",
  "YOUR FILES (create or edit only these, under apps/frontend/):",
  "  src/pages/Home.tsx                       (edit — live QR + Scan & Send + manual entry)",
  "  src/pages/Session.tsx                    (edit — share-target handling)",
  "  src/components/ManualCodeEntry.tsx       (new — the fallback input)",
  "  matching *.test.tsx files",
  "",
  "WHAT TO BUILD:",
  "1. Home's QR goes LIVE per §16 Phase 6: on mount (or a 'Show my QR' action — follow how Home is",
  "   shaped today), call GET <signaling>/session/new, then render the QR for the returned code via",
  "   QRDisplay (the URL built from the app origin). Tapping the QR refreshes it (§7: 'Tap to",
  "   refresh / enlarge' — at minimum refresh; enlargement optional if it fits the existing layout).",
  "   Handle the failure state (worker unreachable) with the text fallback + retry. NOTE: the host",
  "   flow in useSession already mints its own code on /session — check for a double-mint problem:",
  "   if Home pre-mints, the Session page should USE the passed code rather than mint again (the",
  "   guest-less host flow must not create two sessions). Coordinate via how Home navigates",
  "   (e.g. router state carrying the code). If cleanest, Home's QR becomes the mint point and",
  "   Session accepts a pre-minted code via state.",
  "2. 'Scan & Send' comes ALIVE (§7 Flow A): the button opens QRScanner; multi-selected library items",
  "   from the browser flow into the D8 queue (queueLibrarySends — read its export); on scan,",
  "   navigate to /session?code=<scanned> as GUEST — the queue drains when the session goes active.",
  "   With NO selection, Scan & Send still scans and joins as a plain guest session.",
  "3. Flow B (§7): a QR scanned by the NATIVE camera or a third-party app opens",
  "   https://<origin>/session?code=XXXXXXXX directly — the existing Session page already handles",
  "   ?code= as guest. VERIFY this end-to-end path works with the live-QR mint (origin correctness)",
  "   and add a test if one does not exist.",
  "4. ManualCodeEntry (the §16 fallback): an input accepting the 8-char code (the Phase 1 alphabet —",
  "   server rejects anything else with 400), uppercase-insensitive display but EXACT on submit (the",
  "   server does no normalisation — match its rule), with a join button that navigates to",
  "   /session?code=X. Reachable from Home near the Scan & Send button.",
  "5. Share target (§15): the manifest POSTs files to /session as multipart/form-data. The Session",
  "   page (or the router wiring) must handle a POST-shaped navigation: on load, if the page was",
  "   reached by a share POST, the shared File(s) pre-load into the session as items once active.",
  "   Reality check: the browser gives the SW the POST, and the SW typically redirects to GET",
  "   /session?share=1 with the file stashed — with vite-plugin-pwa's default SW there is NO custom",
  "   SW to implement that stash, and writing one means taking over SW generation (parent-owned",
  "   config). IMPLEMENT WHAT IS POSSIBLE WITHOUT A CUSTOM SW: handle the GET /session?share=1",
  "   landing state gracefully (a 'your shared file was not captured — add it from the board' hint),",
  "   and if a clean no-custom-SW capture path genuinely exists, use it. REPORT the exact share-",
  "   target capability honestly as a residual: full share capture needs a custom SW, which is a",
  "   parent config decision.",
  "",
  "SECURITY/UX NOTES: a scanned code is UNTRUSTED input — validate the format before navigating",
  "(8 chars, the alphabet) and let the worker's 400/404 do the rest. The camera permission is",
  "requested only when the scanner actually opens (never on page load).",
  "",
  "TESTS: Home mints and renders the live QR (mock fetch to /session/new; assert QRDisplay receives",
  "the code/URL); refresh re-mints; Scan & Send with a selection queues exactly those items and",
  "navigates as guest with the scanned code; without selection joins plainly; ManualCodeEntry",
  "validates the alphabet client-side and navigates; a malformed scanned code does not navigate;",
  "the share landing state renders its hint. Two-party: the Home-minted code flows through to a",
  "real guest join (the existing harness) with the queue draining on active."
].join("\n");

const wave1 = await Promise.all([
  runOpts("p6-lane-a-display", { label: "Build QR display", agent: "worker", context: "fresh", task: LANE_DISPLAY }),
  runOpts("p6-lane-b-scanner", { label: "Build QR scanner + detection layer", agent: "worker", context: "fresh", task: LANE_SCANNER })
]);

emit("Phase 6 wave 1: display=" + String(wave1[0].ok) + " scanner=" + String(wave1[1].ok));

if (!wave1[0].ok || !wave1[1].ok) {
  return {
    aborted: "a wave-1 lane failed — wave 2 not launched",
    displayReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 5000),
    scannerReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 5000)
  };
}

const wave2 = await runOpts("p6-integration", {
  label: "Wire live QR + scan flows + share target",
  agent: "worker",
  context: "fresh",
  task: LANE_INTEGRATION
});

emit("Phase 6 wave 2: integration=" + String(wave2.ok));

const review = await runOpts("p6-review", {
  label: "Review Phase 6 QR + PWA",
  agent: "reviewer",
  context: "fresh",
  task: [
    "You are a fresh-context reviewer with NO prior conversation. Read the code yourself. You are",
    "READ-ONLY: no edits, no file creation, no git commands, no servers.",
    "",
    "TARGET: QRDrop Phase 6 — QR + PWA (PLAN.md §16 Phase 6, spec §15 and §7). Repo root:",
    "/mnt/warehouse/source/QRDrop. The parent has verified typecheck/tests/build (including that the",
    "service worker builds with /session* excluded from the navigate fallback). Review correctness and",
    "the flows.",
    "",
    "READ: AGENTS.md, ORCHESTRATION.md (D1-D9 — D8 matters for Scan & Send), PLAN.md §3 (QR content),",
    "§7 (both send flows), §8 (role rules), §15 (manifest + share target + SW rules), §16 Phase 6,",
    "§19 decision 11. Code: components/QRDisplay.tsx, QRScanner.tsx, lib/barcode.ts,",
    "components/ManualCodeEntry.tsx, pages/Home.tsx, pages/Session.tsx, config.ts, vite.config.ts,",
    "public/manifest.webmanifest, and the tests. Also the signaling worker's /session/new.",
    "",
    "JUDGE, in priority order:",
    "  P0 — PAIRING FLOWS:",
    "   - Does the Home QR encode the FULL URL (origin + /session?code=) per §3, from the same origin",
    "     the app runs on? Is there any way a code minted by Home gets double-minted by the Session",
    "     page's host flow (two sessions for one user intent)?",
    "   - Scan & Send (Flow A): with a selection, do exactly those items queue (D8) and navigate as",
    "     guest with the scanned code? Without selection, a plain guest join?",
    "   - Flow B: does /session?code=X still assign guest correctly, and is the manual entry fallback",
    "     wired with client-side alphabet validation matching the server's exact rule (no",
    "     normalisation — the server 400s lowercase)?",
    "   - Is a scanned payload treated as UNTRUSTED (format-validated before navigation, no arbitrary",
    "     URL navigation)?",
    "  P0 — CAMERA/LIFECYCLE:",
    "   - Are ALL MediaStreamTracks stopped on scan success, cancel, error, and unmount? A leaked",
    "     camera is a privacy bug, not a nicety.",
    "   - Is the camera permission requested only when the scanner opens?",
    "   - Is the html5-qrcode fallback dynamically imported so the native path never loads it?",
    "  P1 — QR RENDER:",
    "   - Light panel for the QR regardless of dark theme (contrast polarity), quiet zone, the code",
    "     ALSO as legible text, error fallback to text so pairing never breaks, no setState after",
    "     unmount.",
    "  P1 — PWA (§15):",
    "   - Manifest matches §15 (name, share_target POST multipart to /session, icons incl. maskable)?",
    "   - Does the SW config keep /session* out of precache/navigate-fallback (session pages must be",
    "     fresh)? Is IndexedDB unmanaged by the SW (§15 says the page owns IDB)?",
    "   - Share target: is the honest capability reported (no silent no-op pretending to work)?",
    "  P1 — SCOPE:",
    "   - Phase 7+ work built early (export/import, TURN hardening)? Early implementation is a FINDING.",
    "   - Any @ts-ignore / 'any' / skipped tests / third-party crypto?",
    "",
    "Cite file:line for every finding. Verify by reading code, not comments. State explicitly what you",
    "confirmed correct. Do not pad.",
    "",
    "Label findings P0/P1/P2. End with EXACTLY one line: 'Merge verdict: BLOCK' or 'Merge verdict: OK'",
    "or 'Merge verdict: OK with notes'."
  ].join("\n")
});

return {
  displayOk: wave1[0].ok ?? null,
  displayReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 4000),
  scannerOk: wave1[1].ok ?? null,
  scannerReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 5000),
  integrationOk: wave2.ok ?? null,
  integrationReport: String(wave2.output ?? wave2.error ?? "").slice(0, 7000),
  reviewOk: review.ok ?? null,
  reviewReport: String(review.output ?? review.error ?? "").slice(0, 14000)
};

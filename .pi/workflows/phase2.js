// QRDrop Phase 2 — E2EE Layer (PLAN.md §16 Phase 2).
//
// Shape: two waves. Wave 1 runs the pure crypto lane and the overlay/store lane in
// parallel (they share no files and no types beyond PLAN §9's SessionState). Wave 2
// runs the transport-integration lane AFTER crypto exists, so it reads the real
// crypto.ts exports from disk instead of guessing at a contract. Crypto is the one
// place where a pinned-but-wrong contract would be catastrophic, so it is serialised.
// Then verify + a crypto-focused fresh-context review.

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
  "Phase 1 is COMPLETE and committed: signaling worker + Durable Object, SignalingClient, PeerConnection",
  "with an unencrypted JSON frame seam, and the React shell. 164 tests pass. Do not redo Phase 1 work.",
  "",
  "READ FIRST (mandatory):",
  "  1. AGENTS.md — TypeScript strict everywhere. NEVER use a third-party crypto library: Web Crypto API",
  "     only. NEVER store session data in IndexedDB, Cache API or localStorage.",
  "  2. ORCHESTRATION.md — especially the 'Orchestrator decisions log'. Decisions D1–D4 are BINDING.",
  "     D3 in particular governs how send() must stay void while encryption is async.",
  "     Also read 'Toolchain facts': TypeScript is v7.0.2, where 'baseUrl' is REMOVED.",
  "  3. PLAN.md — the specification. Your sections are named below.",
  "",
  "SCOPE: PHASE 2 ONLY (PLAN.md §16 'Phase 2 — E2EE Layer'). Do not implement Phase 3+ work.",
  "Specifically do NOT create protocol.ts, chunker.ts, library.ts, export.ts, and do NOT introduce",
  "@msgpack/msgpack, tiptap, idb, qrcode or html5-qrcode. Those are later phases. Where a later phase",
  "extends your code, leave a clean seam and a comment naming that phase.",
  "",
  "HARD RULES:",
  "  - context is fresh: you have NO prior conversation. Everything you need is on disk — read it.",
  "  - You are a WORKER, not the orchestrator. Never narrate the parent's plan or write a project",
  "    status update. Do your task and report what YOU changed.",
  "  - Create or edit ONLY the paths listed under YOUR FILES. Other lanes run concurrently here.",
  "  - Parent-owned, NEVER edit: package.json, pnpm-workspace.yaml, tsconfig*, vite.config.ts,",
  "    vitest.config.ts, wrangler.toml, index.html, apps/frontend/public/**, worker-configuration.d.ts,",
  "    PLAN.md, AGENTS.md, ORCHESTRATION.md, TODO.md. If you need a dependency or config change,",
  "    DO NOT make it — report it as a blocker.",
  "  - Run NO git commands. Do NOT run 'pnpm install'.",
  "  - Do NOT start 'wrangler dev', 'workerd' or any blocking server. Verify only with commands that",
  "    terminate on their own.",
  "  - Never weaken the build: no relaxing tsconfig strictness, no @ts-ignore / @ts-expect-error,",
  "    no 'any' casts, no deleting or .skip-ing tests.",
  "  - Handle errors explicitly; no unhandled promise rejections; never log key material, plaintext,",
  "    or the safety phrase.",
  "",
  "FINAL OUTPUT: files created/changed, what you verified (exact command results with test counts),",
  "every deviation from PLAN.md and why, and any blocker for the parent. Be concise; no large listings."
].join("\n");

// ---------------------------------------------------------------- wave 1, lane A
const LANE_CRYPTO = [
  COMMON,
  "",
  "YOU ARE: Lane A — the crypto core. This is the highest-stakes code in the project: a subtle mistake",
  "here silently breaks the entire E2EE guarantee. Precision over speed.",
  "",
  "PLAN.md sections to implement: §11.1 (P-256 ECDH key exchange), §11.2 (HKDF key derivation),",
  "§11.3 (AES-256-GCM session encryption) and §11.6 (safety phrase). Also read §2 (Threat Model),",
  "§10 (the envelope format) and §17 (Security Checklist).",
  "",
  "DO NOT IMPLEMENT §11.4 (locked-item PBKDF2 encryption — that is Phase 4) or §11.5 (export",
  "encryption — that is Phase 7). Leave a short comment in crypto.ts naming the phase that will add",
  "them. Stay in Phase 2 scope.",
  "",
  "YOUR FILES (create only these, under apps/frontend/src/lib/):",
  "  crypto.ts          — §11.1, §11.2, §11.3",
  "  safetyPhrase.ts    — §11.6",
  "  wordlist.ts        — the 256-word list",
  "  crypto.test.ts",
  "  safetyPhrase.test.ts",
  "",
  "EXACT API TO EXPORT FROM crypto.ts (PLAN.md §11 — match these signatures):",
  "  generateKeypair(): Promise<CryptoKeyPair>            // ECDH, namedCurve P-256, extractable public key",
  "  exportPublicKey(key: CryptoKey): Promise<ArrayBuffer>      // raw SPKI",
  "  importPeerPublicKey(raw: ArrayBuffer): Promise<CryptoKey>",
  "  deriveSharedSecret(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<ArrayBuffer>",
  "  deriveSessionKey(sharedSecret: ArrayBuffer, sessionId: string): Promise<CryptoKey>",
  "      // HKDF: hash SHA-256, salt = sessionId bytes (UTF-8), info = 'qrdrop-session-v1', 256 bits,",
  "      // imported as an AES-GCM CryptoKey with encrypt+decrypt usages, non-extractable.",
  "  deriveSafetyPhraseBytes(sharedSecret: ArrayBuffer, sessionId: string): Promise<Uint8Array>",
  "      // HKDF: same hash and salt, info = 'qrdrop-phrase-v1'. MUST use a DIFFERENT info string from",
  "      // the session key so the two keys are cryptographically independent (domain separation).",
  "      // Return at least 3 bytes.",
  "  encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<ArrayBuffer>",
  "      // Random 12-byte IV via crypto.getRandomValues, prepended: [iv(12)][ciphertext+GCM tag]",
  "  decrypt(key: CryptoKey, envelope: ArrayBuffer): Promise<Uint8Array>",
  "      // Slices the first 12 bytes as the IV and decrypts the rest. MUST let the DOMException",
  "      // propagate on an auth-tag failure — callers drop the frame silently per PLAN.md §17.",
  "",
  "ADDITIVE HELPERS you should also export (not in §11 but required to move keys over the JSON",
  "signaling channel, which is text-only): toBase64(bytes: ArrayBuffer | Uint8Array): string and",
  "fromBase64(text: string): Uint8Array. Use a constant-time-free but standard approach; they carry",
  "public keys only, never secrets. Validate base64 input and throw a clear error on malformed input.",
  "",
  "safetyPhrase.ts: bytesToPhrase(bytes: Uint8Array): [string, string, string] — maps 3 bytes to 3",
  "words from the 256-word list (one byte per word, so index = byte value). Throw if given fewer than",
  "3 bytes. Words must be uppercased for display per PLAN.md §8's mock ('RIVER COPPER EIGHT').",
  "",
  "wordlist.ts: export a frozen array of EXACTLY 256 distinct, short, common, unambiguous English",
  "words (PLAN.md §11.6 calls it an EFF short wordlist subset). Requirements: all lowercase in the",
  "source array, no duplicates, no words differing only by a letter or two (avoid confusable pairs",
  "like 'there'/'three' or 'wall'/'ball'), nothing offensive, and prefer concrete nouns/adjectives",
  "that are easy to read aloud over a phone. Length 3–8 characters each. Add a test asserting the",
  "array length is exactly 256 and that new Set(words).size === 256.",
  "",
  "CRITICAL CORRECTNESS REQUIREMENTS:",
  "  - Use globalThis.crypto (Web Crypto) only. No libraries. Node 20+ exposes crypto.subtle, so tests",
  "    run in the plain node vitest environment — do not add jsdom.",
  "  - Every encrypt call MUST use a fresh random IV. Never reuse or derive an IV deterministically.",
  "  - The session key and the phrase bytes MUST come from separate HKDF info strings so knowing one",
  "    reveals nothing about the other.",
  "  - decrypt() must NOT catch the auth-tag failure. A wrong key or tampered ciphertext has to surface",
  "    as a rejection so the transport can drop the frame.",
  "  - Nothing may retain key material longer than needed; do not export the raw shared secret anywhere",
  "    it could be logged, and never add console.* calls.",
  "",
  "TESTS — these matter more than usual. At minimum:",
  "  1. THE INTEROPERABILITY TEST (most important in the project): generate two independent keypairs,",
  "     perform ECDH in BOTH directions, and assert both sides derive byte-identical shared secrets,",
  "     identical session keys (export both and compare bytes), and identical safety phrases. This is",
  "     what actually proves two real devices will agree.",
  "  2. encrypt/decrypt round-trip, including empty plaintext and a large (>=1 MiB) payload.",
  "  3. IV uniqueness: encrypt the same plaintext twice and assert the ciphertexts differ and the first",
  "     12 bytes differ.",
  "  4. Tamper detection: flip one bit in the ciphertext, in the IV, and in the tag; assert decrypt",
  "     rejects every time. Also assert a truncated envelope (<12 bytes) rejects rather than throwing a",
  "     confusing error.",
  "  5. Wrong-key decryption rejects.",
  "  6. Domain separation: deriveSessionKey and deriveSafetyPhraseBytes from the same secret produce",
  "     different bytes.",
  "  7. Key usages/extractability: the session key is non-extractable and allows encrypt+decrypt.",
  "  8. bytesToPhrase determinism and the 256-word invariants above; a byte value of 0 and 255 both map",
  "     to valid in-range words.",
  "  9. base64 round-trip, including malformed-input rejection.",
  "",
  "VERIFY before finishing: pnpm --filter @qrdrop/frontend typecheck and",
  "pnpm --filter @qrdrop/frontend test. Both must pass. Typecheck may report errors in files belonging",
  "to the concurrent overlay lane — ignore only those, and make sure no error is attributable to YOUR files."
].join("\n");

// ---------------------------------------------------------------- wave 1, lane C
const OVERLAY_CONTRACT = [
  "",
  "=== OVERLAY + STORE CONTRACT (Lane C implements; Lane B consumes in wave 2) ===",
  "// apps/frontend/src/components/session/SafetyPhraseOverlay.tsx",
  "export type SafetyPhraseOverlayProps = {",
  "  phrase: readonly [string, string, string]",
  "  confirmed: boolean            // this device has tapped Confirmed",
  "  peerConfirmed: boolean        // the peer's phrase-confirm has arrived",
  "  onConfirm: () => void",
  "  onAbort: () => void",
  "  busy?: boolean                // disables the buttons while awaiting the peer",
  "}",
  "export function SafetyPhraseOverlay(props: SafetyPhraseOverlayProps): JSX.Element",
  "",
  "// additions to apps/frontend/src/store/sessionStore.ts (SessionState already has",
  "// safetyPhrase, phraseConfirmed and phase from Phase 1 — do not remove or rename them)",
  "setSafetyPhrase(phrase: [string, string, string] | null): void",
  "setPeerConfirmed(value: boolean): void",
  "confirmPhrase(): void           // sets phraseConfirmed = true for this device",
  "// plus a derived selector bothConfirmed(): phraseConfirmed && peerConfirmed",
  "// Phase 2 adds ONE new field to SessionState: peerConfirmed: boolean (default false).",
  "// It must be reset by the existing reset/endSession action.",
  "=== END CONTRACT ===",
  "",
  "The overlay follows PLAN.md §8 Phase 2 exactly: full-screen, the instruction 'Confirm these match",
  "on both devices:', the three words rendered LARGE, then a [ Confirmed ✓ ] button and an",
  "[ Abort session ] button. Once this device has confirmed, show that state clearly and indicate",
  "whether the peer has confirmed yet. The session must NOT proceed until both have confirmed."
].join("\n");

const LANE_OVERLAY = [
  COMMON,
  "",
  "YOU ARE: Lane C — the safety-phrase overlay and its store wiring. You are running CONCURRENTLY with",
  "the crypto lane, so apps/frontend/src/lib/crypto.ts and safetyPhrase.ts DO NOT EXIST YET.",
  "Do not create them, do not stub them, do not import them. Your components receive the phrase as a",
  "prop and are fully testable without any crypto.",
  "",
  "PLAN.md sections to implement: §8 (Session Flow — Phase 2 is the full-screen SafetyPhrase overlay",
  "and the rule that the session does not proceed until confirmed on both sides), §9 (Session Data",
  "Model — SessionState), §15 (theme colours only).",
  "",
  "YOUR FILES (create or edit only these, under apps/frontend/):",
  "  src/components/session/SafetyPhraseOverlay.tsx   (new)",
  "  src/store/sessionStore.ts                        (edit — add to the existing store)",
  "  src/styles.css                                   (edit — append overlay styles only)",
  "  src/components/session/SafetyPhraseOverlay.test.tsx  (new)",
  "  src/store/sessionStore.test.ts                   (new)",
  "",
  "REQUIREMENTS:",
  "1. SafetyPhraseOverlay.tsx — implement the contract below. Presentational and pure: it takes the",
  "   phrase and flags as props and calls onConfirm/onAbort. It must NOT derive, compute or import any",
  "   crypto, and must not talk to the store directly (the page/hook owns that). Render the three words",
  "   large and clearly separated, per PLAN.md §8's mock. Accessible: the words should be readable by a",
  "   screen reader as three separate words, and both buttons need discernible labels.",
  "2. sessionStore.ts — add peerConfirmed plus the actions and selector in the contract. Phase 1 already",
  "   declared safetyPhrase, phraseConfirmed, phase and errorMessage; keep every existing field and",
  "   action working, and make sure the reset/endSession path clears peerConfirmed too. PLAN.md §9's",
  "   field list must remain satisfied — you are adding, never removing.",
  "3. styles.css — APPEND only. Dark theme consistent with the existing #0f0f0f styling. The overlay must",
  "   cover the full screen and block interaction with anything behind it while unconfirmed. Do not",
  "   restructure or reformat existing rules.",
  "4. Tests — use the jsdom docblock convention this repo already uses (see",
  "   src/hooks/useWebRTC.test.tsx, added in Phase 1: a '/** @vitest-environment jsdom */' docblock on",
  "   line 1, React act(), renderHook). Cover: the three words render; onConfirm fires and the confirmed",
  "   state is shown; onAbort fires; the peer-confirmed indication changes when peerConfirmed flips;",
  "   buttons are disabled while busy; and the store actions/selectors behave (including that",
  "   bothConfirmed() is false until BOTH flags are set, and that reset clears them).",
  "",
  "DO NOT touch pages/Session.tsx, hooks/useSession.ts, hooks/useWebRTC.ts or anything under src/lib/.",
  "Lane B mounts your overlay into the session flow in wave 2 — your job is the component and the store.",
  OVERLAY_CONTRACT,
  "",
  "VERIFY before finishing: pnpm --filter @qrdrop/frontend test must pass for your test files.",
  "Typecheck will report missing-module errors for src/lib/crypto.ts and src/lib/safetyPhrase.ts if you",
  "mistakenly import them — you must not import them at all."
].join("\n");

// ---------------------------------------------------------------- wave 2, lane B
const LANE_TRANSPORT = [
  COMMON,
  "",
  "YOU ARE: Lane B — transport integration. The crypto lane has FINISHED, so",
  "apps/frontend/src/lib/crypto.ts and safetyPhrase.ts now exist on disk. READ THEIR ACTUAL EXPORTS",
  "FIRST and code against what is really there — do not assume. The overlay lane has also finished, so",
  "SafetyPhraseOverlay.tsx and the store additions exist; read those too.",
  "",
  "PLAN.md sections to implement: §8 (Session Flow Phases 1–3, including the rule that the session does",
  "not proceed until both sides confirm), §10 (Wire Protocol — the encrypted envelope and the",
  "phrase-confirm message), §11 (how the crypto API is meant to be used), §12 (PeerConnection),",
  "§13 (public-key exchange during the WS handshake), §17 (Security Checklist), §19 (decisions 5 and 9).",
  "",
  "YOUR FILES (edit only these, under apps/frontend/):",
  "  src/lib/webrtc.ts            — encrypt the seam, widen the frame type, async send queue",
  "  src/lib/signaling.ts         — only if the real public key needs transport changes",
  "  src/hooks/useSession.ts      — key exchange, phrase derivation, confirm handshake, phase gating",
  "  src/hooks/useWebRTC.ts       — only what the async send/error channel requires",
  "  src/pages/Session.tsx        — mount SafetyPhraseOverlay and gate progression on it",
  "  corresponding *.test.ts(x) files for the above",
  "",
  "WHAT TO BUILD:",
  "1. PUBLIC KEY EXCHANGE (§13). Each side calls generateKeypair(), then sends its own public key in the",
  "   join message's publicKey field as base64 (Phase 1 passes an empty string there — fill it in for",
  "   real). Each side receives the peer's key via the 'pubkey' signaling message, imports it, and runs",
  "   ECDH. Preserve the Phase 1 behaviour that 'pubkey' is ALSO the 'peer has joined' cue the host waits",
  "   for before offering (decision D2) — do not break that ordering. Preserve decision D4: a host that",
  "   sees a second peer-joined cue after offering must still fail fast, not re-offer.",
  "   The sessionId for HKDF is the 8-character session code both sides already know.",
  "2. SESSION KEY + PHRASE. Derive the session key and the safety-phrase bytes from the shared secret,",
  "   convert the bytes to the three words, and put them in the store via setSafetyPhrase. Both peers",
  "   must independently derive the SAME three words — that is the whole point of the overlay.",
  "3. ENCRYPT THE SEAM (§10, §11.3). Phase 1 built exactly one encodeFrame and one decodeFrame choke",
  "   point in webrtc.ts. Replace their JSON bodies so every frame is msgpack-free but encrypted:",
  "   serialise the payload to JSON bytes, encrypt with the session key, and send the resulting",
  "   [iv(12)][ciphertext+tag] ArrayBuffer as a BINARY DataChannel frame. decodeFrame reverses it.",
  "   Before the session key exists, frames cannot be encrypted — so the DataChannel must not carry",
  "   application data until key derivation has completed. Enforce that (queue or refuse) rather than",
  "   silently sending plaintext. NO PLAINTEXT APPLICATION DATA MAY EVER CROSS THE CHANNEL.",
  "4. DECISION D3 — send() STAYS void. PLAN.md §12 specifies send(msg): void but AES-GCM is async. Keep",
  "   the public signature. The reviewed approach: keep the synchronous readyState guard at the top of",
  "   send() (a test pins that it throws synchronously before the channel is open), then route only the",
  "   async encrypt+send through an internal promise chain so ordering is preserved and no unhandled",
  "   rejection escapes. TWO CONSEQUENCES YOU MUST HANDLE: (a) failures become asynchronous, so the",
  "   existing try/catch around send() in useSession.ts can no longer report them — add an explicit",
  "   send-error callback rather than dropping failures silently; (b) decodeFrame becomes async, so",
  "   inbound handling must be serialised the same way, or a slow decrypt will REORDER frames.",
  "5. AUTH-TAG FAILURES (§17). A frame that fails decryption is dropped SILENTLY — never crash, never",
  "   expose partial plaintext, and in development only, note it without logging the payload.",
  "6. phrase-confirm + BOTH-SIDES GATING (§8 Phase 2, §10). Widen the frame payload to a small",
  "   discriminated union covering what Phase 2 needs: the existing hello frame, phrase-confirm, and",
  "   session-end. Keep it minimal — PLAN.md §16 puts the full protocol.ts WireMessage set and msgpack",
  "   serialisation in Phase 3, and your union should be shaped so Phase 3 can replace it wholesale.",
  "   When the user taps Confirmed, send phrase-confirm and set the local phraseConfirmed flag. When the",
  "   peer's phrase-confirm arrives, set peerConfirmed. The session advances to phase 'active' ONLY when",
  "   both are true. Until then the overlay stays up and no item traffic flows.",
  "7. PHASE GATING (§8). Wire the store's phase through: connecting → pairing (overlay up, awaiting both",
  "   confirms) → active. Render SafetyPhraseOverlay from Session.tsx during 'pairing' with the props in",
  "   the contract below. Abort must tear the session down cleanly.",
  "",
  "SECURITY INVARIANTS — a reviewer will check each of these:",
  "  - No plaintext application frame ever reaches the DataChannel.",
  "  - Key material, the shared secret, and the derived phrase are never logged and never written to",
  "    IndexedDB, Cache API or localStorage (AGENTS.md). Memory only.",
  "  - The session key and the phrase come from separate HKDF info strings; never reuse one for the other.",
  "  - A decrypt failure drops the frame and does not throw out of a callback.",
  "  - No third-party crypto library; Web Crypto only.",
  OVERLAY_CONTRACT,
  "",
  "TESTS: node has crypto.subtle, so write a REAL two-party test — generate two keypairs, run the full",
  "exchange in both directions through the actual hook/transport code paths (inject the fake WebSocket",
  "and fake RTCPeerConnection the Phase 1 tests already use), and assert both sides derive the same",
  "three words and can exchange an encrypted frame. Also cover: a frame encrypted under the wrong key is",
  "dropped silently; send() before the channel opens still throws synchronously; send() preserves order",
  "under the async queue; the session does not reach 'active' until both confirms land; and abort tears",
  "down cleanly.",
  "",
  "VERIFY before finishing — all three must pass:",
  "  pnpm -r typecheck",
  "  pnpm -r test",
  "  pnpm -r build"
].join("\n");

const wave1 = await Promise.all([
  runOpts("p2-lane-a-crypto", { label: "Build crypto core (ECDH/HKDF/AES-GCM)", agent: "worker", context: "fresh", task: LANE_CRYPTO }),
  runOpts("p2-lane-c-overlay", { label: "Build safety-phrase overlay + store", agent: "worker", context: "fresh", task: LANE_OVERLAY })
]);

emit("Phase 2 wave 1: crypto=" + String(wave1[0].ok) + " overlay=" + String(wave1[1].ok));

// Wave 2 only makes sense if the crypto lane produced crypto.ts. If it failed, the
// transport lane would have nothing to integrate against, so stop and report rather
// than spawn a lane guaranteed to flail.
if (!wave1[0].ok) {
  return {
    aborted: "crypto lane failed — wave 2 not launched",
    cryptoReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 6000),
    overlayReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4000)
  };
}

const wave2 = await runOpts("p2-lane-b-transport", {
  label: "Wire E2EE into transport + gate session",
  agent: "worker",
  context: "fresh",
  task: LANE_TRANSPORT
});

emit("Phase 2 wave 2: transport=" + String(wave2.ok));

const review = await runOpts("p2-review", {
  label: "Crypto-focused review of Phase 2",
  agent: "reviewer",
  context: "fresh",
  task: [
    "You are a fresh-context reviewer with NO prior conversation. Read the code yourself. You are",
    "READ-ONLY: do not edit, create or delete any file, run no git commands, and start no server.",
    "",
    "TARGET: QRDrop Phase 2 — the E2EE layer (PLAN.md §16 'Phase 2 — E2EE Layer'). Repo root:",
    "/mnt/warehouse/source/QRDrop. The parent has already verified typecheck, tests and build; do not",
    "re-litigate the build. Review CRYPTOGRAPHIC CORRECTNESS and the security invariants.",
    "",
    "READ: AGENTS.md, ORCHESTRATION.md (decisions D1–D4 are binding — verify the code honours them,",
    "especially D3's void send() and D2's pubkey-as-join-cue), and PLAN.md §2, §8, §10, §11, §12, §13,",
    "§17, §19. Then read apps/frontend/src/lib/crypto.ts, safetyPhrase.ts, wordlist.ts, webrtc.ts,",
    "signaling.ts, hooks/useSession.ts, hooks/useWebRTC.ts, pages/Session.tsx,",
    "components/session/SafetyPhraseOverlay.tsx and store/sessionStore.ts.",
    "",
    "THIS IS A CRYPTO REVIEW. Be adversarial and specific:",
    "  P0 — WOULD BREAK THE E2EE GUARANTEE:",
    "   - Is ANY application frame able to reach the DataChannel unencrypted? Trace every path into",
    "     channel.send(). Is there a window before key derivation where plaintext could be sent, or where",
    "     a send is silently dropped/queued and later flushed as plaintext?",
    "   - IV handling: is a fresh random 12-byte IV generated per encrypt? Any IV reuse, counter reuse,",
    "     or deterministic IV? (IV reuse under GCM is catastrophic.)",
    "   - Envelope framing: is [iv(12)][ciphertext+tag] parsed correctly? Off-by-one on the slice?",
    "     Behaviour on envelopes shorter than 12 bytes?",
    "   - Key separation: do the session key and the phrase bytes use DIFFERENT HKDF info strings?",
    "     Is the same shared secret ever used directly as a key without HKDF?",
    "   - HKDF parameters exactly per §11.2: SHA-256, salt = sessionId bytes, 256-bit output.",
    "   - ECDH: P-256, correct import/export (raw SPKI), and does each side use ITS OWN private key with",
    "     the PEER'S public key? A self-ECDH bug would derive a key the peer cannot match.",
    "   - Auth-tag failure: is the DOMException allowed to propagate and the frame dropped silently?",
    "     Any place that catches it and continues with partial or empty plaintext? Any crash path?",
    "   - Key usages/extractability: is the session key non-extractable with only encrypt+decrypt?",
    "   - Is key material, the shared secret, or the derived phrase ever logged, or written to IndexedDB,",
    "     Cache API or localStorage? AGENTS.md forbids the last three absolutely. Grep, do not assume.",
    "  P0 — PAIRING / MITM:",
    "   - Do BOTH peers independently derive the same three words? Is the phrase derived from the shared",
    "     secret (so an active MITM cannot match it), not from the session code alone?",
    "   - Is the session genuinely BLOCKED until both sides confirm? Can item traffic or any other",
    "     application message flow before bothConfirmed()? Check the store gate AND the transport.",
    "   - Can a peer forge or replay a phrase-confirm? Is the confirm itself encrypted and authenticated?",
    "   - Is the public key authenticated at all, or does the code trust whatever arrives on the signaling",
    "     channel? (Trusting it is expected — the safety phrase IS the authentication — but verify the",
    "     overlay cannot be bypassed and that the phrase is actually shown before traffic flows.)",
    "  P1 — CORRECTNESS AND PHASE 3 READINESS:",
    "   - D3: does send() keep its public void signature? Is ordering preserved through the async queue?",
    "     Can an unhandled rejection escape? Are async send FAILURES surfaced, given that the old",
    "     synchronous try/catch can no longer see them?",
    "   - Is inbound decoding serialised, or can a slow decrypt reorder frames?",
    "   - Are D2 (pubkey as the join cue) and D4 (fail fast on a re-joined peer, never re-offer) still",
    "     intact after the key-exchange changes?",
    "   - Is the frame union shaped so Phase 3 can replace it with protocol.ts + msgpack wholesale?",
    "   - Wordlist: exactly 256 unique entries? Any confusable pairs that would defeat a human comparison?",
    "     Does bytesToPhrase handle byte values 0 and 255 in range?",
    "  P1 — SCOPE:",
    "   - Was Phase 3+ work built early (protocol.ts, msgpack, chunker, library/IndexedDB, export)?",
    "     Early implementation is a FINDING, not a bonus.",
    "   - Were §11.4/§11.5 (locked-item and export encryption) implemented early? They belong to Phase 4/7.",
    "   - Any @ts-ignore / @ts-expect-error / 'any' used to silence the strict compiler?",
    "   - Any third-party crypto dependency introduced?",
    "",
    "METHOD: cite file and line for every finding. Verify claims by reading the code, not by trusting",
    "comments — a comment asserting 'fresh IV per message' is not evidence. Where you confirm something is",
    "CORRECT, say so explicitly; a clean bill of health on a specific crypto risk is as valuable as a",
    "finding. Do not pad, and do not invent issues to seem thorough.",
    "",
    "Label findings P0 / P1 / P2. End with EXACTLY one line, verbatim:",
    "'Merge verdict: BLOCK' or 'Merge verdict: OK' or 'Merge verdict: OK with notes'."
  ].join("\n")
});

return {
  cryptoOk: wave1[0].ok ?? null,
  cryptoReport: String(wave1[0].output ?? wave1[0].error ?? "").slice(0, 5000),
  overlayOk: wave1[1].ok ?? null,
  overlayReport: String(wave1[1].output ?? wave1[1].error ?? "").slice(0, 4000),
  transportOk: wave2.ok ?? null,
  transportReport: String(wave2.output ?? wave2.error ?? "").slice(0, 7000),
  reviewOk: review.ok ?? null,
  reviewReport: String(review.output ?? review.error ?? "").slice(0, 14000)
};

// Augments the wrangler-generated Env from worker-configuration.d.ts with the
// secrets and optional vars that are not declared in wrangler.toml [vars].
//
// This file is deliberately named env-extra.d.ts: a .d.ts sharing a basename with a
// .ts file is treated as shadowed build output and silently dropped from the program.
// Do not rename it to env.d.ts.
//
// Declaration merging adds to the generated `interface Env`, which already extends
// the generated __BaseEnv_Env (SESSION_TTL_SECONDS, TURN_TTL_SECONDS, RATE_LIMIT and
// the SESSION Durable Object binding).

interface Env {
  /**
   * Realtime TURN key identifier (wrangler.toml [vars]).
   * Declared optional here because worker-configuration.d.ts was generated before TURN_KEY_ID was declared.
   */
  TURN_KEY_ID?: string
  /** Set with `wrangler secret put TURN_KEY_SECRET`. Absent in local dev. */
  TURN_KEY_SECRET?: string
  /**
   * Comma-separated CORS allowlist for /session/new. Optional: when absent the
   * worker falls back to the Vite dev origin so local development works unconfigured.
   */
  ALLOWED_ORIGINS?: string
}

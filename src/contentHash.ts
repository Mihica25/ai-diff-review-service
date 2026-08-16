import { createHash } from "node:crypto";
import type { ProviderName } from "./providers";

export interface ResolvedOptions {
  provider: ProviderName;
  maxFindings: number;
}

// sha256 of the canonicalized {diff, options} pair, using the *resolved*
// options (defaults/`.catch()` fallbacks already applied). This is what
// caching keys on: byte-identical {diff, options} → cacheHit, independent of
// any Idempotency-Key. Deliberately distinct from computeBodyHash below —
// two requests that resolve to the same effective options (one omitting
// `options` entirely, another sending `options: {}`) should cache-hit each
// other, even though their raw request bodies differ.
export function computeContentHash(diff: string, options: ResolvedOptions): string {
  const canonical = JSON.stringify({
    diff,
    options: { provider: options.provider, maxFindings: options.maxFindings },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// sha256 of the raw request body (for Idempotency-Key's "same key +
// byte-identical body" check), not the resolved options computeContentHash
// above uses — idempotency needs literal request equality, caching needs
// semantic {diff, options} equality, and those differ when `options` is
// omitted vs. sent as `{}`. Hashes JSON.stringify(the parsed body), so two
// requests only count as identical if their JSON keys are also in the same
// order — a documented limitation, not an oversight.
export function computeBodyHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

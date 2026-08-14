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

// sha256 of the raw request body, for Idempotency-Key comparison: "same key
// + byte-identical body". Deliberately hashes the body as received (unknown
// fields, un-resolved options and all), not the validated/defaulted shape
// computeContentHash uses — idempotency is about literal request equality,
// caching is about semantic {diff, options} equality, and those two
// genuinely differ for a request that omits `options` vs. one that sends
// `options: {}` (same resolved effect, different raw body).
//
// Note on "byte-identical": this hashes JSON.stringify(parsed body), not the
// literal wire bytes — Fastify parses the body before this runs, and
// capturing true raw bytes would need extra plugin plumbing. In practice
// this means two requests are only treated as identical if their JSON keys
// are also in the same order (JSON.parse preserves source key order), which
// covers the realistic case (a client retrying literally resends the same
// body) without the added complexity of raw-body capture.
//
// This and computeContentHash are both literally `sha256(JSON.stringify(x))`
// — deliberately left as two named functions rather than one shared
// primitive, since the whole point of the comments here is explaining *why*
// they must stay semantically distinct; collapsing them to one generic
// helper plus two one-line callers would bury that distinction, not clarify it.
export function computeBodyHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

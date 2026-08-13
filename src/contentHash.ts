import { createHash } from "node:crypto";
import type { ProviderName } from "./providers";

export interface ResolvedOptions {
  provider: ProviderName;
  maxFindings: number;
}

// sha256 of the canonicalized {diff, options} pair. The `jobs.content_hash`
// column populated here isn't acted on until Phase 6 (idempotency/caching)
// wires up the actual lookup — computing it now just satisfies the NOT NULL
// column and avoids a schema migration later.
export function computeContentHash(diff: string, options: ResolvedOptions): string {
  const canonical = JSON.stringify({
    diff,
    options: { provider: options.provider, maxFindings: options.maxFindings },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

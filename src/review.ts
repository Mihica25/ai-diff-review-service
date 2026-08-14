import type { Finding } from "./findings";
import { sortAndDedupeFindings } from "./findings";
import { chunkDiff } from "./chunking";
import { runProvider, type ProviderName } from "./providers";

// Chunks the diff (file-boundary-safe, per LIMITS.chunkBytes), runs the
// requested provider over each chunk independently, then merges through the
// same sort+dedup pass used for a single unchunked scan — which is what
// makes chunked results identical to unchunked ones (same findings, same
// order, no dupes, no losses), rather than something asserted and hoped for.
export function runReview(provider: ProviderName, diffText: string): Finding[] {
  const chunks = chunkDiff(diffText);
  const findings = chunks.flatMap((chunk) => runProvider(provider, chunk));
  return sortAndDedupeFindings(findings);
}

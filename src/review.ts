import type { Finding } from "./findings";
import { sortAndDedupeFindings } from "./findings";
import { chunkDiff } from "./chunking";
import { runProvider, type ProviderName, type LlmConfig } from "./providers";

// Chunks the diff, runs the provider per chunk, then merges through the same
// sort+dedup pass a single-chunk scan uses — why chunked and unchunked
// results are identical, not just assumed to be. Chunks run concurrently:
// free for the synchronous mock provider, and keeps a multi-chunk llm diff's
// latency near one call's duration instead of N. One chunk failing fails the
// whole review — no partial results, matching llm's "one attempt" contract.
export async function runReview(provider: ProviderName, diffText: string, llmConfig?: LlmConfig): Promise<Finding[]> {
  const chunks = chunkDiff(diffText);
  const results = await Promise.all(chunks.map((chunk) => runProvider(provider, chunk, llmConfig)));
  return sortAndDedupeFindings(results.flat());
}

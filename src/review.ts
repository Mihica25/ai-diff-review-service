import type { Finding } from "./findings";
import { sortAndDedupeFindings } from "./findings";
import { chunkDiff } from "./chunking";
import { runProvider, type ProviderName, type LlmConfig } from "./providers";

// Chunks the diff (file-boundary-safe, per LIMITS.chunkBytes), runs the
// requested provider over each chunk independently, then merges through the
// same sort+dedup pass used for a single unchunked scan — which is what
// makes chunked results identical to unchunked ones (same findings, same
// order, no dupes, no losses), rather than something asserted and hoped for.
// Chunks run concurrently (Promise.all), not sequentially — for the mock
// provider this is free (it's synchronous), but for the llm provider it
// keeps a multi-chunk diff's total latency close to one model call's
// duration instead of multiplying it by chunk count. If any chunk's call
// fails, the whole review fails — no partial results, matching "one
// attempt, clear failure" for the llm provider.
export async function runReview(provider: ProviderName, diffText: string, llmConfig?: LlmConfig): Promise<Finding[]> {
  const chunks = chunkDiff(diffText);
  const results = await Promise.all(chunks.map((chunk) => runProvider(provider, chunk, llmConfig)));
  return sortAndDedupeFindings(results.flat());
}

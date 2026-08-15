import type { Finding } from "../findings";
import { runMockProvider } from "./mock";
import { runLlmProvider, LlmProviderError, type LlmConfig } from "./llm";

export type ProviderName = "mock" | "llm";
export type { LlmConfig };
export { LlmProviderError };

// diff text -> findings[], dispatched by provider name. `llmConfig` is only
// needed for "llm" — undefined means no credentials are configured on this
// server, which fails the same graceful way an unreachable/erroring model
// does (LlmProviderError), never a crash.
export async function runProvider(
  provider: ProviderName,
  diffText: string,
  llmConfig?: LlmConfig,
): Promise<Finding[]> {
  if (provider === "mock") {
    return runMockProvider(diffText);
  }
  if (!llmConfig) {
    throw new LlmProviderError("LLM provider is not configured on this server");
  }
  return runLlmProvider(diffText, llmConfig);
}

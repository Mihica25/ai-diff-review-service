import type { Finding } from "../findings";
import { runMockProvider } from "./mock";

export type ProviderName = "mock" | "llm";

// A deliberate, safe-to-expose-to-clients failure — distinct from an
// unexpected exception (e.g. a DB error), whose raw message must never be
// echoed back in an API response.
export class ProviderNotImplementedError extends Error {}

// diff text -> findings[], dispatched by provider name. The llm provider
// lands in Phase 8; requesting it today fails the job gracefully (via the
// worker's try/catch) rather than crashing the process.
export function runProvider(provider: ProviderName, diffText: string): Finding[] {
  if (provider === "mock") {
    return runMockProvider(diffText);
  }
  throw new ProviderNotImplementedError("llm provider not yet implemented");
}

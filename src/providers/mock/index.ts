import type { Finding } from "../../findings";
import { sortAndDedupeFindings } from "../../findings";
import { parseDiff } from "./parseDiff";
import { runMockRules } from "./rules";

// diff text -> findings[]. Pure function, no HTTP coupling — safe to unit
// test directly and to reuse per-chunk in Phase 4.
export function runMockProvider(diffText: string): Finding[] {
  const addedLines = parseDiff(diffText);
  const findings = runMockRules(addedLines);
  return sortAndDedupeFindings(findings);
}

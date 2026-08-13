export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "security" | "correctness" | "performance" | "style";

export interface Finding {
  id: string;
  ruleId: string;
  path: string;
  line: number;
  severity: Severity;
  category: Category;
  title: string;
  evidence: string;
}

export function makeFindingId(ruleId: string, path: string, line: number): string {
  return `${ruleId}:${path}:${line}`;
}

// Ordering everywhere (results and streams): path (lexicographic) -> line
// (ascending) -> ruleId. Dedup by `id`. Shared here because Phase 4 chunking
// must apply this exact same pass to merged chunk results.
export function sortAndDedupeFindings(findings: Finding[]): Finding[] {
  const byId = new Map<string, Finding>();
  for (const finding of findings) {
    if (!byId.has(finding.id)) {
      byId.set(finding.id, finding);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return 0;
  });
}

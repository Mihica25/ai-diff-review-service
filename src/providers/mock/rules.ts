import type { Category, Finding, Severity } from "../../findings";
import { makeFindingId } from "../../findings";
import type { AddedLine } from "./parseDiff";

export interface RuleDef {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  // `lines` is the full added-line list for one file, in order; `index` is
  // the line currently being tested. Most rules only look at `content`, but
  // MOCK-004 needs to look ahead across subsequent added lines.
  matches(lines: AddedLine[], index: number): boolean;
}

const CREDENTIAL_RE = /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i;
const SQL_KEYWORD_RE = /\b(SELECT|INSERT|UPDATE|DELETE)\b/;
const LOOSE_NULL_RE = /(?<![=!])(==|!=)(?!=)\s*null\b/;
const INJECTION_RE = /ignore previous instructions|disregard all prior|you are now/i;

function matchesSqlConcatenation(content: string): boolean {
  const stringRe = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = stringRe.exec(content)) !== null) {
    const inner = match[2] ?? "";
    if (!SQL_KEYWORD_RE.test(inner)) {
      continue;
    }
    const start = match.index;
    const end = start + match[0].length;
    const before = content.slice(0, start).trimEnd();
    const after = content.slice(end).trimStart();
    if (before.endsWith("+") || after.startsWith("+")) {
      return true;
    }
  }
  return false;
}

const CATCH_HEADER_RE = /catch\s*\([^)]*\)/;

// Empty catch block, possibly spanning multiple added lines. Only considers
// braces found among added lines (rules apply to added lines only); if the
// closing brace isn't itself an added line, this won't flag it. Scanning
// starts right after "catch(...)" on the first line — not from the start of
// that line's content — so a preceding `try { ... }` on the same line (e.g.
// "try { risky(); } catch (e) {}") doesn't get mistaken for the catch body.
// The lookahead stops at a hunk boundary (not just a file boundary): two
// unrelated hunks in the same file could otherwise let a stray '}' added far
// below "close" a catch block whose real body was never touched by the diff.
function isEmptyCatchAt(lines: AddedLine[], startIndex: number): boolean {
  const path = lines[startIndex]?.path;
  const hunk = lines[startIndex]?.hunk;
  const firstContent = lines[startIndex]?.content ?? "";
  const catchHeader = CATCH_HEADER_RE.exec(firstContent);
  if (!catchHeader) {
    return false;
  }
  const startOffset = catchHeader.index + catchHeader[0].length;

  let depth = 0;
  let seenOpen = false;
  let body = "";

  for (let j = startIndex; j < lines.length && j - startIndex <= 50; j++) {
    const entry = lines[j];
    if (!entry || entry.path !== path || entry.hunk !== hunk) {
      break;
    }
    const text = j === startIndex ? entry.content.slice(startOffset) : entry.content;
    for (const ch of text) {
      if (ch === "{") {
        depth++;
        seenOpen = true;
        continue;
      }
      if (ch === "}") {
        depth--;
        if (seenOpen && depth === 0) {
          return body.trim().length === 0;
        }
        continue;
      }
      if (seenOpen) {
        body += ch;
      }
    }
    if (seenOpen) {
      body += "\n";
    }
  }
  return false;
}

export const MOCK_RULES: RuleDef[] = [
  {
    id: "MOCK-001",
    severity: "critical",
    category: "security",
    title: "eval usage",
    matches: (lines, i) => (lines[i]?.content ?? "").includes("eval("),
  },
  {
    id: "MOCK-002",
    severity: "critical",
    category: "security",
    title: "hardcoded credential",
    matches: (lines, i) => CREDENTIAL_RE.test(lines[i]?.content ?? ""),
  },
  {
    id: "MOCK-003",
    severity: "high",
    category: "security",
    title: "SQL string concatenation",
    matches: (lines, i) => matchesSqlConcatenation(lines[i]?.content ?? ""),
  },
  {
    id: "MOCK-004",
    severity: "high",
    category: "correctness",
    title: "swallowed exception",
    matches: (lines, i) => /\bcatch\s*\(/.test(lines[i]?.content ?? "") && isEmptyCatchAt(lines, i),
  },
  {
    id: "MOCK-005",
    severity: "medium",
    category: "correctness",
    title: "loose null comparison",
    matches: (lines, i) => LOOSE_NULL_RE.test(lines[i]?.content ?? ""),
  },
  {
    id: "MOCK-006",
    severity: "medium",
    category: "performance",
    title: "deep-clone via JSON",
    matches: (lines, i) => (lines[i]?.content ?? "").includes("JSON.parse(JSON.stringify("),
  },
  {
    id: "MOCK-007",
    severity: "low",
    category: "style",
    title: "console.log left in",
    matches: (lines, i) => (lines[i]?.content ?? "").includes("console.log("),
  },
  {
    id: "MOCK-008",
    severity: "low",
    category: "style",
    title: "unresolved marker",
    matches: (lines, i) => {
      const content = lines[i]?.content ?? "";
      return content.includes("TODO") || content.includes("FIXME");
    },
  },
  {
    id: "MOCK-INJ",
    severity: "critical",
    category: "security",
    title: "prompt-injection content",
    matches: (lines, i) => INJECTION_RE.test(lines[i]?.content ?? ""),
  },
];

export function runMockRules(addedLines: AddedLine[]): Finding[] {
  const findings: Finding[] = [];

  for (let i = 0; i < addedLines.length; i++) {
    const line = addedLines[i];
    if (!line) continue;

    for (const rule of MOCK_RULES) {
      if (rule.matches(addedLines, i)) {
        findings.push({
          id: makeFindingId(rule.id, line.path, line.line),
          ruleId: rule.id,
          path: line.path,
          line: line.line,
          severity: rule.severity,
          category: rule.category,
          title: rule.title,
          evidence: line.content,
        });
      }
    }
  }

  return findings;
}

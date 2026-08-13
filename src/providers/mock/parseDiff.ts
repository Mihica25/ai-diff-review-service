export interface AddedLine {
  path: string;
  line: number; // line number in the new file
  content: string; // the line content, verbatim, without the leading '+'
  hunk: number; // monotonically increasing id, unique per hunk across the whole diff
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// TODO(reuse): hand-duplicated from HUNK_HEADER above rather than derived
// from it (e.g. `new RegExp(HUNK_HEADER.source, "m")`) — the two patterns
// have to be kept in sync by hand if hunk-header tolerance ever changes.
// Also low-confidence but worth a look: this only checks that a hunk-header
// shaped substring exists anywhere in the body, not that it's structurally a
// real hunk header (e.g. decoy text containing that exact shape would pass
// this gate and then produce zero findings from the real parser).
const HUNK_HEADER_ANYWHERE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

// A cheap "is this even a unified diff" check for request validation — a
// diff with no hunk header at all can never produce any added lines, so it's
// invalid per the contract ("not parseable as a unified diff" -> 422).
export function looksLikeUnifiedDiff(diffText: string): boolean {
  return HUNK_HEADER_ANYWHERE.test(diffText);
}

function extractPath(headerValue: string): string | null {
  const withoutTimestamp = (headerValue.split("\t")[0] ?? "").trim();
  if (withoutTimestamp === "" || withoutTimestamp === "/dev/null") {
    return null;
  }
  // Strip a single leading "a/" or "b/" style prefix used by git-style diffs.
  return withoutTimestamp.replace(/^[ab]\//, "");
}

// Parses a unified diff and extracts every added ('+') line, excluding the
// '+++' file header, with its computed new-file line number. Pure function,
// no HTTP/framework coupling — this is reused verbatim by the chunker.
//
// Each hunk body is bounded by the line counts declared in its own
// "@@ -old,oldCount +new,newCount @@" header, rather than by sniffing the
// prefix of subsequent lines. That matters because an added line whose own
// content starts with "++ " becomes the raw diff line "+++ ..." once the
// '+' marker is prepended — indistinguishable by prefix alone from a real
// "+++" file-header line. Bounding by declared count means we never need to
// guess while inside a hunk body: we simply know when it ends.
export function parseDiff(diffText: string): AddedLine[] {
  const rawLines = diffText.split("\n");
  const lines = rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;

  const added: AddedLine[] = [];
  let currentPath: string | null = null;
  let newLineNum = 0;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunkId = -1;

  for (const line of lines) {
    if (!inHunk && line.startsWith("+++ ")) {
      currentPath = extractPath(line.slice(4));
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      continue;
    }
    if (!inHunk && line.startsWith("@@")) {
      const match = HUNK_HEADER.exec(line);
      if (match?.[2]) {
        newLineNum = parseInt(match[2], 10);
        oldRemaining = match[1] !== undefined ? parseInt(match[1], 10) : 1;
        newRemaining = match[3] !== undefined ? parseInt(match[3], 10) : 1;
        inHunk = true;
        hunkId++;
      }
      continue;
    }
    if (!inHunk) {
      continue; // "diff --git", "index ...", etc.
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — not a real line, doesn't move counters.
      continue;
    }
    if (line.startsWith("+")) {
      if (currentPath !== null) {
        added.push({ path: currentPath, line: newLineNum, content: line.slice(1), hunk: hunkId });
      }
      newLineNum++;
      newRemaining--;
    } else if (line.startsWith("-")) {
      oldRemaining--;
    } else {
      // Context line (starts with a space, or is malformed/blank).
      newLineNum++;
      oldRemaining--;
      newRemaining--;
    }

    if (oldRemaining <= 0 && newRemaining <= 0) {
      // Hunk body fully consumed per its own declared counts. The next line
      // is either a new "@@" (another hunk in this file) or a new file's
      // "--- "/"+++ " header pair — both now eligible to be recognized again.
      inHunk = false;
    }
  }

  return added;
}

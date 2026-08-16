export interface AddedLine {
  path: string;
  line: number; // line number in the new file
  content: string; // the line content, verbatim, without the leading '+'
  hunk: number; // monotonically increasing id, unique per hunk across the whole diff
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface HunkHeader {
  newStart: number;
  oldCount: number;
  newCount: number;
}

// Parses a "@@ -old,oldCount +new,newCount @@" line. Exported so chunking.ts
// can do its own hunk-bounded scan using the exact same grammar as this
// file's own parser, rather than a second, separately maintained copy.
export function parseHunkHeader(line: string): HunkHeader | null {
  const match = HUNK_HEADER.exec(line);
  if (!match?.[2]) {
    return null;
  }
  return {
    newStart: parseInt(match[2], 10),
    oldCount: match[1] !== undefined ? parseInt(match[1], 10) : 1,
    newCount: match[3] !== undefined ? parseInt(match[3], 10) : 1,
  };
}

export type HunkLineKind = "no-newline-marker" | "added" | "removed" | "context";

// Classifies one line inside a hunk body. Shared by this file's own walk and
// chunking.ts's hunk-bounded boundary scan, so a future change to what
// counts as added/removed/context/no-newline can't drift between the two —
// previously each file had its own copy of this same if/else chain, and a
// second copy is exactly what let the chunker's boundary detection and this
// file's parsing fall out of sync once already (see chunking.ts's docstring).
export function classifyHunkLine(line: string): HunkLineKind {
  if (line.startsWith("\\")) return "no-newline-marker";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

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
  // Git-style diffs prefix every path with "a/" (old) or "b/" (new) to keep
  // them visually distinct from real repo-relative paths — strip it to
  // recover the actual path.
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
      const hunk = parseHunkHeader(line);
      if (hunk) {
        newLineNum = hunk.newStart;
        oldRemaining = hunk.oldCount;
        newRemaining = hunk.newCount;
        inHunk = true;
        hunkId++;
      }
      continue;
    }
    if (!inHunk) {
      continue; // "diff --git", "index ...", etc.
    }

    const kind = classifyHunkLine(line);
    if (kind === "no-newline-marker") {
      continue;
    }
    if (kind === "added") {
      if (currentPath !== null) {
        added.push({ path: currentPath, line: newLineNum, content: line.slice(1), hunk: hunkId });
      }
      newLineNum++;
      newRemaining--;
    } else if (kind === "removed") {
      oldRemaining--;
    } else {
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

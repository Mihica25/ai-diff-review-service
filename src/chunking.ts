import { LIMITS } from "./limits";
import { parseHunkHeader } from "./providers/mock/parseDiff";

// A "file section" is one file's complete diff: its header (git metadata
// and/or the --- / +++ pair) through the end of its last hunk.
//
// Boundary lines ("diff --git ..." or "--- ...") are only ever recognized
// OUTSIDE a hunk body, bounded by each hunk's own declared old/new line
// counts — never by sniffing what a line starts with while inside one. That
// matters because a *removed* line whose own content starts with "-- " (a
// Lua/SQL/Haskell-style comment, say) becomes the raw diff line "--- ..."
// once the '-' marker is prepended — indistinguishable by prefix alone from
// a real "--- " file-header line. An earlier version of this function did
// exactly that naive prefix check unconditionally and silently truncated
// the file's diff at that point, losing every added line (and finding)
// after it — the same class of bug parseDiff.ts already had to fix once.
function splitIntoFileSections(diffText: string): string[] {
  const rawLines = diffText.split("\n");
  const lines = rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;

  const sections: string[][] = [];
  let current: string[] = [];
  // True in the brief window right after a "diff --git " line, until its own
  // "--- " pair is consumed — decided fresh per section, not once for the
  // whole document. A single document-wide choice (git-style vs. plain)
  // would misdetect a boundary for a diff that mixes both styles: a
  // plain-format file (no "diff --git ") immediately after a git-style one
  // would never be recognized as starting a new section, silently merging
  // it into the previous file's chunk.
  let pendingGitHeader = false;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of lines) {
    if (!inHunk) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        inHunk = true;
        oldRemaining = hunk.oldCount;
        newRemaining = hunk.newCount;
        current.push(line);
        continue;
      }
      if (line.startsWith("diff --git ")) {
        if (current.length > 0) {
          sections.push(current);
        }
        current = [line];
        pendingGitHeader = true;
        continue;
      }
      if (line.startsWith("--- ")) {
        if (pendingGitHeader) {
          // This "--- " is the header pair belonging to the "diff --git "
          // line just seen for this same section — not a new boundary.
          pendingGitHeader = false;
        } else if (current.length > 0) {
          // A "--- " with no preceding "diff --git " for this section: a
          // real boundary, whether the whole document is plain-style or
          // this is simply the next file after a git-style one.
          sections.push(current);
          current = [];
        }
      }
      current.push(line);
      continue;
    }

    // Inside a hunk body: this line is counted against the hunk's declared
    // totals, never treated as a boundary, regardless of its content.
    // TODO(reuse): this +/-/context counting loop is the same logic
    // parseDiff.ts's own hunk walk uses, duplicated rather than shared (only
    // parseHunkHeader itself was factored out) — a future change to how one
    // of them classifies an edge-case line could silently reintroduce the
    // exact class of chunking/parsing mismatch this file's docstring
    // describes already having been fixed once.
    current.push(line);
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — doesn't count against either side.
    } else if (line.startsWith("+")) {
      newRemaining--;
    } else if (line.startsWith("-")) {
      oldRemaining--;
    } else {
      oldRemaining--;
      newRemaining--;
    }

    if (oldRemaining <= 0 && newRemaining <= 0) {
      inHunk = false;
    }
  }
  if (current.length > 0) {
    sections.push(current);
  }

  return sections.map((section) => section.join("\n"));
}

// Splits a diff into chunks of at most `maxChunkBytes`, only on file
// boundaries: one file's section never spans two chunks, and a single
// file's section larger than the limit becomes its own (oversized) chunk.
// A diff that fits within one chunk returns a single-element array — chunk
// count isn't special-cased, it falls out of the packing loop naturally.
export function chunkDiff(diffText: string, maxChunkBytes: number = LIMITS.chunkBytes): string[] {
  const sections = splitIntoFileSections(diffText);
  if (sections.length === 0) {
    return [diffText];
  }

  const chunks: string[] = [];
  let current: string[] = [];

  // TODO(efficiency): re-joins and re-measures the whole `current` array on
  // every section rather than tracking a running byte total, making packing
  // O(n) per section (up to O(n^2) for a chunk built from many small files).
  const currentSizeBytes = (): number => Buffer.byteLength(current.join("\n"), "utf8");

  for (const section of sections) {
    const sectionBytes = Buffer.byteLength(section, "utf8");

    if (sectionBytes > maxChunkBytes) {
      if (current.length > 0) {
        chunks.push(current.join("\n"));
        current = [];
      }
      chunks.push(section);
      continue;
    }

    if (current.length > 0 && currentSizeBytes() + 1 + sectionBytes > maxChunkBytes) {
      chunks.push(current.join("\n"));
      current = [];
    }

    current.push(section);
  }

  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  return chunks;
}

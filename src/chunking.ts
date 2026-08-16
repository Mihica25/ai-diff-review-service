import { LIMITS } from "./limits";
import { parseHunkHeader, classifyHunkLine } from "./providers/mock/parseDiff";

// A "file section" is one file's complete diff: its header (git metadata
// and/or the --- / +++ pair) through the end of its last hunk.
//
// Boundary lines ("diff --git ..." or "--- ...") are only ever recognized
// OUTSIDE a hunk body, bounded by each hunk's own declared old/new line
// counts — never by sniffing what a line starts with while inside one. That
// matters because a *removed* line whose own content starts with "-- " (a
// Lua/SQL/Haskell-style comment, say) becomes the raw diff line "--- ..."
// once the '-' marker is prepended — indistinguishable by prefix alone from
// a real "--- " file-header line.
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
    // classifyHunkLine is shared with parseDiff.ts's own hunk walk (see its
    // definition) so the two can't drift apart on what counts as
    // added/removed/context/no-newline.
    current.push(line);
    const kind = classifyHunkLine(line);
    if (kind === "added") {
      newRemaining--;
    } else if (kind === "removed") {
      oldRemaining--;
    } else if (kind === "context") {
      oldRemaining--;
      newRemaining--;
    }
    // "no-newline-marker" is deliberately excluded here — it's an EOF
    // marker, not a real content line, so it never counts against either
    // side's remaining total.

    if (oldRemaining <= 0 && newRemaining <= 0) {
      inHunk = false;
    }
  }
  if (current.length > 0) {
    sections.push(current);
  }

  return sections.map((section) => section.join("\n"));
}

// The packing decision shared by chunkDiff and countChunks: greedily group
// sections into a chunk until the next one would overflow maxChunkBytes,
// with an oversized single section becoming its own chunk immediately.
// Yields section *indices* rather than joined strings, so a count-only
// caller (countChunks) never has to build any chunk content — and the
// running byte total is tracked incrementally rather than by re-joining and
// re-measuring `current` on every section.
function* packSections(sections: string[], maxChunkBytes: number): Generator<number[]> {
  let current: number[] = [];
  let currentBytes = 0;

  for (let i = 0; i < sections.length; i++) {
    const sectionBytes = Buffer.byteLength(sections[i]!, "utf8");

    if (sectionBytes > maxChunkBytes) {
      if (current.length > 0) {
        yield current;
        current = [];
        currentBytes = 0;
      }
      yield [i];
      continue;
    }

    if (current.length > 0 && currentBytes + 1 + sectionBytes > maxChunkBytes) {
      yield current;
      current = [];
      currentBytes = 0;
    }

    current.push(i);
    currentBytes += current.length === 1 ? sectionBytes : 1 + sectionBytes;
  }

  if (current.length > 0) {
    yield current;
  }
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
  for (const indices of packSections(sections, maxChunkBytes)) {
    chunks.push(indices.map((i) => sections[i]).join("\n"));
  }
  return chunks;
}

// Same chunk boundaries as chunkDiff, but only the count — no chunk content
// is ever built. POST /v1/reviews needs usage.chunks at submission time,
// before the worker ever runs runReview() (which calls chunkDiff() itself
// for the real content).
export function countChunks(diffText: string, maxChunkBytes: number = LIMITS.chunkBytes): number {
  const sections = splitIntoFileSections(diffText);
  if (sections.length === 0) {
    return 1;
  }

  return [...packSections(sections, maxChunkBytes)].length;
}

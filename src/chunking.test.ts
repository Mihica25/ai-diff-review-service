import { chunkDiff } from "./chunking";

// Each added line is padded to a fixed ~100 bytes so total size is a
// predictable, reliable function of line count — short lines like "+x0"
// undercounted badly enough in an earlier version of this file that a
// "several thousand short lines" file came in well under 64 KiB by accident.
function fileDiff(path: string, addedLineCount: number): string {
  const lines = Array.from(
    { length: addedLineCount },
    (_, i) => `+const paddedLine${i} = "${"x".repeat(80)}"; // filler`,
  );
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${addedLineCount} @@`,
    ...lines,
    "",
  ].join("\n");
}

describe("chunkDiff", () => {
  it("returns a single chunk for a diff well under the limit", () => {
    const diff = fileDiff("a.ts", 5);
    const chunks = chunkDiff(diff, 65_536);
    expect(chunks).toHaveLength(1);
  });

  it("never splits a single file's section across two chunks", () => {
    // Two files, each individually small, but together over the limit.
    const a = fileDiff("a.ts", 50);
    const b = fileDiff("b.ts", 50);
    const combined = a + b;
    const maxChunkBytes = Buffer.byteLength(a, "utf8") + 10; // fits `a` alone, not both

    const chunks = chunkDiff(combined, maxChunkBytes);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("a.ts");
    expect(chunks[0]).not.toContain("b.ts");
    expect(chunks[1]).toContain("b.ts");
    expect(chunks[1]).not.toContain("a.ts");
  });

  it("packs several small files into one chunk when they fit together", () => {
    const a = fileDiff("a.ts", 2);
    const b = fileDiff("b.ts", 2);
    const c = fileDiff("c.ts", 2);
    const combined = a + b + c;

    const chunks = chunkDiff(combined, 65_536);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("a.ts");
    expect(chunks[0]).toContain("b.ts");
    expect(chunks[0]).toContain("c.ts");
  });

  it("gives an oversized single file its own chunk, larger than the limit", () => {
    const huge = fileDiff("huge.ts", 700); // ~80 KB, over the 64 KiB limit
    const small = fileDiff("small.ts", 2);
    const combined = huge + small;

    const chunks = chunkDiff(combined, 65_536);

    expect(chunks).toHaveLength(2);
    const hugeChunk = chunks.find((c) => c.includes("huge.ts"));
    expect(hugeChunk).toBeDefined();
    expect(Buffer.byteLength(hugeChunk!, "utf8")).toBeGreaterThan(65_536);
    expect(chunks.find((c) => c.includes("small.ts"))).toBeDefined();
  });

  it("does not merge an oversized file's chunk with adjacent small files", () => {
    const small1 = fileDiff("a.ts", 2);
    const huge = fileDiff("huge.ts", 700);
    const small2 = fileDiff("b.ts", 2);
    const combined = small1 + huge + small2;

    const chunks = chunkDiff(combined, 65_536);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain("a.ts");
    expect(chunks[1]).toContain("huge.ts");
    expect(chunks[2]).toContain("b.ts");
  });

  it("keeps every chunk (except an oversized single-file one) at or under the limit", () => {
    const files = Array.from({ length: 20 }, (_, i) => fileDiff(`file${i}.ts`, 10));
    const combined = files.join("");
    const maxChunkBytes = 2000;

    const chunks = chunkDiff(combined, maxChunkBytes);

    for (const chunk of chunks) {
      const bytes = Buffer.byteLength(chunk, "utf8");
      // Every chunk here is small files packed together, none individually
      // oversized, so all must respect the limit.
      expect(bytes).toBeLessThanOrEqual(maxChunkBytes);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("works on plain unified diffs with no 'diff --git' header", () => {
    const plain = ["--- a/a.ts", "+++ b/a.ts", "@@ -0,0 +1,1 @@", "+x", ""].join("\n");
    const chunks = chunkDiff(plain, 65_536);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("a.ts");
  });

  it("does not mistake a removed line's content for a '---' file-header mid-hunk", () => {
    // The underlying removed line's own content is "-- old comment" (two
    // dashes) — once prefixed with the diff's own '-' marker, the raw diff
    // line becomes "--- old comment" (three dashes), syntactically
    // identical to a real "--- " file-header line.
    const diff = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "--- old comment",
      "+real added line",
      " context",
      "",
    ].join("\n");

    const chunks = chunkDiff(diff, 65_536);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("real added line");
    expect(chunks[0]).toContain("context");
  });

  it("splits correctly on a diff that mixes git-style and plain file sections", () => {
    // File a.ts has a full "diff --git" header; file b.ts is a bare plain
    // unified-diff fragment with no "diff --git" line at all — a single
    // global choice of boundary style would never recognize b.ts's "--- "
    // as a boundary, silently merging it into a.ts's section.
    const gitStyle = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -0,0 +1,1 @@", "+a", ""].join(
      "\n",
    );
    const plainStyle = ["--- a/b.ts", "+++ b/b.ts", "@@ -0,0 +1,1 @@", "+b", ""].join("\n");
    const combined = gitStyle + plainStyle;

    const chunks = chunkDiff(combined, 65_536);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("a.ts");
    expect(chunks[0]).toContain("b.ts");

    // With a limit that fits only the first file, they must split into two.
    const split = chunkDiff(combined, Buffer.byteLength(gitStyle, "utf8") + 5);
    expect(split).toHaveLength(2);
    expect(split[0]).toContain("a.ts");
    expect(split[0]).not.toContain("b.ts");
    expect(split[1]).toContain("b.ts");
    expect(split[1]).not.toContain("a.ts");
  });

  it("keeps a single file near the 1 MiB payload ceiling as exactly one chunk", () => {
    // Not just "over 64 KiB" (already covered above) — specifically near the
    // *payload* limit, the largest a single file's diff could realistically
    // ever be. Confirms the packing loop doesn't do anything surprising
    // (e.g. attempt to further split, or miscount) at that extreme.
    const diff = fileDiff("onehugefile.ts", 8300); // ~945 KB
    const bytes = Buffer.byteLength(diff, "utf8");
    expect(bytes).toBeGreaterThan(900_000);
    expect(bytes).toBeLessThan(1_048_576);

    const chunks = chunkDiff(diff, 65_536);

    expect(chunks).toHaveLength(1);
    // A trailing newline can be dropped in the split/rejoin round trip (same
    // harmless normalization parseDiff.ts already does) — content, not the
    // exact byte count, is what matters here.
    expect(Buffer.byteLength(chunks[0]!, "utf8")).toBeGreaterThan(900_000);
    expect(chunks[0]).toContain("onehugefile.ts");
  });
});

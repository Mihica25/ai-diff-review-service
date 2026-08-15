import { runReview } from "./review";
import { runMockProvider } from "./providers/mock";
import { chunkDiff } from "./chunking";

function makeFile(index: number): string {
  const path = `src/file${index}.ts`;
  const lines: string[] = [];
  lines.push(`+console.log("file ${index}");`); // MOCK-007, every file
  if (index % 2 === 0) lines.push(`+// TODO: revisit file ${index}`); // MOCK-008
  if (index % 3 === 0) lines.push(`+if (x == null) { return; }`); // MOCK-005
  if (index % 5 === 0) lines.push(`+eval("2+2");`); // MOCK-001
  if (index % 7 === 0) lines.push(`+  } catch (e) {`, `+  }`); // MOCK-004, spans lines
  // Padding so many files together comfortably exceed 64 KiB.
  for (let i = 0; i < 60; i++) {
    lines.push(`+  const padding${index}_${i} = ${i}; // filler`);
  }
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines,
    "",
  ].join("\n");
}

describe("runReview vs unchunked mock scan", () => {
  it("produces identical findings for a diff over 64 KiB split into multiple chunks", async () => {
    const bigDiff = Array.from({ length: 40 }, (_, i) => makeFile(i)).join("");
    expect(Buffer.byteLength(bigDiff, "utf8")).toBeGreaterThan(65_536);
    expect(chunkDiff(bigDiff).length).toBeGreaterThan(1);

    const chunked = await runReview("mock", bigDiff);
    const unchunked = runMockProvider(bigDiff);

    expect(chunked).toEqual(unchunked);
    expect(chunked.length).toBeGreaterThan(0);
    // Ordering (path -> line -> ruleId) must survive the chunk/merge round trip.
    const sorted = [...chunked].sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.line !== b.line) return a.line - b.line;
      return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
    });
    expect(chunked).toEqual(sorted);
  });

  it("produces identical findings when a single file's own diff exceeds 64 KiB", async () => {
    // One oversized file (its own chunk) plus ordinary files around it.
    const hugeLines = Array.from(
      { length: 700 },
      (_, i) => `+const v${i} = "${"x".repeat(80)}"; // filler`,
    );
    hugeLines.push('+console.log("in the huge file");');
    const huge = [
      "diff --git a/huge.ts b/huge.ts",
      "--- a/huge.ts",
      "+++ b/huge.ts",
      `@@ -0,0 +1,${hugeLines.length} @@`,
      ...hugeLines,
      "",
    ].join("\n");
    expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(65_536);

    const bigDiff = makeFile(0) + huge + makeFile(1);
    const chunks = chunkDiff(bigDiff);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => Buffer.byteLength(c, "utf8") > 65_536)).toBe(true);

    const chunked = await runReview("mock", bigDiff);
    const unchunked = runMockProvider(bigDiff);
    expect(chunked).toEqual(unchunked);
  });

  it("matches unchunked for a small diff too (single chunk, trivial case)", async () => {
    const diff = makeFile(0);
    expect(await runReview("mock", diff)).toEqual(runMockProvider(diff));
  });
});

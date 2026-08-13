import { parseDiff } from "./parseDiff";

describe("parseDiff", () => {
  it("computes new-file line numbers across context/added/removed lines", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc123..def456 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+line2 changed",
      "+new line",
      " line3",
      "",
    ].join("\n");

    expect(parseDiff(diff)).toEqual([
      { path: "src/foo.ts", line: 2, content: "line2 changed", hunk: 0 },
      { path: "src/foo.ts", line: 3, content: "new line", hunk: 0 },
    ]);
  });

  it("handles multiple hunks in one file, resetting the line counter per hunk", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old1",
      "+new1",
      " ctx1",
      "@@ -10,2 +10,3 @@",
      " ctx10",
      "+added10",
      " ctx11",
      "",
    ].join("\n");

    const result = parseDiff(diff);
    expect(result).toEqual([
      { path: "a.ts", line: 1, content: "new1", hunk: expect.any(Number) },
      { path: "a.ts", line: 11, content: "added10", hunk: expect.any(Number) },
    ]);
    // The two lines must be attributed to different hunks.
    expect(result[0]?.hunk).not.toBe(result[1]?.hunk);
  });

  it("handles multiple files in one diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new-a",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new-b",
      "",
    ].join("\n");

    expect(parseDiff(diff)).toEqual([
      { path: "a.ts", line: 1, content: "new-a", hunk: 0 },
      { path: "b.ts", line: 1, content: "new-b", hunk: 1 },
    ]);
  });

  it("records new-file creation with all lines added starting at line 1", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "index 0000000..abc123",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
      "",
    ].join("\n");

    expect(parseDiff(diff)).toEqual([
      { path: "new.ts", line: 1, content: "line1", hunk: 0 },
      { path: "new.ts", line: 2, content: "line2", hunk: 0 },
    ]);
  });

  it("records no added lines for a pure file deletion", () => {
    const diff = [
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "index abc123..0000000",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line1",
      "-line2",
      "",
    ].join("\n");

    expect(parseDiff(diff)).toEqual([]);
  });

  it("ignores '\\ No newline at end of file' markers without shifting line numbers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    expect(parseDiff(diff)).toEqual([{ path: "a.ts", line: 1, content: "new", hunk: 0 }]);
  });

  it("returns an empty array for a context-only (no-op) diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      " line1",
      " line2",
      "",
    ].join("\n");

    expect(parseDiff(diff)).toEqual([]);
  });

  it("never treats the '+++' file header line itself as an added line", () => {
    const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,0 +1,1 @@", "+real added line", ""].join("\n");

    const result = parseDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("real added line");
  });

  it("does not mistake an added line's content for a '+++' header mid-hunk", () => {
    // The underlying file's added line content is literally "++ oops" — once
    // prefixed with the diff's own '+' marker, the raw line becomes
    // "+++ oops", syntactically identical to a real file-header line.
    const diff = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,4 @@",
      " line1",
      "+++ oops",
      "+real line",
      " line2",
      "",
    ].join("\n");

    const result = parseDiff(diff);
    expect(result.map((l) => l.content)).toEqual(["++ oops", "real line"]);
    expect(result.every((l) => l.path === "a.ts")).toBe(true);
  });
});

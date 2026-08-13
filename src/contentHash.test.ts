import { computeContentHash } from "./contentHash";

describe("computeContentHash", () => {
  it("is deterministic for identical diff + options", () => {
    const a = computeContentHash("diff-text", { provider: "mock", maxFindings: 100 });
    const b = computeContentHash("diff-text", { provider: "mock", maxFindings: 100 });
    expect(a).toBe(b);
  });

  it("differs when the diff text differs", () => {
    const a = computeContentHash("diff-a", { provider: "mock", maxFindings: 100 });
    const b = computeContentHash("diff-b", { provider: "mock", maxFindings: 100 });
    expect(a).not.toBe(b);
  });

  it("differs when options differ", () => {
    const a = computeContentHash("diff-text", { provider: "mock", maxFindings: 100 });
    const b = computeContentHash("diff-text", { provider: "mock", maxFindings: 50 });
    expect(a).not.toBe(b);
  });
});

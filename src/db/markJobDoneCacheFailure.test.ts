import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { insertJob, markJobDone, getJobById } from "./jobs";
import * as cache from "./cache";

jest.mock("./cache", () => ({
  ...jest.requireActual("./cache"),
  insertCacheEntry: jest.fn(),
}));

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5433/ai_diff_review";
const pool = new Pool({ connectionString: DATABASE_URL });

beforeEach(async () => {
  jest.clearAllMocks();
  await pool.query("TRUNCATE TABLE job_events, idempotency_keys, jobs, cache_entries");
});

afterAll(async () => {
  await pool.end();
});

describe("markJobDone resilience to cache_entries write failures", () => {
  it("still marks the job done with correct findings even if populating the cache throws", async () => {
    // Regression test: cache population is an optimization for *future*
    // submissions, not part of what makes *this* job's outcome correct — a
    // failure there must never turn an already-successful review into a
    // reported failure.
    (cache.insertCacheEntry as jest.Mock).mockRejectedValue(new Error("cache write boom"));

    const id = randomUUID();
    await insertJob(pool, {
      id,
      provider: "mock",
      diff: "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+console.log(1);\n",
      options: { provider: "mock", maxFindings: 100 },
      contentHash: `hash-${id}`,
      inputBytes: 10,
      chunks: 1,
    });

    const finding = {
      id: "MOCK-007:a.ts:1",
      ruleId: "MOCK-007",
      path: "a.ts",
      line: 1,
      severity: "low" as const,
      category: "style" as const,
      title: "console.log left in",
      evidence: "console.log(1);",
    };

    await expect(
      markJobDone(pool, id, [finding], { inputBytes: 10, chunks: 1, cacheHit: false }),
    ).resolves.toBeUndefined();

    const job = await getJobById(pool, id);
    expect(job?.status).toBe("done");
    expect(job?.findings).toEqual([finding]);
    expect(cache.insertCacheEntry).toHaveBeenCalled();
  });
});

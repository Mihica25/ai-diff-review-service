import { randomUUID } from "node:crypto";
import { claimQueuedJobs, getJobById, insertJob, markJobDone, markJobFailed } from "./jobs";
import { createTestPool } from "../testUtils/testPool";

// Integration tests against a real Postgres (the local docker-compose
// instance) — claiming safety (FOR UPDATE SKIP LOCKED) is exactly the kind
// of thing a mock would defeat the purpose of testing.
const pool = createTestPool();

async function insertTestJob(overrides: { diff?: string; maxFindings?: number } = {}): Promise<string> {
  const id = randomUUID();
  await insertJob(pool, {
    id,
    provider: "mock",
    diff: overrides.diff ?? "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+x\n",
    options: { provider: "mock", maxFindings: overrides.maxFindings ?? 100 },
    contentHash: `hash-${id}`,
    inputBytes: 10,
    chunks: 1,
  });
  return id;
}

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE job_events, idempotency_keys, jobs, cache_entries");
});

afterAll(async () => {
  await pool.end();
});

describe("insertJob / getJobById", () => {
  it("inserts a job as queued with the submitted diff and options", async () => {
    const id = await insertTestJob({ maxFindings: 42 });
    const job = await getJobById(pool, id);

    expect(job).not.toBeNull();
    expect(job?.status).toBe("queued");
    expect(job?.options).toEqual({ provider: "mock", maxFindings: 42 });
    expect(job?.findings).toBeNull();
    expect(job?.usageCacheHit).toBe(false);
  });

  it("does not select the diff column — GET /v1/reviews/:jobId never needs it, and it can be up to 1 MiB", async () => {
    const id = await insertTestJob();
    const job = await getJobById(pool, id);

    expect(job).not.toBeNull();
    expect(job).not.toHaveProperty("diff");
  });

  it("returns null for an unknown id", async () => {
    expect(await getJobById(pool, randomUUID())).toBeNull();
  });
});

describe("claimQueuedJobs", () => {
  it("flips claimed jobs to running and returns them in FIFO (created_at) order", async () => {
    const first = await insertTestJob();
    await new Promise((r) => setTimeout(r, 5));
    const second = await insertTestJob();

    const claimed = await claimQueuedJobs(pool, 10);

    expect(claimed.map((j) => j.id)).toEqual([first, second]);
    expect(claimed.every((j) => j.status === "running")).toBe(true);

    const reFetched = await getJobById(pool, first);
    expect(reFetched?.status).toBe("running");
  });

  it("never claims more than the requested limit, leaving the rest queued", async () => {
    await insertTestJob();
    await insertTestJob();
    await insertTestJob();

    const claimed = await claimQueuedJobs(pool, 2);
    expect(claimed).toHaveLength(2);

    const stillQueued = await pool.query("SELECT count(*) FROM jobs WHERE status = 'queued'");
    expect(Number(stillQueued.rows[0].count)).toBe(1);
  });

  it("never double-claims the same job under concurrent claim attempts", async () => {
    for (let i = 0; i < 5; i++) {
      await insertTestJob();
    }

    // Fire multiple claim calls concurrently, each asking for more than is
    // available — SKIP LOCKED must prevent any overlap between them.
    const [a, b, c] = await Promise.all([
      claimQueuedJobs(pool, 5),
      claimQueuedJobs(pool, 5),
      claimQueuedJobs(pool, 5),
    ]);

    const allClaimedIds = [...a, ...b, ...c].map((j) => j.id);
    const uniqueIds = new Set(allClaimedIds);
    expect(uniqueIds.size).toBe(allClaimedIds.length);
    expect(allClaimedIds).toHaveLength(5);
  });

  it("returns an empty array when nothing is queued", async () => {
    expect(await claimQueuedJobs(pool, 5)).toEqual([]);
  });
});

describe("markJobDone / markJobFailed", () => {
  it("marks a job done with its findings", async () => {
    const id = await insertTestJob();
    await claimQueuedJobs(pool, 1);

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
    const usage = { inputBytes: 10, chunks: 1, cacheHit: false };
    await markJobDone(pool, id, [finding], usage);

    const job = await getJobById(pool, id);
    expect(job?.status).toBe("done");
    expect(job?.findings).toEqual([finding]);
  });

  it("marks a job failed with a clear error, never throwing", async () => {
    const id = await insertTestJob();
    await claimQueuedJobs(pool, 1);

    const usage = { inputBytes: 10, chunks: 1, cacheHit: false };
    await markJobFailed(pool, id, "internal", "llm provider not yet implemented", usage);

    const job = await getJobById(pool, id);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("internal");
    expect(job?.errorMessage).toBe("llm provider not yet implemented");
    expect(job?.findings).toBeNull();
  });
});

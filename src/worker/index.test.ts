import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { insertJob, getJobById } from "../db/jobs";
import { startWorker } from "./index";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5433/ai_diff_review";
// TODO(reuse): see src/db/jobs.test.ts — same createPool() divergence risk.
const pool = new Pool({ connectionString: DATABASE_URL });

async function insertTestJob(diff: string): Promise<string> {
  const id = randomUUID();
  await insertJob(pool, {
    id,
    provider: "mock",
    diff,
    options: { provider: "mock", maxFindings: 100 },
    contentHash: `hash-${id}`,
    inputBytes: Buffer.byteLength(diff, "utf8"),
    chunks: 1,
  });
  return id;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitUntil: timed out");
}

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE job_events, idempotency_keys, jobs, cache_entries");
});

afterAll(async () => {
  await pool.end();
});

describe("worker", () => {
  it("processes a queued job through to done with real findings", async () => {
    const worker = startWorker(pool);
    try {
      const id = await insertTestJob("--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+console.log(1);\n");

      await waitUntil(async () => (await getJobById(pool, id))?.status === "done");

      const job = await getJobById(pool, id);
      expect(job?.findings).toEqual([expect.objectContaining({ ruleId: "MOCK-007" })]);
    } finally {
      await worker.stop();
    }
  });

  it("never leaves a job stuck 'running' after stop() resolves, even under immediate shutdown", async () => {
    // Regression test for a shutdown race: stop() must not just snapshot
    // in-flight jobs, but wait for whatever tick is *currently* claiming, so
    // jobs claimed right as shutdown begins still get processed rather than
    // abandoned mid-flight. Calling stop() with zero delay after start
    // maximizes the chance of landing inside that exact window.
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+x\n";
    const ids = await Promise.all([1, 2, 3].map(() => insertTestJob(diff)));

    const worker = startWorker(pool);
    await worker.stop();

    const result = await pool.query("SELECT status, count(*) FROM jobs WHERE id = ANY($1::uuid[]) GROUP BY status", [
      ids,
    ]);
    const statuses = result.rows.map((r) => r.status);
    expect(statuses).not.toContain("running");
  });

  it("marks a job failed, not crashed, when the requested provider isn't implemented", async () => {
    const id = randomUUID();
    await insertJob(pool, {
      id,
      provider: "llm",
      diff: "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+x\n",
      options: { provider: "llm", maxFindings: 100 },
      contentHash: `hash-${id}`,
      inputBytes: 1,
      chunks: 1,
    });

    const worker = startWorker(pool);
    try {
      await waitUntil(async () => (await getJobById(pool, id))?.status === "failed");
      const job = await getJobById(pool, id);
      expect(job?.errorCode).toBe("internal");
      expect(job?.errorMessage).toMatch(/llm provider/i);
    } finally {
      await worker.stop();
    }
  });

  it("runs at most 4 jobs concurrently; a 5th stays queued until a slot frees, never fails", async () => {
    // Five jobs submitted at once; only 4 should ever be 'running'
    // simultaneously, and the 5th must end up 'done' too, not stuck/failed.
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+x\n";
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => insertTestJob(diff)));

    const worker = startWorker(pool);
    try {
      let sawFive = false;
      let maxRunningObserved = 0;
      const deadline = Date.now() + 5000;

      // Sample concurrently-running count while jobs are in flight — mock
      // jobs finish fast, so this loop wins the race often enough in
      // practice on this schema-simple, near-instant provider.
      while (Date.now() < deadline) {
        const result = await pool.query("SELECT status, count(*) FROM jobs WHERE id = ANY($1::uuid[]) GROUP BY status", [
          ids,
        ]);
        const counts = Object.fromEntries(result.rows.map((r) => [r.status, Number(r.count)]));
        maxRunningObserved = Math.max(maxRunningObserved, counts["running"] ?? 0);
        if ((counts["done"] ?? 0) === 5) {
          sawFive = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(sawFive).toBe(true);
      expect(maxRunningObserved).toBeLessThanOrEqual(4);

      const final = await pool.query("SELECT status, count(*) FROM jobs WHERE id = ANY($1::uuid[]) GROUP BY status", [
        ids,
      ]);
      const finalCounts = Object.fromEntries(final.rows.map((r) => [r.status, Number(r.count)]));
      expect(finalCounts).toEqual({ done: 5 });
    } finally {
      await worker.stop();
    }
  }, 10000);
});

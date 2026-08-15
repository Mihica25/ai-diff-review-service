import { randomUUID } from "node:crypto";
import { claimQueuedJobs, insertJob, markJobDone, markJobFailed } from "./jobs";
import { getJobEventsAfter } from "./jobEvents";
import { createTestPool } from "../testUtils/testPool";

const pool = createTestPool();

async function insertTestJob(): Promise<string> {
  const id = randomUUID();
  await insertJob(pool, {
    id,
    provider: "mock",
    diff: "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+x\n",
    options: { provider: "mock", maxFindings: 100 },
    contentHash: `hash-${id}`,
    inputBytes: 10,
    chunks: 1,
  });
  return id;
}

const USAGE = { inputBytes: 10, chunks: 1, cacheHit: false };
const FINDING_A = {
  id: "MOCK-007:a.ts:1",
  ruleId: "MOCK-007",
  path: "a.ts",
  line: 1,
  severity: "low" as const,
  category: "style" as const,
  title: "console.log left in",
  evidence: "console.log(1);",
};
const FINDING_B = { ...FINDING_A, id: "MOCK-008:a.ts:2", ruleId: "MOCK-008", line: 2 };

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE job_events, idempotency_keys, jobs, cache_entries");
});

afterAll(async () => {
  await pool.end();
});

describe("job_events written through the lifecycle", () => {
  it("writes queued -> running -> finding(s) -> done in order for a successful job", async () => {
    const id = await insertTestJob();
    await claimQueuedJobs(pool, 1);
    await markJobDone(pool, id, [FINDING_A, FINDING_B], USAGE);

    const events = await getJobEventsAfter(pool, id, 0);

    expect(events.map((e) => e.eventType)).toEqual(["status", "status", "finding", "finding", "done"]);
    expect(events[0]?.payload).toEqual({ status: "queued" });
    expect(events[1]?.payload).toEqual({ status: "running" });
    expect(events[2]?.payload).toEqual(FINDING_A);
    expect(events[3]?.payload).toEqual(FINDING_B);
    expect(events[4]?.payload).toEqual({ total: 2, usage: USAGE });
  });

  it("writes queued -> running -> failed-status -> done(total:0) for a failed job", async () => {
    const id = await insertTestJob();
    await claimQueuedJobs(pool, 1);
    await markJobFailed(pool, id, "internal", "boom", USAGE);

    const events = await getJobEventsAfter(pool, id, 0);

    expect(events.map((e) => e.eventType)).toEqual(["status", "status", "status", "done"]);
    expect(events[2]?.payload).toEqual({ status: "failed", error: { code: "internal", message: "boom" } });
    expect(events[3]?.payload).toEqual({ total: 0, usage: USAGE });
  });

  it("ids are strictly increasing, so ordering by id reproduces insertion order", async () => {
    const id = await insertTestJob();
    await claimQueuedJobs(pool, 1);
    await markJobDone(pool, id, [FINDING_A], USAGE);

    const events = await getJobEventsAfter(pool, id, 0);
    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getJobEventsAfter only returns events after the given id (used for live polling)", async () => {
    const id = await insertTestJob();
    await claimQueuedJobs(pool, 1);
    await markJobDone(pool, id, [FINDING_A], USAGE);

    const all = await getJobEventsAfter(pool, id, 0);
    const afterFirst = await getJobEventsAfter(pool, id, all[0]!.id);

    expect(afterFirst).toEqual(all.slice(1));
  });

  it("a job's events never mix with another job's events", async () => {
    const id1 = await insertTestJob();
    const id2 = await insertTestJob();
    await claimQueuedJobs(pool, 2);
    await markJobDone(pool, id1, [FINDING_A], USAGE);
    await markJobDone(pool, id2, [FINDING_B], USAGE);

    const events1 = await getJobEventsAfter(pool, id1, 0);
    const events2 = await getJobEventsAfter(pool, id2, 0);

    expect(events1.find((e) => e.eventType === "finding")?.payload).toEqual(FINDING_A);
    expect(events2.find((e) => e.eventType === "finding")?.payload).toEqual(FINDING_B);
  });

  it("event.id is a real JS number, not a string (Postgres bigserial pitfall)", async () => {
    const id = await insertTestJob();
    const events = await getJobEventsAfter(pool, id, 0);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(typeof event.id).toBe("number");
    }
  });

  it("batch-inserts many finding events correctly in a single round trip", async () => {
    const id = await insertTestJob();
    await claimQueuedJobs(pool, 1);
    const many = Array.from({ length: 50 }, (_, i) => ({ ...FINDING_A, id: `MOCK-007:a.ts:${i}`, line: i }));

    await markJobDone(pool, id, many, USAGE);

    const events = await getJobEventsAfter(pool, id, 0);
    const findingEvents = events.filter((e) => e.eventType === "finding");
    expect(findingEvents).toHaveLength(50);
    expect(findingEvents.map((e) => (e.payload as { line: number }).line)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
  });
});

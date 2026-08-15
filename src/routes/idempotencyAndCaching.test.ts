import { buildServer } from "../server";
import { claimQueuedJobs, markJobDone, markJobFailed } from "../db/jobs";
import { runMockProvider } from "../providers/mock";
import { createTestPool } from "../testUtils/testPool";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5433/ai_diff_review";
const BEARER_TOKEN = "test-token";

const pool = createTestPool();

function makeApp() {
  return buildServer(pool, { PORT: 3000, DATABASE_URL, BEARER_TOKEN, ANTHROPIC_MODEL: "claude-sonnet-5" });
}

function authHeaders(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${BEARER_TOKEN}`, ...extra };
}

const DIFF_A = "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+console.log(1);\n";
const DIFF_B = "--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1,1 @@\n+eval(1);\n";

async function jobCount(): Promise<number> {
  const res = await pool.query("SELECT count(*) FROM jobs");
  return Number(res.rows[0].count);
}

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE job_events, idempotency_keys, jobs, cache_entries");
});

afterAll(async () => {
  await pool.end();
});

describe("Idempotency-Key", () => {
  it("same key + identical body returns the same jobId, without creating a second job", async () => {
    const app = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-1" }),
      payload: { diff: DIFF_A },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-1" }),
      payload: { diff: DIFF_A },
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(await jobCount()).toBe(1);
  });

  it("replaying a key against an already-done job reports its real current status", async () => {
    const app = makeApp();
    const submit = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-done" }),
      payload: { diff: DIFF_A },
    });
    const { jobId } = submit.json();

    const [job] = await claimQueuedJobs(pool, 1);
    const findings = runMockProvider(job!.diff);
    await markJobDone(pool, jobId, findings, {
      inputBytes: job!.usageInputBytes,
      chunks: job!.usageChunks,
      cacheHit: false,
    });

    const replay = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-done" }),
      payload: { diff: DIFF_A },
    });

    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ jobId, status: "done" });
    expect(await jobCount()).toBe(1);
  });

  it("replaying a key against a failed job surfaces the error, not just the bare status", async () => {
    const app = makeApp();
    const submit = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-failed" }),
      payload: { diff: DIFF_A },
    });
    const { jobId } = submit.json();

    await claimQueuedJobs(pool, 1);
    await markJobFailed(pool, jobId, "internal", "simulated failure", {
      inputBytes: 10,
      chunks: 1,
      cacheHit: false,
    });

    const replay = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-failed" }),
      payload: { diff: DIFF_A },
    });

    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({
      jobId,
      status: "failed",
      error: { code: "internal", message: "simulated failure" },
    });
  });

  it("same key + different body returns 409 idempotency_conflict", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-2" }),
      payload: { diff: DIFF_A },
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-2" }),
      payload: { diff: DIFF_B },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: { code: "idempotency_conflict", message: expect.any(String) } });
    expect(await jobCount()).toBe(1);
  });

  it("different keys with the same body create independent jobs", async () => {
    const app = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-a" }),
      payload: { diff: DIFF_A },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "key-b" }),
      payload: { diff: DIFF_A },
    });

    expect(second.json().jobId).not.toBe(first.json().jobId);
    expect(await jobCount()).toBe(2);
  });

  it("two concurrent identical requests with the same key resolve to exactly one job", async () => {
    // Both requests race to insert the same idempotency_keys.key — Postgres'
    // unique constraint resolves who wins; the loser must discover the
    // winner's job rather than create a second one or error out.
    const app = makeApp();
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/reviews",
        headers: authHeaders({ "idempotency-key": "key-race" }),
        payload: { diff: DIFF_A },
      }),
      app.inject({
        method: "POST",
        url: "/v1/reviews",
        headers: authHeaders({ "idempotency-key": "key-race" }),
        payload: { diff: DIFF_A },
      }),
    ]);

    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.json().jobId).toBe(b.json().jobId);
    expect(await jobCount()).toBe(1);
  });

  it("works normally with no Idempotency-Key header at all", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/reviews", headers: authHeaders(), payload: { diff: DIFF_A } });
    expect(res.statusCode).toBe(202);
  });
});

describe("caching", () => {
  it("a byte-identical {diff, options} resubmission is an instant cache hit with identical findings", async () => {
    const app = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: DIFF_A },
    });
    const { jobId: firstId } = first.json();

    const [job] = await claimQueuedJobs(pool, 1);
    const findings = runMockProvider(job!.diff);
    await markJobDone(pool, firstId, findings, {
      inputBytes: job!.usageInputBytes,
      chunks: job!.usageChunks,
      cacheHit: false,
    });

    const second = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: DIFF_A },
    });
    expect(second.statusCode).toBe(202);
    const { jobId: secondId, status } = second.json();
    expect(secondId).not.toBe(firstId);
    // The 202 response is always exactly {jobId, status: "queued"} per the
    // contract's literal spec, even on a cache hit — no cache-hit variant.
    expect(status).toBe("queued");

    // The job is already 'done' in the DB, though (no worker ever touched
    // it) — that's reported on the GET response, not the POST one.
    const getRes = await app.inject({ method: "GET", url: `/v1/reviews/${secondId}`, headers: authHeaders() });
    const body = getRes.json();
    expect(body.status).toBe("done");
    expect(body.usage.cacheHit).toBe(true);
    expect(body.findings).toEqual(findings);
  });

  it("cache hit works with no Idempotency-Key at all, and with a different key than the original", async () => {
    const app = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "original-key" }),
      payload: { diff: DIFF_A },
    });
    const { jobId: firstId } = first.json();
    const [job] = await claimQueuedJobs(pool, 1);
    const findings = runMockProvider(job!.diff);
    await markJobDone(pool, firstId, findings, {
      inputBytes: job!.usageInputBytes,
      chunks: job!.usageChunks,
      cacheHit: false,
    });

    const noKey = await app.inject({ method: "POST", url: "/v1/reviews", headers: authHeaders(), payload: { diff: DIFF_A } });
    const differentKey = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders({ "idempotency-key": "totally-different-key" }),
      payload: { diff: DIFF_A },
    });

    for (const res of [noKey, differentKey]) {
      // POST always reports "queued" (see the byte-identical-resubmission
      // test above); the cache hit itself shows up on the GET response.
      expect(res.json().status).toBe("queued");
      const getRes = await app.inject({ method: "GET", url: `/v1/reviews/${res.json().jobId}`, headers: authHeaders() });
      expect(getRes.json().usage.cacheHit).toBe(true);
    }
  });

  it("does not cache-hit when options differ, even for the same diff", async () => {
    const app = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: DIFF_A, options: { maxFindings: 5 } },
    });
    const { jobId: firstId } = first.json();
    const [job] = await claimQueuedJobs(pool, 1);
    const findings = runMockProvider(job!.diff);
    await markJobDone(pool, firstId, findings, {
      inputBytes: job!.usageInputBytes,
      chunks: job!.usageChunks,
      cacheHit: false,
    });

    const differentOptions = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: DIFF_A, options: { maxFindings: 50 } },
    });

    expect(differentOptions.json().status).toBe("queued");
  });

  it("a cache-hit job's SSE stream replays the full event sequence just like a normally-processed job", async () => {
    const app = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: DIFF_A },
    });
    const { jobId: firstId } = first.json();
    const [job] = await claimQueuedJobs(pool, 1);
    const findings = runMockProvider(job!.diff);
    await markJobDone(pool, firstId, findings, {
      inputBytes: job!.usageInputBytes,
      chunks: job!.usageChunks,
      cacheHit: false,
    });

    const cached = await app.inject({ method: "POST", url: "/v1/reviews", headers: authHeaders(), payload: { diff: DIFF_A } });
    const { jobId: cachedId } = cached.json();

    const stream = await app.inject({ method: "GET", url: `/v1/reviews/${cachedId}/stream`, headers: authHeaders() });
    const events = stream.payload
      .split("\n\n")
      .filter((b) => b.trim())
      .map((b) => b.split("\n").find((l) => l.startsWith("event: "))?.slice(7));
    expect(events).toEqual(["status", "status", "finding", "done"]);
  });
});

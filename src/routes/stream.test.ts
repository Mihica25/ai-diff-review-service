import { Pool } from "pg";
import { buildServer } from "../server";
import { claimQueuedJobs, markJobDone } from "../db/jobs";
import { runMockProvider } from "../providers/mock";
import { startWorker, type Worker } from "../worker";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5433/ai_diff_review";
const BEARER_TOKEN = "test-token";

const pool = new Pool({ connectionString: DATABASE_URL });

function makeApp() {
  return buildServer(pool, { PORT: 3000, DATABASE_URL, BEARER_TOKEN });
}

function authHeaders() {
  return { authorization: `Bearer ${BEARER_TOKEN}` };
}

const VALID_DIFF = "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+console.log(1);\n";

interface SseFrame {
  id: string;
  event: string;
  data: unknown;
}

function parseSse(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const idLine = lines.find((l) => l.startsWith("id: "));
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!idLine || !eventLine || !dataLine) {
        throw new Error(`malformed SSE block: ${block}`);
      }
      return { id: idLine.slice(4), event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
    });
}

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE job_events, idempotency_keys, jobs, cache_entries");
});

afterAll(async () => {
  await pool.end();
});

describe("GET /v1/reviews/:jobId/stream", () => {
  it("requires a bearer token", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/reviews/00000000-0000-0000-0000-000000000000/stream" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 not_found for a malformed jobId, without opening a stream", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/reviews/not-a-uuid/stream",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).not.toMatch(/text\/event-stream/);
    expect(res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("returns 404 not_found for an unknown (but valid) jobId", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/reviews/00000000-0000-0000-0000-000000000000/stream",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("replays the full stored event log for an already-finished job", async () => {
    const app = makeApp();
    const submit = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: VALID_DIFF },
    });
    const { jobId } = submit.json();

    const [job] = await claimQueuedJobs(pool, 1);
    const findings = runMockProvider(job!.diff);
    await markJobDone(pool, jobId, findings, {
      inputBytes: job!.usageInputBytes,
      chunks: job!.usageChunks,
      cacheHit: job!.usageCacheHit,
    });

    const res = await app.inject({ method: "GET", url: `/v1/reviews/${jobId}/stream`, headers: authHeaders() });

    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const frames = parseSse(res.payload);
    expect(frames.map((f) => f.event)).toEqual(["status", "status", "finding", "done"]);
    expect(frames[0]?.data).toEqual({ status: "queued" });
    expect(frames[1]?.data).toEqual({ status: "running" });
    expect(frames[2]?.data).toMatchObject({ ruleId: "MOCK-007" });
    expect(frames[3]?.data).toMatchObject({ total: 1 });
  });

  it("replaying a finished job's stream twice produces byte-identical output", async () => {
    const app = makeApp();
    const submit = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: VALID_DIFF },
    });
    const { jobId } = submit.json();

    const [job] = await claimQueuedJobs(pool, 1);
    const findings = runMockProvider(job!.diff);
    await markJobDone(pool, jobId, findings, {
      inputBytes: job!.usageInputBytes,
      chunks: job!.usageChunks,
      cacheHit: job!.usageCacheHit,
    });

    const first = await app.inject({ method: "GET", url: `/v1/reviews/${jobId}/stream`, headers: authHeaders() });
    const second = await app.inject({ method: "GET", url: `/v1/reviews/${jobId}/stream`, headers: authHeaders() });

    expect(second.payload).toBe(first.payload);
  });

  it("streams events live as a real worker processes the job, ending with done", async () => {
    const app = makeApp();
    let worker: Worker | undefined;
    try {
      worker = startWorker(pool);

      const submit = await app.inject({
        method: "POST",
        url: "/v1/reviews",
        headers: authHeaders(),
        payload: { diff: VALID_DIFF },
      });
      const { jobId } = submit.json();

      // Connect to the stream right away — the job may still be queued.
      // inject() waits for the handler to finish, which only happens once
      // the SSE loop observes a `done` event, so this proves live tailing
      // (not just replaying a pre-existing log) as long as the worker
      // genuinely processes the job concurrently with this same request.
      const res = await app.inject({ method: "GET", url: `/v1/reviews/${jobId}/stream`, headers: authHeaders() });

      const frames = parseSse(res.payload);
      expect(frames.map((f) => f.event)).toEqual(["status", "status", "finding", "done"]);
      expect(frames.at(-1)?.event).toBe("done");
    } finally {
      await worker?.stop();
    }
  }, 10000);
});

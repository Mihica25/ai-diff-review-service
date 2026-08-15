import { buildServer } from "../server";
import { claimQueuedJobs, markJobDone } from "../db/jobs";
import { runMockProvider } from "../providers/mock";
import { createTestPool } from "../testUtils/testPool";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5433/ai_diff_review";
const BEARER_TOKEN = "test-token";

const pool = createTestPool();

function makeApp() {
  return buildServer(pool, { PORT: 3000, DATABASE_URL, BEARER_TOKEN, ANTHROPIC_MODEL: "claude-sonnet-5" });
}

const VALID_DIFF = "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+console.log(1);\n";

function authHeaders() {
  return { authorization: `Bearer ${BEARER_TOKEN}` };
}

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE job_events, idempotency_keys, jobs, cache_entries");
});

afterAll(async () => {
  await pool.end();
});

describe("POST /v1/reviews", () => {
  it("accepts a valid diff and returns 202 with a queued job", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: VALID_DIFF },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("queued");
    expect(typeof body.jobId).toBe("string");
  });

  it("rejects a missing diff with 422 invalid_diff", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: { code: "invalid_diff", message: expect.any(String) } });
  });

  it("rejects an empty diff with 422 invalid_diff", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: "   " },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_diff");
  });

  it("rejects text with no hunk header as unparseable, 422 invalid_diff", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: "this is not a diff at all" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_diff");
  });

  it("rejects malformed JSON with 400 invalid_json", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: "{ this is not valid json",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "invalid_json", message: expect.any(String) } });
  });

  it("rejects an unsupported Content-Type with 415 invalid_json, not internal", async () => {
    // Regression test: Fastify's own content-type-parser rejects this before
    // the route ever runs (FST_ERR_CTP_INVALID_MEDIA_TYPE, statusCode 415).
    // The error handler used to key on bare statusCode and only special-cased
    // 400/413, so this fell through to the generic branch and reported
    // `code: "internal"` despite being a client error, not a server one.
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: { ...authHeaders(), "content-type": "application/xml" },
      payload: JSON.stringify({ diff: VALID_DIFF }),
    });

    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: { code: "invalid_json", message: expect.any(String) } });
  });

  it("rejects a payload over 1 MiB with 413 payload_too_large", async () => {
    const app = makeApp();
    const hugeDiff = VALID_DIFF + "x".repeat(1_048_576 + 1);
    const res = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: hugeDiff },
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: { code: "payload_too_large", message: expect.any(String) } });
  });

  it("falls back to defaults for an unrecognized provider instead of erroring", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: VALID_DIFF, options: { provider: "not-a-real-provider" } },
    });

    // No error code exists for "invalid options" in the contract's closed
    // taxonomy — falls back to the default provider rather than 4xx-ing.
    expect(res.statusCode).toBe(202);
  });

  it("ignores unknown top-level body fields", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: VALID_DIFF, somethingUnexpected: true },
    });

    expect(res.statusCode).toBe(202);
  });

  it("requires a bearer token", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/reviews", payload: { diff: VALID_DIFF } });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/reviews/:jobId", () => {
  it("returns 404 not_found for an unknown jobId", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/reviews/00000000-0000-0000-0000-000000000000",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("returns 404 not_found (not 500) for a malformed, non-UUID jobId", async () => {
    // jobs.id is a Postgres `uuid` column — without a format guard, this
    // would make the query itself throw and fall through to a 500.
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/reviews/some-id",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("returns the job's status and shape right after submission (queued)", async () => {
    const app = makeApp();
    const submit = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: VALID_DIFF },
    });
    const { jobId } = submit.json();

    const res = await app.inject({ method: "GET", url: `/v1/reviews/${jobId}`, headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobId).toBe(jobId);
    expect(["queued", "running", "done"]).toContain(body.status);
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.usage).toEqual({
      inputBytes: Buffer.byteLength(VALID_DIFF, "utf8"),
      chunks: 1,
      cacheHit: false,
    });
  });

  it("eventually reaches done with the expected mock finding, processed by the worker's own logic", async () => {
    // Phase 3 doesn't start the background worker inside this test process,
    // so exercise the same claim -> process -> done path directly against
    // the route's job row to prove the GET response reflects it correctly.
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

    const res = await app.inject({ method: "GET", url: `/v1/reviews/${jobId}`, headers: authHeaders() });
    const body = res.json();
    expect(body.status).toBe("done");
    expect(body.findings).toEqual([
      expect.objectContaining({ ruleId: "MOCK-007", path: "a.ts", line: 1 }),
    ]);
  });
});

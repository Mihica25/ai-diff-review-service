import { buildServer } from "../server";
import { LIMITS } from "../limits";
import { createTestPool } from "../testUtils/testPool";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5433/ai_diff_review";
const BEARER_TOKEN = "test-token";

const pool = createTestPool();

function makeApp() {
  return buildServer(pool, { PORT: 3000, DATABASE_URL, BEARER_TOKEN, ANTHROPIC_MODEL: "claude-sonnet-5" });
}

function authHeaders() {
  return { authorization: `Bearer ${BEARER_TOKEN}` };
}

const VALID_DIFF = "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+console.log(1);\n";

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE job_events, idempotency_keys, jobs, cache_entries");
});

afterAll(async () => {
  await pool.end();
});

describe("rate limiting on POST /v1/reviews", () => {
  it("allows exactly the declared burst, then rejects the next one with 429 + Retry-After", async () => {
    const app = makeApp();

    for (let i = 0; i < LIMITS.rateLimitBurst; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/reviews",
        headers: authHeaders(),
        payload: { diff: VALID_DIFF },
      });
      expect(res.statusCode).toBe(202);
    }

    const rejected = await app.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: VALID_DIFF },
    });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBeDefined();
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
    expect(rejected.json()).toEqual({ error: { code: "rate_limited", message: expect.any(String) } });
  }, 20_000);

  it("a rate-limited request never reaches the database — no job is created for it", async () => {
    const app = makeApp();
    for (let i = 0; i < LIMITS.rateLimitBurst; i++) {
      await app.inject({ method: "POST", url: "/v1/reviews", headers: authHeaders(), payload: { diff: VALID_DIFF } });
    }

    await app.inject({ method: "POST", url: "/v1/reviews", headers: authHeaders(), payload: { diff: VALID_DIFF } });

    const count = await pool.query("SELECT count(*) FROM jobs");
    expect(Number(count.rows[0].count)).toBe(LIMITS.rateLimitBurst);
  }, 20_000);

  it("never rate-limits GET routes, even after POST's budget is fully exhausted", async () => {
    const app = makeApp();
    for (let i = 0; i < LIMITS.rateLimitBurst + 5; i++) {
      await app.inject({ method: "POST", url: "/v1/reviews", headers: authHeaders(), payload: { diff: VALID_DIFF } });
    }

    const health = await app.inject({ method: "GET", url: "/health" });
    const spec = await app.inject({ method: "GET", url: "/spec" });
    const getJob = await app.inject({
      method: "GET",
      url: "/v1/reviews/00000000-0000-0000-0000-000000000000",
      headers: authHeaders(),
    });

    expect(health.statusCode).toBe(200);
    expect(spec.statusCode).toBe(200);
    expect(getJob.statusCode).toBe(404); // not rate limited — just an unknown job id
  }, 20_000);

  it("declares the same burst and rate in /spec that it actually enforces", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/spec" });
    const body = res.json();

    expect(body.limits.rateLimitPerMinute).toBe(LIMITS.rateLimitPerMinute);
    expect(body.limits.rateLimitBurst).toBe(LIMITS.rateLimitBurst);
  });

  it("each server instance gets its own independent budget", async () => {
    const appA = makeApp();
    const appB = makeApp();

    for (let i = 0; i < LIMITS.rateLimitBurst; i++) {
      const res = await appA.inject({
        method: "POST",
        url: "/v1/reviews",
        headers: authHeaders(),
        payload: { diff: VALID_DIFF },
      });
      expect(res.statusCode).toBe(202);
    }
    expect((await appA.inject({ method: "POST", url: "/v1/reviews", headers: authHeaders(), payload: { diff: VALID_DIFF } })).statusCode).toBe(429);

    const resB = await appB.inject({
      method: "POST",
      url: "/v1/reviews",
      headers: authHeaders(),
      payload: { diff: VALID_DIFF },
    });
    expect(resB.statusCode).toBe(202);
  }, 20_000);
});

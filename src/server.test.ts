import type { Pool } from "pg";
import { buildServer } from "./server";
import { LIMITS } from "./limits";

const BEARER_TOKEN = "test-token";

function makeApp() {
  const fakePool = {} as Pool;
  return buildServer(fakePool, {
    PORT: 3000,
    DATABASE_URL: "postgres://unused",
    BEARER_TOKEN,
  });
}

describe("GET /health", () => {
  it("returns status ok with version and uptime", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("requires no auth", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /spec", () => {
  it("returns the declared limits exactly", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/spec" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      specVersion: "1.0",
      providers: ["mock", "llm"],
      limits: LIMITS,
    });
  });
});

describe("bearer auth on /v1/*", () => {
  it("rejects requests with no Authorization header", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/reviews/some-id" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("rejects requests with the wrong token", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/reviews/some-id",
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("passes through unknown /v1/* routes with a valid token (404, not 401)", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/reviews/some-id",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });

  it("does not apply to public routes", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("unknown routes", () => {
  it("returns the error envelope, not Fastify's default 404 shape", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/nonexistent" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });
});

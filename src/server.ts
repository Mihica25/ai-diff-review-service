import Fastify, { FastifyInstance, FastifyError } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config";
import { errorEnvelope } from "./errors";
import { LIMITS } from "./limits";
import { createRateLimiter, type RateLimiter } from "./rateLimit";
import { registerAuth } from "./plugins/auth";
import { registerHealthRoute } from "./routes/health";
import { registerSpecRoute } from "./routes/spec";
import { registerReviewRoutes } from "./routes/reviews";
import { registerStreamRoute } from "./routes/stream";

declare module "fastify" {
  interface FastifyInstance {
    pool: Pool;
    rateLimiter: RateLimiter;
  }
}

export function buildServer(pool: Pool, config: Config): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: LIMITS.maxPayloadBytes });
  app.decorate("pool", pool);
  // Built fresh per buildServer() call (not a module-level singleton) so
  // each test's own app instance gets a full, independent burst budget —
  // the same reason app.pool is decorated per-instance rather than shared
  // at module scope.
  app.decorate("rateLimiter", createRateLimiter(LIMITS.rateLimitPerMinute, LIMITS.rateLimitBurst));

  registerAuth(app, config.BEARER_TOKEN);

  registerHealthRoute(app);
  registerSpecRoute(app);
  registerReviewRoutes(app);
  registerStreamRoute(app);

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(errorEnvelope("not_found", "Route not found"));
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    request.log.error(err);

    // Keyed on Fastify's own error `code`, not bare `statusCode` — a request
    // with an unsupported Content-Type gets FST_ERR_CTP_INVALID_MEDIA_TYPE
    // (statusCode 415), which needs its own explicit branch rather than
    // falling into the generic one below. The closed error-code taxonomy
    // (see errors.ts) has no dedicated slot for "wrong Content-Type", so
    // it's mapped to `invalid_json` — the closest existing code — while
    // still returning Fastify's 415 status rather than folding it into a
    // 400.
    if (err.code === "FST_ERR_CTP_INVALID_JSON_BODY" || err.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      reply.code(400).send(errorEnvelope("invalid_json", "Request body is not valid JSON"));
      return;
    }
    if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.code(413).send(errorEnvelope("payload_too_large", "Request body exceeds the maximum allowed size"));
      return;
    }
    if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      reply.code(415).send(errorEnvelope("invalid_json", "Unsupported Content-Type; expected application/json"));
      return;
    }

    const statusCode = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(statusCode).send(errorEnvelope("internal", "Internal server error"));
  });

  return app;
}

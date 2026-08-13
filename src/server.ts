import Fastify, { FastifyInstance, FastifyError } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config";
import { errorEnvelope } from "./errors";
import { LIMITS } from "./limits";
import { registerAuth } from "./plugins/auth";
import { registerHealthRoute } from "./routes/health";
import { registerSpecRoute } from "./routes/spec";
import { registerReviewRoutes } from "./routes/reviews";

declare module "fastify" {
  interface FastifyInstance {
    pool: Pool;
  }
}

export function buildServer(pool: Pool, config: Config): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: LIMITS.maxPayloadBytes });
  app.decorate("pool", pool);

  registerAuth(app, config.BEARER_TOKEN);

  registerHealthRoute(app);
  registerSpecRoute(app);
  registerReviewRoutes(app);

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(errorEnvelope("not_found", "Route not found"));
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    request.log.error(err);

    // TODO(robustness): keying on bare statusCode works today because
    // nothing else in this app throws a plain 400/413 (our own validation
    // replies are sent directly, not thrown) — but it's an invariant held by
    // convention, not by the type system. Fastify actually gives these more
    // specific codes (verified against node_modules/fastify/lib/content-type-parser.js):
    // FST_ERR_CTP_INVALID_JSON_BODY / FST_ERR_CTP_EMPTY_JSON_BODY for
    // malformed JSON, FST_ERR_CTP_BODY_TOO_LARGE for oversized payloads.
    // Keying on `err.code` against those instead of `err.statusCode` would
    // remove the "some future route throws an unrelated bare 400" risk
    // entirely — e.g. `if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE")`.
    if (err.statusCode === 400) {
      reply.code(400).send(errorEnvelope("invalid_json", "Request body is not valid JSON"));
      return;
    }
    if (err.statusCode === 413) {
      reply.code(413).send(errorEnvelope("payload_too_large", "Request body exceeds the maximum allowed size"));
      return;
    }

    const statusCode = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(statusCode).send(errorEnvelope("internal", "Internal server error"));
  });

  return app;
}

import Fastify, { FastifyInstance, FastifyError } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config";
import { errorEnvelope } from "./errors";
import { registerAuth } from "./plugins/auth";
import { registerHealthRoute } from "./routes/health";
import { registerSpecRoute } from "./routes/spec";

declare module "fastify" {
  interface FastifyInstance {
    pool: Pool;
  }
}

export function buildServer(pool: Pool, config: Config): FastifyInstance {
  const app = Fastify({ logger: true });
  app.decorate("pool", pool);

  registerAuth(app, config.BEARER_TOKEN);

  registerHealthRoute(app);
  registerSpecRoute(app);

  // /v1/* routes land in later phases.

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(errorEnvelope("not_found", "Route not found"));
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    request.log.error(err);
    const statusCode = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(statusCode).send(errorEnvelope("internal", "Internal server error"));
  });

  return app;
}

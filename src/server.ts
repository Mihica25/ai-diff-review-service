import Fastify, { FastifyInstance } from "fastify";
import type { Pool } from "pg";

declare module "fastify" {
  interface FastifyInstance {
    pool: Pool;
  }
}

export function buildServer(pool: Pool): FastifyInstance {
  const app = Fastify({ logger: true });
  app.decorate("pool", pool);

  // Routes (/health, /spec, /v1/*) land in later phases.

  return app;
}

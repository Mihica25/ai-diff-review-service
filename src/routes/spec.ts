import type { FastifyInstance } from "fastify";
import { LIMITS } from "../limits";

export function registerSpecRoute(app: FastifyInstance): void {
  app.get("/spec", async () => ({
    specVersion: "1.0",
    providers: ["mock", "llm"],
    limits: LIMITS,
  }));
}

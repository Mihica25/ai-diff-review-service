import type { FastifyInstance } from "fastify";
import { errorEnvelope } from "../errors";

// Applies to every /v1/* route (all methods, including GET). Runs in onRequest
// so an unauthenticated call to an unknown /v1/* path still gets 401, not a
// 404 that would reveal which routes exist.
export function registerAuth(app: FastifyInstance, bearerToken: string): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (path !== "/v1" && !path.startsWith("/v1/")) {
      return;
    }

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    if (!token || token !== bearerToken) {
      await reply.code(401).send(errorEnvelope("unauthorized", "Missing or invalid bearer token"));
    }
  });
}

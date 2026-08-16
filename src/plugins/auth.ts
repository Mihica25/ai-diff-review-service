import type { FastifyInstance } from "fastify";
import { errorEnvelope } from "../errors";

// Fallback for the rare case routeOptions.url is unset (no route matched at
// all) — decodes the raw path best-effort, only to decide whether such a
// request gets a 401 instead of a 404 (hiding whether an unmatched /v1/*
// sub-route exists). No security consequence either way, since nothing
// sensitive is ever reachable at an unmatched route.
function bestEffortPathname(rawUrl: string): string {
  const rawPath = rawUrl.split("?")[0] ?? "";
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

// Applies to every /v1/* route (all methods, including GET). Runs in
// onRequest so an unauthenticated call to an unknown /v1/* path still gets
// 401, not a 404 that would reveal which routes exist.
//
// Checks request.routeOptions.url (Fastify's own record of the route it
// matched) rather than request.url, which is the raw, still percent-encoded
// path — a naive check on that, or even `new URL(...).pathname` (normalizes
// dot-segments but does NOT decode percent-encoding — verified directly),
// lets an encoded "/v1/..." path slip past unauthenticated while Fastify's
// router still decodes and dispatches it underneath (see server.test.ts's
// regression tests for the exact bypass). routeOptions.url can't be fooled this
// way, since it's Fastify's own answer, not a re-derived guess; it's only
// unset for a request that matches no route, which falls back to
// bestEffortPathname() above and 404s regardless.
export function registerAuth(app: FastifyInstance, bearerToken: string): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions?.url ?? bestEffortPathname(request.url);
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

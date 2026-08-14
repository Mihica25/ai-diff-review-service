import type { FastifyInstance } from "fastify";
import { errorEnvelope } from "../errors";

// request.url is the raw, percent-*encoded* path as received — NOT what
// Fastify's router actually matches against, which decodes first. A request
// to "/%76%31/reviews" (percent-encoded "/v1/reviews") has a raw request.url
// that does not start with "/v1/", so a naive string check on it (or even
// `new URL(...).pathname`, which normalizes "." / ".." segments but does NOT
// decode percent-encoded characters — verified directly, both were tried and
// both still let this exact request through) is bypassed entirely, while the
// router still decodes and dispatches it to the real, unauthenticated
// handler underneath.
//
// request.routeOptions.url is the fix: it's Fastify's own record of which
// route it actually matched (confirmed empirically: for a request to
// "/%76%31/reviews/abc", routeOptions.url is exactly "/v1/reviews/:jobId"),
// so checking that instead can never diverge from what actually gets
// dispatched — no encoding trick can fool it, because it isn't re-deriving
// the decoding, it's reading Fastify's own answer.
//
// routeOptions.url is only populated once a route has matched. For a
// request that matches no route at all, it's undefined — but that request
// 404s regardless, so there's no handler underneath to protect; a best-effort
// check against the (still possibly-encoded) raw path is used only to decide
// whether such a request gets a 401 instead of a 404 (hiding whether an
// unmatched /v1/* sub-route exists), which carries no security consequence
// either way since nothing sensitive is ever reachable there.
function bestEffortPathname(rawUrl: string): string {
  const rawPath = rawUrl.split("?")[0] ?? "";
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

// Applies to every /v1/* route (all methods, including GET). Runs in onRequest
// so an unauthenticated call to an unknown /v1/* path still gets 401, not a
// 404 that would reveal which routes exist.
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

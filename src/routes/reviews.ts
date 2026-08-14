import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { errorEnvelope } from "../errors";
import { computeContentHash, computeBodyHash } from "../contentHash";
import { countChunks } from "../chunking";
import {
  insertJob,
  insertCachedJob,
  getJobById,
  IdempotencyKeyRace,
  type IdempotencyWrite,
  type JobStatus,
} from "../db/jobs";
import { getCacheEntry } from "../db/cache";
import { getIdempotencyRecord } from "../db/idempotency";
import { looksLikeUnifiedDiff } from "../providers/mock/parseDiff";

// `provider`/`maxFindings` use .catch() rather than .default(): the closed
// error-code taxonomy (unauthorized, payload_too_large, invalid_json,
// invalid_diff, idempotency_conflict, not_found, rate_limited, internal) has
// no slot for "invalid options", so an unrecognized provider or a malformed
// maxFindings falls back to the default instead of erroring — same lenient
// spirit as "unknown body fields are ignored". `diff` is the only field the
// contract actually defines a validation error for.
// maxFindings is capped (not just positive) so a client can't force an
// unbounded number of job_events rows to be written/streamed for one job —
// 1000 is generous headroom over the documented default of 100.
const optionsSchema = z.object({
  provider: z.enum(["mock", "llm"]).catch("mock"),
  maxFindings: z.number().int().positive().max(1000).catch(100),
});

// TODO(simplify): the outer .catch() here duplicates the inner per-field
// .catch() defaults in optionsSchema (reachable when `options` itself isn't
// an object, e.g. `options: "bad"`). Two spots to keep in sync if a default
// ever changes; worth deriving one from the other.
const reviewBodySchema = z.object({
  diff: z.string(),
  options: optionsSchema.catch({ provider: "mock", maxFindings: 100 }),
});

// `jobs.id` is a Postgres `uuid` column — a non-UUID param would make a
// lookup query itself throw ("invalid input syntax for type uuid"), which
// has no .statusCode and would fall through to a 500 instead of 404. Shared
// between GET /v1/reviews/:jobId and the SSE stream route so the check can't
// drift between the two.
export function isValidJobId(id: string): boolean {
  return z.uuid().safeParse(id).success;
}

// Same lenient-fallback spirit as options above: there's no error code for
// "malformed Idempotency-Key" in the closed taxonomy, so a missing, empty,
// or absurdly long header is treated as if none was supplied at all, rather
// than erroring. 200 chars is generous headroom for any real client's key.
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function parseIdempotencyKeyHeader(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return undefined;
  }
  return value;
}

type IdempotencyResolution =
  | { kind: "replay"; jobId: string; status: JobStatus; errorCode: string | null; errorMessage: string | null }
  | { kind: "conflict" };

// Resolves an existing Idempotency-Key record against the freshly-computed
// body hash: matching body -> replay that job (including its error, if it
// failed); different body -> conflict. Shared between the initial lookup and
// the race-recovery path (two concurrent requests with the same key), which
// both need to resolve the exact same way once a record for the key exists.
async function resolveIdempotencyKey(
  app: FastifyInstance,
  key: string,
  bodyHash: string,
): Promise<IdempotencyResolution | null> {
  const existing = await getIdempotencyRecord(app.pool, key);
  if (!existing) {
    return null;
  }
  if (existing.bodyHash !== bodyHash) {
    return { kind: "conflict" };
  }
  return {
    kind: "replay",
    jobId: existing.jobId,
    status: existing.status,
    errorCode: existing.errorCode,
    errorMessage: existing.errorMessage,
  };
}

// Single place that turns a resolution into an HTTP response — used by both
// the pre-check and the race-recovery path, so the two can't silently drift
// (the same class of bug as the chunking file-boundary duplication this
// session already hit once).
function sendIdempotencyResolution(reply: FastifyReply, resolution: IdempotencyResolution): void {
  if (resolution.kind === "conflict") {
    reply
      .code(409)
      .send(errorEnvelope("idempotency_conflict", "Idempotency-Key already used with a different request body"));
    return;
  }
  const body: Record<string, unknown> = { jobId: resolution.jobId, status: resolution.status };
  if (resolution.status === "failed") {
    body.error = { code: resolution.errorCode ?? "internal", message: resolution.errorMessage ?? "Job failed" };
  }
  reply.code(202).send(body);
}

// Route-scoped onRequest hook (not a global one, unlike auth) so GETs never
// touch the rate limiter at all — checked before body parsing, so an
// over-budget request never pays the cost of parsing/validating a payload
// it's about to be rejected for anyway.
async function checkRateLimit(app: FastifyInstance, reply: FastifyReply): Promise<void> {
  const result = app.rateLimiter.tryConsume();
  if (result.allowed) {
    return;
  }
  reply
    .code(429)
    .header("Retry-After", String(result.retryAfterSeconds))
    .send(errorEnvelope("rate_limited", "Rate limit exceeded — retry after the indicated delay"));
}

export function registerReviewRoutes(app: FastifyInstance): void {
  app.post("/v1/reviews", { onRequest: (_request, reply) => checkRateLimit(app, reply) }, async (request, reply) => {
    const parsed = reviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422).send(errorEnvelope("invalid_diff", "diff is required and must be a string"));
      return;
    }

    const { diff, options } = parsed.data;

    if (diff.trim().length === 0) {
      reply.code(422).send(errorEnvelope("invalid_diff", "diff must not be empty"));
      return;
    }
    if (!looksLikeUnifiedDiff(diff)) {
      reply.code(422).send(errorEnvelope("invalid_diff", "diff is not parseable as a unified diff"));
      return;
    }

    const idempotencyKey = parseIdempotencyKeyHeader(request.headers["idempotency-key"]);
    const bodyHash = idempotencyKey ? computeBodyHash(request.body) : undefined;

    const inputBytes = Buffer.byteLength(diff, "utf8");
    const contentHash = computeContentHash(diff, options);
    // Chunk count is a pure function of the diff bytes (file-boundary split
    // at LIMITS.chunkBytes) — computable immediately, no need to wait for
    // the worker to actually process the job. countChunks() shares its
    // boundary logic with chunkDiff() (which the worker calls later, via
    // runReview(), for the actual chunk content) but never builds the chunk
    // strings themselves, since only the count is needed here.
    const chunks = countChunks(diff);

    // Idempotency-Key lookup and cache lookup are independent of each other
    // (the latter needs only contentHash, computed above) — run them
    // concurrently rather than as two sequential round trips.
    const [idempotencyResolution, cacheEntry] = await Promise.all([
      idempotencyKey && bodyHash ? resolveIdempotencyKey(app, idempotencyKey, bodyHash) : Promise.resolve(null),
      getCacheEntry(app.pool, contentHash),
    ]);

    if (idempotencyResolution) {
      sendIdempotencyResolution(reply, idempotencyResolution);
      return;
    }

    const id = randomUUID();
    const newJob = { id, provider: options.provider, diff, options, contentHash, inputBytes, chunks };
    const idempotencyWrite: IdempotencyWrite | undefined =
      idempotencyKey && bodyHash ? { key: idempotencyKey, bodyHash } : undefined;

    try {
      if (cacheEntry) {
        // Cache lookup is independent of any Idempotency-Key: a
        // byte-identical {diff, options} short-circuits straight to a
        // 'done' job with no worker involvement, regardless of whether a
        // key was supplied.
        await insertCachedJob(app.pool, newJob, cacheEntry.findings, idempotencyWrite);
      } else {
        await insertJob(app.pool, newJob, idempotencyWrite);
      }
    } catch (err) {
      if (err instanceof IdempotencyKeyRace && idempotencyKey && bodyHash) {
        // Another request with the same key committed between our lookup
        // and our insert — resolve against whichever record actually won,
        // exactly as if we'd found it on the first lookup.
        const resolution = await resolveIdempotencyKey(app, idempotencyKey, bodyHash);
        if (resolution) {
          sendIdempotencyResolution(reply, resolution);
          return;
        }
      }
      throw err;
    }

    reply.code(202).send({ jobId: id, status: cacheEntry ? "done" : "queued" });
  });

  app.get<{ Params: { jobId: string } }>("/v1/reviews/:jobId", async (request, reply) => {
    if (!isValidJobId(request.params.jobId)) {
      reply.code(404).send(errorEnvelope("not_found", "Unknown jobId"));
      return;
    }

    const job = await getJobById(app.pool, request.params.jobId);
    if (!job) {
      reply.code(404).send(errorEnvelope("not_found", "Unknown jobId"));
      return;
    }

    const body: Record<string, unknown> = {
      jobId: job.id,
      status: job.status,
      findings: job.findings ?? [],
      usage: {
        inputBytes: job.usageInputBytes,
        chunks: job.usageChunks,
        cacheHit: job.usageCacheHit,
      },
    };
    if (job.status === "failed") {
      body.error = { code: job.errorCode ?? "internal", message: job.errorMessage ?? "Job failed" };
      // TODO(reuse): use errorEnvelope() here instead of a hand-built object,
      // for consistency with every other error response in this file.
    }

    reply.code(200).send(body);
  });
}

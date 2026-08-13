import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorEnvelope } from "../errors";
import { computeContentHash } from "../contentHash";
import { insertJob, getJobById } from "../db/jobs";
import { looksLikeUnifiedDiff } from "../providers/mock/parseDiff";

// `provider`/`maxFindings` use .catch() rather than .default(): the closed
// error-code taxonomy (unauthorized, payload_too_large, invalid_json,
// invalid_diff, idempotency_conflict, not_found, rate_limited, internal) has
// no slot for "invalid options", so an unrecognized provider or a malformed
// maxFindings falls back to the default instead of erroring — same lenient
// spirit as "unknown body fields are ignored". `diff` is the only field the
// contract actually defines a validation error for.
const optionsSchema = z.object({
  provider: z.enum(["mock", "llm"]).catch("mock"),
  maxFindings: z.number().int().positive().catch(100),
});

// TODO(simplify): the outer .catch() here duplicates the inner per-field
// .catch() defaults in optionsSchema (reachable when `options` itself isn't
// an object, e.g. `options: "bad"`). Two spots to keep in sync if a default
// ever changes; worth deriving one from the other.
const reviewBodySchema = z.object({
  diff: z.string(),
  options: optionsSchema.catch({ provider: "mock", maxFindings: 100 }),
});

export function registerReviewRoutes(app: FastifyInstance): void {
  app.post("/v1/reviews", async (request, reply) => {
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

    const id = randomUUID();
    const inputBytes = Buffer.byteLength(diff, "utf8");
    const contentHash = computeContentHash(diff, options);

    await insertJob(app.pool, {
      id,
      provider: options.provider,
      diff,
      options,
      contentHash,
      inputBytes,
      chunks: 1, // no chunking yet — Phase 4
    });

    reply.code(202).send({ jobId: id, status: "queued" });
  });

  app.get<{ Params: { jobId: string } }>("/v1/reviews/:jobId", async (request, reply) => {
    // `jobs.id` is a Postgres `uuid` column — a non-UUID param would make the
    // query itself throw ("invalid input syntax for type uuid"), which has no
    // .statusCode and would fall through to a 500 instead of 404. A malformed
    // id can never match a real job either way, so treat it the same as
    // not-found and never let it reach the database.
    if (!z.uuid().safeParse(request.params.jobId).success) {
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

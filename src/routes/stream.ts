import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { errorEnvelope } from "../errors";
import { getJobById } from "../db/jobs";
import { getJobEventsAfter, type JobEventRow } from "../db/jobEvents";
import { isValidJobId } from "./reviews";

const POLL_INTERVAL_MS = 200;
// Keeps the connection alive through proxies/load balancers that drop
// long-idle connections (Railway's edge included) — an SSE comment line is
// ignored by any spec-compliant client but still counts as traffic. Mock
// jobs finish in milliseconds today, so this rarely fires in practice, but
// nothing guarantees every future provider (the llm one, for instance) will.
const HEARTBEAT_INTERVAL_MS = 15_000;
// Safety cap so a job that somehow never reaches a terminal state can't hold
// an SSE connection open forever. Generous relative to the 30s latency SLA
// for <=64 KiB diffs — this is a backstop, not an expected code path.
const MAX_STREAM_MS = 60_000;

function formatSseEvent(event: JobEventRow): string {
  return `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export interface StreamJobEventsOptions {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxStreamMs?: number;
}

// Replays job_events in storage order, then — if the job isn't terminal yet
// — keeps polling for new rows (same low-tech polling philosophy as the
// worker itself) until a `done` event appears, at which point it returns and
// the caller closes the connection. Never reconstructs events from current
// job state: everything written here comes straight from job_events, which
// is what makes two connections to a finished job's stream produce
// byte-identical output.
//
// Extracted from the route handler (rather than inlined) specifically so its
// heartbeat/poll timing can be exercised directly in tests with millisecond
// intervals — actually waiting out the real 15s heartbeat interval in a test
// isn't practical, but the same logic with a 50ms interval is.
export async function streamJobEvents(
  pool: Pool,
  jobId: string,
  write: (chunk: string) => void,
  isClosed: () => boolean,
  options: StreamJobEventsOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const maxStreamMs = options.maxStreamMs ?? MAX_STREAM_MS;

  let lastId = 0;
  let lastActivity = Date.now();
  const start = Date.now();

  while (!isClosed()) {
    const events = await getJobEventsAfter(pool, jobId, lastId);
    for (const event of events) {
      write(formatSseEvent(event));
      lastId = event.id;
      lastActivity = Date.now();
      if (event.eventType === "done") {
        // Terminal for every job regardless of success/failure — a failed
        // job's status:failed event (carrying the error) is already written
        // before this, so seeing `done` here is always safe to stop on.
        return;
      }
    }

    if (Date.now() - start > maxStreamMs) {
      return;
    }
    if (Date.now() - lastActivity >= heartbeatIntervalMs) {
      write(":\n\n");
      lastActivity = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export function registerStreamRoute(app: FastifyInstance): void {
  app.get<{ Params: { jobId: string } }>("/v1/reviews/:jobId/stream", async (request, reply) => {
    if (!isValidJobId(request.params.jobId)) {
      reply.code(404).send(errorEnvelope("not_found", "Unknown jobId"));
      return;
    }

    const job = await getJobById(app.pool, request.params.jobId);
    if (!job) {
      reply.code(404).send(errorEnvelope("not_found", "Unknown jobId"));
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    reply.raw.on("close", () => {
      closed = true;
    });

    try {
      await streamJobEvents(
        app.pool,
        request.params.jobId,
        (chunk) => reply.raw.write(chunk),
        () => closed,
      );
    } catch (err) {
      request.log.error(err);
    } finally {
      reply.raw.end();
    }
  });
}

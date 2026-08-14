import type { FastifyInstance } from "fastify";
import { errorEnvelope } from "../errors";
import { getJobById } from "../db/jobs";
import { getJobEventsAfter, type JobEventRow } from "../db/jobEvents";
import { isValidJobId } from "./reviews";

const POLL_INTERVAL_MS = 200;
// Safety cap so a job that somehow never reaches a terminal state can't hold
// an SSE connection open forever. Generous relative to the 30s latency SLA
// for <=64 KiB diffs — this is a backstop, not an expected code path.
const MAX_STREAM_MS = 60_000;

function formatSseEvent(event: JobEventRow): string {
  return `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

// Replays job_events in storage order, then — if the job isn't terminal yet
// — keeps polling for new rows (same low-tech polling philosophy as the
// worker itself) until a `done` event appears. Never reconstructs events
// from current job state: everything written here comes straight from
// job_events, which is what makes two connections to a finished job's
// stream produce byte-identical output.
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

    let lastId = 0;
    const start = Date.now();

    try {
      while (!closed) {
        const events = await getJobEventsAfter(app.pool, request.params.jobId, lastId);
        for (const event of events) {
          reply.raw.write(formatSseEvent(event));
          lastId = event.id;
          if (event.eventType === "done") {
            closed = true;
          }
        }
        if (closed || Date.now() - start > MAX_STREAM_MS) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err) {
      request.log.error(err);
    } finally {
      reply.raw.end();
    }
  });
}

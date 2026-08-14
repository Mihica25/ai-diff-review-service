import type { Pool } from "pg";
import { LIMITS } from "../limits";
import { claimQueuedJobs, markJobDone, markJobFailed, type JobRow } from "../db/jobs";
import { ProviderNotImplementedError } from "../providers";
import { runReview } from "../review";

const POLL_INTERVAL_MS = 200;
// TODO(efficiency): fixed-interval polling costs a full claim transaction
// every tick even when the queue is empty. LISTEN/NOTIFY or an adaptive
// backoff would remove that idle cost; not worth the complexity yet at this
// scale/timeline.

export interface Worker {
  stop(): Promise<void>;
}

// In-process worker: polls for queued jobs and claims up to
// (maxConcurrentJobs - inFlight.size) at a time via claimQueuedJobs (which
// does the FOR UPDATE SKIP LOCKED claim + running transition). Each claimed
// job is processed concurrently, not awaited sequentially, so up to 4 run in
// parallel; a 5th stays queued until a slot frees up.
//
// TODO(no crash-recovery): a hard process crash (not a clean stop()) leaves
// any 'running' jobs stuck forever — nothing re-claims stale 'running' rows.
// Postgres was chosen for restart-durability, but this specific gap means
// that durability only holds for 'queued' jobs today, not ones already
// in flight at the moment of a crash. Worth a staleness-based reclaim query
// with more time; out of scope for now given how fast mock jobs complete.
export function startWorker(pool: Pool): Worker {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const inFlight = new Set<Promise<void>>();
  // Tracks whichever tick() call is currently executing (or the last one to
  // finish, once idle). stop() must await this — not just snapshot
  // `inFlight` — because a tick can be mid-`await claimQueuedJobs(...)` (jobs
  // already flipped to 'running' in Postgres) at the exact moment stop() is
  // called; without awaiting the in-progress tick, those newly-claimed jobs
  // would never be added to `inFlight` in time to be waited on, and the
  // process could exit while they're still nominally "running" in the DB
  // with nothing left to finish them.
  let currentTick: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    if (stopped) {
      return;
    }

    const available = LIMITS.maxConcurrentJobs - inFlight.size;
    if (available > 0) {
      try {
        const jobs = await claimQueuedJobs(pool, available);
        for (const job of jobs) {
          const p = processJob(pool, job).finally(() => {
            inFlight.delete(p);
          });
          inFlight.add(p);
        }
      } catch (err) {
        // Transient DB hiccup while claiming — log and keep polling rather
        // than letting the worker loop die.
        console.error("worker: claim tick failed", err);
      }
    }

    if (!stopped) {
      timer = setTimeout(() => {
        currentTick = tick();
      }, POLL_INTERVAL_MS);
    }
  }

  currentTick = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      await currentTick;
      await Promise.allSettled(inFlight);
    },
  };
}

// Exported for direct unit testing of its error-sanitization and
// double-failure resilience, which are awkward to provoke reliably through a
// real Postgres instance.
export async function processJob(pool: Pool, job: JobRow): Promise<void> {
  const usage = { inputBytes: job.usageInputBytes, chunks: job.usageChunks, cacheHit: job.usageCacheHit };
  try {
    const findings = runReview(job.options.provider, job.diff);
    const truncated = findings.slice(0, job.options.maxFindings);
    await markJobDone(pool, job.id, truncated, usage);
  } catch (err) {
    // Only a deliberate, known-safe error message is ever returned to
    // clients (via GET /v1/reviews/:jobId) — anything else (a raw DB/driver
    // error, for instance) is logged server-side only, never echoed back.
    const isSafeToExpose = err instanceof ProviderNotImplementedError;
    const message = isSafeToExpose ? err.message : "Internal error while processing this job";
    if (!isSafeToExpose) {
      console.error(`worker: job ${job.id} failed unexpectedly`, err);
    }

    try {
      await markJobFailed(pool, job.id, "internal", message, usage);
    } catch (writeErr) {
      // If even the failure write fails (e.g. the same DB outage that broke
      // markJobDone), do not let this throw escape unhandled — that would
      // crash the whole process over one job, taking every other in-flight
      // job down with it. The job is left stuck; logged for visibility.
      console.error(`worker: failed to record job ${job.id} as failed`, writeErr);
    }
  }
}

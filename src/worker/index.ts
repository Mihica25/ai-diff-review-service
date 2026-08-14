import type { Pool } from "pg";
import { LIMITS } from "../limits";
import { claimQueuedJobs, markJobDone, markJobFailed, type JobRow } from "../db/jobs";
import { ProviderNotImplementedError } from "../providers";
import { runReview } from "../review";

const POLL_INTERVAL_MS = 200;
const MAX_POLL_INTERVAL_MS = 2000;
// Adaptive backoff: only a tick that affirmatively confirms zero queued
// jobs pushes the next tick out by POLL_INTERVAL_MS, capped at
// MAX_POLL_INTERVAL_MS, so an idle queue isn't paying for a full claim
// transaction 5 times a second indefinitely. Every other outcome — a claim
// succeeds, the worker is saturated and doesn't even attempt to claim, or
// the claim attempt itself errors — resets to POLL_INTERVAL_MS. The error
// case matters: an error tells us nothing about whether jobs are actually
// queued, so treating it the same as a confirmed-empty queue would mean a
// transient DB hiccup (the kind CLAUDE.md already flags as the likeliest
// load-test failure mode) slows retries down right when fast retry matters
// most — caught by code review, since the first version of this logic did
// exactly that. The cap is small relative to the 30s "done within 30s"
// budget, so the worst case (a job submitted the instant after a
// fully-backed-off tick) only adds up to 2s of latency, not a risk to that
// budget. LISTEN/NOTIFY would remove the idle cost entirely but is more
// complexity than this scale/timeline calls for.

// Pure decision, exported for direct unit testing — no Postgres or timers
// involved, so the backoff/cap/reset behavior can be tested exhaustively
// without needing to provoke a real claim failure against a real database.
export function nextPollInterval(confirmedEmpty: boolean, current: number): number {
  return confirmedEmpty ? Math.min(current + POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS) : POLL_INTERVAL_MS;
}

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
  let pollInterval = POLL_INTERVAL_MS;

  async function tick(): Promise<void> {
    if (stopped) {
      return;
    }

    const available = LIMITS.maxConcurrentJobs - inFlight.size;
    let confirmedEmpty = false;
    if (available > 0) {
      try {
        const jobs = await claimQueuedJobs(pool, available);
        confirmedEmpty = jobs.length === 0;
        for (const job of jobs) {
          const p = processJob(pool, job).finally(() => {
            inFlight.delete(p);
          });
          inFlight.add(p);
        }
      } catch (err) {
        // Transient DB hiccup while claiming — log and keep polling rather
        // than letting the worker loop die. confirmedEmpty deliberately
        // stays false here: an error is not evidence the queue is empty.
        console.error("worker: claim tick failed", err);
      }
    }

    pollInterval = nextPollInterval(confirmedEmpty, pollInterval);

    if (!stopped) {
      timer = setTimeout(() => {
        currentTick = tick();
      }, pollInterval);
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

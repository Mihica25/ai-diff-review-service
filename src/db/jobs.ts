import type { Pool } from "pg";
import type { Finding } from "../findings";
import type { ProviderName } from "../providers";
import { insertJobEvent, insertJobEvents, type JobEventType } from "./jobEvents";
import { insertCacheEntry } from "./cache";

// TODO(reuse): insertJob/insertCachedJob/claimQueuedJobs/markJobDone/
// markJobFailed each hand-roll their own connect/BEGIN/COMMIT/catch-ROLLBACK/
// finally-release wrapper — a shared `withTransaction(pool, fn)` helper would
// collapse this to one implementation instead of five. Related: this file's
// idempotency_keys race handling (catch a specific unique-violation, throw a
// typed error) and cache.ts's insertCacheEntry (ON CONFLICT DO NOTHING) solve
// the same "two writers, same key" shape two different ways, mainly because
// idempotency needs to know *which* writer won (to replay that job) while
// caching only needs to discard the loser — worth converging on one
// documented pattern if a third dedup-shaped table shows up.

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobOptions {
  provider: ProviderName;
  maxFindings: number;
}

export interface Usage {
  inputBytes: number;
  chunks: number;
  cacheHit: boolean;
}

export interface JobRow {
  id: string;
  status: JobStatus;
  diff: string;
  options: JobOptions;
  contentHash: string;
  findings: Finding[] | null;
  usageInputBytes: number;
  usageChunks: number;
  usageCacheHit: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface NewJob {
  id: string;
  provider: ProviderName;
  diff: string;
  options: JobOptions;
  contentHash: string;
  inputBytes: number;
  chunks: number;
}

export interface IdempotencyWrite {
  key: string;
  bodyHash: string;
}

// Thrown when two concurrent requests race on the same Idempotency-Key: the
// unique constraint on idempotency_keys.key lets Postgres itself resolve who
// wins, rather than a check-then-insert race in application code. The caller
// (the route handler) catches this and re-resolves against whichever record
// actually landed — either replaying that job or reporting 409, exactly as
// if it had been found on the very first lookup. The original Postgres error
// is kept as `cause` so a misclassification (see isIdempotencyKeyViolation)
// is still diagnosable rather than silently discarded.
export class IdempotencyKeyRace extends Error {
  constructor(cause: unknown) {
    super("Idempotency-Key race: another request committed first", { cause });
  }
}

// TODO(reuse): JobRow/JobRowDb/mapRow re-declare fields that don't change
// name three times over; only the usage_*/error_*/content_hash fields
// actually need snake->camel mapping. SQL column aliasing
// (SELECT ... AS "usageInputBytes") would collapse this to one type.
interface JobRowDb {
  id: string;
  status: JobStatus;
  diff: string;
  options: JobOptions;
  content_hash: string;
  findings: Finding[] | null;
  usage_input_bytes: number;
  usage_chunks: number;
  usage_cache_hit: boolean;
  error_code: string | null;
  error_message: string | null;
}

function mapRow(row: JobRowDb): JobRow {
  return {
    id: row.id,
    status: row.status,
    diff: row.diff,
    options: row.options,
    contentHash: row.content_hash,
    findings: row.findings,
    usageInputBytes: row.usage_input_bytes,
    usageChunks: row.usage_chunks,
    usageCacheHit: row.usage_cache_hit,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

// Checks *which* constraint produced a Postgres unique-violation (23505),
// not just the error code — insertJob/insertCachedJob's transaction also
// inserts into `jobs` (uuid primary key), so a bare code check would
// misclassify any other unique violation in that transaction as an
// idempotency-key race and silently discard the real error.
function isIdempotencyKeyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "constraint" in err &&
    (err as { constraint: unknown }).constraint === "idempotency_keys_pkey"
  );
}

// Job creation, its first job_event (status: queued), and — if an
// Idempotency-Key was supplied — the idempotency_keys row are all written in
// one transaction: a job can never exist without the event a stream replay
// would need, and a key can never point at a job that failed to commit.
export async function insertJob(pool: Pool, job: NewJob, idempotency?: IdempotencyWrite): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO jobs (id, status, provider, diff, options, content_hash, usage_input_bytes, usage_chunks, usage_cache_hit)
       VALUES ($1, 'queued', $2, $3, $4, $5, $6, $7, false)`,
      [job.id, job.provider, job.diff, JSON.stringify(job.options), job.contentHash, job.inputBytes, job.chunks],
    );
    await insertJobEvent(client, job.id, "status", { status: "queued" });
    if (idempotency) {
      await client.query("INSERT INTO idempotency_keys (key, job_id, body_hash) VALUES ($1, $2, $3)", [
        idempotency.key,
        job.id,
        idempotency.bodyHash,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (idempotency && isIdempotencyKeyViolation(err)) {
      throw new IdempotencyKeyRace(err);
    }
    throw err;
  } finally {
    client.release();
  }
}

// The cache-hit path: writes a job that's already 'done' — full event
// sequence (queued -> running -> finding(s) -> done) included — in one
// transaction, with no worker involvement at all. All events go through a
// single insertJobEvents batch call rather than one write per event: this is
// the hot path for repeated/duplicate submissions (the case caching exists
// to make cheap), so it's exactly where holding a pooled connection across
// N unbatched round trips would be most counterproductive. Same
// IdempotencyKeyRace handling as insertJob, since a cache-hit submission can
// carry an Idempotency-Key too.
export async function insertCachedJob(
  pool: Pool,
  job: NewJob,
  findings: Finding[],
  idempotency?: IdempotencyWrite,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO jobs (id, status, provider, diff, options, content_hash, findings, usage_input_bytes, usage_chunks, usage_cache_hit, finished_at)
       VALUES ($1, 'done', $2, $3, $4, $5, $6, $7, $8, true, now())`,
      [
        job.id,
        job.provider,
        job.diff,
        JSON.stringify(job.options),
        job.contentHash,
        JSON.stringify(findings),
        job.inputBytes,
        job.chunks,
      ],
    );
    const usage = { inputBytes: job.inputBytes, chunks: job.chunks, cacheHit: true };
    const events: Array<{ eventType: JobEventType; payload: unknown }> = [
      { eventType: "status", payload: { status: "queued" } },
      { eventType: "status", payload: { status: "running" } },
      ...findings.map((finding) => ({ eventType: "finding" as const, payload: finding })),
      { eventType: "done", payload: { total: findings.length, usage } },
    ];
    await insertJobEvents(client, job.id, events);
    if (idempotency) {
      await client.query("INSERT INTO idempotency_keys (key, job_id, body_hash) VALUES ($1, $2, $3)", [
        idempotency.key,
        job.id,
        idempotency.bodyHash,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (idempotency && isIdempotencyKeyViolation(err)) {
      throw new IdempotencyKeyRace(err);
    }
    throw err;
  } finally {
    client.release();
  }
}

// GET /v1/reviews/{jobId} and the SSE stream route both need the job's
// status/findings/usage/error — never the diff itself, which the response
// never includes but which can be up to 1 MiB. GETs are exempt from rate
// limiting, so a client polling this frequently pays for that column's I/O
// and allocation on every single call; excluding it here removes that cost.
// The return type stays `Omit<JobRow, "diff">` rather than a hand-written
// interface, so a field added to JobRow later must also be added to the
// return-object literal below to compile. That only guards against the
// field being silently dropped from the *response shape*, though — it
// can't catch the raw SQL column list itself falling out of sync, since
// pool.query<T>()'s generic is a compile-time type assertion, never checked
// against the actual query text. A field added here still needs the SELECT
// list, JobRowDb, and the return literal all updated together by hand.
export async function getJobById(pool: Pool, id: string): Promise<Omit<JobRow, "diff"> | null> {
  const result = await pool.query<Omit<JobRowDb, "diff">>(
    `SELECT id, status, options, content_hash, findings, usage_input_bytes, usage_chunks, usage_cache_hit, error_code, error_message
     FROM jobs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    status: row.status,
    options: row.options,
    contentHash: row.content_hash,
    findings: row.findings,
    usageInputBytes: row.usage_input_bytes,
    usageChunks: row.usage_chunks,
    usageCacheHit: row.usage_cache_hit,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

// Claims up to `limit` queued jobs and flips them to 'running' inside a
// single transaction, so two workers (or two ticks) can never claim the same
// job — SKIP LOCKED lets concurrent claimers pass over rows already locked
// by another in-flight transaction instead of blocking on them. Each claimed
// job also gets a status:running event in the same transaction.
export async function claimQueuedJobs(pool: Pool, limit: number): Promise<JobRow[]> {
  if (limit <= 0) {
    return [];
  }

  // One round trip instead of SELECT-then-UPDATE: the inner subquery's own
  // FOR UPDATE SKIP LOCKED does the actual claiming (locks and selects up to
  // `limit` queued rows, letting a concurrent claimer skip past them rather
  // than block), the UPDATE applies to exactly that id set, and the outer
  // SELECT re-establishes FIFO order — Postgres does not preserve a
  // subquery's ORDER BY through UPDATE ... RETURNING on its own, so the
  // ORDER BY on the CTE's output here is what actually guarantees it,
  // rather than a sort written by hand in application code.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<JobRowDb>(
      `WITH claimed AS (
         UPDATE jobs SET status = 'running', started_at = now()
         WHERE id IN (
           SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         RETURNING *
       )
       SELECT * FROM claimed ORDER BY created_at ASC`,
      [limit],
    );
    for (const row of claimed.rows) {
      await insertJobEvent(client, row.id, "status", { status: "running" });
    }
    await client.query("COMMIT");
    return claimed.rows.map(mapRow);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Writes the jobs-row update and every corresponding job_event in one
// transaction, so an SSE replay can never observe a job marked done with
// some of its events missing. The cache_entries write is deliberately
// *not* in this transaction (see below) — it's a separate, best-effort step.
export async function markJobDone(pool: Pool, id: string, findings: Finding[], usage: Usage): Promise<void> {
  const client = await pool.connect();
  let contentHash: string | undefined;
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ content_hash: string }>(
      `UPDATE jobs SET status = 'done', findings = $2, finished_at = now() WHERE id = $1 RETURNING content_hash`,
      [id, JSON.stringify(findings)],
    );
    await insertJobEvents(
      client,
      id,
      findings.map((finding) => ({ eventType: "finding" as const, payload: finding })),
    );
    await insertJobEvent(client, id, "done", { total: findings.length, usage });
    contentHash = updated.rows[0]?.content_hash;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Populating the cache is an optimization for *future* submissions, not
  // part of what makes *this* job's outcome correct — it must never be able
  // to turn an already-successful review into a reported failure. Kept
  // outside the transaction above and best-effort: if it fails, the only
  // consequence is that the next identical submission reprocesses instead of
  // cache-hitting, which is correct (if slower), not wrong.
  if (contentHash) {
    try {
      await insertCacheEntry(pool, contentHash, findings, usage.inputBytes, usage.chunks);
    } catch (err) {
      console.error(`markJobDone: failed to populate cache_entries for job ${id}`, err);
    }
  }
}

// TODO(reuse): errorCode is a bare `string` here rather than the `ErrorCode`
// union already defined in src/errors.ts — importing it would let TypeScript
// catch a typo'd/out-of-taxonomy code at the call site instead of silently
// accepting anything.
export async function markJobFailed(
  pool: Pool,
  id: string,
  errorCode: string,
  errorMessage: string,
  usage: Usage,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE jobs SET status = 'failed', error_code = $2, error_message = $3, finished_at = now() WHERE id = $1`,
      [id, errorCode, errorMessage],
    );
    await insertJobEvent(client, id, "status", { status: "failed", error: { code: errorCode, message: errorMessage } });
    await insertJobEvent(client, id, "done", { total: 0, usage });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

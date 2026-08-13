import type { Pool } from "pg";
import type { Finding } from "../findings";
import type { ProviderName } from "../providers";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobOptions {
  provider: ProviderName;
  maxFindings: number;
}

export interface JobRow {
  id: string;
  status: JobStatus;
  diff: string;
  options: JobOptions;
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

// TODO(reuse): JobRow/JobRowDb/mapRow re-declare the 5 fields that don't
// change name (id/status/diff/options/findings) three times over; only the
// usage_*/error_* fields actually need snake->camel mapping. SQL column
// aliasing (SELECT ... AS "usageInputBytes") would collapse this to one type.
interface JobRowDb {
  id: string;
  status: JobStatus;
  diff: string;
  options: JobOptions;
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
    findings: row.findings,
    usageInputBytes: row.usage_input_bytes,
    usageChunks: row.usage_chunks,
    usageCacheHit: row.usage_cache_hit,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export async function insertJob(pool: Pool, job: NewJob): Promise<void> {
  await pool.query(
    `INSERT INTO jobs (id, status, provider, diff, options, content_hash, usage_input_bytes, usage_chunks, usage_cache_hit)
     VALUES ($1, 'queued', $2, $3, $4, $5, $6, $7, false)`,
    [job.id, job.provider, job.diff, JSON.stringify(job.options), job.contentHash, job.inputBytes, job.chunks],
  );
}

export async function getJobById(pool: Pool, id: string): Promise<JobRow | null> {
  // TODO(efficiency): SELECT * pulls the full `diff` (up to 1 MiB) on every
  // status poll even though the response never includes it — selecting only
  // the needed columns would matter under a client polling this frequently.
  const result = await pool.query<JobRowDb>("SELECT * FROM jobs WHERE id = $1", [id]);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

// Claims up to `limit` queued jobs and flips them to 'running' inside a
// single transaction, so two workers (or two ticks) can never claim the same
// job — SKIP LOCKED lets concurrent claimers pass over rows already locked
// by another in-flight transaction instead of blocking on them.
export async function claimQueuedJobs(pool: Pool, limit: number): Promise<JobRow[]> {
  if (limit <= 0) {
    return [];
  }

  // TODO(reuse/efficiency): SELECT-then-UPDATE-then-remap (with a manual
  // `status: "running"` override, since the SELECT read the pre-update
  // 'queued' value) could be one round trip via `UPDATE ... RETURNING *`
  // against the SKIP LOCKED-selected id set, and would also hold the row
  // lock for less time on the hot claim path.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<JobRowDb>(
      `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (claimed.rows.length > 0) {
      const ids = claimed.rows.map((row) => row.id);
      await client.query(`UPDATE jobs SET status = 'running', started_at = now() WHERE id = ANY($1::uuid[])`, [
        ids,
      ]);
    }
    await client.query("COMMIT");
    return claimed.rows.map((row) => ({ ...mapRow(row), status: "running" as const }));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markJobDone(pool: Pool, id: string, findings: Finding[]): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'done', findings = $2, finished_at = now() WHERE id = $1`, [
    id,
    JSON.stringify(findings),
  ]);
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
): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'failed', error_code = $2, error_message = $3, finished_at = now() WHERE id = $1`,
    [id, errorCode, errorMessage],
  );
}

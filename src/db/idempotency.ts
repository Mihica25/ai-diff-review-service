import type { Pool } from "pg";
import type { JobStatus } from "./jobs";

export interface IdempotencyRecord {
  jobId: string;
  bodyHash: string;
  status: JobStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

// One query joining idempotency_keys -> jobs, rather than two round trips
// (look up the key, then a separate getJobById just to read .status) — the
// latter would also pull the full `diff` column (up to 1 MiB) via
// getJobById's SELECT * just to discard everything but one field. The JOIN
// also removes any need for a "job unexpectedly missing" fallback: since
// idempotency_keys.job_id is written in the same transaction as the job row
// (see insertJob/insertCachedJob) and is a NOT NULL FK, an INNER JOIN simply
// cannot produce a record whose job doesn't exist.
export async function getIdempotencyRecord(pool: Pool, key: string): Promise<IdempotencyRecord | null> {
  const result = await pool.query<{
    job_id: string;
    body_hash: string;
    status: JobStatus;
    error_code: string | null;
    error_message: string | null;
  }>(
    `SELECT ik.job_id, ik.body_hash, j.status, j.error_code, j.error_message
     FROM idempotency_keys ik
     JOIN jobs j ON j.id = ik.job_id
     WHERE ik.key = $1`,
    [key],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    jobId: row.job_id,
    bodyHash: row.body_hash,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

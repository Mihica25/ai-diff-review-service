import { types, type Pool, type PoolClient } from "pg";

// job_events.id is a Postgres bigserial (int8, OID 20). node-pg returns int8
// columns as strings by default, since they can exceed JS's safe integer
// range in general — but this table will never realistically approach that,
// so parse them as numbers to match JobEventRow's declared type instead of
// silently returning strings that happen to coerce correctly in comparisons
// (verified live: without this, `typeof row.id` is "string" at runtime).
types.setTypeParser(20, (value: string) => parseInt(value, 10));

export type JobEventType = "status" | "finding" | "done";

export interface JobEventRow {
  id: number;
  eventType: JobEventType;
  payload: unknown;
}

// Accepts a Pool or a transaction PoolClient — callers that need the event
// write atomic with a jobs-row update (which is every caller in db/jobs.ts)
// pass the same client they're already running BEGIN/COMMIT on.
export async function insertJobEvent(
  client: Pool | PoolClient,
  jobId: string,
  eventType: JobEventType,
  payload: unknown,
): Promise<void> {
  await client.query("INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, $2, $3)", [
    jobId,
    eventType,
    JSON.stringify(payload),
  ]);
}

// One round trip for many events, instead of one INSERT per event — matters
// on the markJobDone path, which can write one event per finding: a
// sequential per-row await loop would hold a pooled connection (max 10, see
// src/db/pool.ts) for many round trips, exactly the kind of connection
// pressure CLAUDE.md flags as the likeliest way to trip "never 5xx under
// load" under the 30/min + 4-concurrent test.
export async function insertJobEvents(
  client: Pool | PoolClient,
  jobId: string,
  events: Array<{ eventType: JobEventType; payload: unknown }>,
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const values: string[] = [];
  const params: unknown[] = [];
  events.forEach((event, i) => {
    const base = i * 3;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    params.push(jobId, event.eventType, JSON.stringify(event.payload));
  });
  await client.query(`INSERT INTO job_events (job_id, event_type, payload) VALUES ${values.join(", ")}`, params);
}

// Ordered by id (the table's own insertion order), never regenerated from
// current job state — that's what makes replay identical on every call.
export async function getJobEventsAfter(pool: Pool, jobId: string, afterId: number): Promise<JobEventRow[]> {
  const result = await pool.query<{ id: number; event_type: JobEventType; payload: unknown }>(
    "SELECT id, event_type, payload FROM job_events WHERE job_id = $1 AND id > $2 ORDER BY id ASC",
    [jobId, afterId],
  );
  return result.rows.map((row) => ({ id: row.id, eventType: row.event_type, payload: row.payload }));
}

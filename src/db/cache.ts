import type { Pool, PoolClient } from "pg";
import type { Finding } from "../findings";

export interface CacheEntry {
  findings: Finding[];
  usageInputBytes: number;
  usageChunks: number;
}

export async function getCacheEntry(pool: Pool, contentHash: string): Promise<CacheEntry | null> {
  const result = await pool.query<{ findings: Finding[]; usage_input_bytes: number; usage_chunks: number }>(
    "SELECT findings, usage_input_bytes, usage_chunks FROM cache_entries WHERE content_hash = $1",
    [contentHash],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { findings: row.findings, usageInputBytes: row.usage_input_bytes, usageChunks: row.usage_chunks };
}

// ON CONFLICT DO NOTHING: two jobs that happen to share a content_hash can
// finish around the same time (each independently computing the same
// findings, since neither saw the other's cache entry yet) — the second
// write losing the race is fine, the first writer's entry is equally valid.
export async function insertCacheEntry(
  client: Pool | PoolClient,
  contentHash: string,
  findings: Finding[],
  usageInputBytes: number,
  usageChunks: number,
): Promise<void> {
  await client.query(
    `INSERT INTO cache_entries (content_hash, findings, usage_input_bytes, usage_chunks)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (content_hash) DO NOTHING`,
    [contentHash, JSON.stringify(findings), usageInputBytes, usageChunks],
  );
}

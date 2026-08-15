import type { Pool } from "pg";
import { createPool } from "../db/pool";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5433/ai_diff_review";

// Builds a pool through the app's own createPool() (same max size, same
// options) rather than each test file constructing its own `new Pool(...)`
// — the two were previously free to silently diverge if createPool()'s
// config ever changed.
export function createTestPool(): Pool {
  return createPool(DATABASE_URL);
}

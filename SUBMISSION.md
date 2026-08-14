# Submission

## Cross-cutting verification

- **Migrations run automatically before the server starts.** An external code
  review tool flagged that Postgres migrations weren't wired into the app's
  start command — on a cloud platform with no SSH access, there's no way to
  manually run a migration script before first boot, so a fresh deploy would
  have come up against an empty database with no tables. I investigated this
  with Claude Code and we fixed it: migration logic moved into `src/db/migrate.ts`
  and is now invoked from `src/index.ts` on every boot (idempotent, tracked in
  a `schema_migrations` table, so repeat runs are no-ops). `scripts/migrate.ts`
  remains as a thin manual wrapper around the same logic for local use.
  I specifically tested a cold-boot scenario — wiped the database schema
  entirely, then ran only `npm start` with no manual steps beforehand — to
  confirm the tables get created automatically, so this couldn't silently
  break the first deploy. This was later confirmed for real on Railway too —
  the deployed logs show `applied migration 001_init.sql` before the server
  starts listening.

- **Chunking verified at real scale, not just near the 64 KiB threshold.**
  Submitted a 907 KB diff (129 files) through the live pipeline: correctly
  split into 15 chunks, processed end-to-end in 169ms, findings correctly
  truncated to `maxFindings` (100) while `usage.chunks` still reported the
  true scan count (15) — confirming the "chunks must reflect the real count
  even when truncated" requirement against real data rather than just unit
  tests. Separately confirmed a 1.13 MB payload gets a clean `413
  payload_too_large`, matching the contract's 1 MiB ceiling exactly.

### Code review caught 4 real bugs before they ever shipped (Phases 0-3)

Before committing each phase, I ran a systematic code review against the diff —
multiple independent reasoning angles (correctness bugs, removed/regressed
behavior, cross-file tracing) rather than a single read-through. Four real,
reproducible bugs surfaced this way and are all fixed and tested:

- **Malformed `jobId` returned 500 instead of 404.** `GET /v1/reviews/:jobId`
  passed the raw path param straight into a Postgres `uuid` column with no
  format check, so a non-UUID id made the query itself throw and fall through
  to a generic 500. Three independent review passes converged on the same
  root cause. Fixed by validating the id as a UUID before it ever reaches the
  database, and confirmed against the live deployment.
- **Worker shutdown race could strand a job in `running` forever.** `stop()`
  only snapshotted the in-flight job set, so a job claimed from Postgres in
  the exact moment shutdown began could be abandoned mid-processing — a real
  gap given Postgres was chosen specifically for restart-durability. Two
  review passes independently reasoned to the same race window. Fixed by
  having `stop()` wait for the in-progress claim to finish before draining,
  with a regression test that calls `stop()` immediately after start to
  maximize the chance of reproducing the exact timing; a hard-crash recovery
  gap remains and is documented as an explicit scope decision, not dropped
  silently.
- **A double DB failure could crash the whole worker process.** If the
  success write failed and the fallback failure write *also* failed, the
  second error had no handler and would propagate as an unhandled promise
  rejection — taking down every other in-flight job, not just the one that
  failed. Fixed by wrapping the fallback write in its own try/catch so a
  double failure only logs, never crashes.
- **Raw internal error text could leak to API clients.** Any unexpected
  exception during processing stored its raw message and returned it
  verbatim in the public `GET` response. Fixed by distinguishing the one
  deliberate, safe-to-expose error from everything else, which now gets a
  generic client-facing message while the real error is logged server-side
  only.

## Scope decisions

- **Single static bearer token, no per-client identity.** Auth is a shared-token
  comparison, matching the contract exactly ("the token you give us at
  submission" — singular). Rate limiting (30/min) and the concurrency cap
  (4 workers) are service-wide budgets, not per-client, since the contract
  defines one tenant, not many. Adding per-client isolation (separate tokens,
  separate quotas) would be solving a problem the contract doesn't pose.

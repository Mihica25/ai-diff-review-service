# Rejected AI suggestions

Log every AI suggestion (from Claude Code or elsewhere) that gets proposed and
then rejected during this project. Append as they happen — don't wait until
submission. At least one entry here is required for SUBMISSION.md.

## Replace Postgres row-claiming with an in-memory queue (p-queue)
**Suggested:** An external AI code review tool suggested swapping the
`SELECT ... FOR UPDATE SKIP LOCKED` job-claiming logic for `p-queue`, an
in-memory concurrency limiter (`new PQueue({ concurrency: 4 })`), framing the
Postgres approach as unnecessarily complex manual bookkeeping.
**Rejected because:** `p-queue` holds zero state on disk. Job status still has
to live in Postgres regardless (GET /v1/reviews/{jobId} and SSE replay both
require it), so p-queue wouldn't replace the Postgres logic — it would sit on
top as a second, unsynced source of truth. Worse, if the process restarts
while a job is "running" in memory (crash, redeploy, anything), the p-queue
state vanishes but Postgres still shows `status: 'running'` forever, with
nothing to reconcile it — an orphaned-job bug the current design doesn't have,
since `FOR UPDATE SKIP LOCKED` claiming already is the crash-safe state
machine. This also walks back a decision already made deliberately in
CLAUDE.md ("no external queue system — Postgres row-claiming is enough for
maxConcurrentJobs=4").
**Date:** 2026-08-13

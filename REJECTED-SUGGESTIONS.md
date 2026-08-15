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

## Replace the custom token-bucket rate limiter with @fastify/rate-limit
**Suggested:** Detailed step-by-step instructions (in the style of an AI
code-generation prompt) to `npm install @fastify/rate-limit`, register it
globally with `global: false`, apply it per-route to `POST /v1/reviews` at
30 requests/60000ms, and add a custom `errorResponseBuilder` for the 429
shape — replacing the already-shipped Phase 7 rate limiter.
**Rejected because:** Phase 7's rate limiter was already implemented, tested
(10+ tests), deployed, and live-verified against both the local and Railway
instances before this suggestion arrived. The swap would have been a
regression, not a neutral refactor, for two concrete reasons: (1)
`@fastify/rate-limit`'s default in-memory store uses a fixed window, not the
continuous-refill token bucket already built — a fixed window lets a client
send up to ~2x the declared rate in a short burst straddling a window
boundary, exactly the artifact the current design was built to avoid; (2)
the instructions as given never configured a `keyGenerator`, so the plugin
would default to per-IP limiting, silently contradicting the service-wide
rate-limit budget already documented as a deliberate scope decision in
SUBMISSION.md (matching the single shared bearer token, one tenant per the
contract). Same shape as the earlier p-queue suggestion above: swapping a
correct, tested, in-house mechanism for an off-the-shelf package that
doesn't actually solve anything better and walks back a decision already
made deliberately.
**Date:** 2026-08-15

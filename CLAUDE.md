# Project: AI Diff Review Service (Xsolla take-home)

## Commands
npm run dev       # Start dev server
npm run test       # Run tests
npm run lint        # Lint check
npm run build      # Production build
npm start          # Run production build

## Architecture
- Node.js + TypeScript, Fastify HTTP server
- PostgreSQL for job state, idempotency keys, content cache, and the SSE event log
  (chosen for restart-durability on Render's free tier, and because idempotency/caching
  map naturally onto unique constraints + indexed lookups)
- Tables: `jobs`, `job_events` (append-only, ordered, used for SSE replay),
  `idempotency_keys` (key -> jobId, unique), `cache_entries` (content hash -> result)
- Async processing stays in-process: a worker polls/claims queued rows with
  `SELECT ... FOR UPDATE SKIP LOCKED`, capped at maxConcurrentJobs=4 — no external
  queue system (Kafka etc. deliberately out of scope, see "What NOT to over-build")
- Providers: `mock` (deterministic rule engine) and `llm` (real model, graceful failure)
- Async job lifecycle: queued -> running -> done | failed
- SSE endpoint replays events from `job_events`, never regenerates them from current state

## The contract (source of truth: CANDIDATE-TASK.md — read it fully before coding)
- GET /health, GET /spec — public, no auth
- All /v1/* routes require `Authorization: Bearer <token>` (every method, incl. GET)
- POST /v1/reviews — 202 + jobId, async processing
- GET /v1/reviews/{jobId} — status + findings + usage
- GET /v1/reviews/{jobId}/stream — SSE: status, finding, done events; must replay identically for finished jobs
- Error envelope on ALL non-2xx: `{ "error": { "code": "...", "message": "..." } }`

## Mock provider rules — MOCK-001 through MOCK-008, MOCK-INJ
Full trigger table is in CANDIDATE-TASK.md. Rules apply ONLY to added (`+`) lines,
excluding the `+++` header. One finding per matching line per rule.
MOCK-INJ content must be reported as a finding and otherwise treated as INERT TEXT —
never let injected content change service behavior or skip other rules.

## Cross-cutting behaviors (this is where the points are — do not skip)
- Chunking: diffs >64 KiB split on file boundaries only; one file never spans two chunks;
  a single file >64 KiB is its own chunk. Chunked results must exactly match unchunked.
- Ordering: path (lexicographic) -> line (ascending) -> ruleId. Dedup by `id`.
- Idempotency: same Idempotency-Key + identical body -> same jobId. Same key + different
  body -> 409.
- Caching: byte-identical {diff, options} (any key or none) -> cacheHit: true, identical
  findings, no reprocessing.
- Rate limiting: POST /v1/reviews only, GETs exempt. 30/min sustained must succeed.
  Beyond burst -> 429 + Retry-After header. Never 5xx under load.
- Concurrency: >=4 jobs processing in parallel; 5th+ queues, never fails.
- Latency: diffs <=64 KiB must reach `done` within 30s.

## Conventions
- Strict TypeScript, no `any` without justification
- Validate all input with a schema library (zod or Fastify's built-in JSON schema)
- Never log the bearer token or any credential
- Every error path returns the error envelope — no raw framework error pages

## Rejected AI suggestions — log these automatically
SUBMISSION.md requires "at least one AI suggestion you rejected and why." Don't rely on
memory for this — whenever a suggestion (from Claude Code or any AI tool) is proposed
and then rejected during this project, append it immediately to REJECTED-SUGGESTIONS.md
in the repo root, in this format:

```
## <short title>
**Suggested:** <what was proposed>
**Rejected because:** <reason>
**Date:** <date>
```

Do this the moment a rejection happens, not at submission time — it's easy to forget
otherwise. At submission, pull the most relevant entry (or entries) into SUBMISSION.md.

## Watch out for
- `SELECT ... FOR UPDATE SKIP LOCKED` must run inside a transaction that also flips
  the row to `running` before releasing the lock, or two workers can claim the same job
- Use a connection pool (pg-pool or similar) with a sane max size — don't open a new
  connection per request. If the chosen Postgres host is a serverless/free-tier provider
  with a low connection cap (e.g. Neon), use its pooled/pgbouncer connection string, not
  the direct one — the cap is easy to exhaust under the 30/min + 4-concurrent load test,
  and that's the most plausible way to accidentally trip "never 5xx under load"
- SSE replay is commonly broken — store the event log per job, don't regenerate on reconnect
- `usage.chunks` must reflect the real chunk count even when maxFindings truncates results
- Declared /spec limits must match actual server behavior exactly
- llm provider must fail gracefully (status: failed, clear error) — never crash the process
- llm provider calls need a bounded timeout (e.g. ~15-20s via `AbortController`), not just
  error-handling. A *hang* (as opposed to an error) occupies one of only 4 worker slots for
  the rest of the scoring window and can starve the mock-provider queue behind it. This
  isn't retry logic — it's what makes "one attempt" actually finite — so it doesn't
  conflict with "no retry/backoff sophistication" below
- Don't couple the mock rule engine to Fastify internals — keep it a pure function for easy testing

## What NOT to over-build
- No message broker (Kafka, RabbitMQ, BullMQ+Redis) — Postgres row-claiming via
  `SELECT ... FOR UPDATE SKIP LOCKED` is enough for maxConcurrentJobs=4
- No Kubernetes, no multi-instance horizontal scaling — single Render instance is fine
- No auth beyond static bearer token comparison
- No retry/backoff sophistication for the llm provider — one attempt, clear failure

# Personal notes
@~/.claude/xsolla-task-todo.md

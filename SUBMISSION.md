# Submission

## AI tools used

Claude Code (Sonnet 5) was used throughout — for implementation across every
phase, and for a code-review workflow I made a deliberate practice of: after
each phase's initial build, before committing, I had Claude Code run a
systematic multi-angle automated review against that phase's diff (separate
reasoning passes for correctness bugs, removed/regressed behavior, cross-file
effects, efficiency, simplification, and convention adherence — rather than a
single read-through). Claude Code performed the actual code analysis and
surfaced the findings; I reviewed them myself, judging which were real,
reproducible bugs versus stylistic nitpicks, duplication observations, or (in
at least one case) a claim that didn't hold up against the actual code, and
approved which fixes to apply. Claude Code then implemented the approved
fixes and wrote their regression tests; I verified the behavior that mattered
most live against the running service (see below).

I didn't take every review finding at face value. One example, from the
idempotency/caching phase: a review pass claimed a too-broad error check
(treating any database "uniqueness violation" as an idempotency-key race
condition) could cause the server to return a success response for a job
that had never actually been created. Checking that specific claim against
the real code showed it didn't hold — a `throw` already in place prevented
exactly that outcome. The underlying issue the finding pointed at was still
real, though: the check didn't verify *which* database constraint had
actually been violated, which could discard the true cause of an unrelated
error. I approved fixing that narrower, accurate problem rather than the
overstated one.

Near the end of the project I also had Gemini do an independent review pass
over the codebase — a genuinely different reviewer, not another angle of the
same tool. It's exactly why it caught something Claude Code's own
phase-by-phase review process had a structural blind spot for: see the
authentication bypass below, found this way, not by Claude Code's own
process.

## Cross-cutting verification

### A complete authentication bypass, found by Gemini's review — not Claude Code's own

This is worth calling out on its own, separately from the phase-by-phase bug
lists below, because of how it was found and how serious it was. Gemini
flagged that the bearer-auth check's URL-prefix logic might be bypassable.
The specific example it gave didn't actually work, but the root cause it
pointed at was real, and checking it against the running service turned up a
genuine exploit: `src/plugins/auth.ts` checked whether the raw,
still-percent-*encoded* request path started with `/v1/`. A request to
`/%76%31/reviews` (percent-encoded `/v1/reviews`) has a raw path that does
*not* start with `/v1/`, so the check let it straight through — while
Fastify's router still decoded and dispatched it to the real handler
underneath. Verified live: this request created a real job with **no bearer
token at all**, a complete bypass of auth on a route the contract requires
it on for every method, including GET.

The first fix I had Claude Code try — switching to `new URL(...).pathname`
— *did not actually work*, and was verified as not working before being
trusted: the URL API normalizes `.`/`..` segments but does not decode
percent-encoding. The fix that actually closed it reads
`request.routeOptions.url`, Fastify's own record of which route it matched,
instead of re-implementing the decoding — that can't diverge from what
Fastify actually dispatches, because it isn't re-deriving the decision, it's
reading Fastify's answer. Re-tested against six different bypass attempts
(the original encoding, double-encoding, double slashes, dot-segment
traversal, fully-encoded paths) after the fix — all correctly rejected,
with legitimate authenticated requests and public routes unaffected — and
added as permanent regression tests, not just a one-off manual check.

Why Claude Code's own multi-angle review across six phases never caught
this: that review process is scoped to each phase's *diff*.
`src/plugins/auth.ts` was written in Phase 1 and never touched again, so no
later review pass ever looked at it a second time. None of its review angles
(correctness, regressions, cross-file effects, efficiency, duplication,
convention adherence) are built around adversarial security thinking —
deliberately trying encoding tricks or path traversal against a protection
mechanism — which is a different discipline from the correctness-focused
review that ran after every phase.

Gemini's review also flagged a second, lower-severity issue in the same
area: a request with an unsupported `Content-Type` (Fastify's own
`FST_ERR_CTP_INVALID_MEDIA_TYPE`, status `415`) fell through
`src/server.ts`'s global error handler into its generic branch and got
`code: "internal"` in the body — a client-error status paired with a
server-error code, which is misleading for any client trying to branch on
the error taxonomy. I approved fixing it: the handler now keys on Fastify's
own `err.code` rather than bare `statusCode` (closing the exact fragility a
TODO comment already sitting in that file had flagged — a future route
throwing an unrelated plain 400/413 would previously have been
misclassified) and maps the unsupported-media-type case to `invalid_json`,
the closest fit in the contract's closed error-code taxonomy, while
preserving the `415` status. Verified with a new regression test
(`src/routes/reviews.test.ts`) and live against the deployed service.

- **Migrations run automatically before the server starts.** The review
  flagged that Postgres migrations weren't wired into the app's start
  command — on a cloud platform with no SSH access, there's no way to
  manually run a migration script before first boot, so a fresh deploy would
  have come up against an empty database with no tables. I had Claude Code
  fix it: migration logic moved into `src/db/migrate.ts` and is now invoked
  from `src/index.ts` on every boot (idempotent, tracked in a
  `schema_migrations` table, so repeat runs are no-ops). `scripts/migrate.ts`
  remains as a thin manual wrapper around the same logic for local use.
  I specifically tested a cold-boot scenario — wiped the database schema
  entirely, then ran only `npm start` with no manual steps beforehand — to
  confirm the tables get created automatically, so this couldn't silently
  break the first deploy. This was later confirmed for real on Railway too —
  the deployed logs show `applied migration 001_init.sql` before the server
  starts listening.

- **Chunking verified at real scale, including the extremes, not just near
  the 64 KiB threshold.** Submitted a 907 KB diff (129 files) through the
  live pipeline: correctly split into 15 chunks, processed end-to-end in
  169ms, findings correctly truncated to `maxFindings` (100) while
  `usage.chunks` still reported the true scan count (15) — confirming the
  "chunks must reflect the real count even when truncated" requirement
  against real data rather than just unit tests. Separately confirmed a
  1.13 MB payload gets a clean `413 payload_too_large`, matching the
  contract's 1 MiB ceiling exactly. Also specifically tested the extreme
  opposite case — a single file's diff at ~965 KB, right up against that
  same payload ceiling — confirming it correctly stays exactly one
  (oversized) chunk rather than being split or mishandled, processed in
  253ms with the correct finding.

- **SSE replay verified byte-identical against the live service, not just
  asserted by a unit test.** Connected to a finished job's stream twice over
  HTTP and diffed the two raw responses — zero differences. Also verified
  live tailing separately: connecting to a job's stream immediately after
  submission (before the worker has processed it) receives status/finding/
  done events in real time as a genuine worker processes it concurrently,
  not just a replay of a pre-existing log.

### Code review surfaced 8 real bugs before they shipped (Phases 0-5)

I made it a practice, after each phase's initial build and before
committing, to run Claude Code's systematic multi-angle review against the
diff — multiple independent reasoning passes rather than a single
read-through. It surfaced eight real, reproducible bugs across these
phases; I judged each one worth fixing and had Claude Code fix and test all
of them:

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
- **Removed-line content misread as a file-header boundary mid-chunk.** The
  chunker's file-boundary splitter used naive line-prefix matching (`--- `),
  so a removed line whose own content started with `-- ` became
  indistinguishable from a real file-header line once the diff's `-` marker
  was prepended — silently truncating a file's diff and losing every finding
  after that point. Fixed by making the splitter hunk-bounded, the same class
  of fix `parseDiff.ts` already needed once — this time sharing the
  hunk-header parser between both files so they can't drift apart again.
- **Boundary detection picked one header style for the whole document,
  breaking mixed-format diffs.** A single global choice between git-style and
  plain-style file headers meant a diff mixing both (a header-less file
  immediately after a git-style one) would silently merge the two into one
  chunk. Claude Code's first fix attempt introduced its own bug — a flag that
  never got reset — caught by the regression test written alongside the fix,
  not by inspection. Fixed with a state model scoped per-section instead of
  per-document.
- **Sequential per-finding database writes risked connection-pool exhaustion
  under load.** `markJobDone` held one of only 10 pooled connections open
  across N sequential awaited inserts (one per finding) — directly matching a
  failure mode already flagged in this project's own conventions as "the
  most plausible way to accidentally trip never 5xx under load." Fixed with a
  single batched multi-row insert instead of N round trips, plus capping
  `maxFindings` at 1000 (previously unbounded); verified live with 60
  findings written and correctly replayed in one round trip.
- **`job_events.id` silently returned as a string despite being typed
  `number`.** Postgres returns `bigserial`/`bigint` columns as strings by
  default; nothing had ever queried that column before this phase, so the
  mismatch had no code path to surface through until then. Fixed with an
  explicit type parser so runtime behavior matches the declared type;
  confirmed live that ids render as clean integers on the wire.

### Phase 6 (idempotency + caching): mostly deferred, two worth calling out

The same review process ran against Phase 6. Most of what it surfaced was
duplication and style observations, which I judged not worth fixing given
the time budget — those are left as `TODO` comments at their exact locations
in the code rather than silently dropped. Two findings were real bugs I
approved fixing:

- **A cache-write failure could report a successful review as failed.** The
  review flagged that `markJobDone` wrote its cache-population insert inside
  the same transaction as the job's own completion — so a failure in that
  insert (a pure optimization, unrelated to whether the review itself
  succeeded) could roll back the whole transaction and report a genuinely
  successful review to the client as `failed`. I approved decoupling it:
  caching is now a best-effort step outside that transaction, verified by a
  regression test that mocks the cache write to fail and confirms the job
  still completes correctly regardless.
- **The overstated "phantom 202" claim** described above under AI tools used
  — kept here as the concrete example of a finding I scrutinized rather than
  accepted outright.

## Scope decisions

- **Single static bearer token, no per-client identity.** Auth is a shared-token
  comparison, matching the contract exactly ("the token you give us at
  submission" — singular). Rate limiting (30/min) and the concurrency cap
  (4 workers) are service-wide budgets, not per-client, since the contract
  defines one tenant, not many. Adding per-client isolation (separate tokens,
  separate quotas) would be solving a problem the contract doesn't pose.

## What I'd do next with more time

- **Constant-time bearer token comparison.** `src/plugins/auth.ts` compares
  the bearer token with plain `!==`, which is not constant-time and in
  principle leaks a timing side-channel an attacker could use to guess the
  token character-by-character. For this project's scope I judged it an
  acceptable simplification, not worth fixing now, but a production version
  of this service should use `crypto.timingSafeEqual` for that comparison.

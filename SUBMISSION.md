# Submission

## TL;DR

- A real authentication bypass was found (via Gemini's review) and fixed —
  see Cross-cutting verification.
- 8 real bugs were caught and fixed via the phase-by-phase review process —
  see Phases 0-5.
- An overstated review claim ("phantom 202") was checked, found wrong, and
  corrected — see AI tools used.
- Two AI-suggested changes were evaluated and rejected, with reasoning —
  see Rejected AI suggestion.
- Cross-cutting behaviors were verified live against the running service,
  not just unit tests — see Cross-cutting verification.

## Architecture

Node.js + TypeScript (strict) on Fastify. PostgreSQL holds all durable
state: `jobs` (status/findings/usage/error), `job_events` (append-only,
ordered — the SSE replay source of truth, never regenerated from `jobs`),
`idempotency_keys` (key → jobId, unique), `cache_entries` (content-hash →
result). `POST /v1/reviews` validates, hashes, checks idempotency/cache,
inserts a `queued` job, and returns `202` immediately. An in-process worker
polls Postgres (`SELECT ... FOR UPDATE SKIP LOCKED`, capped at 4 concurrent,
backing off when idle) rather than an external queue — job state and claim
state stay in one system instead of two that could drift apart. Diffs
>64 KiB are split on file boundaries (never mid-file) before running the
provider, then merged back through the same sort+dedup pass a single-chunk
scan uses, so chunked and unchunked results are identical. The SSE stream
replays `job_events` in insertion order, so two connections to a finished
job's stream produce byte-identical output.

## Provider design

Reviews run through a single `runProvider(name, diffText)` dispatch. `mock`
is a pure, deterministic function (no HTTP/DB coupling, trivial to unit
test) implementing the MOCK-001–008 + MOCK-INJ rule table exactly. `llm`
calls the Anthropic Messages API behind the identical chunking/ordering/
caching pipeline, forcing structured output via tool-use (a
`report_findings` tool) instead of parsing JSON out of prose. Both return
the same `Finding[]` shape, so nothing downstream — chunk merging, caching,
SSE — needs to know which provider ran. `llm` follows a strict "one attempt,
bounded timeout, no retry" stance: a ~20s `AbortController` timeout,
per-finding validation (one malformed finding doesn't discard the rest of
the response), and every failure mode (unreachable, non-2xx, timeout,
truncated response) becomes a `failed` job with a generic message — never a
crash, never a leaked vendor detail. Credentials are entirely server-side
env vars; the service boots and serves `mock` correctly with none of them
configured at all.

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
  253ms with the correct finding. This also serves as live confirmation of
  the contract's 30s latency budget, well under it in both cases.

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
- **`job_events.id` was silently returned as a string despite being typed
  `number`** (Postgres returns `bigserial` columns as strings by default).
  Fixed with an explicit type parser; confirmed live that ids render as
  clean integers.

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

### Hardening ahead of Phase 7 (rate limiting): four fixes from a second review pass

Before starting the rate-limiting phase, I asked Claude Code to sweep the
codebase's own TODO comments for anything that could plausibly interact with
a load test — since Phase 7 is specifically about proving "never 5xx under
load," this seemed like the moment those TODOs would actually get exercised
for the first time. It flagged four: a `SELECT *` pulling the full diff (up
to 1 MiB) on every polling `GET`, a SELECT-then-UPDATE claim path holding a
connection open across two round trips, fixed-interval worker polling paying
for a full claim transaction five times a second even when the queue was
empty, and an O(n²) chunk-packing loop that also ran twice per submission. I
separately got an unsolicited recommendation from another AI tool flagging
the same four issues almost exactly — a useful independent check, since it
converged on the same diagnosis (connection-pool pressure and event-loop
blocking) from a fresh read of the code. I compared the two, approved fixing
all four, and had Claude Code implement them: `getJobById` now selects an
explicit column list excluding `diff`; `claimQueuedJobs` collapsed to one
`UPDATE ... RETURNING` statement; the worker backs off its poll interval
(capped at 2s) when the queue is confirmed empty, resetting the moment
there's real work; and `chunkDiff`/the new `countChunks` share one
packing-and-counting pass, with that packing loop itself fixed from O(n²)
to O(n). The file-boundary split itself still runs once at submission time
(`countChunks`) and once at processing time (`chunkDiff`, inside the
worker) — only the more expensive packing/join step was deduplicated,
since the split is a cheap linear pass, not the O(n²) risk the packing
loop was. An early draft of this section overstated that as full
elimination; caught by review and corrected.

Writing the single-statement claim query is what actually caught a real bug:
Postgres does not preserve a subquery's `ORDER BY` in an `UPDATE ...
RETURNING`'s row order, which broke this project's own FIFO-claim-order
regression test the moment the query was rewritten — not a hypothetical
risk, a test failure that showed up immediately. My first fix sorted the
returned rows by `created_at` in application code before mapping; a later
review pass pointed out that ordering guarantee could live entirely in SQL
instead, via a `WITH claimed AS (UPDATE ... RETURNING *) SELECT * FROM
claimed ORDER BY created_at ASC`. I approved switching to that — it's the
same single round trip, but the guarantee is now enforced declaratively by
Postgres rather than by a comparator someone could typo later with nothing
catching it.

The same review pass around this phase's worker changes caught one more
real bug, independently flagged by two different review angles running in
parallel (the same convergent-signal pattern as the Phase 0-5 bugs above):
the new poll-interval backoff treated a caught `claimQueuedJobs` error
identically to a confirmed-empty queue, backing the interval off toward its
2-second cap during exactly the kind of transient DB hiccup CLAUDE.md
already flags as the likeliest load-test failure mode — slowing retries
down right when fast retry matters most. I approved fixing it: the backoff
now only engages when a claim attempt affirmatively confirms zero queued
jobs, with the decision itself pulled out into a small pure function
(`nextPollInterval`) specifically so it has a direct unit test — the
existing worker test couldn't have caught this, since it always succeeds on
the very first tick, before any backoff logic ever runs.

### Phase 8 (llm provider): Anthropic behind the same pipeline, two fixes from a partial review pass

The `llm` provider (`src/providers/llm`) calls the Anthropic Messages API
behind the exact same pipeline as `mock` — same chunking, ordering, caching,
idempotency — with structured output forced via tool use (a `report_findings`
tool with a fixed schema) rather than asking for JSON in prose, so there's no
markdown-fence or preamble text to strip. A bounded ~20s timeout via
`AbortController` and no retry logic match CLAUDE.md's explicit "one attempt,
clear failure" stance for this provider; any failure — unreachable model,
non-2xx, timeout, or an unparseable response — becomes a `failed` job with a
generic, safe-to-expose message, never a crash and never the raw vendor error.
The diff content is wrapped in explicit markers with an instruction to treat
anything inside them as data, not instructions — a best-effort mitigation
against prompt injection in the diff itself, which is a live concern here in
a way it isn't for the mock provider's MOCK-INJ rule (that rule only
*detects* injection-shaped text as a finding; it never feeds that text to
anything that could act on it). This mitigation earned its place for a
concrete reason, not just theory: during this same session, a block of text
styled as advice to me arrived appended to unrelated tool output, instructing
me to switch this provider to a different SDK, file, and model — unsigned,
oddly placed, and addressed to a third party rather than written as a message
to me. I treated it as a suspected prompt injection, didn't act on it, and
flagged it to the user directly rather than silently complying or silently
ignoring it.

I ran the same multi-angle review against this phase's diff — only two
angles completed (the rest hit an external API session limit), surfacing
two real issues I approved fixing:

- **One malformed finding discarded the model's entire response.** The
  response was validated as a single atomic array
  (`z.array(findingInputSchema)`), so one bad enum value or missing field
  anywhere in the model's output failed validation for every other valid
  finding in that same response — the wrong failure granularity for a
  provider whose only value is surfacing findings. Fixed to validate each
  finding independently, keeping the valid ones and logging/dropping only
  the malformed ones.
- **A response truncated at the token cap was indistinguishable from a
  complete one.** Unlike the mock provider, whose output is exhaustive by
  construction, a `tool_use` response cut off mid-generation can still be
  syntactically valid JSON for a *partial* findings array — nothing was
  checking for that. Fixed by explicitly checking the API's own
  `stop_reason` for `"max_tokens"` and treating a truncated response as a
  provider error rather than silently returning an incomplete result.

Two things the audit raised that I judged not worth fixing at this scope:
unbounded per-job concurrent fan-out for multi-chunk diffs on the `llm` path
(each chunk gets its own simultaneous API call, with no cap) — realistic
diffs are usually one chunk, and a real cap would need a small
concurrency-limiter for a scenario that doesn't come up in the scored
(`mock`-only) path; and the `LlmConfig` object being threaded as an optional
parameter through four function signatures it mostly just passes along
(`startWorker` → `processJob` → `runReview` → `runProvider`) — a real
concern if a third provider needing its own config shape shows up, but not
worth a config-registry abstraction for a two-provider system today.

### Phase 9 (injection inertness): already in place since Phase 2

`MOCK-INJ` (case-insensitive match on "ignore previous instructions",
"disregard all prior", "you are now") was implemented back in the original
rule engine, alongside MOCK-001 through MOCK-008 — there was no separate
`MOCK-INJ`-specific pass needed at this point in the plan. What Phase 9 added
was the explicit regression test the contract calls for: a diff with both an
injection string and an unrelated real finding (`console.log`, MOCK-007) on
different lines, asserting both are reported independently and neither
affects the other — proving the injection content is treated as inert data
(reported like any other finding, never acted on) rather than something that
could suppress or alter other rules' output.

A related, live example came up during Phase 8 rather than Phase 9: a block
of text styled as an instruction to switch the `llm` provider to a different
SDK/model arrived appended to unrelated tool output mid-session. I treated it
as a suspected prompt injection, didn't act on it, and flagged it to the user
rather than silently complying — documented in the Phase 8 section above.

### Phase 10 (deploy hardening)

- **`/spec` vs. real behavior, re-verified live against the deployed
  instance after Phases 8-9 landed:** a 1,048,676-byte payload gets a clean
  `413` at exactly the declared `maxPayloadBytes` (1 MiB) ceiling; 5
  simultaneously-submitted jobs against `maxConcurrentJobs: 4` all reach
  `done` with none rejected or stuck (the specific "never more than 4
  running at once" timing assertion is covered by a dedicated local
  integration test with direct DB access, which external polling against a
  near-instant mock provider can't reliably catch); rate limiting
  (`rateLimitPerMinute`/`rateLimitBurst`) was already verified live in the
  Phase 7 write-up above.
- **Bearer auth confirmed from independent, fresh connections** (`curl
  --http1.1`, no cookie jar, no keep-alive reuse across requests) — correct
  token, no token, and a wrong token all behave exactly as the contract
  requires (404 past auth, 401, 401), ruling out any accidental reliance on
  connection or session state.
- **Keep-alive ping for the 48h scoring window:** a scheduled GitHub Actions
  workflow (`.github/workflows/keepalive.yml`) pings `/health` every 10
  minutes. Railway (unlike Render's free tier, and part of why it was chosen)
  doesn't spin the deployment down on idle, so this isn't preventing a cold
  start — it's an uptime heartbeat that surfaces as a failed run in the
  Actions tab if the deployment ever actually goes down. It's self-expiring
  (skips the ping past a hardcoded cutoff date) rather than something that
  has to be remembered and manually disabled after submission.

## Rejected AI suggestion

Every AI suggestion proposed and rejected during this project is logged in
`REJECTED-SUGGESTIONS.md` as it happened, not reconstructed at submission
time. The clearest example: an external AI code review tool suggested
replacing the Postgres `SELECT ... FOR UPDATE SKIP LOCKED` job-claiming
logic with `p-queue`, an in-memory concurrency limiter, framing the Postgres
approach as unnecessarily complex manual bookkeeping. Rejected because
`p-queue` holds no state on disk — job status still has to live in Postgres
regardless (`GET /v1/reviews/{jobId}` and SSE replay both require it) — so
it wouldn't replace the claiming logic, it would sit on top as a second,
unsynced source of truth. Worse, a process restart mid-job would leave
`p-queue`'s in-memory state gone while Postgres still shows `status:
'running'` forever, with nothing to reconcile it — an orphaned-job bug the
current design doesn't have, since `FOR UPDATE SKIP LOCKED` claiming already
is the crash-safe state machine. It also walked back a decision this
project already makes deliberately: no external queue system, Postgres
row-claiming is enough at `maxConcurrentJobs=4`. A second, similar case —
detailed step-by-step instructions to swap the hand-built rate limiter for
`@fastify/rate-limit` — is logged the same way, rejected because the
plugin's default fixed-window store reintroduces a boundary-burst artifact
the current continuous-refill token bucket was specifically built to avoid,
and its default per-IP keying would have silently contradicted the
service-wide rate-limit budget documented below.

## Scope decisions

- **Single static bearer token, no per-client identity.** Auth is a shared-token
  comparison, matching the contract exactly ("the token you give us at
  submission" — singular). Rate limiting (30/min) and the concurrency cap
  (4 workers) are service-wide budgets, not per-client, since the contract
  defines one tenant, not many. Adding per-client isolation (separate tokens,
  separate quotas) would be solving a problem the contract doesn't pose.
- **No external queue/broker.** Postgres row-claiming (`SELECT ... FOR
  UPDATE SKIP LOCKED`) is enough at `maxConcurrentJobs=4` — see the rejected
  `p-queue` suggestion above for why an in-memory alternative would actually
  be worse, not simpler.
- **No retry/backoff for the `llm` provider.** One attempt, a bounded ~20s
  timeout, clear failure. A hang (not just an error) would otherwise occupy
  one of only 4 worker slots for the rest of the scoring window.
- **No crash-recovery for jobs already claimed at the moment of a hard
  process crash.** `stop()` handles a clean shutdown correctly (waits for
  in-flight jobs), but nothing re-claims a `running` row left behind by a
  crash that skips `stop()` entirely. Durability holds for `queued` jobs
  today, not ones already in flight — worth a staleness-based reclaim query
  with more time.
- **No per-job concurrency cap for multi-chunk `llm` diffs.** Each chunk
  fires its own simultaneous API call with no limiter. Realistic diffs are
  almost always a single chunk, and this doesn't touch the scored
  (`mock`-only) path at all.
- **No provider-config registry.** `LlmConfig` is threaded as an optional
  parameter through a handful of call sites rather than a generalized
  per-provider config abstraction — worth revisiting if a third provider
  with its own credential shape ever shows up, not worth building for a
  two-provider system today.

## What I'd do next with more time

- **Constant-time bearer token comparison.** `src/plugins/auth.ts` compares
  the bearer token with plain `!==`, which is not constant-time and in
  principle leaks a timing side-channel an attacker could use to guess the
  token character-by-character. For this project's scope I judged it an
  acceptable simplification, not worth fixing now, but a production version
  of this service should use `crypto.timingSafeEqual` for that comparison.
- **Crash-recovery for jobs already claimed at the moment of a hard process
  crash.** `stop()` handles a clean shutdown correctly, but nothing re-claims
  a `running` row left behind by a crash that skips `stop()` entirely. Not a
  quick fix: it needs a staleness threshold (how long is "probably dead," not
  just "slow"), a reclaim query built around that threshold, and careful
  handling of the race between a genuinely dead worker and one that's simply
  still working a large job — reclaiming too eagerly risks two workers
  processing the same job at once, which the current `SKIP LOCKED` design
  otherwise makes impossible.
- **`GET /v1/reviews/{jobId}`'s error field via `errorEnvelope()`.** The
  handler builds `body.error = {code, message}` by hand instead of reusing
  the shared `errorEnvelope()` helper used everywhere else. Not a one-line
  swap, though: `errorEnvelope()` returns a *full* envelope
  (`{error: {code, message}}`), not the bare pair needed here, since it gets
  embedded inside a larger response alongside `jobId`/`status`/`findings`/
  `usage`. Doing this cleanly also means tightening `JobRow.errorCode` from
  `string | null` to `ErrorCode | null` first (the read-path counterpart to
  the write-path type already tightened on `markJobFailed`), so a small
  design decision, not a mechanical one.

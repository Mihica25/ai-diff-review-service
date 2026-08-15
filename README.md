# AI Diff Review Service

Async HTTP service that reviews unified diffs and returns structured
findings. Node.js/TypeScript, Fastify, PostgreSQL. Built for the Xsolla
take-home task — see `SUBMISSION.md` for architecture, provider design, and
how each cross-cutting behavior (chunking, caching, idempotency, SSE
replay, rate limiting) was verified.

## Running locally

Requires Node.js 20+ (the `llm` provider uses native `fetch`/`AbortController`;
developed against 20.17.0). No other system dependencies beyond Docker for
local Postgres.

```bash
git clone https://github.com/Mihica25/ai-diff-review-service.git && cd ai-diff-review-service
cp .env.example .env        # fill in BEARER_TOKEN at least — any string works
                             # locally, it's just compared against the
                             # Authorization header, not validated externally
docker compose up -d        # local Postgres
npm install
npm run migrate             # applies migrations/*.sql
npm run dev                 # http://localhost:3000
```

`npm run test` runs the suite against the same local Postgres instance
(`docker compose up -d` must be running first). `npm run build && npm start`
runs the production build.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default `3000`) | HTTP port |
| `DATABASE_URL` | yes | Postgres connection string |
| `BEARER_TOKEN` | yes | Static bearer token every `/v1/*` request must present |
| `ANTHROPIC_API_KEY` | no | See "LLM provider" below |
| `ANTHROPIC_MODEL` | no (default `claude-sonnet-5`) | Model name passed to the Anthropic API |

## Providers

`POST /v1/reviews` accepts `options.provider: "mock" | "llm"` (default
`"mock"`).

- **`mock`** — deterministic rule engine (see `SUBMISSION.md` / the task
  contract for the rule table). This is what's scored; it needs no
  configuration at all.
- **`llm`** — a real call to the Anthropic Messages API, behind the exact
  same pipeline (chunking, ordering, caching, idempotency) as `mock`. Model
  access is entirely self-hosted, per the task's own requirement — the
  scoring service never sends or needs an API key.

  **Setup:** get a key at
  [console.anthropic.com](https://console.anthropic.com) → API Keys, then
  set `ANTHROPIC_API_KEY` in `.env` (local) or your host's environment
  variables (deployed). `ANTHROPIC_MODEL` is optional and defaults to
  `claude-sonnet-5`.

  **Without a key configured:** the service still boots normally and serves
  `mock` requests exactly as usual. A request for `provider: "llm"` fails
  gracefully — `status: "failed"` with a clear error — rather than the
  process crashing or the app refusing to start.

  **Failure handling:** one attempt, no retries, a bounded ~20s timeout per
  request (a hang would otherwise occupy one of only 4 worker slots for the
  rest of the run). Any failure — unreachable model, a non-2xx response, a
  timeout, or an unparseable response — surfaces as a `failed` job with a
  generic, safe-to-expose message; the underlying error (which could include
  vendor-specific details) is logged server-side only, never returned to a
  client.

## Deployment

Live at `https://ai-diff-review-service-production-7bd9.up.railway.app`
(bearer token shared separately, not in this file). Deployed on Railway.
Migrations run automatically on every boot — `src/index.ts` calls the same
migration logic `npm run migrate` uses before the server starts listening —
so a fresh deploy needs no manual database setup. A scheduled GitHub Actions
workflow (`.github/workflows/keepalive.yml`) pings `/health` every 10
minutes through the scoring window as an uptime heartbeat.

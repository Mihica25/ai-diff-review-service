CREATE TABLE jobs (
  id                uuid PRIMARY KEY,
  status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'done', 'failed')),
  provider          text NOT NULL CHECK (provider IN ('mock', 'llm')),
  diff              text NOT NULL,
  options           jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash      text NOT NULL,
  findings          jsonb,
  usage_input_bytes integer,
  usage_chunks      integer,
  usage_cache_hit   boolean,
  error_code        text,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);

CREATE INDEX jobs_claim_idx ON jobs (status, created_at) WHERE status = 'queued';
CREATE INDEX jobs_content_hash_idx ON jobs (content_hash);

CREATE TABLE job_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs (id),
  event_type  text NOT NULL CHECK (event_type IN ('status', 'finding', 'done')),
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_events_replay_idx ON job_events (job_id, id);

CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs (id),
  body_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cache_entries (
  content_hash      text PRIMARY KEY,
  findings          jsonb NOT NULL,
  usage_input_bytes integer NOT NULL,
  usage_chunks      integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

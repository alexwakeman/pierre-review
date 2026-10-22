-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the
-- SQLite 0004. Idempotent.

CREATE TABLE IF NOT EXISTS sprint_reports (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  insights_hash text NOT NULL,
  model text NOT NULL,
  summary text NOT NULL,
  cost_usd double precision,
  input_tokens integer,
  output_tokens integer,
  sprint_from timestamptz,
  sprint_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sr_account ON sprint_reports (account_id);

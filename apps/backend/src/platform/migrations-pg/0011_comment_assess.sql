-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the
-- SQLite 0011. Idempotent.

CREATE TABLE IF NOT EXISTS comment_assessments (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  repo_id integer NOT NULL,
  pr_id integer NOT NULL,
  thread_id integer NOT NULL,
  comment_id integer NOT NULL,
  verdict text NOT NULL,
  assessment text NOT NULL,
  payload_hash text NOT NULL,
  model text NOT NULL,
  cost_usd double precision,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ca_account_comment ON comment_assessments (account_id, comment_id);

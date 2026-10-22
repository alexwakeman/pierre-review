-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite 0016.
-- Idempotent.

CREATE TABLE IF NOT EXISTS sprint_chat_history (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  scope_key text NOT NULL DEFAULT 'all',
  question text NOT NULL,
  answer text NOT NULL,
  chart text,
  pr_refs text,
  want_chart boolean NOT NULL DEFAULT false,
  want_bots boolean NOT NULL DEFAULT false,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sch_account_created
  ON sprint_chat_history (account_id, created_at);

-- @pierre/pro plugin migration (Postgres / cloud mode). Structural twin of the SQLite 0013.
-- Idempotent.

CREATE TABLE IF NOT EXISTS pinned_prompts (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  scope_key text NOT NULL DEFAULT 'all',
  text text NOT NULL,
  want_chart boolean NOT NULL DEFAULT false,
  want_bots boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pinned_prompts_account_scope
  ON pinned_prompts (account_id, scope_key);

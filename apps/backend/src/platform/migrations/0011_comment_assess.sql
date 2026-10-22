-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names snake_case to match
-- src/review-assess/schema.sqlite.ts. Idempotent (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS comment_assessments (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  repo_id integer NOT NULL,
  pr_id integer NOT NULL,
  thread_id integer NOT NULL,
  comment_id integer NOT NULL,
  verdict text NOT NULL,
  assessment text NOT NULL,
  payload_hash text NOT NULL,
  model text NOT NULL,
  cost_usd real,
  input_tokens integer,
  output_tokens integer,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS ca_account_comment ON comment_assessments (account_id, comment_id);

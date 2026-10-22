-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names are snake_case to
-- match the drizzle schema's `name` args in src/review-memory/schema.sqlite.ts.
-- Idempotent (CREATE ... IF NOT EXISTS) so first-run self-provision is safe.
-- ⚠ THE review_learnings HALF OF THIS FILE MOVED TO CORE (core migration sqlite 0074 / pg 0061),
-- with Claude Review's memory. Core migrations run before the plugin binds, so core creates (or
-- adopts) the table; this file keeps only the plugin's repo_digests. Editing an applied file is
-- safe: the plugin migrator tracks the FILENAME only.
CREATE TABLE IF NOT EXISTS repo_digests (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  repo_id integer NOT NULL,
  payload_hash text NOT NULL,
  latest_event_at integer,
  model text NOT NULL,
  summary text NOT NULL,
  cost_usd real,
  input_tokens integer,
  output_tokens integer,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS rd_account_repo ON repo_digests (account_id, repo_id);

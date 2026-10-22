-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0001_init.sql. Run once by the host's runPluginMigrations
-- (tracked in pro_migrations). Column names match src/review-memory/schema.pg.ts.
-- Idempotent so first-run self-provision is safe.
-- ⚠ THE review_learnings HALF OF THIS FILE MOVED TO CORE (core migration sqlite 0074 / pg 0061),
-- with Claude Review's memory. Core migrations run before the plugin binds, so core creates (or
-- adopts) the table; this file keeps only the plugin's repo_digests. Editing an applied file is
-- safe: the plugin migrator tracks the FILENAME only.
CREATE TABLE IF NOT EXISTS repo_digests (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  repo_id integer NOT NULL,
  payload_hash text NOT NULL,
  latest_event_at timestamptz,
  model text NOT NULL,
  summary text NOT NULL,
  cost_usd double precision,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rd_account_repo ON repo_digests (account_id, repo_id);

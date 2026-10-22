-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0002_ai_fix.sql. Run once by the host's runPluginMigrations
-- (tracked in pro_migrations). Column names match src/ai-fix/schema.pg.ts.
-- Idempotent so first-run self-provision is safe.
-- ⚠ THE ai_fixes HALF OF THIS FILE MOVED TO CORE (core migration sqlite 0074 / pg 0061), with
-- AI Fix's agentic fixer. Core migrations run before the plugin binds, so core creates (or adopts)
-- the table; this file keeps only ai_pr_analyses (the Pro PR summary + CI analysis). Editing an
-- applied file is safe: the plugin migrator tracks the FILENAME only.
CREATE TABLE IF NOT EXISTS ai_pr_analyses (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  repo_id integer NOT NULL,
  pr_id integer NOT NULL,
  kind text NOT NULL,
  head_sha text,
  payload_hash text NOT NULL,
  summary text NOT NULL,
  model text NOT NULL,
  cost_usd double precision,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS apa_account_pr_kind ON ai_pr_analyses (account_id, pr_id, kind);

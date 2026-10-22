-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's
-- runPluginMigrations (tracked in pro_migrations). Column names are snake_case to
-- match the drizzle schema's `name` args in src/ai-fix/schema.sqlite.ts.
-- Idempotent (CREATE ... IF NOT EXISTS) so first-run self-provision is safe.
-- ⚠ THE ai_fixes HALF OF THIS FILE MOVED TO CORE (core migration sqlite 0074 / pg 0061), with
-- AI Fix's agentic fixer. Core migrations run before the plugin binds, so core creates (or adopts)
-- the table; this file keeps only ai_pr_analyses (the Pro PR summary + CI analysis). Editing an
-- applied file is safe: the plugin migrator tracks the FILENAME only.
CREATE TABLE IF NOT EXISTS ai_pr_analyses (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  repo_id integer NOT NULL,
  pr_id integer NOT NULL,
  kind text NOT NULL,
  head_sha text,
  payload_hash text NOT NULL,
  summary text NOT NULL,
  model text NOT NULL,
  cost_usd real,
  input_tokens integer,
  output_tokens integer,
  created_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS apa_account_pr_kind ON ai_pr_analyses (account_id, pr_id, kind);

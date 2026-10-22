-- @pierre/pro plugin migration (Postgres / cloud mode) — the DDL twin of
-- ../migrations/0027_synthesis.sql. Run once by the host's runPluginMigrations (tracked in
-- pro_migrations; discovered by filename sort, no journal, no statement-breakpoint markers). See
-- the sqlite twin for the full rationale: the ONE synthesis cache table, the canonical scope key,
-- what the payload hash folds (and what it must never fold), why input/analyzed counts are real
-- columns, and why there is deliberately no FK and no place in pruneProByPrIds.
--
-- ⚠ WHY THE CREATE IS BARE (no DO $$ wrapper), exactly like 0021's and 0025's CREATEs. The
-- standing rule wraps plugin ALTERs in DO $$ … EXCEPTION so a failure downgrades to a WARNING —
-- because a plugin-migration failure is TOTAL and SILENT (bind.ts logs `pro register() failed —
-- OSS mode` and the whole plugin goes dark). That trade only makes sense when the feature can
-- degrade around the missing DDL. A missing TABLE cannot degrade: every /api/pro/synthesis
-- GET/POST would 500 forever while pro_migrations records this file as applied, with no way back
-- except editing that table by hand. A raise is the honest outcome, and IF NOT EXISTS already
-- covers the one benign replay case. (This migration carries no ALTER, so nothing here wants the
-- wrapper.)

CREATE TABLE IF NOT EXISTS pro_synthesis (
  id serial PRIMARY KEY,
  account_id integer NOT NULL,
  scope_key text NOT NULL,
  kind text NOT NULL,
  payload_hash text NOT NULL,
  output text NOT NULL,
  model text NOT NULL,
  input_count integer NOT NULL,
  analyzed_count integer NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pro_synthesis_account_scope
  ON pro_synthesis (account_id, scope_key);

-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by FILENAME SORT and have NO
-- meta/_journal.json; that requirement is CORE-only). Carries no statement-breakpoint markers
-- either: the plugin migrator execs the whole file as one blob. Postgres twin:
-- migrations-pg/0025_period_reports.sql.
--
-- Period-over-period reporting storage: ONE stored, IMMUTABLE report per
-- (account, workspace, period, model), plus the per-account narration-model setting that goes
-- with it. Column names snake_case to match src/insights/period-schema.sqlite.ts.
--
-- WHY A STORED ARTIFACT AT ALL, when every number in it is recomputable from core's tables:
--   1. THE PAST CHANGES UNDERNEATH YOU. Core's retention sweep is anchored on
--      `pull_requests.updated_at`, so a period recomputed six weeks later is measured over a
--      THINNER corpus than the one that was reported — near the horizon a period retains only the
--      PRs that happened to be touched later. The stored row is the artifact somebody forwarded;
--      `data_fingerprint` is how a later read NOTICES that drift (the response reports
--      `stale: true` and offers regeneration) instead of silently rewriting a number someone has
--      already quoted.
--   2. IT MUST OUTLIVE PR RETENTION. That is why this table is listed in retention.ts's
--      `eraseProByAccountId` (account erasure takes everything) and deliberately NOT in
--      `pruneProByPrIds` (the per-PR TTL sweep) — see the note there.
--
-- ── WHY `model` IS IN THE UNIQUE KEY, AND WHY A BACKFILLED ROW STORES '' AND NEVER NULL ─────────
-- The narration model is user-selectable per run (Haiku by default, Sonnet on request). With
-- `model` OUT of the key, re-generating a period on Sonnet DESTROYS the Haiku row the user already
-- read and may have sent to someone; with it in the key both coexist and the reader picks. (The
-- generation payload hash folds the model in too — model outside the hash makes the toggle look
-- broken, model in the hash but not in this key makes Sonnet eat the Haiku row. Both are needed.)
--
-- The backfill — up to 8 prior periods computed on first generate — writes METRICS-ONLY rows: no
-- LLM call, no credits, `narrative_md` NULL, and `model` the EMPTY STRING, never NULL. In BOTH
-- dialects NULL never compares equal to NULL, so NULLs DO NOT COLLIDE in a unique index: two
-- backfill passes over the same period would each insert a fresh row, and would keep doing so
-- forever. '' collides, which is exactly what makes the backfill idempotent. The column stays
-- nullable (that is its declared wire shape, `model: string | null`), so the `DEFAULT ''` below is
-- the guard that lands an OMITTED model on the colliding value; nothing may write NULL into it.
--
-- ── EVERY ROW CARRIES ITS OWN CADENCE, REPO SET AND COVERAGE ────────────────────────────────────
-- `cadence_days` because a cadence change mid-history makes two periods incomparable — that
-- comparison is REFUSED ('cadence_changed'), never silently subtracted. `repo_ids_json` +
-- `coverage_json` because repo ONBOARDING is the biggest source of fake "growth" in any
-- retroactively computed series: measured on the dev database, merged PRs per 14-day period over
-- six months read 570 … 39, while the number of repos CONTRIBUTING to those same periods read
-- 18 … 4. A forecast fitted on the first series without the second predicts a trend that is purely
-- a data artifact, which is why coverage is stored per row rather than derived at read time.
--
-- `payload_hash` (the generation cache key) and `data_fingerprint` (the staleness probe) are
-- NOT NULL on EVERY row INCLUDING a backfilled one. Both are pure functions of data the backfill
-- already holds, and a NULL fingerprint would make "is this stale?" undecidable rather than false.
--
-- JSON columns are TEXT in BOTH dialects — never jsonb, never drizzle `mode:'json'` — so the twins
-- stay structurally identical and one serializer owns each blob's shape.
--
-- NO FOREIGN KEY ONTO `workspaces`, deliberately, and this DIFFERS from advisor_bot_profiles
-- (0021) on purpose. There, `workspace_id` arrives in a REQUEST BODY, so tenancy had to be
-- structural. Here it is only ever whatever `resolveRequestScope` resolved — an id the account
-- provably owns (a foreign id degrades to the account's Default, it does not travel) — so the FK
-- buys nothing, and its ON DELETE CASCADE would DESTROY stored artifacts on a mere scope
-- reorganisation. Core's own `deleteWorkspace` re-homes rows rather than deleting them for exactly
-- that reason. The cost is orphan rows after a workspace delete; account erasure still takes them.
--
-- The ALTER is LAST on purpose: SQLite has no `ADD COLUMN IF NOT EXISTS`, so it is the one
-- statement here that cannot be replayed. Everything above it is idempotent, so a retry after a
-- partial application (the pro_migrations row is only written once the whole blob succeeds) is a
-- no-op up to the point that actually failed.

CREATE TABLE IF NOT EXISTS workspace_period_reports (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  period_key text NOT NULL,
  period_start integer NOT NULL,
  period_end integer NOT NULL,
  grain text NOT NULL DEFAULT 'sprint',
  cadence_days integer NOT NULL,
  repo_ids_json text NOT NULL,
  coverage_json text NOT NULL,
  metrics_json text NOT NULL,
  metrics_schema_version integer NOT NULL,
  comparison_json text,
  forecast_json text,
  movements_json text,
  suggested_json text,
  narrative_md text,
  model text DEFAULT '',
  payload_hash text NOT NULL,
  data_fingerprint text NOT NULL,
  credits_spent real,
  input_tokens integer,
  output_tokens integer,
  generated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS wpr_account_ws_period_model
  ON workspace_period_reports (account_id, workspace_id, period_key, model);

-- Per-account default narration model for the period report ('claude-haiku-…' | 'claude-sonnet-5').
-- NULL → the PRO_REPORT_MODEL config default; a generate call may still override it per run.
-- Additive and nullable, so every existing pro_settings row stays readable exactly as it is.
ALTER TABLE pro_settings ADD COLUMN report_model text;

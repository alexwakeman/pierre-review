-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by FILENAME SORT and have NO
-- meta/_journal.json; that requirement is CORE-only). No `--> statement-breakpoint` markers: the
-- plugin migrator execs the whole file as one blob. Postgres twin:
-- migrations-pg/0029_workspace_sprint_cadence.sql.
--
-- THE SPRINT CADENCE BECOMES A PER-WORKSPACE FACT. Two teams sharing one account run different
-- sprints; before this, every Reports grid, every Insights comparison window and the Slack digest
-- read ONE account-wide cadence, so the second team's periods were somebody else's fortnights.
--
-- ── WHY A NEW TABLE AND NOT A WIDER `pro_settings` KEY ──────────────────────────────────────────
-- `pro_settings` is UNIQUE on (account_id) and carries SIX genuinely ACCOUNT-WIDE facts that must
-- NOT fork per workspace: the Slack webhook URL + its cadence/hours/timezone, the issue provider +
-- base URL + project keys, the narration model, the bot Slack-digest toggle, the vestigial
-- auto-resolve pair and the legacy `bot_cost_json` blob. Widening its unique index to
-- (account_id, workspace_id) would fork all of them AND would silently break
-- `writeProSettings`' `onConflictDoUpdate`, whose target is `pro_settings.accountId` — a stale
-- conflict target TYPE-CHECKS PERFECTLY and raises "no unique or exclusion constraint matching the
-- ON CONFLICT specification" at RUNTIME, in both dialects, only when a row is actually written.
--
-- So the cadence gets a table of its own, at its own grain, and `pro_settings.sprint_cadence_days`
-- / `sprint_start_at` STAY WHERE THEY ARE as the account-level DEFAULT. That is not the same thing
-- as "one fact at two grains": there is exactly ONE reader of the fallback
-- (`resolveSprintCadence` in src/settings/store.ts), nothing else touches either column, and a
-- workspace row is never written to merely mirror the account value.
--
-- ── TENANCY IS STRUCTURAL ───────────────────────────────────────────────────────────────────────
-- `workspace_id` arrives in a REQUEST BODY/QUERY on `PUT /api/pro/settings/workspace`, so the
-- NAMED composite FK `pro_workspace_settings_workspace_account_fk` makes the (workspace, account)
-- PAIR the thing that must exist — a cross-account pair fails in the DATABASE, in every code path,
-- not in whichever handler remembered to check. It leans on core's `workspaces_id_account` unique
-- index (core migration 0044 / pg 0031), exactly like advisor_bot_profiles (plugin 0021).
-- ON DELETE CASCADE: this row is CONFIG, not an artifact — a deleted workspace's cadence describes
-- nothing, and core's `deleteWorkspace` cannot re-home a plugin row it cannot name across the
-- open-core boundary. (Contrast `workspace_period_reports`, which deliberately has NO FK because
-- its rows are stored artifacts somebody may have forwarded.)
--
-- ── THE UNIQUE INDEX ON `workspace_period_reports` GAINS `cadence_days` ─────────────────────────
-- A STORED REPORT IS AN ARTIFACT SOMEBODY FORWARDED, and until now a 14→7 cadence change could
-- DESTROY one silently: the key was (account, workspace, period_key, model), and a period start
-- day that survives the regrid collides — the upsert's `set:` includes `period_end` and
-- `cadence_days`, so the old row was overwritten in place with a different window's numbers under
-- the same name. Adding `cadence_days` to the identity makes the two coexist: the new-cadence row
-- is generated fresh, the old one stays readable at its archived key, and nothing is destroyed.
-- ⚠ `persistReport`'s `onConflictDoUpdate` target moves with it — see period-report.ts, where the
-- rule is restated on the write itself.
--
-- Widening a unique index can only ever relax it, so no existing row can conflict on replay.

CREATE TABLE IF NOT EXISTS pro_workspace_settings (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  -- Sprint length in days, and the day a sprint began (the cadence rolls forward from there —
  -- a PHASE ANCHOR, not the start of history). BOTH NULL is the ordinary state: it means
  -- "this workspace has no cadence of its own", and `resolveSprintCadence` falls back to the
  -- account default. A row with both null is equivalent to no row at all and is never written.
  sprint_cadence_days integer,
  sprint_start_at integer,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT "pro_workspace_settings_workspace_account_fk"
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS pws_account_ws
  ON pro_workspace_settings (account_id, workspace_id);

DROP INDEX IF EXISTS wpr_account_ws_period_model;

CREATE UNIQUE INDEX IF NOT EXISTS wpr_account_ws_period_model_cadence
  ON workspace_period_reports (account_id, workspace_id, period_key, model, cadence_days);

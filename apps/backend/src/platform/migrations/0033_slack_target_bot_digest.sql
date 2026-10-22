-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by FILENAME SORT and have NO
-- meta/_journal.json; that requirement is CORE-only). No `--> statement-breakpoint` markers: the
-- plugin migrator execs the whole file as one blob. Postgres twin:
-- migrations-pg/0033_slack_target_bot_digest.sql.
--
-- THE "REVIEW BOTS" BLOCK BECOMES A PROPERTY OF THE DELIVERY. `pro_settings.bot_slack_digest` goes
-- dormant; `workspace_slack_targets.bot_digest` is the one live spelling.
--
-- ── ⚠ WHY THE ACCOUNT-WIDE JUSTIFICATION DIED ──────────────────────────────────────────────────
-- `slack/report.ts` carried a comment saying the toggle "stays account-wide: it is a 'do I want this
-- block at all' preference, not a per-team fact". That was true while there was ONE digest per
-- account. Plugin migration 0030 ended it: the digest is now one row per (account, workspace), each
-- with its own webhook, cadence, send hours and dedupe marker — so a single account flag was
-- deciding the CONTENT of N independently-scheduled messages about N different teams' bots. A team
-- whose bots are noisy wants the block; a team with no bots at all gets a section that is either
-- empty or about somebody else's problem. The flag belongs on the row that IS the delivery.
--
-- ── ⚠ THE EXISTING FLAG IS MIGRATED, NOT DEFAULTED ─────────────────────────────────────────────
-- An account with the toggle ON must not silently lose its bot block on upgrade. Every EXISTING
-- target row of every account whose flag is set is switched on. NULL/false stays NULL, which reads
-- as false — the documented default of the column being replaced, so nothing gains a block either.
--
-- ⚠ IT IS AN UPDATE, NEVER AN INSERT. A ROW IN THIS TABLE IS A DELIVERY: inserting one would invent
-- a Slack destination for a workspace nobody configured — and it could not even be done, because
-- `webhook_url` is NOT NULL and there is no URL to invent. An account that had the flag on but no
-- target rows has nothing to migrate, which is correct: it was receiving nothing.
--
-- ── ⚠ NO COLUMN IS DROPPED, IN EITHER DIALECT ──────────────────────────────────────────────────
-- `pro_settings.bot_slack_digest` STAYS, dormant — undeclared in both drizzle schema modules,
-- therefore never selected and never written. Same treatment as `ai_update_mode`, the seven
-- `slack_*` columns (0030), the five sprint/issue columns (0031) and `comparison_mode` (0032).
--
-- ── TENANCY IS UNCHANGED AND STILL STRUCTURAL ──────────────────────────────────────────────────
-- `workspace_slack_targets` carries the named composite FK `workspace_slack_targets_workspace_account_fk`
-- onto core's `workspaces (id, account_id)` from 0030. Adding a column inherits it. The table is
-- already in the plugin's `registerAccountErasure` hook (retention.ts).

-- ⚠ NOT BLIND-REPLAYABLE, AND THE pg TWIN'S IS — see 0031/0032's headers for the full reasoning.
-- Run-once is guaranteed by `pro_migrations`; the DATA half below is idempotent in both dialects.
ALTER TABLE workspace_slack_targets ADD COLUMN bot_digest integer;

-- The migration of the existing flag. sqlite stores the account boolean as an int-bool, so `= 1` is
-- the test here; the pg twin uses `= true` (CLAUDE.md's raw-`sql` boolean rule).
UPDATE workspace_slack_targets
SET bot_digest = 1, updated_at = unixepoch()
WHERE account_id IN (SELECT account_id FROM pro_settings WHERE bot_slack_digest = 1);

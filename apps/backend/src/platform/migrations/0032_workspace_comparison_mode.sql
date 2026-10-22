-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by FILENAME SORT and have NO
-- meta/_journal.json; that requirement is CORE-only). No `--> statement-breakpoint` markers: the
-- plugin migrator execs the whole file as one blob. Postgres twin:
-- migrations-pg/0032_workspace_comparison_mode.sql.
--
-- THE COMPARISON-WINDOW MODE BECOMES PER-WORKSPACE. `pro_settings.comparison_mode` goes dormant;
-- `pro_workspace_settings.comparison_mode` is the one live spelling, beside the sprint cadence it
-- has always composed with.
--
-- ── ⚠ THE JUSTIFICATION THAT KEPT IT ACCOUNT-WIDE WAS FALSE, AND THAT IS WHY THIS MIGRATION EXISTS
-- Four places in the codebase asserted that rolling-7 / rolling-14 / sprint-position is "a reading
-- preference with no per-team meaning". `resolveComparisonWindow` falsifies it in five lines: under
-- 'sprint' a workspace WITH a cadence gets a sprint-POSITION window (this sprint so far vs the same
-- slice of the last one), while a workspace WITHOUT one silently gets a rolling FORTNIGHT. One
-- account setting therefore produced two different window SHAPES across a single reader's
-- workspaces, with nothing on screen naming which one they were looking at. The mode does not
-- merely sit next to the cadence — it COMPOSES with it, and a fact that composes with a
-- per-workspace fact is a per-workspace fact.
--
-- ── ⚠ TWO STATES, NO CHAIN ─────────────────────────────────────────────────────────────────────
-- There is NO account-level fallback beneath the new column and none should be added. A workspace
-- has a stored mode, or it reads the PRODUCT DEFAULT 'rolling_14' — the same default an
-- unconfigured account has always had. `resolveComparisonMode` is the one reader; null-means-
-- INHERIT is the bug class CLAUDE.md names, and this table already refuses it for the cadence.
--
-- ── ⚠ THE BACKFILL COPIES A DIVERGENT MODE INTO **EVERY** WORKSPACE, AND ONLY A DIVERGENT ONE ──
-- This is 0031's tracker case, not 0031's cadence case, and the difference is worth stating because
-- the same file decided both ways:
--
--   * The CADENCE was not backfilled, because copying one team's fortnight onto every workspace
--     invents a per-team fact nobody stated — the exact defect 0029 existed to end.
--   * The TRACKER was backfilled into every workspace, because it was account-wide AND APPLIED TO
--     EVERY PR: a Default-only copy would have been a silent regression.
--
-- The mode is the tracker case. It applied to every workspace's Insights window, so not copying it
-- would silently re-frame every non-default team's comparison on upgrade — an account that had
-- chosen 'sprint' would find its sprint-position comparisons quietly replaced by rolling
-- fortnights, which is precisely the invisible window-shape change this work exists to end.
--
-- Only 'rolling_7' and 'sprint' are copied. An explicitly-stored 'rolling_14' IS the product
-- default, so writing it into a row would create configuration rows that say nothing and turn "the
-- default" into a stored value somebody later has to reason about. NULL and any junk value are
-- skipped for the same reason.
--
-- ── ⚠ NO COLUMN IS DROPPED, IN EITHER DIALECT ──────────────────────────────────────────────────
-- `pro_settings.comparison_mode` STAYS, dormant — undeclared in both drizzle schema modules,
-- therefore never selected and never written. Same treatment as `ai_update_mode`, the seven
-- `slack_*` columns (0030) and the five sprint/issue columns (0031): dropping a column is
-- irreversible, sqlite makes it expensive, and the old value is the only record of what an account
-- had configured before the split.
--
-- ── TENANCY IS UNCHANGED AND STILL STRUCTURAL ──────────────────────────────────────────────────
-- `pro_workspace_settings` carries the named composite FK `pro_workspace_settings_workspace_account_fk`
-- onto core's `workspaces (id, account_id)` from 0029. Adding a column inherits it; nothing here
-- weakens it. The table is already in the plugin's `registerAccountErasure` hook (retention.ts).

-- ⚠ NOT BLIND-REPLAYABLE, AND THE pg TWIN'S IS. SQLite has no `ADD COLUMN IF NOT EXISTS`, so
-- re-execing this file raises "duplicate column name" (0031 and plugin 0006 have the same
-- property). Run-once is guaranteed by `pro_migrations`. The pg twin DOES use `IF NOT EXISTS`,
-- because a plugin pg migration that throws is downgraded to a WARNING by the host's runner and
-- silently drops the WHOLE plugin to OSS mode; there, replay-safety is load-bearing. The DATA half
-- below is idempotent in both dialects, which is the part a hand re-run would target.
ALTER TABLE pro_workspace_settings ADD COLUMN comparison_mode text;

-- The backfill. One row per (account, workspace) for EVERY workspace of every account whose stored
-- mode DIFFERS from the product default. `ON CONFLICT … DO UPDATE` rather than DO NOTHING because a
-- workspace that already has a row from 0029/0031 must gain the mode too — DO NOTHING would
-- silently skip exactly the workspaces that had bothered to configure a sprint or a tracker.
INSERT INTO pro_workspace_settings (account_id, workspace_id, comparison_mode)
SELECT s.account_id, w.id, s.comparison_mode
FROM pro_settings s
JOIN workspaces w ON w.account_id = s.account_id
WHERE s.comparison_mode IN ('rolling_7', 'sprint')
ON CONFLICT (account_id, workspace_id) DO UPDATE SET
  comparison_mode = excluded.comparison_mode,
  updated_at = unixepoch();

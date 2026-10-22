-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by FILENAME SORT and have NO
-- meta/_journal.json; that requirement is CORE-only). No `--> statement-breakpoint` markers: the
-- plugin migrator execs the whole file as one blob. Postgres twin:
-- migrations-pg/0031_workspace_issue_tracker.sql.
--
-- SLACK, THE ISSUE TRACKER AND THE SPRINT CADENCE BECOME PER-WORKSPACE-ONLY. Migrations 0029 and
-- 0030 moved the cadence and the digest to the workspace grain but LEFT AN ACCOUNT-LEVEL DEFAULT
-- under the cadence. This migration finishes the job:
--
--   1. The Jira/Linear tracker MOVES to `pro_workspace_settings` (the four columns added below).
--   2. The cadence's account fallback is RETIRED — `pro_settings.sprint_cadence_days` /
--      `sprint_start_at` go dormant alongside the `issue_*` columns.
--   3. A per-workspace TICKET MATCH SCOPE arrives: title-only, or title + head branch.
--
-- ── WHY THE TRACKER IS A WORKSPACE FACT ────────────────────────────────────────────────────────
-- The enricher's input is a PULL REQUEST. A repo belongs to EXACTLY ONE workspace
-- (`workspace_repos`; assignment is an upsert = a MOVE), so a PR's workspace is derivable from its
-- repo — the config the enricher needs is reachable at the workspace grain with one indexed read.
-- And it is the grain teams actually want: two teams on one account frequently track work in two
-- different Jira/Linear projects, and until now the second team got the first team's base URL.
--
-- ── ⚠ THE BACKFILL COPIES INTO **EVERY** WORKSPACE, NOT JUST THE DEFAULT ────────────────────────
-- 0030 copied the Slack webhook into the DEFAULT workspace only, because the account-wide cron had
-- only ever delivered ONE digest and the Default workspace was the population it served. The
-- tracker is the opposite case: it was account-wide and it APPLIED TO EVERY PR ON THE ACCOUNT. A
-- Default-only copy would therefore be a silent REGRESSION — every non-default workspace would lose
-- its ticket links on upgrade. Replicating the value into every workspace is what PRESERVES
-- behaviour; the copies are independent from that moment on, which is the whole point.
--
-- This is not the denormalisation CLAUDE.md warns about. That rule is about one fact readable at
-- two grains at once, where "the value" becomes a read of whichever replica you asked. After this
-- migration the account columns are DORMANT — undeclared in both drizzle schema modules, therefore
-- never selected and never written — so there is exactly one live grain and nothing to disagree.
--
-- ── ⚠ THE CADENCE FALLBACK IS RETIRED, AND "NO CADENCE" IS THE PRODUCT DEFAULT ──────────────────
-- `resolveSprintCadence` used to read the workspace row and fall back to `pro_settings`. It now
-- reads the workspace row or answers "no cadence" — TWO STATES, NO CHAIN.
--
-- THERE IS NO DEFAULT SPRINT LENGTH TO FALL BACK TO, AND THERE NEVER WAS. A workspace with no
-- cadence has no sprint grid: `comparisonMode: 'sprint'` degrades to the rolling-14 window
-- (`resolveComparisonWindow`) and the Reports sprint grain refuses (`cadenceConfigured: false`).
-- That is exactly what an unconfigured account already did — the fallback that is being removed
-- pointed at an account pair which was itself null for most accounts. No number is being invented
-- here and none should be.
--
-- ⚠ NO BACKFILL OF THE CADENCE, DELIBERATELY. An account that set an account-level cadence and
-- never set a workspace one loses its sprint grid on upgrade and falls back to the rolling window
-- until somebody sets a cadence on the workspace. That is the honest outcome: copying one team's
-- fortnight onto every workspace is the exact defect 0029 was written to end, and re-doing it here
-- to spare one re-entry would ship it back under a migration's authority. The old values are still
-- readable in `pro_settings` if a support question ever needs them, which is the second reason
-- nothing is dropped.
--
-- ── ⚠ NO COLUMN IS DROPPED, IN EITHER DIALECT ──────────────────────────────────────────────────
-- `pro_settings.sprint_cadence_days` / `sprint_start_at` / `issue_provider` / `issue_base_url` /
-- `issue_project_keys` STAY, dormant. Dropping a column is IRREVERSIBLE and this is a real artifact
-- store: sqlite makes the edit expensive (table rebuild), a botched drop on a customer database is
-- unrecoverable, and these five columns are the only surviving record of what an account had
-- configured before the split — the first thing anyone will want when a user reports "our cadence
-- changed". Dormancy costs five unread columns; a drop costs the ability to answer that question.
-- Same treatment as `ai_update_mode`, the detection flags and 0030's seven `slack_*` columns.
--
-- ── TENANCY IS UNCHANGED AND STILL STRUCTURAL ──────────────────────────────────────────────────
-- `pro_workspace_settings` already carries the named composite FK
-- `pro_workspace_settings_workspace_account_fk` onto `workspaces (id, account_id)` from 0029, which
-- is what makes a cross-account `workspace_id` arriving in a request BODY/QUERY fail in the
-- DATABASE. Adding columns to that table inherits it; nothing here weakens it.
--
-- ⚠ THIS TABLE IS ALREADY IN THE PLUGIN'S `registerAccountErasure` HOOK (retention.ts) and gains
-- no new entry — but it now holds MORE of an account's configuration, so the entry matters more.
-- Core's `accountScopedTables()` cannot see plugin tables.

-- ⚠ THESE FOUR ADD COLUMNs ARE NOT BLIND-REPLAYABLE, AND THE pg TWIN'S ARE. SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so re-execing this file raises "duplicate column name" (plugin
-- 0006's bare ADD COLUMN has the same property). Run-once is guaranteed by `pro_migrations`, which
-- is how the host's plugin migrator tracks these — not by the statements. The pg twin DOES use
-- `IF NOT EXISTS`, because a plugin pg migration that throws is downgraded to a WARNING by the
-- runner and silently drops the whole plugin to OSS mode; there, replay-safety is load-bearing.
-- The DATA half below is idempotent in both dialects, which is the part a hand re-run would target.
ALTER TABLE pro_workspace_settings ADD COLUMN issue_provider text;
ALTER TABLE pro_workspace_settings ADD COLUMN issue_base_url text;
ALTER TABLE pro_workspace_settings ADD COLUMN issue_project_keys text;
-- 'title' | 'title_branch'. NULL reads as 'title_branch' — TODAY'S BEHAVIOUR — so no existing
-- workspace's ticket detection changes when this column appears. It only bites in ALLOWLIST mode:
-- with no configured project keys the head branch is never scanned anyway, because a lowercase
-- branch key (`eng-123`) is structurally indistinguishable from `node-18` / `release-2` / a
-- dependency bump, which is why branch scanning is allowlist-gated in the first place.
ALTER TABLE pro_workspace_settings ADD COLUMN issue_match_scope text;

-- The backfill. One row per (account, workspace) for EVERY workspace of every account that has a
-- usable tracker configured. `ON CONFLICT … DO UPDATE` rather than DO NOTHING because a workspace
-- that already has a cadence row from 0029 must gain the tracker columns too — DO NOTHING would
-- silently skip exactly the workspaces that had bothered to configure a sprint.
--
-- The predicate matches the enricher's own liveness test (`provider != null && baseUrl non-blank`),
-- so a half-configured account copies nothing rather than seeding rows that can never link.
INSERT INTO pro_workspace_settings (
  account_id, workspace_id, issue_provider, issue_base_url, issue_project_keys
)
SELECT
  s.account_id,
  w.id,
  s.issue_provider,
  trim(s.issue_base_url),
  s.issue_project_keys
FROM pro_settings s
JOIN workspaces w ON w.account_id = s.account_id
WHERE s.issue_provider IS NOT NULL
  AND s.issue_base_url IS NOT NULL
  AND trim(s.issue_base_url) <> ''
ON CONFLICT (account_id, workspace_id) DO UPDATE SET
  issue_provider = excluded.issue_provider,
  issue_base_url = excluded.issue_base_url,
  issue_project_keys = excluded.issue_project_keys,
  updated_at = unixepoch();

-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by FILENAME SORT and have NO
-- meta/_journal.json; that requirement is CORE-only). No `--> statement-breakpoint` markers: the
-- plugin migrator execs the whole file as one blob. Postgres twin:
-- migrations-pg/0030_workspace_slack_targets.sql.
--
-- THE SLACK DIGEST BECOMES A PER-WORKSPACE DELIVERY. Until now there was ONE webhook per account
-- and ONE digest, covering the account's DEFAULT workspace only (a documented reduction — see
-- docs/MIGRATIONS.md § Known gaps, slack/cron.ts's header and slack/report.ts's banner, all three
-- rewritten in this change). Two teams sharing an account had one channel and one team's numbers.
--
-- ── WHY A NEW TABLE AND NOT WIDER `pro_settings` COLUMNS ────────────────────────────────────────
-- Same argument plugin 0029 made for the sprint cadence, verbatim: `pro_settings` is UNIQUE on
-- (account_id) and carries genuinely ACCOUNT-WIDE facts (issue provider, narration model, the bot
-- toggles, the legacy cost blob) that must not fork per workspace, and widening its unique index
-- would ALSO silently break `writeProSettings`' `onConflictDoUpdate` — a stale conflict target
-- TYPE-CHECKS PERFECTLY and raises only at RUNTIME, on an actual write.
--
-- ── ⚠ THERE IS NO ACCOUNT-LEVEL FALLBACK COLUMN, AND THAT IS THE DESIGN ─────────────────────────
-- "One webhook for everything" is a UI AFFORDANCE — an "apply to all selected" button in the
-- Settings modal that FANS OUT the same URL into every selected row — NOT a nullable column that
-- means "inherit". null-means-INHERIT is a named bug class in this repo (CLAUDE.md, and
-- `workspace_reviewers.monthly_cents`' own comment: "there is no inheritance anywhere in the new
-- model: null means no price set... Two states, no chain"). Here the two states are: a row exists
-- (this workspace has a channel) or it does not (it has none). No chain, nothing to disagree.
--
-- This is deliberately DIFFERENT from 0029's cadence, where the account pair genuinely IS the
-- product default with exactly one reader. A webhook URL is not a default anybody would want
-- inherited: silently posting a new team's private numbers into whichever channel the account
-- owner configured years ago is a data-egress accident, not a convenience.
--
-- ── THE OLD `pro_settings.slack_*` COLUMNS ARE MIGRATED, THEN GO DORMANT ────────────────────────
-- The INSERT below copies each account's configured webhook into a row for its DEFAULT workspace —
-- which is exactly the population the old cron already delivered — so nothing changes for an
-- existing user beyond gaining the ability to add more. The columns are then left in place and
-- REMOVED FROM THE DRIZZLE SCHEMA (the `ai_update_mode` / detection-flag precedent in
-- settings/schema.sqlite.ts): drizzle only names columns it declares, so an undeclared one is
-- never selected and never written, and `merge()` stops carrying it. ONE live spelling.
-- No DROP COLUMN: it is the one edit sqlite makes expensive, and the rows are the only copy of a
-- secret the API never returns — a botched drop would be unrecoverable.
--
-- ⚠ `slack_last_sent_slot` IS CARRIED ACROSS, and it is the load-bearing column in this INSERT.
-- It is the dedupe marker. A fresh row with a NULL marker is "never sent", so the first sweep
-- after this migration would treat today's already-delivered slot as due and post the digest a
-- second time into a channel that already has it.
--
-- ── TENANCY IS STRUCTURAL ───────────────────────────────────────────────────────────────────────
-- `workspace_id` arrives in a REQUEST BODY on `PUT /api/pro/slack/targets` (a LIST of them), so the
-- NAMED composite FK `workspace_slack_targets_workspace_account_fk` makes the (workspace, account)
-- PAIR the thing that must exist — a cross-account pair fails in the DATABASE, in every code path,
-- not in whichever handler remembered to check. It leans on core's `workspaces_id_account` unique
-- index (core migration 0044 / pg 0031), exactly like pro_workspace_settings (plugin 0029) and
-- advisor_bot_profiles (plugin 0021).
-- ON DELETE CASCADE: this row is CONFIG, not an artifact — a deleted workspace's delivery target
-- describes nothing, and core's `deleteWorkspace` cannot re-home a plugin row it cannot name
-- across the open-core boundary.
--
-- ── ⚠ THE WEBHOOK URL IS STORED PLAINTEXT, AND THAT DECISION IS RE-MADE HERE ────────────────────
-- It was already plaintext on `pro_settings.slack_webhook_url`, justified there as "local-only,
-- single-tenant". That justification no longer covers this table: N rows per account in CLOUD,
-- where the GitHub token IS AES-256-GCM sealed. The call is to KEEP IT PLAINTEXT, for reasons that
-- are about the SECRET, not about effort:
--   • WHAT IT GRANTS is write-only, to one channel the account owner chose. It reads nothing from
--     Slack, names no user, and carries no tenant data. A GitHub token reads private source; these
--     two secrets are different in KIND, and the sealing decision follows the kind.
--   • MULTIPLYING THE COUNT DOES NOT CHANGE THE KIND. N channels instead of one is more blast
--     radius of the same shape — still "post into channels you already asked us to post into".
--   • SEALING WOULD CREATE THE HAZARD IT PREVENTS. `ENCRYPTION_KEY` is CLOUD-ONLY (assertCloudConfig
--     requires it; local has none), so a sealed column would be sealed in one mode and plaintext in
--     the other — two storage formats for one field, which is the "TWO SPELLINGS MUST AGREE" hazard
--     this repo keeps recording. It would also make a key rotation silently break every delivery.
-- The mitigations that DO apply are enforced in code and must stay: the URL is never returned by
-- any route (`configured: true` is all the GET emits), it is never logged (slack/send.ts withholds
-- the response body; the cron logs accountId + workspaceId and nothing else), and every write goes
-- through the `normalizeSlackWebhookUrl` allowlist so a non-Slack host cannot be stored at all.
-- REVISIT if and only if core grows a mode-independent secret-sealing seam on ProContext.

CREATE TABLE IF NOT EXISTS workspace_slack_targets (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  -- NOT NULL on purpose: a row IS a delivery target. "Selected but no channel yet" is not a state
  -- worth storing — it is undeliverable, and storing it would put a row in the sweep that can only
  -- ever be skipped. Deselecting a workspace DELETES its row.
  webhook_url text NOT NULL,
  -- 'off' | 'daily' | 'twice_daily'; null reads as 'off'. Per ROW, so one workspace can be paused
  -- without losing its channel and without touching another's schedule.
  cadence text,
  hour1 integer,
  hour2 integer,
  timezone text,
  last_sent_at integer,
  -- ⚠ THE DEDUPE MARKER, AND IT MUST BE PER ROW. The account-wide
  -- `pro_settings.slack_last_sent_slot` it replaces was ONE column: with a per-workspace sweep,
  -- a single marker means a restart mid-sweep re-sends whichever workspaces had already gone out
  -- and (once the marker advances) skips the ones that had not. A lexically-orderable slot id
  -- ("2026-07-06T09"); the sweep stamps it even when there was nothing to say, so a quiet
  -- workspace is not retried all day.
  last_sent_slot text,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT "workspace_slack_targets_workspace_account_fk"
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS wst_account_ws
  ON workspace_slack_targets (account_id, workspace_id);

INSERT INTO workspace_slack_targets (
  account_id, workspace_id, webhook_url, cadence, hour1, hour2, timezone,
  last_sent_at, last_sent_slot
)
SELECT
  s.account_id,
  w.id,
  trim(s.slack_webhook_url),
  COALESCE(s.slack_cadence, 'off'),
  s.slack_hour1,
  s.slack_hour2,
  s.slack_timezone,
  s.slack_last_sent_at,
  s.slack_last_sent_slot
FROM pro_settings s
JOIN workspaces w ON w.account_id = s.account_id AND w.is_default = 1
WHERE s.slack_webhook_url IS NOT NULL AND trim(s.slack_webhook_url) <> ''
ON CONFLICT (account_id, workspace_id) DO NOTHING;

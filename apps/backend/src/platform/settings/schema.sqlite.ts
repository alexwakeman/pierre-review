// Plugin-owned SQLite schema (local mode) for Pro configuration. THREE tables at TWO grains:
// `pro_settings` (one row per ACCOUNT — the comparison mode, the narration model, the bot
// toggles), `pro_workspace_settings` (one row per WORKSPACE — the sprint cadence and the
// Jira/Linear tracker) and `workspace_slack_targets` (one row per WORKSPACE — a delivery target).
// Structural twin: `schema.pg.ts`. Migrated by the host via
// ctx.registerMigrations (../migrations/0005_pro_settings.sql); this module is ONLY the typed
// query surface.
//
// ⚠ IT DELIBERATELY DECLARES FEWER COLUMNS THAN THE TABLE HAS, AND THAT IS SAFE HERE. Drizzle only
// ever names the columns it knows about, so an undeclared one is never selected and never written
// — which is exactly what "dormant" means. Dormant set: `ai_update_mode` / `ai_interval_minutes`
// (the deleted AI-summary update policy), the seven `slack_*` columns (superseded by
// `workspace_slack_targets` in plugin migration 0030), `sprint_cadence_days` / `sprint_start_at`
// and `issue_provider` / `issue_base_url` / `issue_project_keys` (all five superseded by
// `pro_workspace_settings` in plugin migration 0031), `comparison_mode` (superseded by
// `pro_workspace_settings.comparison_mode` in plugin migration 0032), `bot_slack_digest`
// (superseded by `workspace_slack_targets.bot_digest` in plugin migration 0033),
// `bot_inhouse_detect` / `bot_auto_tag` /
// `bot_login_allowlist` / `bot_deep_detect` / `bot_ai_tiebreak` (the deleted detection settings,
// which never had a consumer), `bot_tag_pierre` / `bot_pierre_footer` (the deleted Limn-attribution
// settings — the marker is now unconditional) and `bot_auto_resolve` / `bot_auto_resolve_days`
// (vestigial since the mute feature was dropped). What is LEFT LIVE on `pro_settings` is one
// column: `report_model`. No migration drops any of them: they are not in
// the way, and dropping a column is the one edit sqlite makes expensive.
//
// ⚠ THIS PACKAGE HAS NO SCHEMA-PARITY TEST (core's cannot see plugin tables), so every edit here
// must be mirrored BY EYE into `schema.pg.ts`.
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  SlackDigestCadence,
  SprintComparisonMode,
} from '@pierre-review/shared';

export const proSettings = sqliteTable(
  'pro_settings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    // ── `sprint_cadence_days` / `sprint_start_at` ARE DORMANT AS OF PLUGIN MIGRATION 0031 ──────
    // The sprint cadence is a WORKSPACE fact and there is no account-level default beneath it any
    // more: `resolveSprintCadence` reads `pro_workspace_settings` or answers "no cadence" — two
    // states, no chain. The two columns still exist and are deliberately NOT declared here, which
    // is what makes them dormant: never selected, never written, `merge()` no longer carries them.
    // ⚠ ONE LIVE SPELLING. Do not re-declare one "to show what the account used to have" — a
    // second grain for one fact is how "the value" becomes a read of whichever replica you asked.
    // ── `comparison_mode` IS DORMANT AS OF PLUGIN MIGRATION 0032 ──────────────────────────────
    // The comparison-window mode joined the cadence on `pro_workspace_settings`. It is not a
    // "reading preference with no per-team meaning" — that claim was false, and the falsifier is
    // `resolveComparisonWindow`: under 'sprint' a workspace WITH a cadence gets a sprint-position
    // window and one WITHOUT silently gets rolling-14, so ONE account setting produced two
    // different window SHAPES with nothing on screen saying which you got. The mode and the
    // cadence COMPOSE, so they share a row.
    // The column still exists and is deliberately NOT declared here, which is what makes it
    // dormant: never selected, never written, `merge()` no longer carries it. ⚠ ONE LIVE
    // SPELLING — do not re-declare it "to show what the account used to have".
    // Which model NARRATES the period-over-period report. null → the PRO_REPORT_MODEL config
    // default; a generate call may still override it per run. Only 'claude-haiku-5-5' is
    // SELECTABLE now (REPORT_MODELS in llm/seam.ts); rows still holding the retired
    // 'claude-sonnet-5' are read through `resolveReportModel` and degrade to the default —
    // deliberately NOT migrated, because the column is a preference, not a fact about history.
    // Plain `text`, not a `$type` union, because the value is a model id the config supplies and
    // pinning a literal here would make a model rename a compile error in the schema rather than
    // in the one place that maps ids to pricing.
    // ⚠ Declaring the column is only step 1 of settings/store.ts's 8-step checklist — miss any of
    // the rest and the field is silently dropped. Note too that settings/routes.ts's `updateSchema`
    // is `additionalProperties: false`, which STRIPS an unlisted property and still answers 200.
    reportModel: text('report_model'),
    // ── THE SEVEN `slack_*` COLUMNS ARE DORMANT AS OF PLUGIN MIGRATION 0030 ──────────────────
    // `slack_webhook_url` / `slack_cadence` / `slack_hour1` / `slack_hour2` / `slack_timezone` /
    // `slack_last_sent_at` / `slack_last_sent_slot` still EXIST in the database and are NOT
    // declared here, which is what makes them dormant: drizzle only ever names the columns it
    // knows about, so an undeclared one is never selected and never written, and `merge()` in
    // store.ts no longer carries them.
    //
    // The digest is now a PER-WORKSPACE delivery, one row per (account, workspace) in
    // `workspace_slack_targets` below, and migration 0030 COPIED each account's configured webhook
    // — including its `last_sent_slot` dedupe marker — into a row for that account's DEFAULT
    // workspace, which is exactly the population the old account-wide cron already served.
    // ⚠ ONE LIVE SPELLING: nothing reads or writes these columns any more. Do not re-declare one
    // "just to read the old value" — that is how a secret ends up configured in two places, one of
    // which the UI cannot see.
    // ── THE THREE `issue_*` COLUMNS ARE DORMANT AS OF PLUGIN MIGRATION 0031 ───────────────────
    // Jira/Linear ticket linking moved to `pro_workspace_settings` below. The enricher's input is
    // a PR; a PR's repo belongs to EXACTLY ONE workspace (`workspace_repos`), so the config it
    // needs is reachable at the workspace grain — and a second team on the same account can point
    // at a different tracker. 0031 COPIED each account's config into a row for EVERY workspace it
    // owns (not just Default: the setting WAS account-wide, so replicating it is what preserves
    // behaviour), after which the copies are independent. Still in the database, not declared.
    // ── `bot_slack_digest` IS DORMANT AS OF PLUGIN MIGRATION 0033 ─────────────────────────────
    // The "Review bots" block became a property of the DELIVERY — `workspace_slack_targets`'s new
    // `bot_digest` column — because the digest itself became per-workspace in plugin 0030, at
    // which point one account flag was deciding the CONTENT of N separately-scheduled messages
    // about N different teams' bots. 0033 copied the flag onto every existing target row. Still in
    // the database, not declared here: never selected, never written.
    // ── Bot-Triage Platform (WS8 control surface). All nullable; store.ts fills the DEFAULTS on
    // read (null = "unset" → the documented default, not a written value). Booleans are int-bool.
    // Both survivors are vestigial — see the dormant list in the file header. ──
    botAutoResolve: integer('bot_auto_resolve', { mode: 'boolean' }),
    botAutoResolveDays: integer('bot_auto_resolve_days'),
    // @deprecated LEGACY, READ-ONLY. JSON array of per-bot monthly cost; null/blank → [].
    // Superseded by `workspace_reviewers.monthly_cents` in CORE — one NULLABLE column on the one
    // row per (account, WORKSPACE, actor) — because a bot is configured at the workspace level,
    // ALL attributes including price, and because cost is now free/CORE rather than Pro. Plugin
    // migration 0020 imports what it can (0019, which wrote the intermediate account-grain table,
    // is a no-op now that core has dropped it).
    //
    // NULLABLE is not the old nullable. The bug class that made a null price dangerous was
    // null-means-INHERIT, sitting on a fallback chain where 0 and null had to be told apart with
    // ?? rather than ||. There is no inheritance anywhere in the new model: null means "no price
    // set" and 0 means "free". Two states, no chain. (Per-workspace prices for one vendor may
    // legitimately DIFFER — that is divergence by design, not drift, and it is why nothing sums
    // cost across workspaces.)
    //
    // IT HAS HAD TWO ELEMENT SHAPES and only one is migratable: `{login, monthlyUsd}` joins to
    // `users`, while older `{kind, monthlyUsd}` entries name a BRAND, not an actor, so there is no
    // `author_user_id` to key a `workspace_reviewers` row on. Those stay here and keep driving the
    // ROI panel through the read-time fallback. Do NOT drop the column until that set is empty.
    botCostJson: text('bot_cost_json'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountUx: uniqueIndex('pro_settings_account').on(t.accountId),
  }),
);

// ── THE PER-WORKSPACE Pro CONFIG (plugin migrations 0029 + 0031) ─────────────────────────────
//
// ONE row per (account, workspace), holding every per-workspace Pro setting that is a VALUE rather
// than a delivery: the sprint cadence + phase anchor (0029) and the Jira/Linear issue tracker
// (0031). Two teams sharing one account run different sprints and may track work in different
// projects; before these migrations both were single account-wide facts.
//
// ⚠ ONE TABLE, NOT THREE. A second per-workspace config table would be three places to remember
// in `registerAccountErasure`, three FKs to keep named, and three routes to keep at one grain.
// The one thing that legitimately stayed separate is `workspaceSlackTargets` below, because a ROW
// THERE IS A DELIVERY TARGET — its existence IS the setting, so it cannot share a row whose
// absence must mean "no cadence configured".
//
// ⚠ IT IS A SEPARATE TABLE FROM `pro_settings`, NOT A WIDER KEY ON IT. That table still carries
// genuinely ACCOUNT-WIDE facts (comparison mode, report model, bot toggles, the legacy bot cost
// blob) which must not fork per workspace, and widening its unique index would ALSO break
// `writeProSettings`' `onConflictDoUpdate` — a stale conflict target type-checks perfectly and
// raises only at runtime, on an actual write.
//
// ⚠ THERE IS NO ACCOUNT-LEVEL FALLBACK UNDER EITHER SETTING ANY MORE (plugin 0031). The cadence
// used to fall back to `pro_settings.sprint_*` through one resolver; that resolver now reads this
// row or answers "no cadence", and both account columns are dormant. Two states, no chain — which
// is what CLAUDE.md's "a fact lives at exactly ONE grain" asks for. A NULL `sprint_cadence_days`
// is exactly equivalent to no row at all: there is nothing left for it to follow.
//
// ⚠ CLEARING THE CADENCE NULLS THE PAIR; IT DOES NOT DELETE THE ROW. The row also holds the issue
// tracker, so `writeWorkspaceCadence`'s old DELETE would now take an unrelated setting with it.
//
// Tenancy is STRUCTURAL: the named composite FK `pro_workspace_settings_workspace_account_fk`
// lives in the MIGRATION SQL only (0029, both dialects) — drizzle cannot declare an FK onto a core
// table it has no object for across the open-core boundary, and index/FK metadata here is inert
// anyway. Same arrangement as advisor_bot_profiles.
export const proWorkspaceSettings = sqliteTable(
  'pro_workspace_settings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    sprintCadenceDays: integer('sprint_cadence_days'),
    sprintStartAt: integer('sprint_start_at', { mode: 'timestamp' }),
    // ── The comparison-window mode, per workspace (plugin migration 0032) ─────────────────────
    // 'rolling_7' | 'rolling_14' | 'sprint'; NULL reads as 'rolling_14' — THE PRODUCT DEFAULT, and
    // the only default there is. Two states, no chain: `pro_settings.comparison_mode` is dormant
    // and nothing falls back to it.
    // ⚠ IT SITS BESIDE THE CADENCE BECAUSE THE TWO COMPOSE. 'sprint' means "this sprint so far vs
    // the same slice of the last one" — which is a different window SHAPE depending on whether
    // THIS workspace has a cadence at all. Reading the pair off two grains is the defect 0032
    // closed.
    comparisonMode: text('comparison_mode').$type<SprintComparisonMode>(),
    // ── `issue_*` (plugin 0031) and `jira_email` / `jira_token` (plugin 0035) ARE DORMANT ──────
    // The issue tracker moved to CORE at apiVersion 23 (`workspace_trackers`). Core's boot-time
    // move (apps/backend/src/tracker/legacy-import.ts) copied each workspace's values — the token in
    // its stored form — and NULLed these columns. They stay (plugin migrations are additive) and are
    // deliberately NOT declared: never selected, never written. Do not re-declare them.
    // ── `jira_ac_field_id` / `jira_ac_field_name` ARE DORMANT ────────────────────────────────
    // The acceptance-criteria field was a per-workspace choice for one release and moved to the
    // Claude Review panel, PER TICKET: real sites carry several fields named "Acceptance Criteria"
    // and the right one varies by issue type, so no single workspace answer was usable. The
    // columns stay (plugin migrations are additive) and are deliberately NOT declared, which is what
    // makes them dormant: never selected, never written. Do not re-declare them.
    // ── Auto Claude review, per workspace (plugin migration 0036) ─────────────────────────────
    // NULL/false = off. `autoReviewEnabledAt` is when it was last switched ON and is the floor the
    // sweeper (../claude-review/auto.ts) reviews from: only PRs OPENED at or after it. Re-stamped on
    // every off -> on, so nothing opened while it was off is picked up.
    // ── The hourly cost of engineering time, in US CENTS (plugin migration 0041) ──────────────
    // A READING setting for Chronology's "hours saved" figure. NULL = not set (hours only).
    hourlyCostCents: integer('hourly_cost_cents'),
    autoReviewEnabled: integer('auto_review_enabled', { mode: 'boolean' }),
    autoReviewEnabledAt: integer('auto_review_enabled_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountWsUx: uniqueIndex('pws_account_ws').on(t.accountId, t.workspaceId),
  }),
);

// ── THE PER-WORKSPACE SLACK DELIVERY TARGET (plugin migration 0030) ──────────────────────────
//
// One row per (account, workspace). A ROW IS A DELIVERY TARGET: it exists ⇒ that workspace's
// digest is generated on this schedule and posted to this channel; it does not exist ⇒ that
// workspace gets nothing. Deselecting a workspace DELETES its row.
//
// ⚠ THERE IS NO ACCOUNT-LEVEL FALLBACK, BY DESIGN. "One webhook for everything" is a UI
// AFFORDANCE — an "apply to all selected" button that FANS OUT the same URL into every selected
// row — never a nullable column meaning "inherit". null-means-INHERIT is a named bug class here
// (CLAUDE.md; and `workspace_reviewers.monthly_cents`' own comment: "there is no inheritance
// anywhere in the new model... Two states, no chain"). Two states here too: a channel, or none.
// It is deliberately NOT the arrangement `pro_workspace_settings` uses for the sprint cadence —
// a cadence has a sensible product default; a webhook URL does not, and inheriting one would
// silently post a new team's private numbers into a channel somebody configured years ago.
//
// ⚠ `lastSentSlot` IS PER ROW AND THAT IS LOAD-BEARING. Its predecessor
// `pro_settings.slack_last_sent_slot` was ONE column per account; under a per-workspace sweep a
// single marker means a restart mid-sweep RE-SENDS the workspaces that already went out and, once
// the marker advances, SKIPS the ones that had not.
//
// ⚠ `webhookUrl` IS PLAINTEXT and the decision was re-made (not inherited) when the count went
// from one per account to N — the argument is written out in full in migration 0030's header.
// Short form: the secret is write-only capability to one channel the account owner chose, sealing
// is CLOUD-ONLY (`ENCRYPTION_KEY`) and would fork the storage format by deployment mode, and the
// mitigations that actually bound it are in code — never returned by a route, never logged, and
// every write routed through `normalizeSlackWebhookUrl`'s allowlist.
//
// Tenancy is STRUCTURAL: the named composite FK `workspace_slack_targets_workspace_account_fk`
// lives in the MIGRATION SQL only (0030, both dialects) — drizzle cannot declare an FK onto a core
// table across the open-core boundary, and index/FK metadata here is inert anyway. It matters
// more here than on most tables because `workspaceId` arrives in a request BODY, as a LIST.
export const workspaceSlackTargets = sqliteTable(
  'workspace_slack_targets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    webhookUrl: text('webhook_url').notNull(),
    cadence: text('cadence').$type<SlackDigestCadence>(),
    hour1: integer('hour1'),
    hour2: integer('hour2'),
    timezone: text('timezone'),
    lastSentAt: integer('last_sent_at', { mode: 'timestamp' }),
    lastSentSlot: text('last_sent_slot'),
    // ── The "Review bots" block, per DELIVERY (plugin migration 0033) ─────────────────────────
    // NULL reads as false (the documented default of the account flag it replaces). It was
    // `pro_settings.bot_slack_digest`, one flag per account, justified as "not a per-team fact" —
    // a premise that died in plugin 0030, when the digest itself became per-workspace: from that
    // point one account flag decided the CONTENT of N independently-scheduled messages about N
    // different teams' bots. 0033 copies the account flag onto every existing target row, so no
    // account loses the block on upgrade, and `pro_settings.bot_slack_digest` goes dormant.
    botDigest: integer('bot_digest', { mode: 'boolean' }),
    // ── The two Slack EVENT signals (plugin migration 0040) — NULL reads as false ─────────────
    // A post when a Claude Review run succeeds, and one when a PR is seen merging live. They ride
    // the delivery row because they need its webhook; the digest cadence does not gate them.
    notifyReviews: integer('notify_reviews', { mode: 'boolean' }),
    notifyMerges: integer('notify_merges', { mode: 'boolean' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountWsUx: uniqueIndex('wst_account_ws').on(t.accountId, t.workspaceId),
  }),
);

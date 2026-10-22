// Plugin-owned Postgres schema (cloud mode) — the structural twin of `schema.sqlite.ts`
// (SAME table + column names, SAME nullability), pg-core types.
//
// ⚠ Like its twin, it declares FEWER columns than the table has: `ai_update_mode` /
// `ai_interval_minutes`, the detection + Limn-attribution `bot_*` columns, (as of plugin migration
// 0030) the seven `slack_*` columns, (as of plugin migration 0031) `sprint_cadence_days` /
// `sprint_start_at` + `issue_provider` / `issue_base_url` / `issue_project_keys`, (as of plugin
// migration 0032) `comparison_mode` AND (as of plugin migration 0033) `bot_slack_digest` are
// DORMANT — still in the database, never selected, never written. The dormant list and the
// reasoning live in `schema.sqlite.ts`'s header. There is NO parity test in this package — mirror
// by eye.
import { boolean, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type {
  SlackDigestCadence,
  SprintComparisonMode,
} from '@pierre-review/shared';

export const proSettings = pgTable(
  'pro_settings',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    // `sprint_cadence_days` / `sprint_start_at` are DORMANT as of plugin migration 0031 — the
    // cadence is a WORKSPACE fact with no account default beneath it. Twin of schema.sqlite.ts,
    // where the reasoning lives. ONE live spelling; do not re-declare either.
    // `comparison_mode` is DORMANT as of plugin migration 0032 — the comparison-window mode joined
    // the cadence on `pro_workspace_settings`, because the two COMPOSE ('sprint' is a different
    // window shape on a workspace with no cadence). Twin of schema.sqlite.ts, where the reasoning
    // lives. ONE live spelling; do not re-declare it.
    // Period-report narration model; null → the PRO_REPORT_MODEL config default (twin of
    // schema.sqlite.ts, where the store-checklist warning lives).
    reportModel: text('report_model'),
    // The seven `slack_*` columns are DORMANT as of plugin migration 0030 — still in the database,
    // deliberately NOT declared, therefore never selected and never written. The digest is now a
    // per-workspace delivery in `workspaceSlackTargets` below; 0030 copied each account's webhook
    // (and its dedupe marker) into a row for the DEFAULT workspace. Full reasoning in the sqlite
    // twin's header. ONE live spelling — do not re-declare one to "read the old value".
    // The three `issue_*` columns are DORMANT as of plugin migration 0031 — the Jira/Linear
    // tracker is a per-WORKSPACE setting now (`proWorkspaceSettings` below); 0031 copied each
    // account's config into a row for EVERY workspace it owns. Twin of schema.sqlite.ts.
    // `bot_slack_digest` is DORMANT as of plugin migration 0033 — the "Review bots" block is a
    // property of the DELIVERY now (`workspaceSlackTargets.botDigest` below). Twin of
    // schema.sqlite.ts, where the reasoning lives.
    // ── Bot-Triage Platform (WS8) — structural twin of schema.sqlite.ts. Booleans as pg boolean
    // (both dialects infer boolean | null); all nullable, store fills defaults on read. Both
    // survivors are vestigial — see the dormant list in the sqlite twin's header. ──
    botAutoResolve: boolean('bot_auto_resolve'),
    botAutoResolveDays: integer('bot_auto_resolve_days'),
    // @deprecated LEGACY, READ-ONLY — superseded by CORE `workspace_reviewers.monthly_cents`. Kept
    // because older `{kind, monthlyUsd}` entries name a brand, not an actor, and so cannot be
    // migrated; they keep driving the ROI panel through the read-time fallback. See the sqlite twin.
    botCostJson: text('bot_cost_json'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountUx: uniqueIndex('pro_settings_account').on(t.accountId),
  }),
);

// The per-workspace Pro config (plugin migrations 0029 + 0031 + 0032) — structural twin of the sqlite
// declaration, where the whole rationale lives (why ONE table rather than three, why it is
// separate from `pro_settings`, why there is no account-level fallback under either setting, why
// clearing the cadence NULLS the pair rather than deleting the row, and why the composite FK lives
// in the migration rather than here).
export const proWorkspaceSettings = pgTable(
  'pro_workspace_settings',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    sprintCadenceDays: integer('sprint_cadence_days'),
    sprintStartAt: timestamp('sprint_start_at', { withTimezone: true, mode: 'date' }),
    // The comparison-window mode, per workspace (plugin migration 0032). 'rolling_7' |
    // 'rolling_14' | 'sprint'; NULL reads as 'rolling_14', the product default and the only one
    // there is. Beside the cadence because the two compose — twin of schema.sqlite.ts.
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
    // Auto Claude review, per workspace (plugin migration 0036). Twin of schema.sqlite.ts.
    autoReviewEnabled: boolean('auto_review_enabled'),
    autoReviewEnabledAt: timestamp('auto_review_enabled_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    accountWsUx: uniqueIndex('pws_account_ws').on(t.accountId, t.workspaceId),
  }),
);

// The per-workspace Slack delivery target (plugin migrations 0030 + 0033) — structural twin of the sqlite
// declaration, where the whole rationale lives (why a row IS the target, why there is NO
// account-level fallback column, why `lastSentSlot` must be per row, why the URL stays plaintext,
// and why the composite FK lives in the migration rather than here).
export const workspaceSlackTargets = pgTable(
  'workspace_slack_targets',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    webhookUrl: text('webhook_url').notNull(),
    cadence: text('cadence').$type<SlackDigestCadence>(),
    hour1: integer('hour1'),
    hour2: integer('hour2'),
    timezone: text('timezone'),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true, mode: 'date' }),
    lastSentSlot: text('last_sent_slot'),
    // The "Review bots" block, per DELIVERY (plugin migration 0033). NULL reads as false — the
    // documented default of the account flag it replaces. Twin of schema.sqlite.ts, where the
    // reasoning lives; pg `boolean` against sqlite's int-bool, the standing dialect pairing.
    botDigest: boolean('bot_digest'),
    // The two Slack event signals (plugin migration 0040). Twin of schema.sqlite.ts.
    notifyReviews: boolean('notify_reviews'),
    notifyMerges: boolean('notify_merges'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    accountWsUx: uniqueIndex('wst_account_ws').on(t.accountId, t.workspaceId),
  }),
);

// Plugin-owned SQLite schema (local mode) for the Bot Tuning Advisor. Structural twin:
// `schema.pg.ts` (same table + column names + nullability). Migrated by the host via
// ctx.registerMigrations (the .sql under ../../migrations); this module is ONLY the typed
// query surface.
//
// Three tables, all account-scoped (⇒ listed in retention.ts eraseProByAccountId and seeded
// in test/isolation.test.ts). None is PR-keyed: a recommendation references its created PR by
// (prRepoId, prNumber, prUrl) — never a core prId the TTL sweep could dangle — so
// pruneProByPrIds deliberately does NOT touch them.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// One DECIDED recommendation per (account, workspace, dedupeKey). Findings stay pure query
// results — a row is written only when the user ACTS (dismiss / open PR / file issue).
// `dedupeKey` is 'intent|botUserId|targetKey|windowKind'; every onConflictDoUpdate on this
// table must target exactly [accountId, workspaceId, dedupeKey] (the 0042/0045 lesson: a
// stale conflict target type-checks and then throws at the first real write).
// `outputJson` is {files:[{path, templated, refined?, final}]} — the deterministic version is
// retained beside any refined prose, always.
export const advisorRecommendations = sqliteTable(
  'advisor_recommendations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    botUserId: integer('bot_user_id').notNull(),
    intent: text('intent').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    targetJson: text('target_json').notNull(),
    evidenceJson: text('evidence_json').notNull(),
    retroJson: text('retro_json'),
    outputJson: text('output_json'),
    // 'dismissed' | 'pr_opened' | 'pr_merged' | 'issue_filed' | 'superseded'
    status: text('status').notNull(),
    prRepoId: integer('pr_repo_id'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    issueUrl: text('issue_url'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountWorkspaceKeyUx: uniqueIndex('advrec_account_ws_key').on(
      t.accountId,
      t.workspaceId,
      t.dedupeKey,
    ),
  }),
);

// One profile row per (account, workspace, bot) — the one-bot-object rule extended: the T1
// ask-once answers and the T3 confirmed manifest are facts about (account, workspace, actor)
// and live in ONE row. ⚠ The persist() shared-values-object landmine applies verbatim: the T1
// and T3 writers build SEPARATE narrowed set: objects — a T1 re-answer must never wipe a
// confirmed manifest and vice versa.
export const advisorBotProfiles = sqliteTable(
  'advisor_bot_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    botUserId: integer('bot_user_id').notNull(),
    // 'known:<adapterKey>' | 'prose' | 'lint:<tool>' | 'unknown'
    kindHint: text('kind_hint'),
    configPath: text('config_path'),
    ownerContact: text('owner_contact'),
    // The "bot's own repo" issue-filing target — USER-SUPPLIED, never derived from comment text.
    ownerRepo: text('owner_repo'),
    notes: text('notes'),
    // 'user' | 'inferred'
    profileSource: text('profile_source'),
    manifestJson: text('manifest_json'),
    manifestConfirmedAt: integer('manifest_confirmed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountWorkspaceBotUx: uniqueIndex('advprof_account_ws_bot').on(
      t.accountId,
      t.workspaceId,
      t.botUserId,
    ),
    // Tenancy as a CONSTRAINT: `workspace_id` arrives in REQUEST BODIES, so the PAIR
    // (workspace_id, account_id) must exist in `workspaces` — a cross-account pair fails in
    // the database in every code path, not in whichever handler remembered to check. The
    // NAMED composite FK `advisor_bot_profiles_workspace_account_fk` lives in the MIGRATION
    // SQL only (0021, both dialects): drizzle can't declare an FK onto a core table it has
    // no object for across the open-core boundary, and index/FK metadata here is inert
    // anyway — the migrations are the authority.
  }),
);

// Append-only anchor log per (account, workspace, repo, bot) — what keeps MEASUREMENT
// independent of EMISSION: a 'user_reported' row anchors a config change Limn never authored,
// and the effect panel reads anchors without ever seeing a recommendation. No unique — it's a
// log. `recommendationId` is a soft reference (no FK): a pruned recommendation must not
// invalidate history.
export const advisorConfigEvents = sqliteTable(
  'advisor_config_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    repoId: integer('repo_id').notNull(),
    botUserId: integer('bot_user_id').notNull(),
    // 'advisor_pr' | 'user_reported' | 'detected'
    source: text('source').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp' }).notNull(),
    configPath: text('config_path'),
    description: text('description'),
    recommendationId: integer('recommendation_id'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountRepoOccurredIx: index('advevt_account_repo_occurred').on(
      t.accountId,
      t.repoId,
      t.occurredAt,
    ),
  }),
);

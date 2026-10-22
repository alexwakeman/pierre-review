// Plugin-owned Postgres schema (cloud mode) — the structural twin of `schema.sqlite.ts`
// (SAME table + column names, SAME nullability), pg-core types. The named composite FK on
// advisor_bot_profiles lives in the migration SQL only (see the sqlite twin's note).
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const advisorRecommendations = pgTable(
  'advisor_recommendations',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    botUserId: integer('bot_user_id').notNull(),
    intent: text('intent').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    targetJson: text('target_json').notNull(),
    evidenceJson: text('evidence_json').notNull(),
    retroJson: text('retro_json'),
    outputJson: text('output_json'),
    status: text('status').notNull(),
    prRepoId: integer('pr_repo_id'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    issueUrl: text('issue_url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountWorkspaceKeyUx: uniqueIndex('advrec_account_ws_key').on(
      t.accountId,
      t.workspaceId,
      t.dedupeKey,
    ),
  }),
);

export const advisorBotProfiles = pgTable(
  'advisor_bot_profiles',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    botUserId: integer('bot_user_id').notNull(),
    kindHint: text('kind_hint'),
    configPath: text('config_path'),
    ownerContact: text('owner_contact'),
    ownerRepo: text('owner_repo'),
    notes: text('notes'),
    profileSource: text('profile_source'),
    manifestJson: text('manifest_json'),
    manifestConfirmedAt: timestamp('manifest_confirmed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountWorkspaceBotUx: uniqueIndex('advprof_account_ws_bot').on(
      t.accountId,
      t.workspaceId,
      t.botUserId,
    ),
  }),
);

export const advisorConfigEvents = pgTable(
  'advisor_config_events',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    repoId: integer('repo_id').notNull(),
    botUserId: integer('bot_user_id').notNull(),
    source: text('source').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    configPath: text('config_path'),
    description: text('description'),
    recommendationId: integer('recommendation_id'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountRepoOccurredIx: index('advevt_account_repo_occurred').on(
      t.accountId,
      t.repoId,
      t.occurredAt,
    ),
  }),
);

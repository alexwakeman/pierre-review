// ⚠ DORMANT: addressed_checks (the "was this addressed" check, REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// Plugin-owned SQLite schema for the "was this TRULY addressed?" check (local mode). Structural
// twin of `schema.pg.ts` (identical table + column names + nullability). Migrated by the host's
// runPluginMigrations via ../migrations/0012_resolution_check.sql; this module is ONLY the typed
// query surface. accountId is denormalized onto every row (the plugin's verify:isolation
// guarantee); every query filters it.
import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// One Haiku "given what changed afterward, was the concern this thread / PR comment raised actually
// addressed?" verdict + a 0-100 confidence. `targetKind` discriminates a review thread (keyed on
// reviewThreads.id) from a PR-level comment (keyed on prComments.id). One row per
// (accountId, targetKind, targetId); upserted on regenerate, $0-on-unchanged via payloadHash.
export const addressedChecks = sqliteTable(
  'addressed_checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    prId: integer('pr_id').notNull(),
    targetKind: text('target_kind').notNull(), // 'thread' | 'pr_comment'
    targetId: integer('target_id').notNull(),
    verdict: text('verdict').notNull(), // 'addressed' | 'likely' | 'partial' | 'not_addressed' | 'unclear'
    confidence: integer('confidence').notNull(), // 0-100
    rationale: text('rationale').notNull(), // Markdown
    payloadHash: text('payload_hash').notNull(),
    model: text('model').notNull(),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    targetUx: uniqueIndex('ac_account_target').on(t.accountId, t.targetKind, t.targetId),
  }),
);

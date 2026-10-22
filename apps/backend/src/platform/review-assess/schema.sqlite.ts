// ⚠ DORMANT: comment_assessments (the single-thread validity check, REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// Plugin-owned SQLite schema for Comment-validity assessment (local mode). Structural twin of
// `schema.pg.ts` (identical table + column names + nullability). Migrated by the host's
// runPluginMigrations via ../migrations/0011_comment_assess.sql; this module is ONLY the typed
// query surface. accountId is denormalized onto every row (the plugin's own verify:isolation
// guarantee); every query filters it.
import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// One Haiku "is this review comment valid, given the thread + diff?" assessment, keyed to a review
// thread's ORIGINATING (root) comment. One row per (accountId, commentId); upserted on regenerate,
// $0-on-unchanged via payloadHash. Retained after generation so the inline verdict persists.
export const commentAssessments = sqliteTable(
  'comment_assessments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    prId: integer('pr_id').notNull(),
    threadId: integer('thread_id').notNull(),
    commentId: integer('comment_id').notNull(), // the root comment the assessment is about
    verdict: text('verdict').notNull(), // 'valid' | 'partly' | 'weak' | 'unclear'
    assessment: text('assessment').notNull(), // Markdown rationale
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
    commentUx: uniqueIndex('ca_account_comment').on(t.accountId, t.commentId),
  }),
);

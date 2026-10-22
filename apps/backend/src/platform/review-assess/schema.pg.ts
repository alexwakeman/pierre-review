// ⚠ DORMANT: comment_assessments (the single-thread validity check, REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// Plugin-owned Postgres schema for Comment-validity assessment (cloud mode) — the structural twin
// of `schema.sqlite.ts` (SAME table + column names + nullability), pg-core types. db.ts types
// every query against this module and casts the active driver to it.
import {
  pgTable,
  text,
  integer,
  serial,
  doublePrecision,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const commentAssessments = pgTable(
  'comment_assessments',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    prId: integer('pr_id').notNull(),
    threadId: integer('thread_id').notNull(),
    commentId: integer('comment_id').notNull(),
    verdict: text('verdict').notNull(),
    assessment: text('assessment').notNull(),
    payloadHash: text('payload_hash').notNull(),
    model: text('model').notNull(),
    costUsd: doublePrecision('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    commentUx: uniqueIndex('ca_account_comment').on(t.accountId, t.commentId),
  }),
);

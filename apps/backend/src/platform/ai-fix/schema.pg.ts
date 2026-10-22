// ⚠ DORMANT: ai_pr_analyses (the AI PR summary + CI analysis, REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// Plugin-owned Postgres schema for AI Fix (cloud mode) — the structural twin of
// `schema.sqlite.ts` (SAME table + column names + nullability), pg-core types.
// db.ts types every query against this module and casts the active driver to it.
import {
  pgTable,
  text,
  integer,
  serial,
  doublePrecision,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const aiPrAnalyses = pgTable(
  'ai_pr_analyses',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    prId: integer('pr_id').notNull(),
    kind: text('kind').notNull(),
    headSha: text('head_sha'),
    payloadHash: text('payload_hash').notNull(),
    summary: text('summary').notNull(),
    model: text('model').notNull(),
    costUsd: doublePrecision('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    prKindUx: uniqueIndex('apa_account_pr_kind').on(
      t.accountId,
      t.prId,
      t.kind,
    ),
  }),
);

// (`ai_fixes` moved to core with AI Fix's agentic fixer: apps/backend/src/db/schema.pg.ts,
// core migration sqlite 0074 / pg 0061. This module keeps the Pro `ai_pr_analyses` only.)

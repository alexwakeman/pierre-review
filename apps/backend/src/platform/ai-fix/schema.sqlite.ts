// ⚠ DORMANT: ai_pr_analyses (the AI PR summary + CI analysis, REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// Platform-owned SQLite schema for AI Fix. Migrated by the
// host's runPluginMigrations via ../migrations/0002_ai_fix.sql; this module is ONLY
// the typed query surface. accountId is denormalized onto every row (the plugin's own
// verify:isolation guarantee); every query filters it.
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Cached read-only analyses (PR summary + CI failure analysis). One row per
// (accountId, prId, kind); upserted on regenerate, keyed by a payload content hash.
export const aiPrAnalyses = sqliteTable(
  'ai_pr_analyses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    prId: integer('pr_id').notNull(),
    kind: text('kind').notNull(), // 'summary' (+ dormant 'ci_analysis' rows from the retired CI analysis — never read)
    headSha: text('head_sha'),
    payloadHash: text('payload_hash').notNull(),
    summary: text('summary').notNull(),
    model: text('model').notNull(),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    prKindUx: uniqueIndex('apa_account_pr_kind').on(
      t.accountId,
      t.prId,
      t.kind,
    ),
  }),
);

// (`ai_fixes` moved to core with AI Fix's agentic fixer: apps/backend/src/db/schema.sqlite.ts,
// core migration sqlite 0074 / pg 0061. This module keeps the Pro `ai_pr_analyses` only.)

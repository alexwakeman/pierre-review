// ⚠ DORMANT: addressed_checks (the "was this addressed" check, REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// Plugin-owned Postgres schema for the "was this TRULY addressed?" check (cloud mode) — the
// structural twin of `schema.sqlite.ts` (SAME table + column names + nullability), pg-core types.
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

export const addressedChecks = pgTable(
  'addressed_checks',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    prId: integer('pr_id').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: integer('target_id').notNull(),
    verdict: text('verdict').notNull(),
    confidence: integer('confidence').notNull(),
    rationale: text('rationale').notNull(),
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
    targetUx: uniqueIndex('ac_account_target').on(t.accountId, t.targetKind, t.targetId),
  }),
);

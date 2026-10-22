// Plugin-owned Postgres schema for the comment-ANNOTATIONS platform (cloud mode) — the
// structural twin of `schema.sqlite.ts` (SAME table + column names + nullability), pg-core
// types. db.ts types every query against this module and casts the active driver to it.
// ⚠ LIVE FOR ONE KIND ONLY: `impact` (the blast-radius impact note, targetKind 'pull_request').
// The comment kinds 'addressed' | 'validity' | 'simplify' (the removed "Check review") are DORMANT
// rows: never written, skipped on read, still erased with the account. Never drop them.
import {
  pgTable,
  text,
  integer,
  serial,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const prCommentAnnotations = pgTable(
  'pr_comment_annotations',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    prId: integer('pr_id').notNull(),
    kind: text('kind').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: integer('target_id').notNull(),
    verdict: text('verdict'),
    confidence: integer('confidence'),
    body: text('body').notNull(),
    payloadHash: text('payload_hash').notNull(),
    model: text('model').notNull(),
    costUsd: doublePrecision('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    // See the sqlite twin: the grounding diff as JSON, `addressed` thread rows only.
    // Migration 0022.
    evidence: text('evidence'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    targetUx: uniqueIndex('pca_account_kind_target').on(
      t.accountId,
      t.kind,
      t.targetKind,
      t.targetId,
    ),
    prKindIdx: index('pca_account_pr_kind').on(t.accountId, t.prId, t.kind),
  }),
);

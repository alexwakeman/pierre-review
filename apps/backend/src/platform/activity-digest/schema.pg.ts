// ⚠ DORMANT: repo_digests (the per-repo activity digest, REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// The per-repo LLM headline digest cache (Pro). Lived in review-memory/schema.*.ts beside
// review_learnings until Claude Review's memory moved to core (core migration 0074 / pg 0061);
// repo_digests stayed, so it moved here, beside the feature that owns it.
// Plugin-owned Postgres schema (cloud mode) — the structural twin of
// `schema.sqlite.ts` (SAME table + column names, SAME nullability), with pg-core
// types. `db.ts` types every query against THIS module and casts the active driver
// to it, so drift would break the cast's soundness (kept in sync by hand, exactly
// like the host's schema.pg.ts). Mirrors the host's sqlite->pg type mapping:
//   integer().primaryKey({autoIncrement})  -> serial().primaryKey()
//   integer({mode:'timestamp'})            -> timestamp({withTimezone, mode:'date'})
//   real()                                 -> doublePrecision()
//   .default(sql`(unixepoch())`)           -> .defaultNow()
import {
  pgTable,
  text,
  integer,
  serial,
  doublePrecision,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const repoDigests = pgTable(
  'repo_digests',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    latestEventAt: timestamp('latest_event_at', {
      withTimezone: true,
      mode: 'date',
    }),
    model: text('model').notNull(),
    summary: text('summary').notNull(),
    costUsd: doublePrecision('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountRepoUx: uniqueIndex('rd_account_repo').on(t.accountId, t.repoId),
  }),
);

// ⚠ DORMANT: repo_digests (the per-repo activity digest, REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// The per-repo LLM headline digest cache (Pro). Lived in review-memory/schema.*.ts beside
// review_learnings until Claude Review's memory moved to core (core migration 0074 / pg 0061);
// repo_digests stayed, so it moved here, beside the feature that owns it.
// Plugin-owned SQLite schema (local mode). The structural twin lives in
// `schema.pg.ts` and MUST stay identical (same table + column names, same
// nullability) — `db.ts` casts the active driver+schema to the pg types, exactly
// like the host's client.ts. These tables are migrated by the host's
// runPluginMigrations via ctx.registerMigrations (the .sql under ../migrations);
// this module is ONLY the typed query surface, not a DDL source.
//
// Multi-tenancy: `accountId` is denormalized onto every table and every query
// filters it (the plugin's own verify:isolation guarantee). Composite uniques.
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Per-repo LLM headline digest cache (Pro Workstream 2). One row per
// (accountId, repoId); upserted on regenerate, keyed by a payload content hash.
export const repoDigests = sqliteTable(
  'repo_digests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    latestEventAt: integer('latest_event_at', { mode: 'timestamp' }),
    model: text('model').notNull(),
    summary: text('summary').notNull(),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountRepoUx: uniqueIndex('rd_account_repo').on(t.accountId, t.repoId),
  }),
);

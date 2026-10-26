// Plugin-owned SQLite schema (local mode) for the ONE synthesis cache (plan P2.1 / D3) — the
// cached, credit-metered Haiku grouping pass behind the drill-down verdict cards (C3) and the
// workspace bot synthesis (C6). Structural twin: `schema.pg.ts` (same table + column names +
// nullability, kept in step BY EYE — this package has no schema-parity test). Migrated by the
// host via ctx.registerMigrations (../../migrations/0027_synthesis.sql); this module is ONLY the
// typed query surface.
//
// One row per (account, SCOPE): `scopeKey` is the CANONICAL serialised descriptor
// (`synthesisScopeKey` in ./scope.ts — kind + ws:<id> + window + the drill-down's own narrowing,
// fixed slot order), so a regenerate OVERWRITES rather than accretes and two spellings of one
// drill-down cannot mint two rows. `kind` is embedded in the key AND stored as its own column so
// reads/erasure/ops can filter without parsing key strings.
//
// `output` is the VALIDATED grouping as JSON TEXT (server-verified itemIds ⊆ input,
// server-computed counts, recomputed remainder — D4: the model authors no numbers).
// `inputCount`/`analyzedCount` are real columns because the "Summarised X of Y" coverage line is
// the disclosure that keeps a capped synthesis honest. No cost columns — spend goes to the shared
// ai_usage ledger (feature 'synthesis').
//
// A REGENERABLE scope-keyed cache (the bot_theme_reports family, NOT the workspace_period_reports
// keyed-history family): listed in retention.ts's eraseProByAccountId, deliberately absent from
// pruneProByPrIds (no pr_id grain — staleness via the payload hash, not deletion, is how it ages),
// and seeded in test/isolation.test.ts.
//
// ⚠ Every `onConflictDoUpdate` on this table must target exactly [accountId, scopeKey] — the
// declared unique below. A stale conflict target TYPE-CHECKS perfectly and raises "no unique or
// exclusion constraint matching the ON CONFLICT specification" at runtime, in both dialects, only
// when a row is actually written (the 0042/0045 lesson).
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const proSynthesis = sqliteTable(
  'pro_synthesis',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    kind: text('kind').notNull(),
    payloadHash: text('payload_hash').notNull(),
    output: text('output').notNull(),
    model: text('model').notNull(),
    // Who answered ('claude' | 'codex'; platform migration 0042). NULL on older rows reads as Claude
    // unless `model` is a Codex id (packages/shared `aiRunProvider`). `model` is what RAN.
    provider: text('provider'),
    inputCount: integer('input_count').notNull(),
    analyzedCount: integer('analyzed_count').notNull(),
    generatedAt: integer('generated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountScopeUx: uniqueIndex('pro_synthesis_account_scope').on(t.accountId, t.scopeKey),
  }),
);

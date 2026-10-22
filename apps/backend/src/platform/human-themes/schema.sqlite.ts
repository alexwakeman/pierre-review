// ⚠ DORMANT: human_theme_reports (the Feed "Discussion themes", REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// Plugin-owned SQLite schema (local mode) for the Feed "Discussion themes" AI summary — the human
// sibling of bot_theme_reports. Structural twin: `schema.pg.ts`. Migrated by the host via
// ctx.registerMigrations; this module is ONLY the typed query surface.
import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// One cached Human-Themes report per (account, SCOPE, window). The full result (themes + narrative +
// participants + aggregates + coverage) is serialized into `resultJson`; keyed by a payload hash so
// re-generating an unchanged scope/window is $0.
//
// `scopeKey` is `scopeKeyFor(workspaceId)` — `ws:<id>`. The column NAME and its `'all'` default are
// deliberately unchanged (see bot-themes/schema.sqlite.ts for the full note); plugin migration 0020
// DELETEs every pre-workspace row, so nothing is left keyed by the legacy vocabulary.
export const humanThemeReports = sqliteTable(
  'human_theme_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull().default('all'),
    windowKind: text('window_kind').notNull().default('rolling_14'),
    payloadHash: text('payload_hash').notNull(),
    resultJson: text('result_json').notNull(),
    model: text('model').notNull(),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: integer('generated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountScopeWindowUx: uniqueIndex('htr_account_scope_window').on(
      t.accountId,
      t.scopeKey,
      t.windowKind,
    ),
  }),
);

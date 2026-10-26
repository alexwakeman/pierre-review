// Plugin-owned SQLite schema (local mode) for the Bots "Themes" AI summary — a Haiku qualitative
// read of what the automated reviewers are flagging over a WORKSPACE's repos in a window.
// Migrated by the host
// via ctx.registerMigrations (the .sql under ../migrations); this module is ONLY the typed query
// surface.
import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// One cached Bot-Themes report per (account, SCOPE, window). The full result (themes + narrative +
// the deterministic aggregates + coverage) is serialized into `resultJson`; the report is keyed by
// a payload hash so re-generating an unchanged scope/window is $0 (like preset_reports).
// `windowKind` distinguishes the rolling_7/14/30 windows.
//
// `scopeKey` is `scopeKeyFor(workspaceId)` — `ws:<id>` — so each workspace's report is cached
// independently. The COLUMN NAME (and its `'all'` default) are unchanged on purpose: renaming a
// column across six tables and two dialects buys nothing, and after plugin migration 0020 no row
// uses the default (every writer supplies the value, and 0020 DELETEs every pre-workspace row).
// The `ws:` prefix is what makes a legacy bare `'3'` (team 3) undistinguishable-proof against
// workspace 3, whose repo set is not necessarily the same.
export const botThemeReports = sqliteTable(
  'bot_theme_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull().default('all'),
    windowKind: text('window_kind').notNull().default('rolling_14'),
    payloadHash: text('payload_hash').notNull(),
    resultJson: text('result_json').notNull(),
    model: text('model').notNull(),
    // Who answered ('claude' | 'codex'; platform migration 0042). NULL on older rows reads as Claude
    // unless `model` is a Codex id (packages/shared `aiRunProvider`). `model` is what RAN.
    provider: text('provider'),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: integer('generated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountScopeWindowUx: uniqueIndex('btr_account_scope_window').on(
      t.accountId,
      t.scopeKey,
      t.windowKind,
    ),
  }),
);

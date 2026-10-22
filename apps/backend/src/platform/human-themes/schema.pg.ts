// ⚠ DORMANT: human_theme_reports (the Feed "Discussion themes", REMOVED). Nothing reads or writes this table any more; it stays declared so the
// account erasure, retention prune and isolation test still cover it. Never drop it.
// Plugin-owned Postgres schema (cloud mode) — the structural twin of `schema.sqlite.ts`.
import {
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const humanThemeReports = pgTable(
  'human_theme_reports',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull().default('all'),
    windowKind: text('window_kind').notNull().default('rolling_14'),
    payloadHash: text('payload_hash').notNull(),
    resultJson: text('result_json').notNull(),
    model: text('model').notNull(),
    costUsd: doublePrecision('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountScopeWindowUx: uniqueIndex('htr_account_scope_window').on(
      t.accountId,
      t.scopeKey,
      t.windowKind,
    ),
  }),
);

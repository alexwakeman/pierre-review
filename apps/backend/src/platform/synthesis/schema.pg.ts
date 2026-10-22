// Plugin-owned Postgres schema (cloud mode) — the structural twin of `schema.sqlite.ts` (SAME
// table + column names, SAME nullability), pg-core types. Every column comment lives in the
// sqlite twin; the two are kept in step BY EYE (this package has no schema-parity test). The
// mechanical mapping is the period-schema one: autoincrement pk → serial, timestamp-mode integer
// → timestamptz, `(unixepoch())` → now(). JSON stays TEXT in BOTH dialects.
import { integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const proSynthesis = pgTable(
  'pro_synthesis',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    kind: text('kind').notNull(),
    payloadHash: text('payload_hash').notNull(),
    output: text('output').notNull(),
    model: text('model').notNull(),
    inputCount: integer('input_count').notNull(),
    analyzedCount: integer('analyzed_count').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountScopeUx: uniqueIndex('pro_synthesis_account_scope').on(t.accountId, t.scopeKey),
  }),
);

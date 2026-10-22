// Plugin-owned Postgres schema (cloud mode) — the structural twin of `schema.sqlite.ts` (SAME
// table + column names, SAME nullability), pg-core types. Every column comment lives in the
// sqlite twin; the two are kept in step BY EYE (this package has no schema-parity test). The
// mechanical mapping is the synthesis/period one: autoincrement pk → serial, timestamp-mode
// integer → timestamptz, `(unixepoch())` → now(). JSON stays TEXT in BOTH dialects.
import { integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const proWorkPlans = pgTable(
  'pro_work_plans',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    output: text('output').notNull(),
    model: text('model').notNull(),
    itemCount: integer('item_count').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountScopeUx: uniqueIndex('pro_work_plans_account_scope').on(t.accountId, t.scopeKey),
  }),
);

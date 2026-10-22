// Postgres twin of ./schema.sqlite.ts — the Chronology pointers cache. Same table, columns and
// nullability; see the sqlite twin for what the row holds and why.
import { integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const proFlowPointers = pgTable(
  'pro_flow_pointers',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    output: text('output').notNull(),
    model: text('model').notNull(),
    prCount: integer('pr_count').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountScopeUx: uniqueIndex('pro_flow_pointers_account_scope').on(t.accountId, t.scopeKey),
  }),
);

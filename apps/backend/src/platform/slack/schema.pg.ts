import { integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// Twin of schema.sqlite.ts (plugin migration 0040), where the reasoning lives.
export const slackSignalNotices = pgTable(
  'slack_signal_notices',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    kind: text('kind').$type<'merge' | 'review'>().notNull(),
    refId: integer('ref_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    accountKindRefUx: uniqueIndex('slack_signal_notices_account_kind_ref').on(
      t.accountId,
      t.kind,
      t.refId,
    ),
  }),
);

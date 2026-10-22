import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ── SENT MARKERS FOR THE SLACK EVENT SIGNALS (plugin migration 0040) ─────────────────────────
//
// One row per (account, kind, ref) that has been CLAIMED for a Slack post: `kind = 'merge'` keys on
// the PR id (once per PR, forever), `kind = 'review'` on the Claude Review run id. The row is
// inserted BEFORE the webhook call (insert … on conflict do nothing), so a second observer of the
// same merge — the next walk, a webhook, a restart — finds the claim and sends nothing. A failed
// post is logged and NOT retried: a retry would double-post when Slack accepted but answered late.
//
// No FK onto core tables (the open-core boundary); account-scoped, so it is in the erasure hook
// (retention.ts).
export const slackSignalNotices = sqliteTable(
  'slack_signal_notices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    kind: text('kind').$type<'merge' | 'review'>().notNull(),
    refId: integer('ref_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountKindRefUx: uniqueIndex('slack_signal_notices_account_kind_ref').on(
      t.accountId,
      t.kind,
      t.refId,
    ),
  }),
);

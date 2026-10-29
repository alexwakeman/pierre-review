import { and, inArray, sql } from 'drizzle-orm';
import { schema, type Executor } from './client.js';

// THE TICKET-COMMENTS HALF OF BOTH PR DELETE PATHS (deleteRepo in queries.ts, retention's
// deletePrSubtree). Comments are stored per TICKET (`tracker_ticket_comments`, migration 0141), not per
// PR, so deleting a PR's `tracker_tickets` rows does not reach them. After those rows go, the comments
// of every ticket NO `tracker_tickets` row of the same account names any more are deleted — a ticket
// still on a surviving PR keeps its comments. Runs inside the caller's transaction. `accountIds` narrows
// the sweep (deleteRepo knows its account); null sweeps every account (retention spans them).
export async function pruneOrphanTicketComments(tx: Executor, accountIds: readonly number[] | null): Promise<void> {
  if (accountIds != null && accountIds.length === 0) return;
  const c = schema.trackerTicketComments;
  const orphan = sql`NOT EXISTS (SELECT 1 FROM "tracker_tickets" tt WHERE tt."account_id" = "tracker_ticket_comments"."account_id" AND tt."provider" = "tracker_ticket_comments"."provider" AND tt."api_root" = "tracker_ticket_comments"."api_root" AND tt."issue_key" = "tracker_ticket_comments"."issue_key")`;
  await tx
    .delete(c)
    .where(accountIds != null ? and(inArray(c.accountId, [...accountIds]), orphan) : orphan)
    .execute();
}

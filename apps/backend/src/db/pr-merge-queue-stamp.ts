// A pull request's GitHub MERGE-QUEUE membership, stamped from a live observation.
//
// ⚠ NOT `db/merge-queue.ts`. That module is Limn's OWN per-repo landing order for armed intents
// (`queued_local`); this one is GitHub's native merge queue, as synced onto `pull_requests`
// (`in_merge_queue` + `merge_queue_entry_state`). Two queues, two files, never one name.
//
// WHY A STAMP AT ALL. A GitHub write is not done when GitHub 200s: the SPA re-reads from the local
// DB, so an enqueue nobody stamped is invisible until the next adaptive walk — up to fifteen
// minutes on a cold repo — and the Pending board is forbidden from fetching to find out. So EVERY
// path that holds a positive answer about membership writes it here:
//
//   - POST / DELETE /api/prs/:id/merge-queue (the two verbs, and the DELETE's own probe)
//   - GET /api/prs/:id/merge-options, when its queue probe answered
//   - the arm route's AlreadyQueued 409 (it just proved the PR is queued)
//   - the disarm route's dequeue of a watcher-made entry
//   - the auto-merge runner's enqueue, and its per-tick live probe
//
// ⚠ POSITIVE ANSWERS ONLY — the partial-response rule ("a column may be CLEARED only on a positive
// statement from GitHub"). Callers pass a NON-NULL `fetchMergeQueueState` result (non-tolerant
// GraphQL with `isInMergeQueue: Boolean!`, so a result is a statement) or the outcome of a mutation
// GitHub accepted. Never the `.catch(() => null)` null of a best-effort probe: that is "we never
// received it", and writing `false` from it would tell the board a queued PR is not queued.
//
// ⚠ THE SYNC'S OWN THREE-STATE FOLD (sync/upsert.ts) DOES NOT COME THROUGH HERE, and must not: a
// walk that did not carry the selection OMITS the keys, and an unconditional setter cannot say
// "omit". This helper is correct precisely because every caller holds an answer.
//
// ⚠ A STAMP THAT CHANGES THE STORED VALUE RAISES THE CHANGE SIGNAL (`notePrChanged`). The board's
// liveness sweep compares GitHub against the ROW, so once a route has written the new value the
// sweep sees no difference and never repaints the card; without the signal a stamp made by the
// runner or by a GET would silence the one mechanism that used to catch it. A write that changed
// nothing raises nothing — a signal costs the SPA a cascade of refetches.

import { and, eq } from 'drizzle-orm';
import { db, schema } from './client.js';
import { mergeQueueEntryStateFrom } from '../sync/upsert.js';
import { notePrChanged } from '../sync/pr-change-signal.js';

/**
 * Write what GitHub just said about this PR's merge-queue membership. Account-scoped (a foreign
 * id matches no row and writes nothing). Returns true when the stored value CHANGED.
 *
 * `rawEntryState` is GitHub's `MergeQueueEntryState` as it arrived (`QUEUED`, `AWAITING_CHECKS`,
 * …), normalised by the ONE normaliser the sync uses. Out of the queue means no entry — a stale
 * `queued` is never carried past a dequeue. In the queue with no modelled state stores "queued,
 * state unknown", never "not queued".
 */
export async function stampPrMergeQueueState(
  prId: number,
  accountId: number,
  inQueue: boolean,
  rawEntryState: string | null,
): Promise<boolean> {
  const { pullRequests } = schema;
  const next = {
    inMergeQueue: inQueue,
    mergeQueueEntryState: inQueue ? mergeQueueEntryStateFrom(rawEntryState) : null,
  };
  const owned = and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId));
  const rows = await db
    .select({
      repoId: pullRequests.repoId,
      inMergeQueue: pullRequests.inMergeQueue,
      mergeQueueEntryState: pullRequests.mergeQueueEntryState,
    })
    .from(pullRequests)
    .where(owned)
    .execute();
  const row = rows[0];
  if (row == null) return false;
  if (
    row.inMergeQueue === next.inMergeQueue &&
    (row.mergeQueueEntryState ?? null) === next.mergeQueueEntryState
  ) {
    return false;
  }
  await db.update(pullRequests).set(next).where(owned).execute();
  notePrChanged(accountId, row.repoId);
  return true;
}

/** The logger half a route or the runner hands in — pino's `warn(obj, msg)`. */
export interface MergeQueueStampLog {
  warn(obj: object, msg: string): void;
}

/**
 * The same write, NEVER FATAL — what every ROUTE calls.
 *
 * ⚠ A STAMP IS A LOCAL COPY OF SOMETHING GITHUB ALREADY SAID, so failing to write it is a stale
 * screen, never a failed request. Most call sites sit inside a try whose catch answers
 * `502 GitHubError`: a DB hiccup there would make GET merge-options read "Couldn't load merge
 * status", refuse an arm, or — after GitHub has ACCEPTED an enqueue or a dequeue — tell the reader
 * the write failed when it landed (and invite a retry). "Once GitHub has 201'd the route may not
 * fail." So the failure is logged and swallowed here, once, rather than at each call site.
 */
export async function stampPrMergeQueueStateNonFatal(
  prId: number,
  accountId: number,
  inQueue: boolean,
  rawEntryState: string | null,
  log: MergeQueueStampLog,
): Promise<void> {
  try {
    await stampPrMergeQueueState(prId, accountId, inQueue, rawEntryState);
  } catch (err) {
    log.warn({ err, prId }, 'merge queue: could not record the queue state on the PR row');
  }
}

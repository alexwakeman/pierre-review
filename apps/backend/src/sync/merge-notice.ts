// ── "A PR WAS SEEN MERGING LIVE" — the one predicate behind the merge event hook ─────────────
//
// The Pro plugin's Slack "Pull request merged" signal must fire for merges this process OBSERVED
// happening, never for history: a first sync, the 90-day deep backfill and every re-walk of an
// already-merged PR must stay silent. Two conditions, both required:
//
//   1. WE KNEW THE PR WHILE IT WAS OPEN. Either `persistPr`'s pre-upsert row said `open`, or the
//      liveness sweep (db/pr-liveness.ts) flipped it open → merged moments ago and recorded it here
//      — that sweep writes `state` without `mergedById`, so the walk that follows would otherwise
//      see `prev.state === 'merged'` and never announce it. A first sighting (`prev === null`) is
//      never live.
//   2. THE MERGE IS RECENT — `mergedAt` within MERGE_NOTICE_WINDOW_MS of the observation. A PR
//      that sat in the DB as open for months and is re-walked after an outage does not page a
//      channel about a merge from last week.
//
// The pending set is in-memory and bounded by the same window (entries older than it are pruned):
// a restart between the liveness flip and the walk loses that one notice, which is the safe
// direction. Dedupe "once per PR, forever" is the PLUGIN's claimed marker, not this module's.

export const MERGE_NOTICE_WINDOW_MS = 2 * 60 * 60 * 1000;

const pending = new Map<string, number>(); // `${accountId}:${prId}` → observedAt ms
const key = (accountId: number, prId: number): string => `${accountId}:${prId}`;

function prune(nowMs: number): void {
  for (const [k, at] of pending) {
    if (nowMs - at > MERGE_NOTICE_WINDOW_MS) pending.delete(k);
  }
}

/** The liveness sweep saw an OPEN row come back merged. */
export function noteLiveMergeTransition(accountId: number, prId: number, nowMs = Date.now()): void {
  prune(nowMs);
  pending.set(key(accountId, prId), nowMs);
}

/**
 * Should `persistPr`'s write of a MERGED PR announce it? Consumes a pending liveness record.
 * Exported pure-ish for its unit test.
 */
export function isLiveMergeObservation(args: {
  accountId: number;
  prId: number;
  prevState: string | null; // null = first sighting
  mergedAt: Date | null;
  nowMs?: number;
}): boolean {
  const nowMs = args.nowMs ?? Date.now();
  prune(nowMs);
  const k = key(args.accountId, args.prId);
  const sawFlip = pending.has(k);
  if (args.prevState == null) return false;
  if (args.prevState !== 'open' && !sawFlip) return false;
  pending.delete(k);
  if (args.mergedAt == null) return false;
  const age = nowMs - args.mergedAt.getTime();
  return age >= -5 * 60 * 1000 && age <= MERGE_NOTICE_WINDOW_MS;
}

/** Test seam. */
export function resetMergeNoticesForTest(): void {
  pending.clear();
}

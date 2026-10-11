import { and, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { inChunks, type TrackerContext } from './context.js';

// THE TICKET-DATES NUDGE (docs/TRACKERS.md § Created and resolved dates). Migration 0098 / pg 0085
// added `issue_created_at` / `issue_resolved_at`; every read since stores them. An OPEN PR's rows are
// re-read on their 30-minute TTL anyway, so they fill by themselves. A MERGED PR's rows are history —
// the worker reads them in missing-only mode and never refreshes them — so without this they would
// stay dateless and the label run would bucket every older story by its first PR instead.
//
// So, ONCE PER TICKET PER PROCESS, a few at a time: tickets whose 'ok' row on a PR MERGED in the last
// 90 days (the worker's own `MERGED_WINDOW_MS`) has no created date are handed to the worker's ONE
// body (`syncPrTickets` with `datesOwed`), which
//   • copies a stored sibling that already has the dates (no call), else reads the ticket;
//   • honours the workspace backoff and the pass budget like any read;
// and the account pass (./worker.ts `runAccountPass`) runs it only on the CRON TICK's unscoped pass
// (`datesNudge`, passed by `runTrackerTick` alone — never by a repo-walk kick, which would add a
// batch per finished walk outside the tick's `MAX_PER_TICK`), only when that pass left NOTHING due,
// and with at most `DATES_BACKFILL_BATCH` tickets out of what remains of its budget. Ticks are two
// minutes apart, so the backlog drains at a walking pace — never a burst.
//
// A ticket the tracker answers with NO created date (or one detection no longer names) is tried once
// and then left alone: `tried` is remembered in memory, so the nudge can never loop on it. A restart
// forgets it — that costs one more read per such ticket, not a loop. Once a scan over EVERY reading
// repo of the account finds nothing owed, the account is DONE until restart (new reads carry the
// dates from the start). ⚠ A scan narrowed to some repos never marks it done (`fullScope`): one quiet
// repo says nothing about the others.

/** Tickets one pass may nudge at most. */
export const DATES_BACKFILL_BATCH = 6;
const WINDOW_MS = 90 * 24 * 60 * 60_000;
/** = the worker's `OK_TTL_MS`: a row read more recently than this is not owed. */
const RECENT_READ_MS = 30 * 60_000;

const tried = new Map<number, Set<string>>();
const done = new Set<number>();

const ticketKey = (provider: string, apiRoot: string, key: string): string => `${provider}|${apiRoot}|${key}`;

export interface DatesOwed {
  /** Merged PR ids to hand the worker. */
  prIds: number[];
  /** Per PR, the keys owed their dates. */
  keys: Map<number, Set<string>>;
  /** The tickets picked (provider|apiRoot|key) and the PRs behind each. */
  tickets: Map<string, number[]>;
}

/** Up to `limit` dateless tickets on recently merged PRs of these repos (this account only). */
export async function datesOwedFor(
  ctx: TrackerContext,
  accountId: number,
  repoIds: readonly number[],
  nowMs: number,
  limit: number,
  /** The scan covered every reading repo of the account — only then may "nothing owed" mark it done. */
  fullScope: boolean,
): Promise<DatesOwed> {
  const out: DatesOwed = { prIds: [], keys: new Map(), tickets: new Map() };
  if (done.has(accountId) || repoIds.length === 0 || limit <= 0) return out;
  const t = ctx.schema.trackerTickets;
  const pr = ctx.schema.pullRequests;
  const rows = await inChunks([...new Set(repoIds)], async (chunk) =>
    (await ctx.db
      .select({ prId: t.prId, issueKey: t.issueKey, provider: t.provider, apiRoot: t.apiRoot, mergedAt: pr.mergedAt })
      .from(t)
      .innerJoin(pr, and(eq(pr.id, t.prId), eq(pr.accountId, accountId)))
      .where(
        and(
          eq(t.accountId, accountId),
          eq(t.state, 'ok'),
          isNull(t.issueCreatedAt),
          // Read more than a TTL ago: a row read just now (this very pass, or since 0098) was read
          // WITH the dates, so a dateless one means the tracker gave none — not owed.
          lt(t.fetchedAt, new Date(nowMs - RECENT_READ_MS)),
          eq(pr.state, 'merged'),
          gte(pr.mergedAt, new Date(nowMs - WINDOW_MS)),
          inArray(pr.repoId, chunk),
        ),
      )
      .orderBy(desc(pr.mergedAt), desc(t.id))
      .execute()) as Array<{ prId: number; issueKey: string; provider: string; apiRoot: string; mergedAt: Date | null }>,
  );
  const mine = tried.get(accountId) ?? new Set<string>();
  // Newest merge first across chunks, so the stories most likely on screen fill first.
  rows.sort((a, b) => (b.mergedAt?.getTime() ?? 0) - (a.mergedAt?.getTime() ?? 0));
  for (const r of rows) {
    const k = ticketKey(r.provider, r.apiRoot, r.issueKey);
    if (mine.has(k)) continue;
    if (!out.tickets.has(k)) {
      if (out.tickets.size >= limit) continue;
      out.tickets.set(k, []);
    }
    out.tickets.get(k)!.push(r.prId);
    const set = out.keys.get(r.prId) ?? new Set<string>();
    set.add(r.issueKey);
    out.keys.set(r.prId, set);
  }
  if (out.tickets.size === 0 && fullScope) done.add(accountId);
  out.prIds = [...out.keys.keys()];
  return out;
}

/** Remember what a nudge tried. A ticket all of whose PRs are still owed (over budget, backed off,
 *  a transient failure) is NOT marked — it comes back on a later pass. */
export function noteDatesTried(accountId: number, owed: DatesOwed, unsettled: ReadonlySet<number>): void {
  const mine = tried.get(accountId) ?? new Set<string>();
  tried.set(accountId, mine);
  for (const [k, prIds] of owed.tickets) {
    if (prIds.every((id) => unsettled.has(id))) continue;
    mine.add(k);
  }
}

/** A settings change (a new site or token) — look again. */
export function reopenDatesBackfill(accountId: number): void {
  done.delete(accountId);
  tried.delete(accountId);
}

/** Test seam. */
export function resetDatesBackfill(): void {
  tried.clear();
  done.clear();
}

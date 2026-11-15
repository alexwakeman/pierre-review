// THE RELEASE SCAN'S LAST TWO STEPS (docs/RELEASES.md § Implementation → Automatic candidate), run by
// the tags step (sync/tags-step.ts) after the ranges, for a RELEASABLE repo only:
//
//   prs      a range PR number with no `pull_requests` row (older than the 90-day sync, or never
//            walked) is synced through THE single-PR path (`syncOnePr` → `persistPr`), so it becomes an
//            ordinary stored PR. OLDEST TAG FIRST (the candidate is proven early), at most
//            RELEASE_PR_FETCH_PER_RUN per run, RELEASE_PR_FETCH_CONCURRENCY at a time, stopped by the
//            run's deadline and the account's budget (paused, never an error). A PR GitHub does not give
//            is remembered (releases/scan-state.ts): it HOLDS its tag and is asked again later.
//   tickets  the range PRs whose tickets are not read yet (THE detection rule finds a key, no stored
//            row: db/release-check.ts `releaseTicketsOwed`, per releasing workspace) are queued in the
//            tracker worker's priority set and a pass is kicked (tracker/worker.ts
//            `queueReleaseTicketReads`, `kickReleaseTicketReads`) — the worker's own missing-only read,
//            any tracker the workspace has. The tracker is still read when a PR is RECEIVED (here: by the
//            scan), never when a page is viewed.
//
// NEVER THROWS. Logs carry the repo and counts only.
import { and, eq, inArray } from 'drizzle-orm';
import { compareTagOrder } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { isBudgetLow, isLimited } from '../github/rate-budget.js';
import { endScanStep, noteScanStep, notePrFetchFailed, notePrFetched, prFetchDue, unreadablePrNumbers } from '../releases/scan-state.js';
import type { TagSyncLogger } from './repo-tags.js';

const { repoTags, repoTagRanges, pullRequests } = schema;

/** Range PRs synced per run. */
export const RELEASE_PR_FETCH_PER_RUN = 120;
export const RELEASE_PR_FETCH_CONCURRENCY = 3;

export interface FetchRangePrsResult {
  fetched: number;
  failed: number;
  /** Numbers still not stored and not failed (a later run). */
  left: number;
  total: number;
  paused: boolean;
}

/** Range PR numbers in tag order (oldest tag first), each once. Pure. */
export function rangePrNumbersInOrder(
  tags: ReadonlyArray<{ name: string; committedAt: Date | null; taggedAt: Date | null }>,
  ranges: ReadonlyArray<{ tagName: string; prNumbers: number[] | null }>,
): number[] {
  const byName = new Map(tags.map((t) => [t.name, t]));
  const ordered = [...ranges].sort((a, b) => {
    const ta = byName.get(a.tagName) ?? { name: a.tagName, committedAt: null, taggedAt: null };
    const tb = byName.get(b.tagName) ?? { name: b.tagName, committedAt: null, taggedAt: null };
    return compareTagOrder(ta, tb);
  });
  const seen = new Set<number>();
  const out: number[] = [];
  for (const r of ordered) for (const n of r.prNumbers ?? []) if (!seen.has(n)) (seen.add(n), out.push(n));
  return out;
}

export async function fetchMissingRangePrs(opts: {
  accountId: number;
  repoId: number;
  owner: string;
  name: string;
  deadline?: number;
  cap?: number;
  log?: TagSyncLogger;
  deps?: { syncPr?: (prNumber: number) => Promise<boolean> };
}): Promise<FetchRangePrsResult> {
  const { accountId, repoId, log } = opts;
  const out: FetchRangePrsResult = { fetched: 0, failed: 0, left: 0, total: 0, paused: false };
  try {
    const [tags, ranges] = await Promise.all([
      db
        .select({ name: repoTags.name, committedAt: repoTags.committedAt, taggedAt: repoTags.taggedAt })
        .from(repoTags)
        .where(and(eq(repoTags.accountId, accountId), eq(repoTags.repoId, repoId)))
        .execute(),
      db
        .select({ tagName: repoTagRanges.tagName, prNumbers: repoTagRanges.prNumbers })
        .from(repoTagRanges)
        .where(and(eq(repoTagRanges.accountId, accountId), eq(repoTagRanges.repoId, repoId)))
        .execute(),
    ]);
    const numbers = rangePrNumbersInOrder(tags, ranges);
    out.total = numbers.length;
    const stored = new Set<number>();
    for (let i = 0; i < numbers.length; i += 400) {
      const rows = await db
        .select({ number: pullRequests.number })
        .from(pullRequests)
        .where(and(eq(pullRequests.accountId, accountId), eq(pullRequests.repoId, repoId), inArray(pullRequests.number, numbers.slice(i, i + 400))))
        .execute();
      for (const r of rows) stored.add(r.number);
    }
    // A number stored since it last failed is no longer unreadable.
    for (const n of unreadablePrNumbers(repoId)) if (stored.has(n) || !numbers.includes(n)) notePrFetched(repoId, n);
    const missing = numbers.filter((n) => !stored.has(n));
    const todo = missing.filter((n) => prFetchDue(repoId, n));
    out.left = missing.length;
    if (todo.length === 0) {
      endScanStep(repoId, 'prs');
      out.left = missing.filter((n) => prFetchDue(repoId, n)).length;
      return out;
    }
    const syncPr =
      opts.deps?.syncPr ??
      (async (n: number): Promise<boolean> => {
        const { syncOnePr } = await import('./sync-one-pr.js');
        const logger = { info: () => {}, warn: (m: string) => log?.warn(m), error: (m: string) => log?.warn(m) };
        return syncOnePr(repoId, n, logger);
      });
    const failedNow = new Set(unreadablePrNumbers(repoId));
    let done = stored.size + [...failedNow].filter((n) => numbers.includes(n) && !todo.includes(n)).length;
    const tell = (paused: boolean): void => noteScanStep(repoId, { step: 'prs', done, total: numbers.length, paused });
    tell(false);
    const cap = opts.cap ?? RELEASE_PR_FETCH_PER_RUN;
    const queue = todo.slice(0, cap);
    let next = 0;
    let stop = false;
    await Promise.all(
      Array.from({ length: Math.min(RELEASE_PR_FETCH_CONCURRENCY, queue.length) }, async () => {
        while (!stop && next < queue.length) {
          if (isLimited(accountId) || isBudgetLow(accountId)) {
            out.paused = true;
            stop = true;
            break;
          }
          if (opts.deadline != null && Date.now() >= opts.deadline) {
            stop = true;
            break;
          }
          const n = queue[next++]!;
          let ok = false;
          try {
            ok = await syncPr(n);
          } catch {
            ok = false;
          }
          if (ok) {
            notePrFetched(repoId, n);
            out.fetched += 1;
            done += 1;
          } else if (isLimited(accountId) || isBudgetLow(accountId)) {
            // Most likely the budget, not the PR: not remembered as unreadable.
            out.paused = true;
            stop = true;
          } else {
            notePrFetchFailed(repoId, n);
            out.failed += 1;
            done += 1;
          }
          tell(out.paused);
        }
      }),
    );
    out.left = Math.max(0, todo.length - out.fetched - out.failed);
    if (out.left === 0) endScanStep(repoId, 'prs');
    if (out.fetched + out.failed > 0) {
      log?.info(`release scan ${opts.owner}/${opts.name}: ${out.fetched} pull request(s) stored, ${out.failed} not given, ${out.left} left`);
    }
  } catch (err) {
    log?.warn(`release scan ${opts.owner}/${opts.name}: fetching pull requests failed (non-fatal): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
  return out;
}

export interface QueueRangeTicketsResult {
  /** PRs queued for a ticket read. */
  queued: number;
  /** Tickets not read yet (all releasing workspaces). */
  waiting: number;
}

/**
 * Queue the range PRs whose tickets are not read yet and kick the tracker worker. Never throws.
 * `deps` are test seams.
 */
export async function queueRangeTickets(opts: {
  accountId: number;
  repoId: number;
  log?: TagSyncLogger;
  deps?: {
    owed?: () => Promise<{ prIds: number[]; waiting: number }>;
    queue?: (prIds: number[]) => void;
  };
}): Promise<QueueRangeTicketsResult> {
  const { accountId, repoId } = opts;
  try {
    let owed: { prIds: number[]; waiting: number };
    if (opts.deps?.owed != null) owed = await opts.deps.owed();
    else {
      const [{ releaseRangeViews }, { releaseTicketsOwed }] = await Promise.all([
        import('../db/release-repos.js'),
        import('../db/release-check.js'),
      ]);
      const prIds = new Set<number>();
      let waiting = 0;
      for (const v of await releaseRangeViews(accountId, repoId)) {
        if (v.workspaceId == null) continue;
        const o = await releaseTicketsOwed(accountId, v.workspaceId, repoId, v.settings);
        for (const id of o.prIds) prIds.add(id);
        waiting += o.waiting;
      }
      owed = { prIds: [...prIds], waiting };
    }
    if (owed.prIds.length > 0) {
      if (opts.deps?.queue != null) opts.deps.queue(owed.prIds);
      else {
        // LAZY: tracker/runtime.ts opens the database at import.
        const [{ trackerContext }, { queueReleaseTicketReads, kickReleaseTicketReads }] = await Promise.all([
          import('../tracker/runtime.js'),
          import('../tracker/worker.js'),
        ]);
        queueReleaseTicketReads(accountId, owed.prIds);
        void kickReleaseTicketReads(trackerContext(), accountId);
      }
    }
    return { queued: owed.prIds.length, waiting: owed.waiting };
  } catch (err) {
    opts.log?.warn(`release scan: queueing ticket reads failed (non-fatal): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return { queued: 0, waiting: 0 };
  }
}

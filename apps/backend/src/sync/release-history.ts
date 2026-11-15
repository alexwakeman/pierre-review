// THE RELEASE SCAN'S ONE HISTORY PASS (docs/RELEASES.md § Implementation → One history pass). For a
// RELEASABLE repo only, run by the tags step (sync/tags-step.ts) after the tag read. It replaces the
// per-tag REST ancestry checks, the per-tag compares and the full single-PR syncs of old PRs.
//
//   READ    the default branch's FIRST-PARENT history NEWEST FIRST: GraphQL `history(first: 100)` on a
//           commit, each commit with `parents(first: 1)` (the chain) and `associatedPullRequests(first:
//           2)` (merged into the default branch → number, title, head branch, author, merge commit).
//           About 3 points a page of 100 commits.
//   STORE   each first-parent commit (`release_history_commits`: its place `seq` and its PR numbers)
//           and each PR's LIGHT record (`release_range_prs`). No `pull_requests` row is made. Which
//           tag a commit belongs to, and which tags are on the default branch, are DERIVED on read
//           (releases/history-fold.ts `historyView`), so a new or moved tag costs no GitHub call.
//   SEGMENTS (`release_history_scans`, one row per repo)
//     deep  from the first head ever read, back until EVERY releasing workspace's BASELINE commit (the
//           newest release tag on the default branch — the first one the walk meets) or the root. It
//           PAUSES at the baseline (cursor kept): a later change of suffix or a deleted release tag
//           lets it go on from there.
//     tip   when the head moved: ONE REST compare `top...head`. A fast-forward → walk the new head down
//           to the walked head (`top_sha`), newest first, before the deep segment goes on. Anything
//           else (rewritten history) → everything stored is dropped and the walk starts again.
//   BOUNDS  resumable (a page's commits and the cursor are written in one transaction), time-boxed by
//           the run's `deadline`, stopped while the account's GraphQL budget is low or limited (paused,
//           never an error). NEVER THROWS.
import { and, count, eq, gt, inArray, lte } from 'drizzle-orm';
import { tagKind, type ReleaseRangeView } from '@pierre-review/shared';
import { db, runTransaction, schema } from '../db/client.js';
import { getGraphqlClientFor, graphqlTolerant, isRateLimitError, withGithubRetry } from '../github/client.js';
import { isBudgetLow, isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import {
  fetchComparePage,
  HISTORY_PAGE,
  RELEASE_HISTORY_QUERY,
  type ReleaseHistoryResponse,
  type RestCompareResponse,
} from '../github/tag-queries.js';
import { walkHistoryPage, type WalkedCommit } from '../releases/history-fold.js';
import { automationVendorFor, isLikelyBot } from './bot-detection.js';

const { releaseHistoryScans, releaseHistoryCommits, releaseRangePrs, repoTags } = schema;

/** The `seq` room of one segment: a tip segment's commits sort above every older one. */
export const SEQ_SPAN = 1_000_000_000;
const EPOCH = '1970-01-01T00:00:00Z';

export interface HistoryLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface WalkHistoryOptions {
  owner: string;
  name: string;
  repoId: number;
  accountId: number;
  token: string;
  /** The default branch head and name the tag read just saw. */
  headSha: string;
  defaultBranch: string;
  /** The workspaces releasing this repo (their suffixes decide each one's baseline). */
  views: readonly ReleaseRangeView[];
  deadline?: number;
  log?: HistoryLogger;
  onProgress?: (p: { done: number; total: number; paused: boolean }) => void;
  deps?: {
    history?: (oid: string, after: string | null, since: string) => Promise<ReleaseHistoryResponse>;
    compare?: (base: string, head: string) => Promise<RestCompareResponse>;
    now?: () => number;
  };
}

export interface WalkHistoryResult {
  /** History pages read this run (the GraphQL calls). */
  pages: number;
  /** REST compares this run (0 or 1). */
  compares: number;
  /** First-parent commits stored this run. */
  walked: number;
  /** Nothing left to walk for any releasing workspace. */
  complete: boolean;
  /** The run stopped on the rate budget. */
  paused: boolean;
  /** History was rewritten: everything stored was dropped and the walk started again. */
  restarted: boolean;
}

type ScanRow = typeof releaseHistoryScans.$inferSelect;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message.slice(0, 200) : String(err));

/** A light record's bot rule: GitHub typed the author a Bot, or the login is known automation. Pure. */
export function historyAuthorIsBot(login: string | null, botType: boolean): boolean {
  if (botType) return true;
  if (login == null) return false;
  return isLikelyBot(login) || automationVendorFor(login) != null;
}

/** Per releasing workspace, the shas of its RELEASE tags (by name). Pure. */
export function releaseShasPerView(
  tags: ReadonlyArray<{ name: string; sha: string }>,
  views: readonly ReleaseRangeView[],
): Array<Set<string>> {
  return views.map((v) => new Set(tags.filter((t) => tagKind(t.name, v.settings) === 'release').map((t) => t.sha)));
}

/** The date the progress estimate counts from: the OLDEST of each workspace's newest release tag
 *  (the deepest the walk needs to go); the epoch when one workspace has none. Pure. */
export function estimateSince(
  tags: ReadonlyArray<{ name: string; sha: string; committedAt: Date | null }>,
  views: readonly ReleaseRangeView[],
): string {
  let since: number | null = null;
  for (const v of views) {
    let newest: number | null = null;
    for (const t of tags) {
      if (tagKind(t.name, v.settings) !== 'release' || t.committedAt == null) continue;
      newest = Math.max(newest ?? 0, t.committedAt.getTime());
    }
    if (newest == null) return EPOCH;
    since = since == null ? newest : Math.min(since, newest);
  }
  return since == null ? EPOCH : new Date(since).toISOString();
}

/** Where the walk stands, for the progress line: commits walked and an estimate of the total. Pure. */
export function historyProgress(row: Pick<ScanRow, 'deepExpectedSha' | 'deepNextIdx' | 'deepEstimate' | 'tipStartSha' | 'tipNextIdx' | 'tipEstimate'>, walked: number, deepSatisfied: boolean): { done: number; total: number } {
  const deepLeft = row.deepExpectedSha != null && !deepSatisfied ? Math.max(0, (row.deepEstimate ?? row.deepNextIdx) - row.deepNextIdx) : 0;
  const tipLeft = row.tipStartSha != null ? Math.max(1, (row.tipEstimate ?? row.tipNextIdx + 1) - row.tipNextIdx) : 0;
  return { done: walked, total: walked + deepLeft + tipLeft };
}

/** Every walked commit of a repo that is the commit of one of these shas. */
async function walkedAmong(accountId: number, repoId: number, shas: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < shas.length; i += 400) {
    const rows = await db
      .select({ sha: releaseHistoryCommits.sha })
      .from(releaseHistoryCommits)
      .where(
        and(
          eq(releaseHistoryCommits.accountId, accountId),
          eq(releaseHistoryCommits.repoId, repoId),
          inArray(releaseHistoryCommits.sha, shas.slice(i, i + 400)),
        ),
      )
      .execute();
    for (const r of rows) out.add(r.sha);
  }
  return out;
}

async function walkedCount(accountId: number, repoId: number): Promise<number> {
  const r = await db
    .select({ n: count() })
    .from(releaseHistoryCommits)
    .where(and(eq(releaseHistoryCommits.accountId, accountId), eq(releaseHistoryCommits.repoId, repoId)))
    .execute();
  return Number(r[0]?.n ?? 0);
}

async function dropRepoHistory(accountId: number, repoId: number): Promise<void> {
  await runTransaction(async (tx) => {
    await tx
      .delete(releaseHistoryCommits)
      .where(and(eq(releaseHistoryCommits.accountId, accountId), eq(releaseHistoryCommits.repoId, repoId)))
      .execute();
    await tx
      .delete(releaseHistoryScans)
      .where(and(eq(releaseHistoryScans.accountId, accountId), eq(releaseHistoryScans.repoId, repoId)))
      .execute();
  });
}

async function freshRow(accountId: number, repoId: number, headSha: string, now: Date): Promise<ScanRow> {
  return (
    await db
      .insert(releaseHistoryScans)
      .values({ accountId, repoId, topSha: headSha, maxBase: 0, deepStartSha: headSha, deepExpectedSha: headSha, deepNextIdx: 0, updatedAt: now })
      .onConflictDoUpdate({
        target: [releaseHistoryScans.accountId, releaseHistoryScans.repoId],
        set: {
          topSha: headSha,
          maxBase: 0,
          deepStartSha: headSha,
          deepCursor: null,
          deepExpectedSha: headSha,
          deepNextIdx: 0,
          deepEstimate: null,
          tipStartSha: null,
          tipStopSha: null,
          tipCursor: null,
          tipExpectedSha: null,
          tipNextIdx: 0,
          tipBase: null,
          tipEstimate: null,
          updatedAt: now,
        },
      })
      .returning()
      .execute()
  )[0]!;
}

/** Store one page's commits + light PRs and the segment's new state, in ONE transaction (DB only). */
async function storePage(
  opts: WalkHistoryOptions,
  taken: WalkedCommit[],
  seqOf: (i: number) => number,
  state: Partial<ScanRow>,
  now: Date,
): Promise<void> {
  const { accountId, repoId } = opts;
  await runTransaction(async (tx) => {
    for (let i = 0; i < taken.length; i += 1) {
      const c = taken[i]!;
      const values = { seq: seqOf(i), prNumbers: c.prs.map((p) => p.number), committedAt: c.committedAt };
      await tx
        .insert(releaseHistoryCommits)
        .values({ accountId, repoId, sha: c.sha, ...values })
        .onConflictDoUpdate({
          target: [releaseHistoryCommits.accountId, releaseHistoryCommits.repoId, releaseHistoryCommits.sha],
          set: values,
        })
        .execute();
      for (const p of c.prs) {
        const light = {
          title: p.title,
          headRefName: p.headRefName,
          authorLogin: p.authorLogin,
          isBot: historyAuthorIsBot(p.authorLogin, p.authorIsBotType),
          mergedAt: p.mergedAt,
          mergeSha: p.mergeSha,
          url: p.url,
          seenAt: now,
        };
        await tx
          .insert(releaseRangePrs)
          .values({ accountId, repoId, number: p.number, ...light })
          .onConflictDoUpdate({ target: [releaseRangePrs.accountId, releaseRangePrs.repoId, releaseRangePrs.number], set: light })
          .execute();
      }
    }
    await tx
      .update(releaseHistoryScans)
      .set({ ...state, updatedAt: now })
      .where(and(eq(releaseHistoryScans.accountId, accountId), eq(releaseHistoryScans.repoId, repoId)))
      .execute();
  });
}

/**
 * Walk what is left of the repo's default-branch history within the run. NEVER THROWS. `complete`
 * means no segment has work left for any releasing workspace.
 */
export async function walkReleaseHistory(opts: WalkHistoryOptions): Promise<WalkHistoryResult> {
  const { owner, name, repoId, accountId, token, log } = opts;
  const fullName = `${owner}/${name}`;
  const out: WalkHistoryResult = { pages: 0, compares: 0, walked: 0, complete: false, paused: false, restarted: false };
  if (opts.views.length === 0) return { ...out, complete: true };
  const nowDate = (): Date => new Date(opts.deps?.now?.() ?? Date.now());
  try {
    const tags = await db
      .select({ name: repoTags.name, sha: repoTags.sha, committedAt: repoTags.committedAt })
      .from(repoTags)
      .where(and(eq(repoTags.accountId, accountId), eq(repoTags.repoId, repoId)))
      .execute();
    const perView = releaseShasPerView(tags, opts.views);
    const since = estimateSince(tags, opts.views);

    const loaded = await readHistoryScan(accountId, repoId);

    const restart = async (why: string): Promise<ScanRow> => {
      log?.info(`release history ${fullName}: ${why}; walking it again`);
      out.restarted = true;
      await dropRepoHistory(accountId, repoId);
      return freshRow(accountId, repoId, opts.headSha, nowDate());
    };

    let row: ScanRow = loaded ?? (await freshRow(accountId, repoId, opts.headSha, nowDate()));
    if (loaded != null && row.topSha !== opts.headSha && row.tipStartSha !== opts.headSha) {
      // The head moved: a fast-forward gets a tip segment; rewritten history starts again.
      if (isLimited(accountId) || isBudgetLow(accountId)) return { ...out, paused: true };
      let cmp: RestCompareResponse | null = null;
      try {
        out.compares += 1;
        cmp =
          (await opts.deps?.compare?.(row.topSha, opts.headSha)) ??
          (await fetchComparePage(token, { owner, name, base: row.topSha, head: opts.headSha, perPage: 1, page: 1 }));
      } catch (err) {
        const rl = isRateLimitError(err);
        if (rl.limited) {
          noteLimited(accountId, rl.resumeAt);
          return { ...out, paused: true };
        }
        const status = (err as { status?: number }).status;
        // 404: the walked head is gone (a force push GitHub has collected) — rewritten.
        if (status !== 404) {
          log?.warn(`release history ${fullName}: could not compare the new head (non-fatal): ${errMsg(err)}`);
          return out;
        }
      }
      if (cmp != null && cmp.status === 'ahead') {
        const tipBase = row.maxBase + SEQ_SPAN;
        await runTransaction(async (tx) => {
          // A tip still walking for an older head is replaced; its commits are walked again.
          if (row.tipBase != null) {
            await tx
              .delete(releaseHistoryCommits)
              .where(
                and(
                  eq(releaseHistoryCommits.accountId, accountId),
                  eq(releaseHistoryCommits.repoId, repoId),
                  gt(releaseHistoryCommits.seq, row.tipBase - SEQ_SPAN),
                  lte(releaseHistoryCommits.seq, row.tipBase),
                ),
              )
              .execute();
          }
          await tx
            .update(releaseHistoryScans)
            .set({
              tipStartSha: opts.headSha,
              tipStopSha: row.topSha,
              tipCursor: null,
              tipExpectedSha: opts.headSha,
              tipNextIdx: 0,
              tipBase,
              tipEstimate: typeof cmp!.ahead_by === 'number' ? cmp!.ahead_by : null,
              updatedAt: nowDate(),
            })
            .where(and(eq(releaseHistoryScans.accountId, accountId), eq(releaseHistoryScans.repoId, repoId)))
            .execute();
        });
        row = (await readHistoryScan(accountId, repoId)) ?? row;
      } else if (cmp == null || cmp.status !== 'identical') {
        row = await restart('the default branch history was rewritten');
      }
    }

    // Which workspaces' baselines the walk has met (the deep segment may pause once all are).
    const found = await walkedAmong(accountId, repoId, [...new Set(perView.flatMap((s) => [...s]))]);
    const seen = perView.map((s) => [...s].some((sha) => found.has(sha)));
    const deepSatisfied = (): boolean => seen.every(Boolean);
    let walkedTotal = await walkedCount(accountId, repoId);
    const tell = (paused: boolean): void => {
      const p = historyProgress(row, walkedTotal, deepSatisfied());
      opts.onProgress?.({ ...p, paused });
    };

    const readPage = async (oid: string, after: string | null): Promise<ReleaseHistoryResponse> =>
      (await opts.deps?.history?.(oid, after, since)) ??
      (await withGithubRetry(() =>
        graphqlTolerant<ReleaseHistoryResponse>(
          getGraphqlClientFor(token),
          RELEASE_HISTORY_QUERY,
          { owner, name, oid, first: HISTORY_PAGE, after, since },
          () => log?.warn(`release history ${fullName}: partial GraphQL (continuing)`),
        ),
      ));

    const stopNow = (): boolean => {
      if (isLimited(accountId) || isBudgetLow(accountId)) {
        out.paused = true;
        return true;
      }
      return opts.deadline != null && Date.now() >= opts.deadline;
    };

    tell(false);
    for (;;) {
      const tip = row.tipStartSha != null;
      if (!tip && (row.deepExpectedSha == null || deepSatisfied())) break;
      if (stopNow()) break;
      const oid = tip ? row.tipStartSha! : row.deepStartSha;
      const cursor = tip ? row.tipCursor : row.deepCursor;
      let resp: ReleaseHistoryResponse;
      try {
        resp = await readPage(oid, cursor);
      } catch (err) {
        const rl = isRateLimitError(err);
        if (rl.limited) {
          noteLimited(accountId, rl.resumeAt);
          out.paused = true;
        } else log?.warn(`release history ${fullName}: a history page failed (non-fatal): ${errMsg(err)}`);
        break;
      }
      out.pages += 1;
      const rate = resp.rateLimit;
      if (rate) {
        const resetAt = rate.resetAt ? new Date(rate.resetAt) : null;
        noteBudget(accountId, { remaining: rate.remaining ?? null, resetAt: resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null });
      }
      const history = resp.repository?.object?.history;
      if (history == null || !Array.isArray(history.nodes)) {
        log?.warn(`release history ${fullName}: the history page did not arrive (retried next run)`);
        break;
      }
      const hasNext = history.pageInfo?.hasNextPage === true && typeof history.pageInfo.endCursor === 'string';
      const now = nowDate();
      if (tip) {
        const r = walkHistoryPage(history.nodes, {
          expected: row.tipExpectedSha,
          stopSha: row.tipStopSha,
          fullName,
          defaultBranch: opts.defaultBranch,
        });
        const base: number = row.tipBase!;
        const idx0: number = row.tipNextIdx;
        if (r.reachedStop) {
          await storePage(opts, r.taken, (i) => base - (idx0 + i), {
            topSha: row.tipStartSha!,
            maxBase: base,
            tipStartSha: null,
            tipStopSha: null,
            tipCursor: null,
            tipExpectedSha: null,
            tipNextIdx: 0,
            tipBase: null,
            tipEstimate: null,
          }, now);
          row = { ...row, topSha: row.tipStartSha!, maxBase: base, tipStartSha: null, tipStopSha: null, tipCursor: null, tipExpectedSha: null, tipNextIdx: 0, tipBase: null, tipEstimate: null };
        } else if (r.expected == null || !hasNext) {
          // The new head's chain never met the walked one: not a fast-forward along the first parent.
          row = await restart('the new head does not continue the walked history');
          walkedTotal = 0;
          continue;
        } else {
          const state: Partial<ScanRow> = { tipCursor: history.pageInfo!.endCursor!, tipExpectedSha: r.expected, tipNextIdx: idx0 + r.taken.length };
          await storePage(opts, r.taken, (i) => base - (idx0 + i), state, now);
          row = { ...row, ...state };
        }
        out.walked += r.taken.length;
        walkedTotal += r.taken.length;
      } else {
        const r = walkHistoryPage(history.nodes, {
          expected: row.deepExpectedSha,
          fullName,
          defaultBranch: opts.defaultBranch,
          pauseAfter: (sha) => {
            perView.forEach((s, i) => {
              if (s.has(sha)) seen[i] = true;
            });
            return deepSatisfied();
          },
        });
        const idx0: number = row.deepNextIdx;
        const estimate: number | null = history.totalCount != null ? (resp.repository?.object?.sinceCount?.totalCount ?? history.totalCount) : row.deepEstimate;
        // Paused at the baseline: the page is read again from the same cursor when the walk goes on.
        const expected = r.expected == null || (!hasNext && !r.paused) ? null : r.expected;
        const state: Partial<ScanRow> = {
          deepCursor: r.paused || !hasNext ? row.deepCursor : history.pageInfo!.endCursor!,
          deepExpectedSha: expected,
          deepNextIdx: idx0 + r.taken.length,
          deepEstimate: estimate ?? null,
        };
        await storePage(opts, r.taken, (i) => -(idx0 + i), state, now);
        row = { ...row, ...state };
        out.walked += r.taken.length;
        walkedTotal += r.taken.length;
      }
      tell(false);
    }
    if (out.paused) tell(true);
    out.complete = row.tipStartSha == null && (row.deepExpectedSha == null || deepSatisfied());
    if (out.walked > 0) log?.info(`release history ${fullName}: ${out.walked} commit(s) walked in ${out.pages} page(s)${out.complete ? ', done' : ''}`);
  } catch (err) {
    log?.warn(`release history ${fullName}: failed (non-fatal): ${errMsg(err)}`);
  }
  return out;
}

/** The DB half's view of one repo's walk (db/release-check.ts). DB only. */
export async function readHistoryScan(accountId: number, repoId: number): Promise<ScanRow | null> {
  return (
    (
      await db
        .select()
        .from(releaseHistoryScans)
        .where(and(eq(releaseHistoryScans.accountId, accountId), eq(releaseHistoryScans.repoId, repoId)))
        .execute()
    )[0] ?? null
  );
}

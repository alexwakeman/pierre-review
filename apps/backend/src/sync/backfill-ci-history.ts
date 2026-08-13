// One-time CI-HISTORY backfill for a freshly synced repo — the piece that keeps the Activity
// tab's CI charts from starting blank.
//
// `ci_status_events` is a transition log written only when a sync WITNESSES a PR head's CI
// change (sync/upsert.ts), so a newly added repo has no history for the "CI recovery" and
// "CI failures by stage" charts to read: the initial walk writes at most ONE row per PR (its
// final state, observed "now"). GitHub, however, RETAINS per-commit check state indefinitely —
// `statusCheckRollup` is queryable on any commit object — and the walk already stored every
// PR's commit shas + committer dates (`commits`, last:100 per PR). This module joins the two:
// fetch the retained rollup per stored commit, then synthesize the transition rows the sync
// would have written had it been watching, with `observedAt` = the commit's committer date.
//
// HONEST LIMITS, disclosed rather than papered over:
//   • A red→green that happened on the SAME sha (a re-run fixing a flake) is invisible — only
//     the final rollup survives — so synthesized history slightly UNDER-counts recoveries and
//     over-lengthens streaks that ended by re-run. Push-a-fix recoveries (the dominant mode)
//     are captured.
//   • `observedAt` = committer date, where the live log stamps its own observation time. Both
//     lag the actual CI event; neither lies about ordering within a PR.
//   • Failing-check NAMES (the by-stage chart) cost ~1 point per red commit, so they are
//     fetched newest-first under MAX_DETAIL_SHAS; a red commit past the cap still opens a
//     streak (recovery math intact) but contributes no names.
//
// SAFETY: a PR is touched ONLY when its existing log is provably the initial walk's snapshot —
// zero rows, or exactly one row whose headSha is the PR's newest stored commit (that row is
// informationally a subset of the synthesized series, so it is replaced to keep the log
// single-voiced). Any PR with real observed history is left alone, which is what makes the
// whole pass safe to re-run on a deep re-sync of a long-tracked repo.
import { and, asc, eq } from 'drizzle-orm';
import { db, schema, runTransaction } from '../db/client.js';
import {
  getGraphqlClientFor,
  graphqlTolerant,
  withGithubRetry,
  type GraphqlClient,
} from '../github/client.js';
import {
  buildCommitStatesQuery,
  COMMIT_CHECKS_ALIAS_CAP,
  COMMIT_STATES_ALIAS_CAP,
  type CommitStatesResponse,
} from '../github/branch-queries.js';
import { ciStatusFrom } from './upsert.js';
import {
  backfillBranchHistory,
  fetchFailingChecks,
  type BranchSyncLogger,
} from './branch-status.js';
import type { CiStatus } from '@pierre-review/shared';

const { pullRequests, commits, ciStatusEvents } = schema;

// Total rollup lookups one repo's backfill may spend, across all its PRs. At the 100-alias
// page (~1 point each) this is ~20 points; PRs are taken newest-first, so what a tight budget
// drops is the oldest history — the part the 84-day chart windows are least likely to read.
export const MAX_BACKFILL_SHAS = 2000;

// How many red commits get the SECOND, per-commit-point contexts fetch for failing-check
// names. Names feed only the by-stage breakdown; recovery math never needs them.
export const MAX_DETAIL_SHAS = 200;

// The statuses a synthesized row may carry. 'pending'/'expected' rollups on OLD commits are
// stale amber (CI that never finished), not history worth writing — and the chart walk ignores
// them anyway; 'unknown' is the live writer's own exclusion.
type SynthStatus = 'success' | 'failure' | 'error';

export interface SynthesizedCiEvent {
  headSha: string;
  status: SynthStatus;
  failingChecks: string[];
  observedAt: Date;
}

export interface CandidatePr {
  prId: number;
  // Ascending (committedAt, id) — the order the synthesized log replays in.
  commits: { sha: string; committedAt: Date }[];
  // The initial walk's first-observation row to replace, when one exists.
  soleEventId: number | null;
}

export interface CiHistoryBackfillOptions {
  owner: string;
  name: string;
  repoId: number;
  accountId: number;
  token: string;
  log?: BranchSyncLogger;
  shouldCancel?: () => boolean;
}

export interface PrCiBackfillResult {
  prCount: number;
  eventCount: number;
  rateLimitCost: number;
  // PRs dropped by the sha budget — logged, never silent.
  truncatedPrs: number;
  cancelled: boolean;
}

/**
 * The eligibility rule, pure: a PR may be synthesized only when its stored events are provably
 * the initial walk's snapshot (see the module header). `events` is every existing row for the
 * PR; `newestSha` is the newest STORED commit's sha.
 */
export function isSynthesizable(
  events: { headSha: string }[],
  newestSha: string | undefined,
): boolean {
  if (newestSha == null) return false;
  if (events.length === 0) return true;
  return events.length === 1 && events[0]!.headSha === newestSha;
}

/**
 * Replay one PR's commits into the rows the live writer would have recorded, pure. Commits
 * arrive ascending; a sha absent from `statusBySha` (CI never ran, or the rollup wasn't
 * received) contributes nothing. A PR whose replay contains no red at all returns [] — an
 * all-green log feeds neither chart, and skipping it keeps the table lean.
 */
export function synthesizeCiEvents(
  commitRows: { sha: string; committedAt: Date }[],
  statusBySha: Map<string, CiStatus>,
  failingNamesBySha: Map<string, string[]>,
): SynthesizedCiEvent[] {
  const rows: SynthesizedCiEvent[] = [];
  for (const c of commitRows) {
    const status = statusBySha.get(c.sha);
    if (status !== 'success' && status !== 'failure' && status !== 'error') continue;
    rows.push({
      headSha: c.sha,
      status,
      failingChecks: status === 'success' ? [] : failingNamesBySha.get(c.sha) ?? [],
      observedAt: c.committedAt,
    });
  }
  return rows.some((r) => r.status !== 'success') ? rows : [];
}

/**
 * The repo's synthesizable PRs, newest-activity-first (the order the sha budget consumes them
 * in). DB-only; exported for the throwaway-DB test.
 */
export async function collectCandidatePrs(
  accountId: number,
  repoId: number,
): Promise<CandidatePr[]> {
  const eventRows = await db
    .select({ id: ciStatusEvents.id, prId: ciStatusEvents.prId, headSha: ciStatusEvents.headSha })
    .from(ciStatusEvents)
    .where(and(eq(ciStatusEvents.accountId, accountId), eq(ciStatusEvents.repoId, repoId)))
    .orderBy(asc(ciStatusEvents.observedAt))
    .execute();
  const eventsByPr = new Map<number, { id: number; headSha: string }[]>();
  for (const e of eventRows) {
    const list = eventsByPr.get(e.prId) ?? [];
    list.push({ id: e.id, headSha: e.headSha });
    eventsByPr.set(e.prId, list);
  }

  // Join through pullRequests rather than an id list — `commits` carries no accountId/repoId
  // of its own, and a joined predicate can't outgrow a dialect's bind-parameter limit.
  const commitRows = await db
    .select({
      prId: commits.prId,
      sha: commits.sha,
      committedAt: commits.committedAt,
      commitId: commits.id,
    })
    .from(commits)
    .innerJoin(pullRequests, eq(commits.prId, pullRequests.id))
    .where(and(eq(pullRequests.accountId, accountId), eq(pullRequests.repoId, repoId)))
    .execute();
  const commitsByPr = new Map<number, { sha: string; committedAt: Date; commitId: number }[]>();
  for (const c of commitRows) {
    const list = commitsByPr.get(c.prId) ?? [];
    list.push({ sha: c.sha, committedAt: c.committedAt, commitId: c.commitId });
    commitsByPr.set(c.prId, list);
  }

  const candidates: CandidatePr[] = [];
  for (const [prId, list] of commitsByPr) {
    list.sort(
      (a, b) => a.committedAt.getTime() - b.committedAt.getTime() || a.commitId - b.commitId,
    );
    const events = eventsByPr.get(prId) ?? [];
    const newest = list[list.length - 1];
    if (!isSynthesizable(events, newest?.sha)) continue;
    candidates.push({
      prId,
      commits: list.map((c) => ({ sha: c.sha, committedAt: c.committedAt })),
      soleEventId: events.length === 1 ? events[0]!.id : null,
    });
  }
  candidates.sort(
    (a, b) =>
      b.commits[b.commits.length - 1]!.committedAt.getTime() -
      a.commits[a.commits.length - 1]!.committedAt.getTime(),
  );
  return candidates;
}

/**
 * Rollup states for the given shas, one aliased call. Mirrors `fetchFailingChecks`' contract:
 * an entry exists ONLY for a sha whose rollup actually arrived non-null — absence means
 * "unknowable", never "green".
 */
export async function fetchCommitStates(
  client: GraphqlClient,
  owner: string,
  name: string,
  shas: string[],
  log?: BranchSyncLogger,
): Promise<{ bySha: Map<string, CiStatus>; cost: number }> {
  const variables: Record<string, unknown> = { owner, name };
  shas.forEach((sha, i) => {
    variables[`s${i}`] = sha;
  });
  const resp = await withGithubRetry(() =>
    graphqlTolerant<CommitStatesResponse>(
      client,
      buildCommitStatesQuery(shas.length),
      variables,
      (errors) =>
        log?.warn(
          `ci-backfill ${owner}/${name}: partial GraphQL on commit states — ` +
            `synthesizing nothing for the affected commits`,
          errors,
        ),
    ),
  );
  const bySha = new Map<string, CiStatus>();
  shas.forEach((sha, i) => {
    const state = resp.repository?.[`c${i}`]?.statusCheckRollup?.state;
    if (state == null) return;
    bySha.set(sha, ciStatusFrom(state));
  });
  return { bySha, cost: resp.rateLimit?.cost ?? 0 };
}

/**
 * Write one repo's synthesized logs in ONE transaction: per PR, delete the first-observation
 * row being replaced (by id — a row appended by a racing targeted sync after collection is
 * deliberately left alone), then insert the series. Exported for the throwaway-DB test.
 */
export async function writeSynthesizedEvents(
  scope: { accountId: number; repoId: number },
  perPr: { prId: number; soleEventId: number | null; rows: SynthesizedCiEvent[] }[],
): Promise<number> {
  let written = 0;
  await runTransaction(async (tx) => {
    for (const pr of perPr) {
      if (pr.rows.length === 0) continue;
      if (pr.soleEventId != null) {
        await tx
          .delete(ciStatusEvents)
          .where(
            and(
              eq(ciStatusEvents.id, pr.soleEventId),
              eq(ciStatusEvents.accountId, scope.accountId),
            ),
          )
          .execute();
      }
      await tx
        .insert(ciStatusEvents)
        .values(
          pr.rows.map((r) => ({
            accountId: scope.accountId,
            repoId: scope.repoId,
            prId: pr.prId,
            headSha: r.headSha,
            status: r.status,
            failingChecks: r.failingChecks,
            observedAt: r.observedAt,
          })),
        )
        .execute();
      written += pr.rows.length;
    }
  });
  return written;
}

/**
 * The PR half of the backfill: collect → fetch retained rollups (batched) → fetch failing
 * names for the newest red commits (capped) → synthesize → write. Cancellation between
 * batches abandons the whole pass without writing — a partial log would be indistinguishable
 * from a complete one.
 */
export async function backfillPrCiHistory(
  opts: CiHistoryBackfillOptions,
): Promise<PrCiBackfillResult> {
  const { owner, name, repoId, accountId } = opts;
  const none: PrCiBackfillResult = {
    prCount: 0,
    eventCount: 0,
    rateLimitCost: 0,
    truncatedPrs: 0,
    cancelled: false,
  };
  const candidates = await collectCandidatePrs(accountId, repoId);
  if (candidates.length === 0) return none;

  // Consume the sha budget newest-first. `continue` rather than break: a later, smaller PR may
  // still fit the remainder.
  const included: CandidatePr[] = [];
  let truncatedPrs = 0;
  let budget = 0;
  for (const c of candidates) {
    if (budget + c.commits.length > MAX_BACKFILL_SHAS) {
      truncatedPrs += 1;
      continue;
    }
    budget += c.commits.length;
    included.push(c);
  }

  // One fetch per unique sha — stacked PRs can share commits.
  const newestAtBySha = new Map<string, number>();
  for (const c of included) {
    for (const commit of c.commits) {
      const at = commit.committedAt.getTime();
      const prev = newestAtBySha.get(commit.sha);
      if (prev == null || at > prev) newestAtBySha.set(commit.sha, at);
    }
  }
  const uniqueShas = [...newestAtBySha.keys()];

  const client = getGraphqlClientFor(opts.token);
  const statusBySha = new Map<string, CiStatus>();
  let cost = 0;
  for (let i = 0; i < uniqueShas.length; i += COMMIT_STATES_ALIAS_CAP) {
    if (opts.shouldCancel?.()) return { ...none, rateLimitCost: cost, cancelled: true };
    const chunk = uniqueShas.slice(i, i + COMMIT_STATES_ALIAS_CAP);
    const r = await fetchCommitStates(client, owner, name, chunk, opts.log);
    for (const [sha, status] of r.bySha) statusBySha.set(sha, status);
    cost += r.cost;
  }

  // Failing-check names for the newest red commits, under the detail cap.
  const redShas = [...statusBySha.entries()]
    .filter(([, s]) => s === 'failure' || s === 'error')
    .map(([sha]) => sha)
    .sort((a, b) => (newestAtBySha.get(b) ?? 0) - (newestAtBySha.get(a) ?? 0))
    .slice(0, MAX_DETAIL_SHAS);
  const failingNamesBySha = new Map<string, string[]>();
  for (let i = 0; i < redShas.length; i += COMMIT_CHECKS_ALIAS_CAP) {
    if (opts.shouldCancel?.()) return { ...none, rateLimitCost: cost, cancelled: true };
    const chunk = redShas.slice(i, i + COMMIT_CHECKS_ALIAS_CAP);
    const r = await fetchFailingChecks(client, owner, name, chunk, opts.log);
    for (const [sha, checks] of r.bySha) {
      // `fetchFailingChecks` already filtered to red and deduped by name; the live writer
      // stores sorted names, so the synthesized rows do too.
      failingNamesBySha.set(sha, checks.map((c) => c.name).sort());
    }
    cost += r.cost;
  }

  const perPr = included
    .map((c) => ({
      prId: c.prId,
      soleEventId: c.soleEventId,
      rows: synthesizeCiEvents(c.commits, statusBySha, failingNamesBySha),
    }))
    .filter((p) => p.rows.length > 0);
  const eventCount = await writeSynthesizedEvents({ accountId, repoId }, perPr);

  return {
    prCount: perPr.length,
    eventCount,
    rateLimitCost: cost,
    truncatedPrs,
    cancelled: false,
  };
}

/**
 * The whole post-full-sync CI-history pass: trunk first (the strip is the visible surface),
 * then the PR log. Each half is STRICTLY NON-FATAL and separately logged — an informational
 * backfill must never turn the successful sync that preceded it into an error, so nothing
 * here throws.
 */
export async function runCiHistoryBackfill(opts: CiHistoryBackfillOptions): Promise<void> {
  const fullName = `${opts.owner}/${opts.name}`;
  try {
    const r = await backfillBranchHistory(opts);
    opts.log?.info(
      `ci-backfill ${fullName}: trunk history ${r.commitCount} commit(s) over ${r.pages} ` +
        `page(s), ${r.rateLimitCost} rate-limit point(s)${r.truncated ? ' — TRUNCATED at the page cap' : ''}`,
    );
  } catch (err) {
    opts.log?.warn(
      `ci-backfill ${fullName}: trunk history failed (non-fatal): ` +
        `${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    );
  }
  try {
    const r = await backfillPrCiHistory(opts);
    if (r.cancelled) {
      opts.log?.info(`ci-backfill ${fullName}: PR CI history cancelled before writing`);
      return;
    }
    opts.log?.info(
      `ci-backfill ${fullName}: synthesized ${r.eventCount} CI event(s) across ${r.prCount} ` +
        `PR(s), ${r.rateLimitCost} rate-limit point(s)` +
        (r.truncatedPrs > 0 ? ` — ${r.truncatedPrs} PR(s) dropped by the sha budget` : ''),
    );
  } catch (err) {
    opts.log?.warn(
      `ci-backfill ${fullName}: PR CI history failed (non-fatal): ` +
        `${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    );
  }
}

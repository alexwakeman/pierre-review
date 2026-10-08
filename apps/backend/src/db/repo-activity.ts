// WHERE IS THE WORK HAPPENING — per-repository activity over the workspace's REPORTING WINDOW.
//
// The flow-metric tiles beside this on Reports → Overview answer "how much" and "how fast" for the
// whole workspace. They cannot answer "which repository", because a workspace-wide figure is one
// number over a population whose members routinely differ by two orders of magnitude: on the dev
// corpus one fortnight held 147 PRs / 1.4k lines in a config repo and 71 PRs / 141.7k lines in an
// application repo. Both are "activity"; they are not the same activity.
//
// ── THE WINDOW IS THE TILES' WINDOW, HANDED IN ───────────────────────────────────────────────
//
// Reports' rule: every figure is tied to the workspace's reporting window (this sprint so far when
// the workspace has a sprint cadence, else the trailing 7/14 days). This fold does NOT resolve it:
// the route resolves it ONCE (`getReportingWindow`, db/reporting-window.ts — the plugin's
// `resolveComparisonWindow` when bound) and hands the same object to the tiles and to this, so the
// card and the tiles above it measure one window by construction. A running sprint is measured up
// to now (`measuredTo`), never into the future.
//
// ── WHY THIS IS A SEPARATE MODULE AND NOT A FIELD ON getWorkspaceMetrics ─────────────────────
//
// `getWorkspaceMetrics` is a 400-line fold whose PR SELECT carries none of the five columns this
// needs (repoId, authorId, additions, deletions, changedFiles).
//
// It also cannot live in `queries.ts`: it needs `resolveActorLanes`, and `actor-lanes.ts` imports
// FROM `queries.ts`. Every other lane-consuming fold (`period-metrics.ts`, `pr-intervals.ts`,
// `automation-output.ts`, `person-period.ts`) is a module beside them for exactly that reason.
//
// COST: two indexed scans (one PR window, one repo list) plus `resolveActorLanes`' fixed handful.
// Nothing multiplies by repo count, which is what keeps `/api/workspace-metrics` honest on the
// `read` fall-through — the tier comment in api/plugins/rate-limit.ts turns on that word.
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { WorkspaceRepoActivity, WorkspaceRepoActivityRow } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { resolveActorLanes } from './actor-lanes.js';
import type { BotScope } from './queries.js';
import { measuredTo, type ReportingWindow } from './reporting-window.js';

const { pullRequests, repos } = schema;

/** Top-N by PRs opened. Beyond about a dozen bands the bars are unreadable even rotated (the dev
 *  workspace has 19 active repositories in a typical fortnight). NEVER a silent truncation — the
 *  response carries `activeRepos` and an `omitted` aggregate so the cards can state both what was
 *  cut and what it was worth. */
export const REPO_ACTIVITY_MAX_REPOS = 12;

/**
 * Per-repository PR and line counts over `window` (the workspace's reporting window).
 *
 * ⚠ `scope.repoIds` IS REQUIRED AND CONCRETE, and `[]` returns null — the same contract
 * `getWorkspaceMetricsForScope` states at length. A nullable "means every repo" parameter would
 * widen an empty workspace to the whole account, which is the opposite of what a scope is.
 * `scope.workspaceId` is not decoration either: it is the JUDGEMENT grain, the thing that decides
 * who counts as automation, and it is why this takes a `BotScope` rather than a bare id list.
 */
export async function getWorkspaceRepoActivity(
  accountId: number,
  scope: BotScope,
  nowMs: number,
  window: ReportingWindow,
): Promise<WorkspaceRepoActivity | null> {
  if (scope.repoIds.length === 0) return null;

  // Ownership narrowing, mirroring getWorkspaceMetricsForScope: `resolveWorkspaceScope` already
  // guarantees `repoIds ⊆ this workspace's membership`, and this second predicate makes the tenancy
  // structural in the query rather than inherited from a caller's memory.
  const ownedRepos = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name, createdAt: repos.createdAt })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, scope.repoIds)))
    .execute();
  if (ownedRepos.length === 0) return null;
  const ownedIds = ownedRepos.map((r) => r.id);

  const fromMs = window.fromMs;
  const toMs = Math.max(fromMs, measuredTo(window, nowMs));

  // ⚠ TWO-SIDED AND HALF-OPEN, `[fromMs, toMs)`. `gte`/`lt`, never `lte` on the upper bound: a PR
  // opened at exactly `toMs` belongs to the next read of this window, not to both.
  const prs = await db
    .select({
      repoId: pullRequests.repoId,
      authorId: pullRequests.authorId,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      changedFiles: pullRequests.changedFiles,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, ownedIds),
        gte(pullRequests.openedAt, new Date(fromMs)),
        lt(pullRequests.openedAt, new Date(toMs)),
      ),
    )
    .execute();

  // THE AUTOMATION SET. `automatedIds`, never `automatedReviewerUserIds` alone. Real accounts carry
  // the same actor as two rows with conflicting flags (`dependabot` and `dependabot[bot]`), and on
  // the measured account one of each pair sat at `automated: 0`. Trusting one signal splits one bot
  // across both series and under-counts each.
  //
  // ⚠ ITS CANDIDATE SET IS (workspace verdict ∪ globally `users.isBot`), and the login vocabularies
  // refine a lane INSIDE that set rather than widening it — a vocabulary hit counts on its own for
  // a candidate, but admits nobody. So an actor with a vendor login, `isBot: false` and no
  // `workspace_reviewers` row lands in the HUMAN series. That is deliberate: it is the answer every
  // other lane consumer gives, and re-deriving "is this a bot" here to be cleverer would put a
  // second classifier on screen that can disagree with the Timeline's own bot-hiding.
  const lanes = await resolveActorLanes(accountId, scope);

  type Acc = {
    human: number;
    automation: number;
    lines: number;
    sized: number;
    unsized: number;
  };
  const byRepo = new Map<number, Acc>();
  for (const p of prs) {
    let acc = byRepo.get(p.repoId);
    if (!acc) {
      acc = { human: 0, automation: 0, lines: 0, sized: 0, unsized: 0 };
      byRepo.set(p.repoId, acc);
    }
    // A null author is neither evidence of a bot nor of a person; it counts as human for the same
    // reason `resolveActorLanes` rule 2 does — the absence of an automation signal is not one.
    if (p.authorId != null && lanes.automatedIds.has(p.authorId)) acc.automation += 1;
    else acc.human += 1;

    // ⚠ THE SANCTIONED UNSIZED GUARD, copied verbatim from period-metrics.ts. The three size
    // columns are NOT NULL DEFAULT 0, so a PR whose detail never hydrated is byte-identical to one
    // that changed nothing. Summing the fabricated zero is invisible; summing 80% of a repository's
    // PRs and calling it that repository's line count is a wrong number with no way to notice.
    const observed = p.changedFiles > 0 || p.additions > 0 || p.deletions > 0;
    if (observed) {
      acc.sized += 1;
      acc.lines += p.additions + p.deletions;
    } else {
      acc.unsized += 1;
    }
  }

  const rows: WorkspaceRepoActivityRow[] = [];
  for (const r of ownedRepos) {
    const acc = byRepo.get(r.id);
    if (!acc) continue; // a repository with nothing opened in the window draws no band at all
    rows.push({
      repoId: r.id,
      repoFullName: `${r.owner}/${r.name}`,
      prsOpenedHuman: acc.human,
      prsOpenedAutomation: acc.automation,
      linesChanged: acc.sized > 0 ? acc.lines : null,
      sizedPrs: acc.sized,
      unsizedPrs: acc.unsized,
      // ⚠ `repos.createdAt` is when the repo was added to THIS ACCOUNT, not when it was created on
      // GitHub — which is exactly the axis wanted: it bounds how much of the window we could
      // possibly have observed. A real `>=` against the window start; sqlite stores these as epoch
      // SECONDS, so no `+1ms` fudging.
      addedDuringWindow: r.createdAt.getTime() >= fromMs,
    });
  }

  // Rank by TOTAL PRs opened — the primary metric, and the one both charts are ordered by so a
  // reader can scan the same repository across the pair without re-finding it. Ties break on the
  // repo name so the order is stable between requests rather than heap order.
  rows.sort(
    (a, b) =>
      b.prsOpenedHuman +
        b.prsOpenedAutomation -
        (a.prsOpenedHuman + a.prsOpenedAutomation) ||
      a.repoFullName.localeCompare(b.repoFullName),
  );

  const shown = rows.slice(0, REPO_ACTIVITY_MAX_REPOS);
  const cut = rows.slice(REPO_ACTIVITY_MAX_REPOS);
  // What the cap cut, so the cards can state it. The lines chart is ranked by the PR count, so the
  // repository that leads on lines CAN be below the fold — `omitted.linesChanged` is the only thing
  // that lets the reader see that happened. Null when nothing cut was ever sized, for the same
  // reason a row's own figure is: unknown is not zero.
  const cutSized = cut.reduce((n, r) => n + r.sizedPrs, 0);
  return {
    windowDays: Math.max(1, Math.ceil((toMs - fromMs) / 86_400_000)),
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    repos: shown,
    activeRepos: rows.length,
    workspaceRepos: ownedRepos.length,
    omitted: {
      repos: cut.length,
      prsOpened: cut.reduce((n, r) => n + r.prsOpenedHuman + r.prsOpenedAutomation, 0),
      linesChanged: cutSized > 0 ? cut.reduce((n, r) => n + (r.linesChanged ?? 0), 0) : null,
    },
  };
}

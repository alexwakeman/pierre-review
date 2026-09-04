// Pending-board liveness — the DATABASE half (target resolution + the narrow write-back).
//
// The GitHub half is github/pr-liveness.ts; the route that composes the two is
// `POST /api/attention/liveness` in api/routes/insights.ts. This module owns two things:
//
//   1. RESOLVING a client-supplied list of local PR ids to GitHub node ids, under the account
//      AND the resolved workspace's membership. That resolve IS the isolation guarantee for a
//      route whose ids arrive in a request body: an id belonging to another tenant, to another
//      workspace, or to nothing at all simply does not come back, so it can never reach GitHub
//      and can never be written to. (scripts/verify-isolation.ts exercises it directly.)
//   2. APPLYING what GitHub said, one narrow UPDATE per genuinely-moved row.
//
// It lives beside queries.ts rather than in it, on the db/repo-activity.ts precedent set earlier
// in this batch: queries.ts is already 9k lines and carries literal NUL bytes that make `rg`/
// `grep` under-report against it, so new folds go in a file a search can actually find.
import { and, eq, inArray } from 'drizzle-orm';
import type { MergeStateStatus } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { READY_MERGE_STATES } from './triage.js';
import type { PrLivenessObservation } from '../github/pr-liveness.js';

const { pullRequests } = schema;

/** One board PR, as the local DB currently has it. */
export interface PrLivenessTarget {
  prId: number;
  repoId: number;
  githubNodeId: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  mergeable: 'mergeable' | 'conflicting' | 'unknown' | null;
  mergeStateStatus: MergeStateStatus | null;
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  updatedAt: Date;
}

/**
 * Resolve the caller's PR ids to liveness targets, scoped to the account AND the workspace's
 * repo membership.
 *
 * ⚠ BOTH PREDICATES, AND NEITHER IS REDUNDANT. `accountId` is the tenancy boundary; `repoIds` is
 * the scope the route echoes back, and without it a caller could name their OWN PRs from another
 * workspace and have this route refresh (and bill GitHub quota for) rows outside the board they
 * claimed to be looking at. `repoIds` comes from `resolveWorkspaceScope`, so `[]` — an empty
 * workspace — correctly resolves nothing rather than widening to the account.
 */
export async function getPrLivenessTargets(
  accountId: number,
  repoIds: number[],
  prIds: number[],
): Promise<PrLivenessTarget[]> {
  if (prIds.length === 0 || repoIds.length === 0) return [];
  const rows = await db
    .select({
      prId: pullRequests.id,
      repoId: pullRequests.repoId,
      githubNodeId: pullRequests.githubNodeId,
      state: pullRequests.state,
      isDraft: pullRequests.isDraft,
      mergeable: pullRequests.mergeable,
      mergeStateStatus: pullRequests.mergeStateStatus,
      reviewDecision: pullRequests.reviewDecision,
      updatedAt: pullRequests.updatedAt,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        inArray(pullRequests.id, prIds),
      ),
    )
    .execute();
  return rows.map((r) => ({
    prId: r.prId,
    repoId: r.repoId,
    githubNodeId: r.githubNodeId,
    state: r.state,
    isDraft: r.isDraft,
    mergeable: r.mergeable ?? null,
    mergeStateStatus: (r.mergeStateStatus as MergeStateStatus | null) ?? null,
    reviewDecision: r.reviewDecision ?? null,
    updatedAt: r.updatedAt,
  }));
}

/**
 * WHICH TARGETS EARN THE EXPENSIVE SECOND PASS, in priority order.
 *
 * The mergeability selection costs ~5s for 25 PRs and 502s the gateway at 50 (see the measured
 * table in PR_LIVENESS_NODES_QUERY), so only a bounded subset can ever have it. The ordering is
 * the whole design decision:
 *
 *   1. PRs whose STORED merge state already puts them on the board as a FORWARD card
 *      (READY_MERGE_STATES ∪ {'behind'}). These are the rows offering a Merge / Update-branch
 *      button, and a stale `mergeStateStatus` there is a button that 405s — the most expensive
 *      kind of wrong this board can be. The board caps forward cards at 15 per kind, so this
 *      group is at most 30 PRs and usually far fewer.
 *   2. Everything else still open, most-recently-updated first — the rotation that lets a
 *      `blocked → clean` flip (somebody else's approval satisfying branch protection) be noticed
 *      at all. It is best-effort by construction: on a board with more than ~25 PRs the tail of
 *      this list simply waits for the next adaptive walk, which is exactly what it did before.
 *
 * Already-merged/closed targets are excluded outright: their card is leaving on this very refetch
 * and GitHub will not be recomputing mergeability for them.
 */
export function rankForMergeStatePass(
  targets: PrLivenessTarget[],
  cap: number,
): PrLivenessTarget[] {
  const forward = (t: PrLivenessTarget): boolean =>
    t.mergeStateStatus != null &&
    (t.mergeStateStatus === 'behind' || READY_MERGE_STATES.has(t.mergeStateStatus));
  return targets
    .filter((t) => t.state === 'open')
    .sort(
      (a, b) =>
        Number(forward(b)) - Number(forward(a)) ||
        b.updatedAt.getTime() - a.updatedAt.getTime() ||
        a.prId - b.prId,
    )
    .slice(0, cap);
}

/** What one applied observation changed, if anything. */
export interface PrLivenessDiff {
  prId: number;
  /**
   * Did anything the BOARD reads move — state, draftness, merge state, or the PR's own clock?
   *
   * ⚠ This is what the route counts and what the SPA gates its board refetch on, and it is
   * DELIBERATELY narrower than "the row was written". A `reviewDecision` GitHub simply restated
   * changes no card, and on real data 92% of open PRs carry a null decision it restates on every
   * single tick — counting that as movement would make the board refetch on a fixed timer while
   * pretending the timer was evidence.
   */
  movedOnBoard: boolean;
  /** The PR left the open set — its card is gone from the board's own fold on the next read. */
  leftOpenSet: boolean;
}

/**
 * Write back ONE observation, and only the columns GitHub positively spoke about.
 *
 * ⚠ A COLUMN MAY BE CLEARED ONLY ON A POSITIVE STATEMENT FROM GITHUB. `graphqlTolerant` returns
 * partial data with forbidden fields NULLED, so an absent `mergeable` is indistinguishable from
 * "GitHub says unknown" at the JSON level. `foldLivenessNode` has already collapsed that: it
 * refuses the whole node unless `state` arrived (proving the fragment landed), and it leaves
 * `mergeable`/`mergeStateStatus` UNSET rather than null when they were not asked for. So here,
 * `undefined` means omit the key and anything else is written — including `reviewDecision: null`,
 * which on this path is GitHub saying "this repo requires no review", the same value the fat sync
 * walk stores from the same field.
 *
 * ⚠ IT DOES NOT TOUCH `mergedById`. That is the maintainer-inference input and it is not in this
 * selection; inventing one (or clearing it) from a probe that never asked would corrupt a
 * different feature. The next `persistPr` fills it in.
 *
 * Returns null when nothing in the row actually moved — the common case, and what lets the route
 * report an honest `changed` count instead of inviting a refetch on every tick.
 */
export async function applyPrLiveness(
  accountId: number,
  target: PrLivenessTarget,
  obs: PrLivenessObservation,
): Promise<PrLivenessDiff | null> {
  const set: Record<string, unknown> = {};
  // `dirty` = the row needs writing at all. `movedOnBoard` = a card can change because of it.
  // Two flags, deliberately: see PrLivenessDiff.movedOnBoard.
  let dirty = false;
  let movedOnBoard = false;
  const change = (onBoard: boolean): void => {
    dirty = true;
    if (onBoard) movedOnBoard = true;
  };

  if (obs.state !== target.state) {
    set.state = obs.state;
    change(true);
  }
  if (obs.isDraft != null && obs.isDraft !== target.isDraft) {
    set.isDraft = obs.isDraft;
    change(true);
  }
  // Timestamps that only ever ARRIVE (GitHub never un-merges), so they carry no comparison and
  // no movement of their own — they ride along so a card leaving the board leaves with a real
  // merged/closed clock instead of a null the next walk has to backfill.
  if (obs.mergedAt != null && target.state !== 'merged') {
    set.mergedAt = new Date(obs.mergedAt);
    dirty = true;
  }
  if (obs.closedAt != null && target.state === 'open') {
    set.closedAt = new Date(obs.closedAt);
    dirty = true;
  }
  if (obs.updatedAt != null) {
    const next = new Date(obs.updatedAt);
    if (next.getTime() !== target.updatedAt.getTime()) {
      set.updatedAt = next;
      change(true);
    }
  }
  // Written whenever it DIFFERS, null included — on this path a null is GitHub saying "this repo
  // requires no review", the same value persistPr stores from the same field, and it reaches us
  // only because `state` proved the fragment landed. Not board movement: no card renders it.
  if (obs.reviewDecision !== target.reviewDecision) {
    set.reviewDecision = obs.reviewDecision;
    change(false);
  }
  // ── The two computed fields, and the one rule that keeps this sweep CONVERGENT ────────────
  //
  // `undefined` = the cheap pass never asked. Never conflated with GitHub's own 'unknown'.
  //
  // ⚠ AN OBSERVED 'unknown' DOES NOT OVERWRITE A KNOWN STORED VALUE, and this is a DELIBERATE
  // divergence from `persistPr`, which writes it. GitHub does not store mergeability: asking for
  // it STARTS a background trial merge, and the answer while that runs is UNKNOWN. `persistPr`
  // runs on the adaptive cadence (2-15 min) so it rarely catches that window; this sweep runs
  // every 60s and would sit in it — downgrading `clean` to `unknown`, taking the card's Merge
  // button away, then restoring it a minute later. Every one of those transitions is a `changed`,
  // so the board would refetch on a fixed timer forever with a GitHub call in front of it, which
  // is precisely the churn `changed` exists to prevent.
  //
  // Cost of the guard: a PR whose merge state genuinely became unknowable (a force-push mid-
  // computation) keeps its previous state until the next full walk. That is the same staleness
  // every card had before this route existed, on a narrow slice of PRs, for a couple of minutes.
  const authoritative = <T>(next: T | undefined, stored: T | null, unknown: T): boolean =>
    next !== undefined && next !== stored && !(next === unknown && stored != null);
  if (authoritative(obs.mergeStateStatus, target.mergeStateStatus, 'unknown')) {
    set.mergeStateStatus = obs.mergeStateStatus;
    change(true);
  }
  if (authoritative(obs.mergeable, target.mergeable, 'unknown')) {
    set.mergeable = obs.mergeable;
    // The board's merge GATE reads it (`card.mergeable ?? 'unknown'` → mergeVerdict), so a
    // conflict appearing or clearing really can change a button.
    change(true);
  }

  if (!dirty) return null;
  await db
    .update(pullRequests)
    .set(set)
    .where(and(eq(pullRequests.id, target.prId), eq(pullRequests.accountId, accountId)))
    .execute();
  return {
    prId: target.prId,
    movedOnBoard,
    leftOpenSet: target.state === 'open' && obs.state !== 'open',
  };
}

// Pending-board liveness — the GitHub data plane (READ only; nothing here writes to GitHub).
//
// One question, asked for a whole board at a time: "are these pull requests still what our rows
// say they are?" It exists because the Pending board is built entirely from synced rows — which
// is the whole reason it can render fifty cards without fifty fetches — and a PR merged, closed
// or unblocked by SOMEBODY ELSE therefore keeps its card until the adaptive walk comes round to
// that repo (hot 120s / warm 300s / cold 900s, plus the cron tick).
//
// Modelled on github/reactions.ts, which is the precedent for a batched on-demand `nodes(ids:)`
// read that spends the tenant's quota on a hot surface: `isLimited` before asking, `noteBudget`
// from the query's own `rateLimit` block, `isRateLimitError` on failure, and DEGRADE TO EMPTY
// rather than throwing — a board that could not be freshened is a board rendering synced rows,
// which is exactly what it rendered before this module existed.
//
// ⚠ TWO PASSES, TWO BATCH SIZES, AND THE REASON IS MEASURED WALL TIME, NOT POINTS. See the cost
// table in the PR_LIVENESS_NODES_QUERY header: `mergeable`/`mergeStateStatus` are computed by
// GitHub on demand (a trial merge per PR), so 50 ids asking for them 502s the gateway after ~11s
// while 90 ids WITHOUT them answer in ~1.4s. Both cost exactly 1 point. The split is expressed as
// one query with an `@include` directive rather than two constants precisely so the batch size
// and the selection are chosen by the SAME flag and cannot drift apart.
import {
  getGraphqlClientFor,
  graphqlTolerant,
  isRateLimitError,
} from './client.js';
import { isLimited, noteBudget, noteLimited } from './rate-budget.js';
import {
  PR_LIVENESS_NODES_QUERY,
  type GqlPrLivenessNode,
  type PrLivenessNodesGqlResponse,
} from './queries.js';

/**
 * The CHEAP pass's batch. GitHub's `nodes(ids:)` accepts at most 100 ids; kept under it for the
 * reason REACTION_NODE_BATCH is, and MEASURED comfortable at 90 (~1.4s, 1 point).
 */
export const PR_LIVENESS_NODE_BATCH = 90;

/**
 * The EXPENSIVE pass's batch — the one that asks GitHub to compute mergeability.
 *
 * ⚠ 25 IS NOT A ROUND NUMBER PICKED FOR TIDINESS. Measured: 40 ids answered in 5.8s, 50 ids
 * returned HTTP 502 after 10.8s, 90 ids 502'd after 11.2s. The failure is a gateway TIMEOUT and
 * it returns no partial data — one over-large batch loses every PR in it, not the marginal one.
 * 25 measured 3.9-5.5s across three disjoint slices of this account's real open PRs, which leaves
 * roughly a 2× margin against the observed cliff on a resource whose latency is GitHub's to vary.
 */
export const PR_MERGE_STATE_NODE_BATCH = 25;

/** One PR's observed state, as GitHub reported it. Absent fields are UNOBSERVED, never "no". */
export interface PrLivenessObservation {
  nodeId: string;
  /** 'open' | 'closed' | 'merged' — lowercased. Present iff the PullRequest fragment landed. */
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean | null;
  updatedAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  /** null is a POSITIVE statement here ("this repo requires no review"), not an absence. */
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  /** undefined = not asked for (the cheap pass) or not received. Never conflated with a value. */
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  mergeStateStatus?:
    | 'clean'
    | 'dirty'
    | 'unstable'
    | 'blocked'
    | 'behind'
    | 'has_hooks'
    | 'unknown';
}

export interface FetchPrLivenessOptions {
  /**
   * The account whose token this is — the key of the per-account rate budget. REQUIRED, exactly as
   * in reactions.ts: it is the only thing between "every open board, every minute" and a token
   * that is already out of points.
   */
  accountId: number;
  /** Ask for `mergeable`/`mergeStateStatus` too. ⚠ Costs ~5s and caps the batch at 25. */
  withMergeState: boolean;
  /** Partial-GraphQL reporter (a node the token cannot read). Never fatal. */
  onPartial?: (errors: unknown) => void;
  /**
   * Fired when the lookup was skipped (already limited) or abandoned (limited mid-flight). Purely
   * for the caller's log line and the route's `paused` report — the DEGRADE is unconditional.
   */
  onRateLimited?: (resumeAt: Date | null) => void;
}

/** A `rateLimit.resetAt` we can actually use, or null. Never feeds an Invalid Date to the budget. */
function parseResetAt(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const STATE_FROM: Record<string, 'open' | 'closed' | 'merged'> = {
  OPEN: 'open',
  CLOSED: 'closed',
  MERGED: 'merged',
};

const MERGEABLE_FROM: Record<string, 'mergeable' | 'conflicting' | 'unknown'> = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
  UNKNOWN: 'unknown',
};

const MERGE_STATE_FROM: Record<string, PrLivenessObservation['mergeStateStatus']> = {
  CLEAN: 'clean',
  DIRTY: 'dirty',
  UNSTABLE: 'unstable',
  BLOCKED: 'blocked',
  BEHIND: 'behind',
  HAS_HOOKS: 'has_hooks',
  UNKNOWN: 'unknown',
};

const REVIEW_DECISION_FROM: Record<
  string,
  'approved' | 'changes_requested' | 'review_required'
> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

/**
 * Fold ONE node into an observation, or null when nothing usable arrived.
 *
 * ⚠ `state` IS THE PROOF THAT THE FRAGMENT LANDED. GitHub returns a non-null `state` for every
 * PullRequest it will talk about, so a null/absent one means the id resolved to another type, the
 * token cannot see it, or `graphqlTolerant` NULLED the selection after a partial error. In all
 * three cases we know nothing and must say so — an "absent means unchanged" reading here would
 * quietly stop refreshing exactly the PRs whose access just broke.
 */
export function foldLivenessNode(
  node: GqlPrLivenessNode | null | undefined,
): PrLivenessObservation | null {
  if (!node?.id) return null;
  const state = node.state ? STATE_FROM[node.state.toUpperCase()] : undefined;
  if (!state) return null;
  const out: PrLivenessObservation = {
    nodeId: node.id,
    state,
    isDraft: typeof node.isDraft === 'boolean' ? node.isDraft : null,
    updatedAt: node.updatedAt ?? null,
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null,
    // Null here is GitHub SAYING "no review decision" (the 92%-of-open-PRs case on real data:
    // the repo requires no review), which is the same value persistPr stores from the fat walk.
    // It reaches us only because `state` above proved the fragment landed.
    reviewDecision: node.reviewDecision
      ? (REVIEW_DECISION_FROM[node.reviewDecision.toUpperCase()] ?? null)
      : null,
  };
  // Left UNSET, never set to a fallback: the cheap pass does not ask for these, and an
  // enum member we do not model is dropped rather than written through.
  const m = node.mergeable ? MERGEABLE_FROM[node.mergeable.toUpperCase()] : undefined;
  if (m) out.mergeable = m;
  const s = node.mergeStateStatus
    ? MERGE_STATE_FROM[node.mergeStateStatus.toUpperCase()]
    : undefined;
  if (s) out.mergeStateStatus = s;
  return out;
}

/**
 * Read liveness for up to one BATCH of node ids in ONE GraphQL call (1 point — see the measured
 * table in the query's header). The caller does the batching; this function does not loop.
 *
 * Nodes GitHub answered with `null`, nodes of a non-PullRequest type, and nodes whose selection
 * came back NULLED by a partial error are simply ABSENT from the result — the caller leaves those
 * rows exactly as they were, which is strictly better than inventing a state for them.
 *
 * An exhausted budget returns EMPTY rather than throwing, for reactions.ts's reason one surface
 * over: liveness is a freshening pass over rows that are already renderable, so failing it must
 * never turn a working board into an error. The caller reports the pause instead.
 */
export async function fetchPrLivenessForNodes(
  token: string,
  nodeIds: string[],
  opts: FetchPrLivenessOptions,
): Promise<PrLivenessObservation[]> {
  if (nodeIds.length === 0) return [];
  const { accountId, withMergeState } = opts;

  // Already known-limited (this token's sync walk paused, or any other consumer classified a
  // limited error): do not spend a request to be told so again. The cheap-consumer contract —
  // `isLimited`, deliberately NOT `gateBudget`: nobody is holding a board open waiting out an
  // hourly window, and the floor exists to leave headroom for the user's own clicks.
  if (isLimited(accountId)) {
    opts.onRateLimited?.(null);
    return [];
  }

  let res: PrLivenessNodesGqlResponse;
  try {
    const gql = getGraphqlClientFor(token);
    res = await graphqlTolerant<PrLivenessNodesGqlResponse>(
      gql,
      PR_LIVENESS_NODES_QUERY,
      { ids: nodeIds, withMergeState },
      opts.onPartial,
    );
  } catch (err) {
    const rl = isRateLimitError(err);
    if (!rl.limited) throw err;
    // Tell the SHARED budget so the walks and the other cheap consumers back off too — a limit
    // discovered by a liveness probe is a fact about the token, not about liveness.
    noteLimited(accountId, rl.resumeAt);
    opts.onRateLimited?.(rl.resumeAt);
    return [];
  }

  if (res.rateLimit) {
    noteBudget(accountId, {
      remaining: res.rateLimit.remaining ?? null,
      resetAt: parseResetAt(res.rateLimit.resetAt),
    });
  }

  const out: PrLivenessObservation[] = [];
  for (const node of res.nodes ?? []) {
    const obs = foldLivenessNode(node);
    if (obs) out.push(obs);
  }
  return out;
}

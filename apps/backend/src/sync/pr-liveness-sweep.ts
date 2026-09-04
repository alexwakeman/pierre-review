// The Pending board's liveness sweep — the composition behind `POST /api/attention/liveness`.
//
// ONE PROBLEM, STATED PRECISELY. The board renders from synced rows and must keep doing so: the
// alternative — each card resolving its own state — is ~4-5 upstream calls per PR, i.e. 200-250
// calls to paint fifty cards, which is the failure the whole board is designed around. But that
// also means a pull request merged, closed or unblocked by SOMEBODY ELSE keeps its card until the
// adaptive scheduler next walks that repo: 2 minutes on a hot repo, 15 on a cold one. "If the PR
// is merged it should drop off immediately" is not reachable from the local DB at all.
//
// So: ONE batched GraphQL question for the WHOLE board, on the reactions.ts template. Two passes
// (see github/pr-liveness.ts for the measured reason), 2 GraphQL points total, ~7s wall for a
// full-size board. Compare that with the ~200 calls of the per-card alternative.
//
// ⚠ IT WRITES ROWS AND REPORTS A COUNT. IT DOES NOT TOUCH THE BOARD. The SPA's only permitted
// response to `changed > 0` is to REFETCH `['attention-cards']` + `['daily-brief']` together —
// never to splice a card out client-side. Every cap disclosure on that board gates on
// `shown === count` where `shown` is counted off the card list and `count` comes from the brief,
// so removing one card locally deletes the "50 of 148" line silently, on exactly the workspaces
// where the cap bites. Refetching is the only shape that keeps the two halves one snapshot.
import type { FastifyBaseLogger } from 'fastify';
import { getAccessToken } from '../auth/account.js';
import {
  fetchPrLivenessForNodes,
  PR_LIVENESS_NODE_BATCH,
  PR_MERGE_STATE_NODE_BATCH,
  type PrLivenessObservation,
} from '../github/pr-liveness.js';
import {
  applyPrLiveness,
  getPrLivenessTargets,
  rankForMergeStatePass,
  type PrLivenessTarget,
} from '../db/pr-liveness.js';

/**
 * The hard cap on how many PRs one sweep will look at.
 *
 * It is the cheap pass's batch size, and it is deliberately ONE batch rather than a loop: this is
 * a client-driven route on a timer, so an unbounded id list would let a large board (or a script)
 * turn one HTTP request into an arbitrary number of GraphQL requests. A board carrying more than
 * 90 distinct PRs gets the 90 the client ranked highest and the rest keeps the freshness it had —
 * which is the adaptive walk, i.e. exactly what every card had before this route existed.
 */
export const PR_LIVENESS_MAX_IDS = PR_LIVENESS_NODE_BATCH;

export interface PrLivenessSweepResult {
  /** How many of the caller's ids resolved to PRs it actually owns in this workspace. */
  checked: number;
  /** Of those, how many the expensive pass could also re-read mergeability for. */
  mergeStateChecked: number;
  /** Rows whose BOARD-VISIBLE state moved. The SPA refetches the board iff this is > 0. */
  changed: number;
  /** Of those, how many left the open set entirely (merged or closed elsewhere). */
  leftOpenSet: number;
  /**
   * Set when the account's GitHub budget was exhausted, so the sweep answered from nothing.
   * ⚠ A PAUSE IS NOT AN ERROR — red is for unrecoverable failures only. The client renders
   * nothing for it; the board keeps its synced rows, which is what it had anyway.
   */
  paused: { resumeAt: string | null } | null;
}

// One sweep at a time per ACCOUNT. Two browser tabs on the same board, or a tab whose interval
// overlaps its own focus refetch, would otherwise pay twice for one answer — and the second
// sweep's writes race the first's for no benefit at all, since they are reading the same PRs.
//
// ⚠ SYNCHRONOUS CLAIM, RELEASED ON EVERY BAIL PATH INCLUDING A THROWN LOOKUP. The add below and
// the try that guards it are adjacent on purpose: an `await` between them is how this pattern
// leaks a permanent claim and wedges the feature for the life of the process.
const inFlight = new Set<number>();

/** Test-only: clear the in-flight claims between cases. */
export function __resetPrLivenessSweep(): void {
  inFlight.clear();
}

/**
 * Re-read the board's PRs from GitHub and write back what moved.
 *
 * Returns null when a sweep for this account is ALREADY running — the caller reports a no-op, not
 * an error: the in-flight sweep is about to produce the very answer this call wanted.
 */
export async function sweepPrLiveness(args: {
  accountId: number;
  repoIds: number[];
  prIds: number[];
  log: FastifyBaseLogger;
}): Promise<PrLivenessSweepResult | null> {
  const { accountId, repoIds, prIds, log } = args;
  if (inFlight.has(accountId)) return null;
  inFlight.add(accountId);
  try {
    // ⚠ THE ISOLATION BOUNDARY, and it is the first thing that happens: ids arriving in a request
    // body are resolved through an accountId + workspace-membership scoped select, so an id
    // belonging to another tenant, another workspace or nothing at all is simply absent from
    // `targets` and can never reach GitHub or a write.
    const targets = await getPrLivenessTargets(accountId, repoIds, prIds);
    if (targets.length === 0) {
      return { checked: 0, mergeStateChecked: 0, changed: 0, leftOpenSet: 0, paused: null };
    }

    let pausedAt: { resumeAt: string | null } | null = null;
    const notePause = (resumeAt: Date | null): void => {
      // First pause wins — the two passes share one budget, so the second would only restate it.
      pausedAt ??= { resumeAt: resumeAt?.toISOString() ?? null };
    };
    const token = await getAccessToken(accountId);
    const byNode = new Map<string, PrLivenessTarget>(
      targets.map((t) => [t.githubNodeId, t]),
    );

    // ── PASS 1 — the cheap one, over everything (measured 1 point, ~1.4s for 90 ids) ──────────
    // This is the pass that answers the actual complaint: `state` says whether the PR is still
    // open, and a card whose PR merged leaves on the refetch this triggers.
    const observed = new Map<string, PrLivenessObservation>();
    const cheap = await fetchPrLivenessForNodes(
      token,
      targets.map((t) => t.githubNodeId),
      {
        accountId,
        withMergeState: false,
        onPartial: (errors) =>
          log.warn({ errors }, 'prLiveness: partial GraphQL response (cheap pass)'),
        onRateLimited: notePause,
      },
    );
    for (const o of cheap) observed.set(o.nodeId, o);

    // ── PASS 2 — mergeability, for a ranked SUBSET (measured 1 point, ~5s for 25 ids) ─────────
    // ⚠ THE SUBSET IS NOT AN OPTIMISATION, IT IS THE ONLY SHAPE THAT WORKS. Asking 50 PRs for
    // `mergeStateStatus` returns HTTP 502 with no partial data — GitHub computes mergeability on
    // demand and its gateway times out first. `rankForMergeStatePass` puts the PRs already
    // rendering a Merge / Update-branch button at the front, because a stale merge state THERE is
    // a button that 405s.
    //
    // Skipped entirely once the budget is exhausted: `fetchPrLivenessForNodes` would short-circuit
    // on `isLimited` anyway, but reporting the pause once and stopping is the honest shape.
    let mergeStateChecked = 0;
    if (pausedAt == null) {
      // Rank off what pass 1 just proved, not off the stored row: a PR that merged thirty seconds
      // ago must not spend one of the 25 expensive slots.
      const stillOpen = targets.filter((t) => {
        const o = observed.get(t.githubNodeId);
        return o == null ? t.state === 'open' : o.state === 'open';
      });
      const wanted = rankForMergeStatePass(stillOpen, PR_MERGE_STATE_NODE_BATCH);
      if (wanted.length > 0) {
        const rich = await fetchPrLivenessForNodes(
          token,
          wanted.map((t) => t.githubNodeId),
          {
            accountId,
            withMergeState: true,
            onPartial: (errors) =>
              log.warn({ errors }, 'prLiveness: partial GraphQL response (merge-state pass)'),
            onRateLimited: notePause,
          },
        );
        mergeStateChecked = rich.length;
        // MERGED INTO pass 1's answer rather than replacing it: the rich node carries the same
        // scalars plus the two extra fields, so a later observation is strictly better informed.
        for (const o of rich) observed.set(o.nodeId, o);
      }
    }

    // ── APPLY ─────────────────────────────────────────────────────────────────────────────────
    // One narrow UPDATE per genuinely-moved row. Sequential, not Promise.all: on sqlite these
    // share one write lock, and the loop is bounded at 90.
    let changed = 0;
    let leftOpenSet = 0;
    for (const [nodeId, obs] of observed) {
      const target = byNode.get(nodeId);
      // A node id GitHub answered that we did not ask about cannot happen, but the map lookup is
      // what makes that structurally true rather than assumed.
      if (!target) continue;
      const diff = await applyPrLiveness(accountId, target, obs);
      if (diff == null) continue;
      if (diff.movedOnBoard) changed += 1;
      if (diff.leftOpenSet) leftOpenSet += 1;
    }

    return {
      checked: targets.length,
      mergeStateChecked,
      changed,
      leftOpenSet,
      paused: pausedAt,
    };
  } finally {
    // EVERY bail path — the early returns above, a thrown `getAccessToken`, a thrown target
    // lookup, a non-rate-limit GraphQL error rethrown by fetchPrLivenessForNodes.
    inFlight.delete(accountId);
  }
}

// Emoji reactions — the GitHub data plane (READ half; the write half lives in mutations.ts
// with the rest of the GitHub writes).
//
// Nothing in this module is reachable from the sync pipeline. Reactions are fetched on demand
// and never persisted: there is no column, no migration, no upsert and no delete path. The
// whole feature's cost model is "one cheap batched query per screenful of comments", which is
// why the batching lives on the CLIENT (hooks/useReactions.ts) and this function takes a LIST.
//
// Everything read from a PR is attacker-authored, but a reaction carries no free text at all —
// `content` is a closed eight-member GitHub enum and `count` is an integer. Unknown enum
// members are DROPPED rather than passed through, so a future GitHub addition cannot reach the
// SPA as an unrenderable value.
//
// It DOES spend GitHub quota, though — one GraphQL point per screenful of comments — so it
// takes part in the per-account rate budget (github/rate-budget.ts) exactly like every other
// GitHub-spending path: it consults `isLimited` before asking, feeds `noteBudget` from the
// `rateLimit` block this query has always selected, and classifies a failure through the
// EXISTING `isRateLimitError`. See `fetchReactionsForNodes` for why an exhausted budget
// degrades to an EMPTY answer instead of an error.

import type { ReactionContent, ReactionGroupSummary } from '@pierre-review/shared';
import { getGraphqlClientFor, graphqlTolerant, isRateLimitError } from './client.js';
import { isLimited, noteBudget, noteLimited } from './rate-budget.js';
import {
  REACTION_NODES_QUERY,
  type GqlReactionGroup,
  type ReactionNodesGqlResponse,
} from './queries.js';

/**
 * GitHub's `nodes(ids:)` accepts at most 100 ids per call. Kept slightly under so a future
 * addition to the selection cannot push a batch over an unrelated ceiling.
 */
export const REACTION_NODE_BATCH = 90;

/** Wire (lowercase) → GitHub enum (uppercase). The only place the two vocabularies meet. */
const TO_GITHUB: Record<ReactionContent, string> = {
  thumbs_up: 'THUMBS_UP',
  thumbs_down: 'THUMBS_DOWN',
  laugh: 'LAUGH',
  hooray: 'HOORAY',
  confused: 'CONFUSED',
  heart: 'HEART',
  rocket: 'ROCKET',
  eyes: 'EYES',
};

const FROM_GITHUB: Record<string, ReactionContent> = {
  THUMBS_UP: 'thumbs_up',
  THUMBS_DOWN: 'thumbs_down',
  LAUGH: 'laugh',
  HOORAY: 'hooray',
  CONFUSED: 'confused',
  HEART: 'heart',
  ROCKET: 'rocket',
  EYES: 'eyes',
};

export function toGithubReactionContent(content: ReactionContent): string {
  return TO_GITHUB[content];
}

/**
 * Fold GitHub's group list into the wire shape.
 *
 * ⚠ GitHub ALWAYS returns all eight groups, with `reactors.totalCount: 0` for the empty ones
 * (verified against real nodes). Dropping the zeros here is load-bearing: without it the wire
 * carries eight entries per comment for a corpus that is overwhelmingly reaction-free, and
 * every consumer has to re-derive the same filter.
 */
export function summariseReactionGroups(
  groups: GqlReactionGroup[] | null | undefined,
): ReactionGroupSummary[] {
  if (!groups) return [];
  const out: ReactionGroupSummary[] = [];
  for (const g of groups) {
    const content = FROM_GITHUB[g.content];
    // An enum member we do not know how to render is dropped, not surfaced.
    if (!content) continue;
    const count = g.reactors?.totalCount ?? 0;
    if (count <= 0) continue;
    out.push({ content, count, viewerHasReacted: g.viewerHasReacted === true });
  }
  return out;
}

export interface NodeReactionState {
  nodeId: string;
  groups: ReactionGroupSummary[];
  viewerCanReact: boolean;
}

export interface FetchReactionsOptions {
  /**
   * The account whose token this is — the key of the per-account rate budget. REQUIRED, not
   * optional: this is the only thing standing between "every screenful of comments" and a
   * token that is already out of points.
   */
  accountId: number;
  /** Partial-GraphQL reporter (a node the token cannot read). Never fatal. */
  onPartial?: (errors: unknown) => void;
  /**
   * Fired when the lookup was skipped (already limited) or abandoned (limited mid-flight)
   * instead of answering. `resumeAt` is the classifier's estimate when GitHub gave one.
   * Purely for the caller's log line — the DEGRADE itself is unconditional.
   */
  onRateLimited?: (resumeAt: Date | null) => void;
}

/** A `rateLimit.resetAt` we can actually use, or null. Never feeds an Invalid Date to the budget. */
function parseResetAt(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Read reactions for up to REACTION_NODE_BATCH node ids in ONE GraphQL call.
 *
 * `graphqlTolerant` rather than a bare client call: one node the token cannot read must not
 * wipe out the other 89. Nodes GitHub answered with `null`, nodes of a non-Reactable type, and
 * nodes whose selection came back NULLED by a partial error are all simply ABSENT from the
 * result — the caller renders nothing for them, which is the same as "no reactions" from the
 * UI's point of view and strictly better than inventing an empty set.
 *
 * ── THE RATE BUDGET ──────────────────────────────────────────────────────────────────────
 * This is a GitHub-spending path on a HOT surface (every mounted comment on every screen), so
 * it both consults and feeds the per-account budget:
 *
 *   • `isLimited` BEFORE asking — the cheap-consumer contract (github/rate-budget.ts), the
 *     same one the adaptive probe and the PR-refresh poll follow. Deliberately NOT `gateBudget`
 *     and deliberately NOT gated on RATE_BUDGET_FLOOR: the floor exists to leave the walks
 *     headroom *for the user's own clicks*, and this IS one of those clicks — and nobody is
 *     holding a comment thread open waiting out an hourly window.
 *   • `noteBudget` on success, from the `rateLimit` block the query has always selected for
 *     exactly this purpose, so a sibling walk pauses pre-emptively instead of hitting the 403.
 *     (`noteBudget` never clears `limitedUntil` — a GraphQL page landing proves nothing about
 *     a REST-observed secondary limit.)
 *   • `isRateLimitError` on failure — the EXISTING, SEPARATE classifier. `isRetryableGithubError`
 *     is NOT widened to cover it (a test pins its 403/429 exclusion), because "retry in
 *     milliseconds" is the wrong answer to an exhausted window.
 *
 * An exhausted budget therefore returns EMPTY rather than throwing. A reaction bar is a
 * decoration; the absent-means-unknown contract this function already has (see above) means
 * the client renders nothing for it, which is a far better failure than 502-ing a request the
 * user did not knowingly make. The route's remaining 502 path stays reserved for real faults.
 */
export async function fetchReactionsForNodes(
  token: string,
  nodeIds: string[],
  opts: FetchReactionsOptions,
): Promise<NodeReactionState[]> {
  if (nodeIds.length === 0) return [];
  const { accountId } = opts;

  // Already known-limited (this token's sync walk paused, or any other consumer classified a
  // limited error): do not spend a request to be told so again.
  if (isLimited(accountId)) {
    opts.onRateLimited?.(null);
    return [];
  }

  let res: ReactionNodesGqlResponse;
  try {
    const gql = getGraphqlClientFor(token);
    res = await graphqlTolerant<ReactionNodesGqlResponse>(
      gql,
      REACTION_NODES_QUERY,
      { ids: nodeIds },
      opts.onPartial,
    );
  } catch (err) {
    const rl = isRateLimitError(err);
    if (!rl.limited) throw err;
    // Tell the SHARED budget, so the walks and the other cheap consumers back off too — a
    // limit discovered by a reaction lookup is a fact about the token, not about reactions.
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

  const out: NodeReactionState[] = [];
  for (const node of res.nodes ?? []) {
    if (!node?.id) continue;
    // `viewerCanReact === undefined/null` means the Reactable selection never arrived (a
    // non-Reactable type, or a field NULLED by a partial error). Reporting `false` there is
    // the safe direction: it hides the add affordance rather than offering a write that
    // would fail.
    out.push({
      nodeId: node.id,
      groups: summariseReactionGroups(node.reactionGroups),
      viewerCanReact: node.viewerCanReact === true,
    });
  }
  return out;
}

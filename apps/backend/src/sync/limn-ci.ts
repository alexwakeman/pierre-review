// LIMN'S OWN STATUS LINES ARE NOT CI — the COMMIT-HISTORY half (shared limn-status.ts is the PR-head
// half). The default-branch snapshot, its history backfill and the one-time PR CI-history backfill
// read a commit's rollup STATE only (no contexts — the cost model in github/branch-queries.ts), and
// GitHub folds a teammate's `limn/review-*` line into that state: a green commit with an unfinished
// "free to claim" line reads PENDING, a commit with no CI and a finished review line reads SUCCESS.
//
// So each of those reads also selects the commit's legacy status NAMES (`LIMN_MARK_FIELDS`, free),
// and a commit that carries a Limn line in a state Limn could have caused (SUCCESS or PENDING —
// Limn never posts failure or error) has its state RECOMPUTED from its contexts, one ~1-point
// aliased call per COMMIT_CHECKS_ALIAS_CAP commits. A commit with no Limn line costs nothing more.
import { isLimnStatusContext, rollupStateWithoutLimn } from '@pierre-review/shared';
import { graphqlTolerant, withGithubRetry, type GraphqlClient } from '../github/client.js';
import {
  buildCommitChecksQuery,
  COMMIT_CHECKS_ALIAS_CAP,
  type CommitChecksResponse,
  type GqlLimnMark,
} from '../github/branch-queries.js';
import { checkContextState } from './upsert.js';

/** Does the commit's status list (as received) carry one of Limn's own lines? */
export function carriesLimnLine(mark: GqlLimnMark | null | undefined): boolean {
  return (mark?.status?.contexts ?? []).some((c) => isLimnStatusContext(c?.context ?? null));
}

/**
 * Must this commit's rollup state be recomputed without Limn's lines? Only a SUCCESS or PENDING
 * state with a Limn line beside it: Limn posts nothing but pending and success, so a FAILURE /
 * ERROR / EXPECTED state is never Limn's doing and stands as GitHub said it. Pure.
 */
export function needsLimnRecompute(state: string | null | undefined, mark: GqlLimnMark | null | undefined): boolean {
  const s = (state ?? '').toUpperCase();
  return (s === 'SUCCESS' || s === 'PENDING') && carriesLimnLine(mark);
}

/**
 * The rollup states of the given commits WITHOUT Limn's lines, recomputed from their contexts
 * (`rollupStateWithoutLimn`, which keeps GitHub's state on a contexts page that is not complete).
 * An entry exists only for a commit whose contexts arrived: absent = unknowable. A `null` value is
 * a commit whose only checks are Limn's own (it has no CI). Batches of COMMIT_CHECKS_ALIAS_CAP;
 * THROWS on a failed call (callers guard it — each is non-fatal).
 */
export async function fetchRollupsWithoutLimn(
  client: GraphqlClient,
  owner: string,
  name: string,
  shas: readonly string[],
  onPartial?: (errors: unknown) => void,
): Promise<{ bySha: Map<string, string | null>; cost: number }> {
  const bySha = new Map<string, string | null>();
  let cost = 0;
  for (let i = 0; i < shas.length; i += COMMIT_CHECKS_ALIAS_CAP) {
    const chunk = shas.slice(i, i + COMMIT_CHECKS_ALIAS_CAP);
    const variables: Record<string, unknown> = { owner, name };
    chunk.forEach((sha, j) => {
      variables[`s${j}`] = sha;
    });
    const resp = await withGithubRetry(() =>
      graphqlTolerant<CommitChecksResponse>(client, buildCommitChecksQuery(chunk.length), variables, onPartial),
    );
    chunk.forEach((sha, j) => {
      const rollup = resp.repository?.[`c${j}`]?.statusCheckRollup ?? null;
      const nodes = rollup?.contexts?.nodes;
      if (rollup == null || nodes == null) return;
      const contexts = nodes
        .filter((c): c is NonNullable<typeof c> => c != null)
        .map((c) => ({ name: c.__typename === 'CheckRun' ? c.name : c.context, state: checkContextState(c) }));
      bySha.set(sha, rollupStateWithoutLimn(rollup.state, contexts, rollup.contexts?.pageInfo?.hasNextPage !== true));
    });
    cost += resp.rateLimit?.cost ?? 0;
  }
  return { bySha, cost };
}

// THE SETTLE SWEEP'S QUERY (sync/settle-sweep.ts) — READ only.
//
// One aliased `repository(...)` per repo, each listing the repo's OPEN pull requests with just
// enough to tell whether our stored row is still right about the things GitHub changes WITHOUT
// bumping `updatedAt`: the head commit, its CI rollup, the review-thread resolutions — plus
// `updatedAt` itself, so a PR the walk missed is noticed too, and the default branch's head, so a
// trunk move (which silently re-decides every open PR's merge state) is noticed.
//
// COST — MEASURED 2026-10-28 (`rateLimit { cost }`, read-only, on a real 9-repo workspace): 9
// points for 9 aliased repos, i.e. ~1 point per repo. GitHub prices a query by the requests its
// connections need: per repo, `pullRequests(first:50)` is 1 request and each of its 50 PRs adds 1
// for `commits(last:1)` and 1 for `reviewThreads(first:100)` → 101 requests ≈ 1 point.
// ⚠ Do NOT put a connection UNDER `reviewThreads` or `commits` (a comments list, check contexts):
// that multiplies by the PR count and is how the fat walk costs 15 points a page. `status
// { contexts }` is a plain list, not a connection, and is free — it is how a head carrying one of
// Limn's own `limn/…` lines is recognised (github/branch-queries.ts LIMN_MARK_FIELDS).
//
// ⚠ NO MERGEABILITY HERE. Asking for `mergeable` makes GitHub run a trial merge per PR, and more
// than 25 in one request 502s the gateway (docs/REALTIME-SYNC.md, the 502 rule). A whole
// workspace's open PRs in one aliased request would break that rule, so merge state is read by the
// existing batched path instead (≤25 per request), triggered when this query sees the trunk move.

/** PRs per page of a repo's open list. Kept at 50: the measured ~1 point per repo depends on it. */
export const SETTLE_PR_PAGE = 50;
/** Review threads read per PR — no child connection, so the size does not change the price. */
export const SETTLE_THREAD_PAGE = 100;
/** Repos aliased into one request (~1 point each). */
export const SETTLE_REPOS_PER_QUERY = 10;

const SETTLE_PR_FIELDS = /* GraphQL */ `
  number
  id
  updatedAt
  isDraft
  reviewDecision
  commits(last: 1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          state
        }
        status {
          contexts {
            context
          }
        }
      }
    }
  }
  reviewThreads(first: ${SETTLE_THREAD_PAGE}) {
    totalCount
    nodes {
      isResolved
    }
  }
`;

/**
 * One request reading `count` repos' open PRs (one page each). Variables: `o<i>`/`n<i>` (owner,
 * name) and an optional `a<i>` cursor for a follow-up page.
 */
export function buildSettleSweepQuery(count: number): string {
  const vars = Array.from(
    { length: count },
    (_, i) => `$o${i}: String!, $n${i}: String!, $a${i}: String`,
  ).join(', ');
  const aliases = Array.from(
    { length: count },
    (_, i) => `    r${i}: repository(owner: $o${i}, name: $n${i}) {
      defaultBranchRef {
        target {
          oid
        }
      }
      pullRequests(
        states: [OPEN]
        first: ${SETTLE_PR_PAGE}
        after: $a${i}
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ...SettlePr
        }
      }
    }`,
  ).join('\n');
  return `query SettleSweep(${vars}) {
    rateLimit {
      cost
      remaining
      resetAt
    }
${aliases}
  }
  fragment SettlePr on PullRequest {${SETTLE_PR_FIELDS}}`;
}

export interface GqlSettlePr {
  number?: number | null;
  id?: string | null;
  updatedAt?: string | null;
  isDraft?: boolean | null;
  reviewDecision?: string | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        oid?: string | null;
        statusCheckRollup?: { state?: string | null } | null;
        status?: { contexts?: Array<{ context?: string | null } | null> | null } | null;
      } | null;
    } | null> | null;
  } | null;
  reviewThreads?: {
    totalCount?: number | null;
    nodes?: Array<{ isResolved?: boolean | null } | null> | null;
  } | null;
}

export interface GqlSettleRepo {
  defaultBranchRef?: { target?: { oid?: string | null } | null } | null;
  pullRequests?: {
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
    nodes?: Array<GqlSettlePr | null> | null;
  } | null;
}

export interface SettleSweepResponse {
  rateLimit?: { cost?: number | null; remaining?: number | null; resetAt?: string | null } | null;
  // Keyed `r0`…`r<n-1>`; null = a repo GitHub would not show (gone, or a nulled selection).
  [alias: string]: GqlSettleRepo | SettleSweepResponse['rateLimit'] | null | undefined;
}

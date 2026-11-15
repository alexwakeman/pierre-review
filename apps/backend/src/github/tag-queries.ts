// TAGS (docs/RELEASES.md) — READ only: the repo's tags (GraphQL), the commits between two commits
// (REST compare), and the PRs a handful of commits came from (GraphQL, the fallback for a commit
// no stored PR's `merge_commit_oid` names).
//
// COST.
//   • REPO_TAGS_QUERY: one `refs(first: 100)` page with no child connection ⇒ 1 point. A RELEASABLE
//     repo pages on (`after`) up to REPO_TAGS_READ_CAP_RELEASABLE tags (≤ 10 points per read).
//   • The settle sweep adds `refs(first: 1)` per repo to its own query (github/settle-query.ts):
//     one node, no measurable change to its ~1 point per repo.
//   • compareCommits: REST (the core REST budget, not GraphQL points), one call per page of 100
//     commits; ancestry asks for ONE commit (per_page=1).
//   • fetchClosedPrsPage: REST list of closed PRs into the default branch, 100 per call — the oldest
//     tag's 'history' range (sync/tag-ranges.ts), read oldest first and stopped at the tag's date.
//   • buildCommitPrsQuery: ≤ COMMIT_PRS_ALIAS_CAP aliases × associatedPullRequests(first: 3) ⇒
//     ≤ 150 nodes ⇒ 2 points.
//
// Nullability: everything a tolerant partial (`graphqlTolerant`) can null is optional below.
import { ghRestGetFor, withGithubRetry } from './client.js';

/** Tags in one page of the read, newest by the tagged commit's date. A repo no workspace releases reads
 *  this one page only (past it the read is incomplete). */
export const REPO_TAGS_READ_CAP = 100;
/** Tags read for a RELEASABLE repo (pages of REPO_TAGS_READ_CAP): the whole history the check walks.
 *  Past it the read is incomplete and the count is logged. */
export const REPO_TAGS_READ_CAP_RELEASABLE = 1000;

export const REPO_TAGS_QUERY = /* GraphQL */ `
  query RepoTags($owner: String!, $name: String!, $first: Int!, $after: String) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        name
        target {
          oid
        }
      }
      refs(refPrefix: "refs/tags/", first: $first, after: $after, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          target {
            __typename
            oid
            ... on Commit {
              committedDate
            }
            ... on Tag {
              tagger {
                date
              }
              target {
                __typename
                oid
                ... on Commit {
                  committedDate
                }
              }
            }
          }
        }
      }
    }
  }
`;

export interface GqlTagTarget {
  __typename?: string | null;
  oid?: string | null;
  committedDate?: string | null;
  tagger?: { date?: string | null } | null;
  target?: { __typename?: string | null; oid?: string | null; committedDate?: string | null } | null;
}

export interface GqlTagRef {
  name?: string | null;
  target?: GqlTagTarget | null;
}

export interface GqlTagRefs {
  totalCount?: number | null;
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
  nodes?: Array<GqlTagRef | null> | null;
}

export interface RepoTagsResponse {
  rateLimit?: { cost?: number | null; remaining?: number | null; resetAt?: string | null } | null;
  repository?: {
    defaultBranchRef?: { name?: string | null; target?: { oid?: string | null } | null } | null;
    refs?: GqlTagRefs | null;
  } | null;
}

// ---- REST compare -------------------------------------------------------------------------------

const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

export interface RestCompareCommit {
  sha?: unknown;
}

export interface RestCompareResponse {
  status?: unknown;
  ahead_by?: unknown;
  behind_by?: unknown;
  total_commits?: unknown;
  commits?: RestCompareCommit[];
}

/** One page of `GET /repos/{owner}/{name}/compare/{base}...{head}`. Throws as ghRestGetFor does. */
export async function fetchComparePage(
  token: string,
  args: { owner: string; name: string; base: string; head: string; perPage: number; page: number },
): Promise<RestCompareResponse> {
  if (!SHA_RE.test(args.base) || !SHA_RE.test(args.head)) throw new Error('compare: not a commit sha');
  const path =
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.name)}` +
    `/compare/${args.base}...${args.head}?per_page=${args.perPage}&page=${args.page}`;
  return withGithubRetry(() => ghRestGetFor<RestCompareResponse>(token, path));
}

// ---- Closed PRs into a branch (the oldest tag's history) ----------------------------------------

export interface RestPullListItem {
  number?: unknown;
  created_at?: unknown;
  merged_at?: unknown;
  merge_commit_sha?: unknown;
  base?: { ref?: unknown } | null;
}

/** Closed PRs listed per call. */
export const CLOSED_PRS_PAGE = 100;

/** One page of `GET /repos/{owner}/{name}/pulls?state=closed&base=<base>`, OLDEST CREATED first. */
export async function fetchClosedPrsPage(
  token: string,
  args: { owner: string; name: string; base: string; page: number },
): Promise<RestPullListItem[]> {
  const path =
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.name)}/pulls` +
    `?state=closed&base=${encodeURIComponent(args.base)}&sort=created&direction=asc&per_page=${CLOSED_PRS_PAGE}&page=${args.page}`;
  const out = await withGithubRetry(() => ghRestGetFor<unknown>(token, path));
  return Array.isArray(out) ? (out as RestPullListItem[]) : [];
}

// ---- The commit → PR fallback -------------------------------------------------------------------

/** Commits asked about in one request. */
export const COMMIT_PRS_ALIAS_CAP = 50;

/** One aliased `object(oid:)` per commit sha; the shas travel as VARIABLES (`s<i>`). */
export function buildCommitPrsQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$s${i}: GitObjectID!`).join(', ');
  const aliases = Array.from(
    { length: count },
    (_, i) => `      c${i}: object(oid: $s${i}) {
        ... on Commit {
          associatedPullRequests(first: 3) {
            nodes {
              number
              merged
              baseRefName
              repository {
                nameWithOwner
              }
            }
          }
        }
      }`,
  ).join('\n');
  return `query CommitPrs($owner: String!, $name: String!${count > 0 ? `, ${vars}` : ''}) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    repository(owner: $owner, name: $name) {
${aliases}
    }
  }`;
}

export interface GqlCommitPrsNode {
  associatedPullRequests?: {
    nodes?: Array<{
      number?: number | null;
      merged?: boolean | null;
      baseRefName?: string | null;
      repository?: { nameWithOwner?: string | null } | null;
    } | null> | null;
  } | null;
}

export interface CommitPrsResponse {
  rateLimit?: { cost?: number | null; remaining?: number | null; resetAt?: string | null } | null;
  repository?: Record<string, GqlCommitPrsNode | null | undefined> | null;
}

// TAGS (docs/RELEASES.md) — READ only: the repo's tags (GraphQL), a REST compare (does the new head
// descend from the walked one?) and THE HISTORY PASS (GraphQL `history` with each commit's PRs).
//
// COST.
//   • REPO_TAGS_QUERY: one `refs(first: 100)` page with no child connection ⇒ 1 point. A RELEASABLE
//     repo pages on (`after`) up to REPO_TAGS_READ_CAP_RELEASABLE tags (≤ 10 points per read).
//   • The settle sweep adds `refs(first: 1)` per repo to its own query (github/settle-query.ts):
//     one node, no measurable change to its ~1 point per repo.
//   • fetchComparePage: REST (the core REST budget), per_page=1 — ONE call when the default branch
//     head moved, to tell a fast-forward from rewritten history.
//   • RELEASE_HISTORY_QUERY: 100 commits a page, each with parents(first: 1) and
//     associatedPullRequests(first: 2) ⇒ about 3 points a page.
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

// ---- The default branch's history (the release scan's ONE pass, sync/release-history.ts) ----------

/** Commits per history page. */
export const HISTORY_PAGE = 100;
/** PRs asked per commit (a squash or merge commit has one; a rebased commit can share it). */
export const HISTORY_COMMIT_PRS = 2;

/**
 * One page of a commit's `history` (git log order from that commit: every reachable commit, newest
 * first; the walk keeps the FIRST-PARENT chain by following `parents(first: 1)`), each with the PRs it
 * came from. Pinned to the segment's START commit (`$oid`), so a cursor stays valid while the branch
 * moves. `sinceCount`: the commits since a date (the newest release tag's), for the progress bar.
 * Cost: 100 commits × (parents + PRs) ≈ 3 points a page.
 */
export const RELEASE_HISTORY_QUERY = /* GraphQL */ `
  query ReleaseHistory($owner: String!, $name: String!, $oid: GitObjectID!, $first: Int!, $after: String, $since: GitTimestamp!) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    repository(owner: $owner, name: $name) {
      object(oid: $oid) {
        ... on Commit {
          sinceCount: history(first: 1, since: $since) {
            totalCount
          }
          history(first: $first, after: $after) {
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              oid
              committedDate
              parents(first: 1) {
                nodes {
                  oid
                }
              }
              associatedPullRequests(first: ${HISTORY_COMMIT_PRS}) {
                nodes {
                  number
                  title
                  url
                  headRefName
                  baseRefName
                  merged
                  mergedAt
                  mergeCommit {
                    oid
                  }
                  author {
                    __typename
                    login
                  }
                  repository {
                    nameWithOwner
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export interface GqlHistoryPr {
  number?: number | null;
  title?: string | null;
  url?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
  merged?: boolean | null;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string | null } | null;
  author?: { __typename?: string | null; login?: string | null } | null;
  repository?: { nameWithOwner?: string | null } | null;
}

export interface GqlHistoryCommit {
  oid?: string | null;
  committedDate?: string | null;
  parents?: { nodes?: Array<{ oid?: string | null } | null> | null } | null;
  associatedPullRequests?: { nodes?: Array<GqlHistoryPr | null> | null } | null;
}

export interface ReleaseHistoryResponse {
  rateLimit?: { cost?: number | null; remaining?: number | null; resetAt?: string | null } | null;
  repository?: {
    object?: {
      sinceCount?: { totalCount?: number | null } | null;
      history?: {
        totalCount?: number | null;
        pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
        nodes?: Array<GqlHistoryCommit | null> | null;
      } | null;
    } | null;
  } | null;
}

import { config } from '../config.js';

// Comment + review bodies are now ALWAYS persisted (the consolidated Feed renders
// full markdown), so they're always fetched: review bodies + review-comment bodies
// are already unconditional in the query below, and PR-comment bodies join them here.
// Only the PR description, commit messages, and the large review-comment diff hunks
// stay lean-gated (none are used at sync time and they aren't stored when lean) —
// dropping them from the query shrinks each backfill page substantially.
const fullText = config.persistBodies;
const prBodyField = fullText ? '\n          body' : '';
const commitMessageField = fullText ? '\n                message' : '';
const reviewCommentDiffHunkField = fullText ? '\n                  diffHunk' : '';
const prCommentBodyField = '\n              body';

// One query per repo per sync: PRs, reviews, review threads (+comments),
// general PR comments, and commits in a single round trip.
export const REPO_ACTIVITY_QUERY = /* GraphQL */ `
  query RepoActivity($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      id
      nameWithOwner
      viewerPermission
      defaultBranchRef {
        name
      }
      pullRequests(
        first: 25
        after: $cursor
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          number
          title${prBodyField}
          isDraft
          state
          additions
          deletions
          changedFiles
          files(first: 100) {
            nodes {
              path
              additions
              deletions
            }
          }
          createdAt
          mergedAt
          closedAt
          updatedAt
          url
          baseRefName
          headRefName
          mergeable
          mergeStateStatus
          author {
            login
            ... on User {
              id
              name
              avatarUrl
            }
          }
          mergedBy {
            login
            ... on User {
              id
              name
              avatarUrl
            }
          }
          labels(first: 20) {
            nodes {
              name
              color
            }
          }
          reviewRequests(first: 20) {
            nodes {
              requestedReviewer {
                __typename
                ... on User {
                  id
                  login
                }
                ... on Team {
                  id
                  name
                }
              }
            }
          }
          headCommit: commits(last: 1) {
            nodes {
              commit {
                oid
                statusCheckRollup {
                  state
                  contexts(first: 100) {
                    nodes {
                      __typename
                      ... on CheckRun {
                        name
                        status
                        conclusion
                        detailsUrl
                      }
                      ... on StatusContext {
                        context
                        state
                        targetUrl
                      }
                    }
                  }
                }
              }
            }
          }
          commits(last: 100) {
            nodes {
              commit {
                oid
                committedDate${commitMessageField}
                author {
                  user {
                    login
                    id
                  }
                }
                committer {
                  user {
                    login
                    id
                  }
                }
              }
            }
          }
          reviews(first: 50) {
            nodes {
              id
              fullDatabaseId
              state
              body
              submittedAt
              author {
                login
                ... on User {
                  id
                  name
                  avatarUrl
                }
              }
            }
          }
          reviewThreads(first: 50) {
            nodes {
              id
              isResolved
              isOutdated
              isCollapsed
              path
              line
              comments(first: 50) {
                nodes {
                  id
                  fullDatabaseId
                  body
                  createdAt${reviewCommentDiffHunkField}
                  author {
                    login
                    ... on User {
                      id
                      name
                      avatarUrl
                    }
                  }
                }
              }
            }
          }
          comments(first: 50) {
            nodes {
              id
              fullDatabaseId${prCommentBodyField}
              createdAt
              author {
                login
                ... on User {
                  id
                  name
                  avatarUrl
                }
              }
            }
          }
        }
      }
    }
    rateLimit {
      remaining
      resetAt
      cost
    }
  }
`;

// Lightweight lookup used when adding a repo (just need the node id + canonical
// owner/name casing).
export const REPO_ID_QUERY = /* GraphQL */ `
  query RepoId($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      name
      owner {
        login
      }
    }
  }
`;

// Single-PR detail fetch for on-demand text hydration (cloud "lean storage" mode).
// Only the bulky text the DB no longer stores: PR body, review/comment/PR-comment
// bodies, review-comment diff hunks, commit messages, and the head-commit checks
// (for the per-job checkRuns JSON). Matched back to stored rows by GitHub node id
// (the `id`/`fullDatabaseId` fields) and, for commits, by `oid`/sha. Cheap (~1 pt).
export const PR_DETAIL_QUERY = /* GraphQL */ `
  query PrDetail($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id
        number
        body
        additions
        deletions
        changedFiles
        files(first: 100) {
          nodes {
            path
            additions
            deletions
          }
        }
        headCommit: commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
        reviews(first: 50) {
          nodes {
            id
            fullDatabaseId
            body
          }
        }
        reviewThreads(first: 50) {
          nodes {
            id
            comments(first: 50) {
              nodes {
                id
                fullDatabaseId
                body
                diffHunk
              }
            }
          }
        }
        comments(first: 50) {
          nodes {
            id
            fullDatabaseId
            body
          }
        }
        commits(last: 100) {
          nodes {
            commit {
              oid
              message
            }
          }
        }
      }
    }
    rateLimit {
      remaining
      resetAt
      cost
    }
  }
`;

// Live repository search for the Add-repo picker. `searchQuery` is built by the route
// from the user term: it always restricts matching to the repo name (`in:name`), and
// an `owner/...` prefix is turned into an `org:`/`user:` qualifier so results stay
// within that owner. The route then re-ranks by literal name match. `viewer` is folded
// into the same round trip so the route can float the user's own / org repos to the
// top without a second request. Open-PR count comes free via pullRequests.totalCount.
export const REPO_SEARCH_QUERY = /* GraphQL */ `
  query RepoSearch($searchQuery: String!, $first: Int!, $cursor: String) {
    search(query: $searchQuery, type: REPOSITORY, first: $first, after: $cursor) {
      repositoryCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on Repository {
          id
          name
          nameWithOwner
          description
          url
          isPrivate
          stargazerCount
          owner {
            login
            avatarUrl
          }
          pullRequests(states: OPEN) {
            totalCount
          }
        }
      }
    }
    viewer {
      login
      organizations(first: 100) {
        nodes {
          login
        }
      }
    }
    rateLimit {
      remaining
      resetAt
      cost
    }
  }
`;

// Resolves whether an owner login is a User or an Organization, so an `owner/`
// prefix search can pick the correct GitHub search qualifier (`org:` vs `user:`).
// `__typename` is "User" | "Organization" | (null when the login doesn't exist).
export const OWNER_TYPE_QUERY = /* GraphQL */ `
  query OwnerType($login: String!) {
    repositoryOwner(login: $login) {
      __typename
    }
  }
`;

export interface OwnerTypeResponse {
  repositoryOwner: { __typename: string } | null;
}

// ---- response types ----

export interface GqlActor {
  login: string;
  id?: string; // present only for User (via inline fragment)
  name?: string | null;
  avatarUrl?: string | null;
}

export interface GqlCommitNode {
  commit: {
    oid: string;
    committedDate: string;
    message: string;
    author: { user: { login: string; id: string } | null } | null;
    committer: { user: { login: string; id: string } | null } | null;
  };
}

export interface GqlReview {
  id: string;
  fullDatabaseId: string | null;
  state: string;
  body: string | null;
  submittedAt: string | null;
  author: GqlActor | null;
}

export interface GqlReviewComment {
  id: string;
  fullDatabaseId: string | null;
  body: string;
  createdAt: string;
  diffHunk: string | null;
  author: GqlActor | null;
}

export interface GqlReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  path: string;
  line: number | null;
  comments: { nodes: GqlReviewComment[] };
}

export interface GqlPrComment {
  id: string;
  fullDatabaseId: string | null;
  body: string;
  createdAt: string;
  author: GqlActor | null;
}

export interface GqlLabel {
  name: string;
  color: string;
}

export interface GqlReviewRequest {
  requestedReviewer:
    | { __typename: 'User'; id: string; login: string }
    | { __typename: 'Team'; id: string; name: string }
    | null;
}

export type GqlCheckContext =
  | {
      __typename: 'CheckRun';
      name: string;
      status: string | null;
      conclusion: string | null;
      detailsUrl: string | null;
    }
  | {
      __typename: 'StatusContext';
      context: string;
      state: string | null;
      targetUrl: string | null;
    };

export interface GqlHeadCommit {
  commit: {
    oid: string;
    statusCheckRollup: {
      state: string;
      contexts?: { nodes: GqlCheckContext[] };
    } | null;
  };
}

export interface GqlPrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface GqlPullRequest {
  id: string;
  number: number;
  title: string;
  body: string | null;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  // Diff size — GraphQL scalars + the (capped) per-file connection.
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { nodes: GqlPrFile[] };
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  mergeable: string | null;
  mergeStateStatus: string | null;
  author: GqlActor | null;
  mergedBy: GqlActor | null;
  labels: { nodes: GqlLabel[] };
  reviewRequests: { nodes: GqlReviewRequest[] };
  headCommit: { nodes: GqlHeadCommit[] };
  commits: { nodes: GqlCommitNode[] };
  reviews: { nodes: GqlReview[] };
  reviewThreads: { nodes: GqlReviewThread[] };
  comments: { nodes: GqlPrComment[] };
}

export interface RepoActivityResponse {
  repository: {
    id: string;
    nameWithOwner: string;
    // GraphQL RepositoryPermission enum (ADMIN/MAINTAIN/WRITE/TRIAGE/READ); may be
    // null. Drives whether the viewer may approve a PR.
    viewerPermission: string | null;
    defaultBranchRef: { name: string } | null;
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GqlPullRequest[];
    };
  } | null;
  rateLimit: {
    remaining: number;
    resetAt: string;
    cost: number;
  };
}

export interface RepoIdResponse {
  repository: {
    id: string;
    name: string;
    owner: { login: string };
  } | null;
}

// Response shape for PR_DETAIL_QUERY (on-demand text hydration). Node ids
// (`id`/`fullDatabaseId`) and commit `oid` are the keys hydration matches on.
export interface PrDetailResponse {
  repository: {
    pullRequest: {
      id: string;
      number: number;
      body: string | null;
      additions: number;
      deletions: number;
      changedFiles: number;
      files: { nodes: GqlPrFile[] };
      headCommit: { nodes: GqlHeadCommit[] };
      reviews: {
        nodes: Array<{ id: string; fullDatabaseId: string | null; body: string | null }>;
      };
      reviewThreads: {
        nodes: Array<{
          id: string;
          comments: {
            nodes: Array<{
              id: string;
              fullDatabaseId: string | null;
              body: string;
              diffHunk: string | null;
            }>;
          };
        }>;
      };
      comments: {
        nodes: Array<{ id: string; fullDatabaseId: string | null; body: string }>;
      };
      commits: { nodes: Array<{ commit: { oid: string; message: string } }> };
    } | null;
  } | null;
  rateLimit: { remaining: number; resetAt: string; cost: number };
}

export interface GqlSearchRepo {
  id: string;
  name: string;
  nameWithOwner: string;
  description: string | null;
  url: string;
  isPrivate: boolean;
  stargazerCount: number;
  owner: { login: string; avatarUrl: string | null };
  pullRequests: { totalCount: number };
}

export interface RepoSearchGqlResponse {
  search: {
    repositoryCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    // type: REPOSITORY → each node is a Repository, BUT GitHub returns a NULL node for any
    // search hit the current token can't fully resolve — common with a scoped GitHub-App
    // user token in cloud; a broad local `gh` PAT sees them all — and {} for a (theoretical)
    // non-repo node. Both are null-safe-dropped in the route before any field is read.
    nodes: Array<GqlSearchRepo | null>;
  };
  viewer: {
    login: string;
    // Org nodes can likewise come back null under a scoped token (missing read:org).
    organizations: { nodes: Array<{ login: string } | null> };
  };
  rateLimit: { remaining: number; resetAt: string; cost: number };
}

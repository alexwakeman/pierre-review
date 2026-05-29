// One query per repo per sync: PRs, reviews, review threads (+comments),
// general PR comments, and commits in a single round trip.
export const REPO_ACTIVITY_QUERY = /* GraphQL */ `
  query RepoActivity($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      id
      nameWithOwner
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
          title
          body
          isDraft
          state
          createdAt
          mergedAt
          closedAt
          updatedAt
          url
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
                }
              }
            }
          }
          commits(last: 100) {
            nodes {
              commit {
                oid
                committedDate
                message
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
                  body
                  createdAt
                  diffHunk
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
              body
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
  state: string;
  body: string | null;
  submittedAt: string | null;
  author: GqlActor | null;
}

export interface GqlReviewComment {
  id: string;
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

export interface GqlHeadCommit {
  commit: {
    oid: string;
    statusCheckRollup: { state: string } | null;
  };
}

export interface GqlPullRequest {
  id: string;
  number: number;
  title: string;
  body: string | null;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  url: string;
  mergeable: string | null;
  mergeStateStatus: string | null;
  author: GqlActor | null;
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

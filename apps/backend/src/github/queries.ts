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

// The full PR-node field selection, shared by the per-repo walk (REPO_ACTIVITY_QUERY)
// and the single-PR targeted fetch (PR_ACTIVITY_ONE_QUERY) so their result shape can
// NEVER drift — both feed the same persistPr(pr: GqlPullRequest, …) unchanged. Edit the
// fields here once and both queries stay in lockstep. The lean-gating interpolations
// (prBodyField, …) apply identically to both.
const PR_NODE_FIELDS = /* GraphQL */ `
  id
  number
  title${prBodyField}
  bodyText
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
  # ---- merge verdict (cluster A: the merge surface) ------------------------------------
  # GitHub's OVERALL review decision (APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / null).
  # A BLOCKED mergeStateStatus says branch protection is unmet but never WHY; this names the
  # review half of it, which is what lets the merge verdict render "review required" instead
  # of a shrug. A cheap scalar on a node already being fetched — no extra request.
  #
  # Merge-QUEUE state (isMergeQueueEnabled / isInMergeQueue / mergeQueueEntry) is deliberately
  # NOT here: it is volatile (a position changes minute to minute) and only ever rendered by
  # the merge control, so it is fetched live in GET /api/prs/:id/merge-options instead of
  # riding this per-page fat query. See fetchMergeQueueState in github/mutations.ts.
  reviewDecision
  # ---- end merge verdict ---------------------------------------------------------------
  author {
    login
    __typename
    ... on User {
      id
      name
      avatarUrl
    }
    ... on Bot {
      id
    }
  }
  mergedBy {
    login
    __typename
    ... on User {
      id
      name
      avatarUrl
    }
    ... on Bot {
      id
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
  # Earliest review-request timestamp — timeline items are chronological, so first:1 is the first
  # request (tiny payload: ≤1 node/PR). Fills the "review pickup time" (request→first review) gap.
  firstReviewRequest: timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], first: 1) {
    nodes {
      ... on ReviewRequestedEvent {
        createdAt
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
        __typename
        ... on User {
          id
          name
          avatarUrl
        }
        ... on Bot {
          id
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
      resolvedBy {
        login
      }
      comments(first: 50) {
        nodes {
          id
          fullDatabaseId
          body
          createdAt${reviewCommentDiffHunkField}
          author {
            login
            __typename
            ... on User {
              id
              name
              avatarUrl
            }
            ... on Bot {
              id
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
        __typename
        ... on User {
          id
          name
          avatarUrl
        }
        ... on Bot {
          id
        }
      }
    }
  }
`;

// One query per repo per sync: PRs, reviews, review threads (+comments),
// general PR comments, and commits in a single round trip.
export const REPO_ACTIVITY_QUERY = /* GraphQL */ `
  query RepoActivity($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      id
      nameWithOwner
      description
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
          ${PR_NODE_FIELDS}
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

// Single-PR targeted fetch (Phase 0 real-time sync — see docs/REALTIME-SYNC.md). Selects
// the SAME node fields as REPO_ACTIVITY_QUERY (via PR_NODE_FIELDS), fetched BY NUMBER
// instead of walked, so the result feeds persistPr unchanged. Costs ~1 point vs a
// multi-page walk. Fed by webhooks (cloud) / the adaptive scheduler (local).
export const PR_ACTIVITY_ONE_QUERY = /* GraphQL */ `
  query PrActivityOne($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${PR_NODE_FIELDS}
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

// The viewer's own recently-active repositories, for first-run onboarding ("watch the
// repos you're working on"). Two complementary lists are folded into one round trip:
// `repositories` (owned / collaborator / org-member repos the viewer can push to) and
// `repositoriesContributedTo` (repos the viewer has committed / opened PRs / reviewed on
// but may not own) — both ordered most-recently-pushed first. The route merges + dedupes
// them by node id. Same repo fields as REPO_SEARCH_QUERY plus `pushedAt` (drives the merge
// tie-break + final ordering). `viewer` + orgs mirror the search query so the route can
// mark owned/member repos. No GraphQL variables → no `query`-reserved-name concern. Local's
// broad `gh` token sees private + org repos; a scoped cloud token sees only what it can read.
export const VIEWER_REPOS_QUERY = /* GraphQL */ `
  query ViewerRepos {
    viewer {
      login
      organizations(first: 100) {
        nodes {
          login
        }
      }
      repositories(
        first: 30
        orderBy: { field: PUSHED_AT, direction: DESC }
        affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      ) {
        nodes {
          ...ViewerRepoFields
        }
      }
      repositoriesContributedTo(
        first: 30
        includeUserRepositories: true
        orderBy: { field: PUSHED_AT, direction: DESC }
        contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW]
      ) {
        nodes {
          ...ViewerRepoFields
        }
      }
    }
    rateLimit {
      cost
      remaining
    }
  }

  fragment ViewerRepoFields on Repository {
    id
    name
    nameWithOwner
    description
    url
    isPrivate
    stargazerCount
    pushedAt
    owner {
      login
      avatarUrl
    }
    pullRequests(states: OPEN) {
      totalCount
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
  id?: string; // present only for User/Bot (via inline fragment)
  name?: string | null;
  avatarUrl?: string | null;
  // GraphQL __typename ('User' | 'Bot' | 'Organization' | 'Mannequin' | …) — captured
  // for the bot-triage classifier (stored on users.githubType). Absent when the actor
  // was synthesized locally (commit authors / review requests pass {login,id} only).
  __typename?: string;
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
  resolvedBy: { login: string } | null;
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
  // Plain-text rendering of the PR description, fetched UNCONDITIONALLY (unlike the lean-gated
  // markdown `body`) so the cross-team search index can cover descriptions without persisting the
  // full markdown. Not stored on pullRequests — flows only into search_index via persistPr.
  bodyText: string | null;
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
  // GraphQL PullRequestReviewDecision (APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED) or
  // null when the repo requires no review. OPTIONAL on the interface so hand-built fixtures
  // predating the field still typecheck.
  reviewDecision?: string | null;
  author: GqlActor | null;
  mergedBy: GqlActor | null;
  labels: { nodes: GqlLabel[] };
  reviewRequests: { nodes: GqlReviewRequest[] };
  // Earliest ReviewRequestedEvent (first:1) — for firstReviewRequestedAt / review-pickup latency.
  // Optional: absent on hand-built test fixtures predating the field.
  firstReviewRequest?: { nodes: Array<{ createdAt?: string | null }> };
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
    // The repo's GitHub "About" description. OPTIONAL on purpose — the three-state
    // partial-response policy (see sync/branch-status.ts): absent (`undefined`) means the
    // selection was never received (hand-built fixtures, a salvaged partial without the key)
    // and the stored value must be PRESERVED; `null` means GitHub positively said the repo
    // has none and CLEARS it; a string overwrites. Threaded through upsertRepo as-is.
    description?: string | null;
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

// Response shape for PR_ACTIVITY_ONE_QUERY. `pullRequest` reuses GqlPullRequest (the
// SAME node type REPO_ACTIVITY_QUERY yields), so a targeted fetch feeds persistPr
// unchanged. Null when the PR is missing / inaccessible (deleted, wrong number, lost
// access), or `repository` null on a SAML wall / NOT_FOUND salvaged by graphqlTolerant.
export interface PrActivityOneResponse {
  repository: {
    pullRequest: GqlPullRequest | null;
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

// A repo node from VIEWER_REPOS_QUERY — the search-repo shape plus `pushedAt`, used by the
// route to dedupe the two node lists (keeping the max pushedAt) and order the result by recency.
export interface GqlViewerRepo extends GqlSearchRepo {
  pushedAt: string | null;
}

export interface ViewerReposGqlResponse {
  viewer: {
    login: string;
    // Org nodes can come back null under a scoped token (missing read:org) — mirror the
    // tolerance in RepoSearchGqlResponse.
    organizations: { nodes: Array<{ login: string } | null> };
    // Each `nodes` array can itself be null, and individual nodes can be null under a scoped
    // GitHub-App token (cloud); a broad local `gh` PAT sees them all. The route null-drops the
    // array and every node before reading any field.
    repositories: { nodes: Array<GqlViewerRepo | null> | null };
    repositoriesContributedTo: { nodes: Array<GqlViewerRepo | null> | null };
  };
  rateLimit: { cost: number; remaining: number };
}

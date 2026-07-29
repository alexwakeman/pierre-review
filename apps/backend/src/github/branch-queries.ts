// Default-branch ("is trunk green?") GraphQL.
//
// Deliberately its OWN file rather than an addition to `github/queries.ts`: that module is the
// PR-shaped activity walk (one fat query, lean-gated field interpolation, shared PR node
// fields), and this query shares none of it. Keeping them apart means a change to the trunk
// snapshot can never perturb the backfill's page shape.
//
// Cost: ~1 rate-limit point per repo per sync — the whole point of asking for the commit
// history AND its per-commit rollup in a single round trip.
//
// Nullability, verified field-by-field against GitHub's published SDL (every one of these is a
// real runtime case, not defensive noise):
//   • `Repository.defaultBranchRef` is nullable — an empty repo has no default branch.
//   • `Ref.target` is nullable AND an interface (`GitObject`), so the `... on Commit` inline
//     fragment is MANDATORY; a branch pointing at a tag object yields `{}` here.
//   • `Commit.statusCheckRollup` is nullable — a commit no CI ever ran on. It IS defined on
//     Commit directly (not only reachable via a PR).
//   • `Commit.author` is a nullable `GitActor`, and its `user` is null whenever the commit's
//     email maps to no GitHub account (the classic "committed from a laptop with a personal
//     email" case) — so `author.name` is the only identity such a commit carries.

// `StatusState` (SUCCESS | FAILURE | PENDING | ERROR | EXPECTED) is exactly the enum the
// existing PR rollup mapper already switches on, so the persist layer reuses that mapping
// rather than inventing a second vocabulary.
export const DEFAULT_BRANCH_QUERY = /* GraphQL */ `
  query DefaultBranchStatus($owner: String!, $name: String!, $first: Int!) {
    rateLimit {
      cost
      remaining
    }
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        name
        target {
          ... on Commit {
            oid
            statusCheckRollup {
              state
            }
            history(first: $first) {
              nodes {
                oid
                messageHeadline
                committedDate
                statusCheckRollup {
                  state
                }
                author {
                  name
                  avatarUrl
                  user {
                    login
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

export interface GqlBranchCommit {
  oid: string;
  messageHeadline: string;
  committedDate: string;
  statusCheckRollup?: { state?: string | null } | null;
  author?: {
    name?: string | null;
    avatarUrl?: string | null;
    user?: { login: string } | null;
  } | null;
}

// `target` is typed as the inline-fragment shape with EVERY field optional: a non-Commit
// target selects nothing, so the object arrives as `{}`.
export interface DefaultBranchResponse {
  rateLimit?: { cost: number; remaining: number } | null;
  repository: {
    defaultBranchRef?: {
      name: string;
      target?: {
        oid?: string;
        statusCheckRollup?: { state?: string | null } | null;
        history?: { nodes: (GqlBranchCommit | null)[] } | null;
      } | null;
    } | null;
  } | null;
}

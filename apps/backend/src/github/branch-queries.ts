// Default-branch ("is trunk green?") GraphQL.
//
// Deliberately its OWN file rather than an addition to `github/queries.ts`: that module is the
// PR-shaped activity walk (one fat query, lean-gated field interpolation, shared PR node
// fields), and this query shares none of it. Keeping them apart means a change to the trunk
// snapshot can never perturb the backfill's page shape.
//
// Cost: ~4 rate-limit points per repo per sync at the 100-commit window — still the whole point
// of asking for the commit history AND its per-commit rollup in a single round trip.
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
//   • `Commit.associatedPullRequests` is a NON-NULL connection in the SDL, and so are its
//     nodes' `number` / `merged` / `baseRefName` / `repository`. They are nonetheless typed
//     optional below for one specific reason: `graphqlTolerant` (github/client.ts) hands back
//     `err.data` on a PARTIAL GraphQL error, where forbidden fields arrive NULLED regardless of
//     their declared nullability. Everything a partial response can null must be optional here,
//     or the mapper would trust a field TypeScript merely believes is present. The connection's
//     `nodes` elements are `[PullRequest]` — genuinely nullable even on a clean response.
//
// COST, and why this file is structured in two phases:
// GitHub scores a GraphQL call from the nodes its connection arguments request (multiply nested
// first/last down each path, sum, then ceil(total/100), min 1). Phase 1 below asks for
// history(first: 100) × associatedPullRequests(first: 3) = 100 + 300 = 400 nodes ⇒ FOUR points,
// which is what the "~4 points per repo per sync" promise above means (the widening from 20 to
// 100 — 80 nodes, one point — is an accepted cost; it feeds the branch-trends charts). Nesting
// `statusCheckRollup.contexts(first: 100)` under that history would be 100 + 100×100 = 10100
// nodes ⇒ ~102 points on EVERY walk of EVERY repo, green or red, on a call adaptive polling
// re-fires every 120s for a hot repo. So the failing-check DETAIL is a SECOND query
// (`buildCommitChecksQuery`) issued only for the commits whose rollup phase 1 already reported
// as failure/error/pending. A green trunk therefore costs exactly the phase-1 walk.

import type { GqlCheckContext } from './queries.js';

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
                # The PR this commit landed from. first:3 rather than 1 because the connection
                # has NO documented ordering, so first:1 would be a non-deterministic pick that
                # could FLIP between syncs; and rather than 10 because 3 keeps the node budget
                # described above at N + 3N (4 points at the 100-commit window, vs 11 for
                # first:10). merged + baseRefName are the
                # ranking inputs (see pickAssociatedPrNumber in sync/branch-status.ts);
                # repository.nameWithOwner exists because this connection spans the repo NETWORK,
                # so a fork's own PR can appear and its number would resolve against the WRONG
                # repo at read time.
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
            }
          }
        }
      }
    }
  }
`;

// One entry of a commit's `associatedPullRequests`. Every field optional for the partial-response
// reason in the header comment, not because the SDL says so.
export interface GqlAssociatedPr {
  number?: number | null;
  merged?: boolean | null;
  baseRefName?: string | null;
  repository?: { nameWithOwner?: string | null } | null;
}

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
  // Absent/null means "we did not RECEIVE this selection" (a partial error nulled it), which the
  // persist layer treats differently from a present-but-empty `nodes` array — the latter is
  // GitHub positively saying "this commit came from no PR". See sync/branch-status.ts.
  associatedPullRequests?: { nodes?: (GqlAssociatedPr | null)[] | null } | null;
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

// ---- Phase 2: per-commit failing-check DETAIL --------------------------------------------
//
// The contexts union is DELIBERATELY SHARED with the PR activity walk rather than restated
// here. `statusCheckRollup.contexts` is the same GitHub field on both surfaces, and
// sync/upsert.ts's `checkContextState` (the CheckRun status/conclusion → CheckRunState table)
// is typed against `GqlCheckContext` — a second local copy of the union would have to be kept
// in lockstep with that mapper by hand, and "a failing check on trunk" would be free to drift
// into meaning something different from "a failing check on a PR". This is a TYPE-ONLY import:
// the two query modules stay separate at runtime, and nothing in queries.ts changes (the PR
// walk does not select `checkSuite`, so widening its type would widen something it never reads).
//
// `checkSuite.workflowRun.workflow.name` is the one field only this query asks for: the workflow
// a CheckRun belongs to ("CI", "Release"), which is how a human names the failure. It is
// optional all the way down and NOTHING may require it to render — `workflowRun` is genuinely
// null for a non-Actions check suite, and a partial error can null the rest.
export type GqlBranchCheckContext =
  | (Extract<GqlCheckContext, { __typename: 'CheckRun' }> & {
      checkSuite?: {
        workflowRun?: { workflow?: { name?: string | null } | null } | null;
      } | null;
    })
  | Extract<GqlCheckContext, { __typename: 'StatusContext' }>;

// The failure-detail selection. `contexts` is a UNION (CheckRun | StatusContext), so both inline
// fragments are MANDATORY and `__typename` is what the mapper switches on — byte-identical to
// the PR walk's headCommit selection plus the workflow name.
//
// `first: 100` deliberately matches the PR walk. Do NOT lower it: `contexts` has no documented
// ordering that puts failures first, so a smaller page can return 100 green contexts on a commit
// whose rollup says FAILURE — i.e. an empty failures array on a red commit, a caret with nothing
// behind it. checkSuite/workflowRun/workflow are plain OBJECTS, not connections, so they add zero
// nodes and therefore zero rate-limit cost.
const COMMIT_CHECKS_SELECTION = /* GraphQL */ `
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
          checkSuite {
            workflowRun {
              workflow {
                name
              }
            }
          }
        }
        ... on StatusContext {
          context
          state
          targetUrl
        }
      }
    }
  }
`;

// How many commits one phase-2 call will ask about. Most commits anyone ever expands are the
// newest few, and capping the alias count caps the worst case (a 100-commit all-red window) at
// ~10 points instead of ~100 — the pathological case is precisely the one where you don't need
// 100 carets to know trunk is broken.
export const COMMIT_CHECKS_ALIAS_CAP = 10;

/**
 * One query with `count` aliased `repository.object(oid:)` lookups, each selecting that commit's
 * check contexts.
 *
 * The shas ride as GraphQL VARIABLES (`$s0`…`$sN` of type `GitObjectID!`), never interpolated
 * into the query text: the only generated part is the alias names, and those are INDEX-derived
 * (`c0`, `c1`, …), never data-derived. Cost is `count` nodes for the objects plus 100 contexts
 * each ⇒ ceil((count × 101)/100) ≈ `count` points, which is why the caller only ever passes the
 * commits phase 1 already reported as non-green.
 */
export function buildCommitChecksQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$s${i}: GitObjectID!`).join(', ');
  const aliases = Array.from(
    { length: count },
    (_, i) => `      c${i}: object(oid: $s${i}) { ... on Commit { ${COMMIT_CHECKS_SELECTION} } }`,
  ).join('\n');
  return `query CommitChecks($owner: String!, $name: String!, ${vars}) {
    rateLimit {
      cost
      remaining
    }
    repository(owner: $owner, name: $name) {
${aliases}
    }
  }`;
}

export interface GqlCommitChecks {
  oid?: string;
  statusCheckRollup?: {
    state?: string | null;
    // Null here is the load-bearing distinction: it means the contexts selection was NOT
    // received (a token that can read the rollup state but not the individual checks), which is
    // NOT the same as a received-but-empty list. The persist layer must not treat the two alike.
    contexts?: { nodes?: (GqlBranchCheckContext | null)[] | null } | null;
  } | null;
}

export interface CommitChecksResponse {
  rateLimit?: { cost: number; remaining: number } | null;
  // Keyed `c0`…`c<n-1>`. `object` returns the GitObject INTERFACE, so a non-Commit target selects
  // nothing and arrives as `{}`; a sha GitHub can't resolve arrives as null. Under
  // noUncheckedIndexedAccess an index into this Record is `| undefined`, which the reader handles.
  repository?: Record<string, GqlCommitChecks | null> | null;
}

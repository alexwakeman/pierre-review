// THE CHECKS ON ONE COMMIT, LIVE (CORE) — what Claude Review reads to see whether the reviewed head
// is failing CI (review/claude-review/ci-failures.ts).
//
// ⚠ BY COMMIT OID, NOT "THE PR'S LATEST COMMIT". A review runs against the head it was queued at;
// the PR may have moved on while it waited, and the checks of a newer commit say nothing about the
// code under review. Lean storage keeps no per-check JSON, so this is one small GraphQL read at
// review time (1 point) — the same `contexts(first:100)` selection PR detail uses, mapped through
// the ONE `checkRunsFrom` (sync/upsert.ts), so "failing" means here exactly what it means on the
// Checks tab.
//
// Plus ONE REST read per failing GitHub Actions job (`fetchActionsJobFailedStep`): the job's own
// step list, for the step that failed. Both NEVER THROW — a failure costs the review its CI section,
// never the review. A rate-limited answer is fed to the account's budget (the compare.ts rule), and
// while that account is KNOWN to be limited (`isLimited`) neither asks at all: the review stores its
// CI as not checked rather than spend a request GitHub will refuse.
import type { CheckRun } from '@pierre-review/shared';
import { checkRunsFrom } from '../sync/upsert.js';
import type { GqlCheckContext } from './queries.js';
import { getGraphqlClientFor, ghRestGetFor, graphqlTolerant, isRateLimitError } from './client.js';
import { isLimited, noteLimited } from './rate-budget.js';

const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

export const COMMIT_CHECKS_QUERY = /* GraphQL */ `
  query CommitChecks($owner: String!, $name: String!, $oid: GitObjectID!) {
    repository(owner: $owner, name: $name) {
      object(oid: $oid) {
        __typename
        ... on Commit {
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
  }
`;

interface CommitChecksResponse {
  repository: {
    object: {
      __typename?: string;
      oid?: string;
      statusCheckRollup?: {
        state?: string | null;
        contexts?: { nodes?: Array<GqlCheckContext | null> | null } | null;
      } | null;
    } | null;
  } | null;
}

export type CommitChecksRead =
  | {
      ok: true;
      // GitHub's rollup state (SUCCESS / FAILURE / ERROR / PENDING / EXPECTED), null when the commit
      // carries no checks at all.
      rollupState: string | null;
      checks: CheckRun[];
    }
  | { ok: false; reason: 'bad_sha' | 'not_found' | 'no_check_access' | 'rate_limited' | 'error' };

/** The checks on one commit. Never throws. */
export async function fetchCommitChecks(
  token: string,
  args: { owner: string; name: string; sha: string; accountId?: number },
): Promise<CommitChecksRead> {
  if (!SHA_RE.test(args.sha)) return { ok: false, reason: 'bad_sha' };
  if (args.accountId != null && isLimited(args.accountId)) return { ok: false, reason: 'rate_limited' };
  try {
    let partial = false;
    const data = await graphqlTolerant<CommitChecksResponse>(
      getGraphqlClientFor(token),
      COMMIT_CHECKS_QUERY,
      { owner: args.owner, name: args.name, oid: args.sha },
      () => {
        partial = true;
      },
    );
    const obj = data?.repository?.object ?? null;
    if (!obj || obj.__typename !== 'Commit') return { ok: false, reason: 'not_found' };
    const rollup = obj.statusCheckRollup ?? null;
    // ⚠ A PARTIAL answer is not "no checks": a token that cannot read checks (a GitHub App without
    // checks:read) gets the rollup NULLED with an error beside it. Only a clean null means none.
    if (rollup == null) return partial ? { ok: false, reason: 'no_check_access' } : { ok: true, rollupState: null, checks: [] };
    if (rollup.contexts == null && partial) return { ok: false, reason: 'no_check_access' };
    const nodes = (rollup.contexts?.nodes ?? []).filter((n): n is GqlCheckContext => n != null);
    const checks = checkRunsFrom({
      oid: obj.oid ?? args.sha,
      statusCheckRollup: { state: rollup.state ?? '', contexts: { nodes } },
    });
    return { ok: true, rollupState: rollup.state ?? null, checks };
  } catch (err) {
    const rl = isRateLimitError(err);
    if (rl.limited) {
      if (args.accountId != null) noteLimited(args.accountId, rl.resumeAt);
      return { ok: false, reason: 'rate_limited' };
    }
    return { ok: false, reason: 'error' };
  }
}

interface RestJob {
  steps?: Array<{ name?: unknown; conclusion?: unknown; number?: unknown }> | null;
}

/**
 * The name of the FIRST failed step of a GitHub Actions job, from GitHub's own step list
 * (`GET /repos/{o}/{r}/actions/jobs/{id}`). null when none failed by GitHub's record, or on any
 * error. Never throws.
 */
export async function fetchActionsJobFailedStep(
  token: string,
  args: { owner: string; name: string; jobId: number; accountId?: number },
): Promise<string | null> {
  if (!Number.isSafeInteger(args.jobId) || args.jobId <= 0) return null;
  if (args.accountId != null && isLimited(args.accountId)) return null;
  try {
    const job = await ghRestGetFor<RestJob>(
      token,
      `/repos/${args.owner}/${args.name}/actions/jobs/${args.jobId}`,
    );
    return failedStepName(job);
  } catch (err) {
    const rl = isRateLimitError(err);
    if (rl.limited && args.accountId != null) noteLimited(args.accountId, rl.resumeAt);
    return null;
  }
}

const FAILED_STEP = new Set(['failure', 'timed_out', 'startup_failure']);

/** Pure: the first failed step of a REST job payload (by step number). Exported for tests. */
export function failedStepName(job: RestJob | null | undefined): string | null {
  const steps = Array.isArray(job?.steps) ? job!.steps! : [];
  const failed = steps
    .filter((s) => typeof s?.conclusion === 'string' && FAILED_STEP.has(s.conclusion))
    .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  const name = failed[0]?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

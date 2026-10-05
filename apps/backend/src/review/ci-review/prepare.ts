import type { CiReviewItem, CiReviewRefusal, ClaudeCiFailure, ClaudeReviewCiState } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import {
  isFailingCheck,
  planCiReview,
  selectCiFailures,
  type CiLogRead,
  type CiPlan,
} from '../claude-review/ci-failures.js';

// THE CI REVIEW'S INPUTS — read LIVE, server-side, before any model runs:
//
//   checks   the head commit's checks (`ctx.ci.readCommitChecks`, one GraphQL read). The failing
//            set the run judges is THIS read's, never the synced one (which may lag).
//   logs     for each FAILING GitHub Actions job not already explained at this head, ONE tail
//            window of its log (`ctx.ci.readJobLog` — CI_LOG_WINDOW_BYTES, a ranged read) and
//            GitHub's failed-step record, at most CI_FAILURES_MAX jobs, in parallel. ⚠ The signed
//            log URL never leaves github/actions-logs.ts: only the text comes back, and only the
//            check's details page is ever stored.
//
// The selection, excerpting and budget are claude-review/ci-failures.ts's (one implementation, the
// one the PR review used before this process existed). Refusals — nothing failing, no Actions log
// at all, no log readable, checks unreadable — are decided HERE and stored; no model runs for them.
//
// CARRY (automatic runs only). An item already explained AT THIS HEAD for the SAME job by the
// previous succeeded run is copied, not re-read: a set that grew by one check costs one log read
// and one diagnosis. A click ("Re-check") carries nothing — the person asked for a fresh look.

export type CiInputs =
  | {
      ok: true;
      plan: CiPlan;
      failingChecks: string[];
      ciState: ClaudeReviewCiState;
      // Extra fields of carried items (path / line / suggestion), by check + job.
      carriedExtras: Map<string, Pick<CiReviewItem, 'path' | 'line' | 'suggestion'>>;
    }
  | {
      ok: false;
      reason: CiReviewRefusal;
      failingChecks: string[] | null;
      ciState: ClaudeReviewCiState | null;
    };

export const carryKey = (checkName: string, jobId: number | null): string => `${checkName}\u0000${jobId ?? ''}`;

/**
 * Read the head's checks and the failing jobs' logs, and decide what the run sends. Never throws for
 * an expected failure (it refuses instead).
 */
export async function readCiInputs(
  ctx: AgentContext,
  a: {
    accountId: number;
    prId: number;
    owner: string;
    name: string;
    headSha: string;
    // The previous succeeded run's items AT THIS HEAD (automatic runs); null ⇒ carry nothing.
    prior: readonly CiReviewItem[] | null;
  },
): Promise<CiInputs> {
  const ci = ctx.ci;
  if (!ci) return { ok: false, reason: 'checks_unreadable', failingChecks: null, ciState: null };
  const checks = await ci.readCommitChecks(a.accountId, { owner: a.owner, name: a.name, sha: a.headSha });
  if (!checks.ok) {
    ctx.log.warn(`ci review pr ${a.prId}: checks not read (${checks.reason})`);
    return { ok: false, reason: 'checks_unreadable', failingChecks: null, ciState: null };
  }
  const failing = checks.checks.filter(isFailingCheck);
  const failingChecks = [...new Set(failing.map((c) => c.name))];
  const prior: ClaudeCiFailure[] | null = a.prior ? a.prior.map((i) => ({ ...i })) : null;
  const sel = selectCiFailures(checks.checks, checks.rollupState, a.headSha, prior);
  const ciState: ClaudeReviewCiState = { state: sel.state, checkCount: sel.checkCount };
  if (failing.length === 0) return { ok: false, reason: 'no_failures', failingChecks: [], ciState };
  // Every failing check is outside GitHub Actions (and nothing is carried): there is no log to read.
  if (sel.toRead.length === 0 && sel.overCap.length === 0 && sel.carried.length === 0) {
    return { ok: false, reason: 'no_logs', failingChecks, ciState };
  }
  const reads: CiLogRead[] = await Promise.all(
    sel.toRead.map(async (check): Promise<CiLogRead> => {
      const jobId = check.jobId as number;
      const [log, step] = await Promise.all([
        ci.readJobLog(a.accountId, { owner: a.owner, name: a.name, jobId }).catch(() => null),
        ci.readFailedStep(a.accountId, { owner: a.owner, name: a.name, jobId }).catch(() => null),
      ]);
      return {
        check,
        step,
        log: log?.available ? { text: log.text, windowTruncated: (log.startByte ?? 0) > 0 } : null,
      };
    }),
  );
  const plan = planCiReview(sel, reads);
  if (plan.sent.length === 0 && plan.carried.length === 0) {
    return { ok: false, reason: 'logs_unavailable', failingChecks, ciState };
  }
  const carriedExtras = new Map<string, Pick<CiReviewItem, 'path' | 'line' | 'suggestion'>>();
  for (const p of a.prior ?? []) {
    carriedExtras.set(carryKey(p.checkName, p.jobId), { path: p.path, line: p.line, suggestion: p.suggestion });
  }
  return { ok: true, plan, failingChecks, ciState, carriedExtras };
}

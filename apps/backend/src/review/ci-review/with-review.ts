import type { AgentContext } from '../agent-context.js';
import { ciReviewDue } from './currency.js';
import { defaultWorkspaceId, getCiPrContext, getCiStateInputs, readSyncedCi } from './persist.js';
import { ciReviewHeld, startCiReview, type StartCiArgs, type StartCiResult } from './manager.js';

// A MANUAL CLAUDE REVIEW ALSO EXPLAINS FAILING CI (docs/CLAUDE-REVIEW.md § CI review, "Beside a
// manual review"). The PR review itself still reads no logs: this starts the CI review — its own
// process, through its own door (`startCiReview`), its own claim, lane and shared slot — when a
// person starts a PR review and the CI review has not already taken this head's failing set.
//
//   DUE exactly as the sweeper's rule (`ciReviewDue`): the SYNCED rollup is red, the newest
//   `ci_status_events` row at the PR's current head names the failing set, nothing is in flight,
//   and no run (succeeded, refused, answered-failed, cancelled) took exactly that (head, set).
//   ⚠ No Actions log is the run's OWN refusal (`no_logs`, stored, no model) — a cheap live read
//   whose stored keys stop the next click asking again. A click, so trigger `manual`: it goes ahead
//   of automatic CI items and never counts against `CI_REVIEW_DAILY_CAP`. Auto runs never come here
//   (the CI sweeper already covers auto-review workspaces).

export interface CiBesideReviewDeps {
  start(ctx: AgentContext, a: StartCiArgs): Promise<StartCiResult>;
  held(accountId: number, prId: number): boolean;
}

const defaultDeps: CiBesideReviewDeps = { start: startCiReview, held: ciReviewHeld };

export type CiBesideReviewOutcome = StartCiResult['outcome'] | 'not_due';

/** Start the CI review beside a manual PR review when it is due. Never throws. */
export async function startCiReviewBesideManualReview(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  deps: CiBesideReviewDeps = defaultDeps,
): Promise<CiBesideReviewOutcome> {
  try {
    if (deps.held(accountId, prId)) return 'already_running';
    const pr = await getCiPrContext(ctx, accountId, prId);
    if (!pr?.headSha || pr.state !== 'open') return 'not_due';
    const [synced, inputs] = await Promise.all([
      readSyncedCi(ctx, accountId, [prId]),
      getCiStateInputs(ctx, accountId, [prId]),
    ]);
    const sc = synced.get(prId);
    if (!sc || sc.headSha !== pr.headSha || !ciReviewDue(inputs.get(prId), sc)) return 'not_due';
    const r = await deps.start(ctx, {
      accountId,
      workspaceId: pr.workspaceId ?? (await defaultWorkspaceId(ctx, accountId)) ?? 0,
      prId,
      repoId: pr.repoId,
      headSha: pr.headSha,
      // The synced set this run answers, so the next click (and the sweeper) see it as taken.
      triggerKey: sc.failingKey,
      trigger: 'manual',
    });
    return r.outcome;
  } catch (err) {
    ctx.log.warn(`ci review beside review pr ${prId}: ${err instanceof Error ? err.message : String(err)}`);
    return 'not_due';
  }
}

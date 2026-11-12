import type { FastifyBaseLogger } from 'fastify';
import type { ProEventHooks } from './contract.js';
import { automationAllowedForPr, automationAllowedForRepo } from '../db/external-repos.js';

// ── HOST → PLUGIN EVENT HOOKS (`ProContext.registerEventHooks`, optional, no apiVersion bump) ─────
//
// Core announces two committed facts to the platform's listeners (today: the Slack event
// signals, platform/slack/signals.ts):
//   • a Claude Review run SUCCEEDED   — review/claude-review/manager.ts, after the run is stored,
//     with its trigger (the Slack listener drops every 'manual' run);
//   • a PR was SEEN merging live      — sync/upsert.ts `persistPr`, AFTER its transaction commits.
//
// ⚠ FIRE-AND-FORGET, ALWAYS. Each emit returns void, never awaits the hook, and logs a failure: a
// Slack outage must never fail a review or a sync. The hooks receive ids only.

let hooks: ProEventHooks | null = null;
let log: Pick<FastifyBaseLogger, 'warn'> | null = null;

export function registerProEventHooks(
  next: ProEventHooks | null,
  logger?: Pick<FastifyBaseLogger, 'warn'>,
): void {
  hooks = next;
  if (logger) log = logger;
}

function fire(label: string, run: () => Promise<void> | void): void {
  void Promise.resolve()
    .then(run)
    .catch((err) => {
      log?.warn({ err }, `pro event hook ${label} failed`);
    });
}

// ⚠ EXTERNAL REPOS (db/external-repos.ts): neither fact is announced for an external repo's PR —
// the Slack signals are automatic posts. Asked here, in core, so the platform needs no new host
// dependency; the check runs inside the fire-and-forget, so an emit still never awaits.
export function emitClaudeReviewCompleted(e: {
  accountId: number;
  prId: number;
  reviewId: number;
  trigger: 'manual' | 'auto';
}): void {
  const h = hooks?.onClaudeReviewCompleted;
  if (h == null) return;
  fire('onClaudeReviewCompleted', async () => {
    if (!(await automationAllowedForPr(e.accountId, e.prId))) return;
    await h(e);
  });
}

export function emitPullRequestMerged(e: { accountId: number; repoId: number; prId: number }): void {
  const h = hooks?.onPullRequestMerged;
  if (h == null) return;
  fire('onPullRequestMerged', async () => {
    if (!(await automationAllowedForRepo(e.accountId, e.repoId))) return;
    await h(e);
  });
}

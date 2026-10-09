import type { FastifyBaseLogger } from 'fastify';
import type { ProEventHooks } from './contract.js';

// ── HOST → PLUGIN EVENT HOOKS (`ProContext.registerEventHooks`, optional, no apiVersion bump) ─────
//
// Core announces two committed facts to the Pro plugin, which owns everything done with them
// (today: the Slack event signals, packages/pro/src/slack/signals.ts):
//   • a Claude Review run SUCCEEDED   — review/claude-review/manager.ts, after the run is stored;
//   • a PR was SEEN merging live      — sync/upsert.ts `persistPr`, AFTER its transaction commits.
//
// ⚠ FIRE-AND-FORGET, ALWAYS. Each emit returns void, never awaits the hook, and logs a failure: a
// Slack outage must never fail a review or a sync. The hooks receive ids only.
// ⚠ Inert in OSS (no plugin, nothing registered) — every emit is then a no-op.

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

export function emitClaudeReviewCompleted(e: {
  accountId: number;
  prId: number;
  reviewId: number;
  trigger: 'manual' | 'auto';
}): void {
  const h = hooks?.onClaudeReviewCompleted;
  if (h == null) return;
  fire('onClaudeReviewCompleted', () => h(e));
}

export function emitPullRequestMerged(e: { accountId: number; repoId: number; prId: number }): void {
  const h = hooks?.onPullRequestMerged;
  if (h == null) return;
  fire('onPullRequestMerged', () => h(e));
}

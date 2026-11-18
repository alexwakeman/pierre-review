// CAN A BACKGROUND RUN START RIGHT NOW? — asked by the auto-review sweeper before it queues a PR and
// again by the manager before it writes the run's row.
//
// ⚠ AUTO REVIEW MUST WAIT, NOT FAIL, while AI is not set up. A PR with ANY `claude_reviews` row is
// never picked again (auto.ts: "one review per PR, ever"), so a run that writes its row and then
// dies on a missing runtime (`AiRuntimeMissingError`) or on no credential uses up that PR's one
// automatic review for good — and counts against the daily cap. Checking BEFORE the row exists
// leaves the PR qualifying, so the first tick after "Set up AI" (or a sign-in) reviews it.
// A click needs no such guard: the reader sees the failure and can press Review again.
import { activeRuntimeStatus, runtimeStatusFor } from '../../ai/active-runtime.js';
import { activeProviderId } from '../../ai/provider-setting.js';
import { preflightFor } from '../../ai/run-choice.js';
import { reviewDefaultProvider } from '../../ai/run-profile.js';
import type { AiAgentKind, AiProviderId } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

/**
 * `kind`: the agent the sweeper is about to start (the pre-flight answers per kind). `provider`: the
 * vendor the run will use (Settings → AI's run profiles, ai/run-profile.ts); absent ⇒ the ACTIVE
 * provider (ai/active-runtime.ts): a Codex machine never waits on Claude's download.
 */
export function agenticRunReady(ctx: Pick<AgentContext, 'llm'>, kind: AiAgentKind, provider?: AiProviderId): boolean {
  if (provider == null || provider === activeProviderId()) {
    if (activeRuntimeStatus().runtime !== 'ready') return false;
    return ctx.llm.detectAuth(kind).status === 'ok';
  }
  if (runtimeStatusFor(provider).runtime !== 'ready') return false;
  return preflightFor(ctx)(provider, kind).status === 'ok';
}

/**
 * The vendor a SINGLE-RUN review kind (CI review, story check, Check threads) runs on now: Settings →
 * AI → Review's "one vendor" (ai/run-profile.ts `reviewDefaultProvider`). Its gates — readiness, the
 * pre-flight, the budget and usage-limit gate — ask about THIS vendor, never the default provider.
 */
export function singleReviewProvider(ctx: Pick<AgentContext, 'llm'>): AiProviderId {
  return reviewDefaultProvider(preflightFor(ctx));
}

// CAN A BACKGROUND RUN START RIGHT NOW? — asked by the auto-review sweeper before it queues a PR and
// again by the manager before it writes the run's row.
//
// ⚠ AUTO REVIEW MUST WAIT, NOT FAIL, while AI is not set up. A PR with ANY `claude_reviews` row is
// never picked again (auto.ts: "one review per PR, ever"), so a run that writes its row and then
// dies on a missing runtime (`AiRuntimeMissingError`) or on no credential uses up that PR's one
// automatic review for good — and counts against the daily cap. Checking BEFORE the row exists
// leaves the PR qualifying, so the first tick after "Set up AI" (or a sign-in) reviews it.
// A click needs no such guard: the reader sees the failure and can press Review again.
import { getAiRuntimeStatus } from '../../ai/runtime.js';
import type { AgentContext } from '../agent-context.js';

export function agenticRunReady(ctx: Pick<AgentContext, 'llm'>): boolean {
  if (getAiRuntimeStatus().runtime !== 'ready') return false;
  return ctx.llm.detectAuth().status === 'ok';
}

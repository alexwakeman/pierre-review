import type { AgentContext } from './agent-context.js';

// THE ONE WAY AN AUTOMATIC AGENTIC RUN ASKS THE CLAUDE SPEND BUDGET (ai/budget.ts). False ⇒ skip
// this run, do not queue it: every caller is a sweep or a hook that re-derives what is due, so the
// work comes back by itself once the budget is under its limit again. A context without the gate (a
// test's fake) is always allowed. A gate that throws allows — the budget never wedges a sweep.
export async function automaticRunAllowed(
  ctx: Pick<AgentContext, 'aiBudget'>,
  accountId: number,
  what: string,
): Promise<boolean> {
  if (!ctx.aiBudget) return true;
  try {
    return await ctx.aiBudget.allowAutomaticRun(accountId, what);
  } catch {
    return true;
  }
}

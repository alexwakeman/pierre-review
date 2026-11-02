import type { AgentContext } from './agent-context.js';
import { activeProviderId } from '../ai/provider-setting.js';
import { anyUsageLockout, isLockedOut } from '../ai/usage-lockout.js';
import type { AiProviderId } from '@pierre-review/shared';

// THE ONE WAY AN AUTOMATIC AGENTIC RUN ASKS THE CLAUDE SPEND BUDGET (ai/budget.ts). False ⇒ skip
// this run, do not queue it: every caller is a sweep or a hook that re-derives what is due, so the
// work comes back by itself once the budget is under its limit again. A context without the gate (a
// test's fake) is always allowed. A gate that throws allows — the budget never wedges a sweep.
// ⚠ A PROVIDER LOCKED OUT BY ITS USAGE LIMIT (ai/usage-lockout.ts) is refused here too, the same
// way: skipped, not queued. `provider`: the provider the run will use (absent ⇒ the default; null ⇒
// the caller picks the provider later and asks the lock itself — the auto-review sweep, whose items
// move to the other provider when the default is locked out).
export async function automaticRunAllowed(
  ctx: Pick<AgentContext, 'aiBudget'>,
  accountId: number,
  what: string,
  provider?: AiProviderId | null,
): Promise<boolean> {
  if (provider !== null && anyUsageLockout() && isLockedOut(provider ?? activeProviderId())) return false;
  if (!ctx.aiBudget) return true;
  try {
    return await ctx.aiBudget.allowAutomaticRun(accountId, what);
  } catch {
    return true;
  }
}

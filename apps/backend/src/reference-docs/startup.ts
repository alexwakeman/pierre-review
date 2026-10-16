import type { AgentContext } from '../review/agent-context.js';
import { sweepDocsOnStartup } from './library.js';
import { reconcileInterruptedBuilds } from './store.js';

// BOOT (review/agentic.ts startAgenticBackground): a build that was running when the process died is
// marked failed (its last built version stays readable; Rebuild starts again), then the disk janitor
// removes every staging folder and anything no row accounts for (a deleted workspace's library).
export async function reconcileReferenceDocsOnStartup(ctx: Pick<AgentContext, 'log'>): Promise<void> {
  const failed = await reconcileInterruptedBuilds();
  if (failed.length > 0) ctx.log.info(`reconciled ${failed.length} interrupted reference doc build(s) -> failed`);
  const removed = await sweepDocsOnStartup();
  if (removed > 0) ctx.log.info(`removed ${removed} orphaned reference doc folder(s)`);
}

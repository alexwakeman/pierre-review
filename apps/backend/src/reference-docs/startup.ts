import type { AgentContext } from '../review/agent-context.js';
import { sweepDocsOnStartup } from './library.js';
import { reconcileInterruptedBuilds } from './store.js';

// BOOT (review/agentic.ts startAgenticBackground): a build that was running when the process died is
// marked failed (its last built version stays readable; Rebuild starts again), then this database's
// folders are moved out of the old shared docs root (once), then the disk janitor removes every
// staging folder and anything no row accounts for — in the folders THIS database owns only
// (owner.ts).
export async function reconcileReferenceDocsOnStartup(ctx: Pick<AgentContext, 'log'>): Promise<void> {
  const failed = await reconcileInterruptedBuilds();
  if (failed.length > 0) ctx.log.info(`reconciled ${failed.length} interrupted reference doc build(s) -> failed`);
  const r = await sweepDocsOnStartup();
  if (r.migration.moved.length > 0) {
    ctx.log.info(`moved ${r.migration.moved.length} reference doc workspace folder(s) out of the shared docs root`);
  }
  for (const l of r.migration.left) {
    ctx.log.warn(
      `reference docs ${l.key}: left in the shared docs root (${l.reason}${l.error ? `: ${l.error}` : ''})`,
    );
  }
  if (r.removed > 0) ctx.log.info(`removed ${r.removed} orphaned reference doc folder(s)`);
  if (r.leftUnowned.length > 0) {
    ctx.log.info(
      `reference docs: left ${r.leftUnowned.length} unmarked workspace folder(s) untouched (${r.leftUnowned.join(', ')})`,
    );
  }
}

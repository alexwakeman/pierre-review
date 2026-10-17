import { markSprintPathsQueued } from '../../db/sprint-paths.js';
import { setAfterSprintRead } from '../../tracker/sprint/hooks.js';
import type { AgentContext } from '../agent-context.js';
import { runSprintPathsPass } from '../sprint-paths/manager.js';
import { runSprintThemePass } from '../sprint-themes/manager.js';
import { runSprintBriefPass } from './manager.js';

// Registered ONLY from `registerAgenticRoutes` (local; cloud registers nothing agentic): every stored
// sprint read hands its workspace to the AFTER-READ CHAIN, in this order:
//   1. the BRIEF pass (./manager.ts, Haiku) — every sprint ticket and ghost gets its summary;
//   2. the sprint-wide THEME pass (../sprint-themes/, Haiku), which runs only when the keys + summaries
//      changed;
//   3. the SPRINT BUILDER (../sprint-paths/, Sonnet 5, agentic), which reads the themes and runs only when
//      the map it is sent changed.
// A brief pass that did not finish ('busy', or stopped by a missing runtime) starts nothing after it: the
// running one re-runs and its own caller continues the chain. (The Haiku sprint STORY pass that used to
// be step 3 is retired; its table is dormant.)

type PassCtx = Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage'>;

export interface SprintAfterReadSteps {
  briefs: (ctx: PassCtx, a: number, w: number) => Promise<{ state: string; stoppedBy?: string | null }>;
  themes: (ctx: PassCtx, a: number, w: number) => Promise<unknown>;
  paths: (ctx: PassCtx, a: number, w: number) => Promise<unknown>;
}

const STEPS: SprintAfterReadSteps = {
  briefs: (ctx, a, w) => runSprintBriefPass(ctx, a, w),
  themes: (ctx, a, w) => runSprintThemePass(ctx, a, w),
  paths: (ctx, a, w) => runSprintPathsPass(ctx, a, w),
};

/** The chain for one stored read (exported for its order test). The page reads 'queued' while it holds
 *  the workspace (db/sprint-paths.ts), released on EVERY path out of it. Never throws. */
export async function runSprintAfterRead(ctx: PassCtx, accountId: number, workspaceId: number, steps: SprintAfterReadSteps = STEPS): Promise<void> {
  markSprintPathsQueued(accountId, workspaceId, true);
  try {
    const briefs = await steps.briefs(ctx, accountId, workspaceId);
    if (briefs.state !== 'done' || briefs.stoppedBy === 'runtime') return;
    await steps.themes(ctx, accountId, workspaceId);
    // The PATHS read the themes, so they follow them (whatever the theme pass answered).
    await steps.paths(ctx, accountId, workspaceId);
  } catch (err) {
    ctx.log.warn({ err: String(err).slice(0, 200) }, 'sprint after-read chain failed');
  } finally {
    markSprintPathsQueued(accountId, workspaceId, false);
  }
}

export function registerSprintBriefs(ctx: AgentContext): void {
  setAfterSprintRead((accountId, workspaceId) => {
    void runSprintAfterRead(ctx, accountId, workspaceId);
  });
}

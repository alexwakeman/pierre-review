import { markSprintStoryQueued } from '../../db/sprint-story.js';
import { setAfterSprintRead } from '../../tracker/sprint/hooks.js';
import type { AgentContext } from '../agent-context.js';
import { runSprintStoryPass } from '../sprint-story/manager.js';
import { runSprintThemePass } from '../sprint-themes/manager.js';
import { runSprintBriefPass } from './manager.js';

// Registered ONLY from `registerAgenticRoutes` (local; cloud registers nothing agentic): every stored
// sprint read hands its workspace to the brief pass (./manager.ts) and, once that pass has finished, to
// the sprint-wide THEME pass (../sprint-themes/), which runs only when the keys + summaries changed. A
// brief pass that answered 'busy' starts no theme pass: the running one re-runs and its own caller
// themes after it. Then the sprint STORY pass (../sprint-story/), which runs only when the graph facts it
// is sent changed. It REPLACES the free story-label trigger This sprint used to have; the story labels
// themselves (Reports → Stories, the story report) are untouched and run on their own triggers.
export function registerSprintBriefs(ctx: AgentContext): void {
  setAfterSprintRead((accountId, workspaceId) => {
    // The page reads 'queued' while this chain holds the workspace (db/sprint-story.ts), released on
    // EVERY path out of it.
    markSprintStoryQueued(accountId, workspaceId, true);
    void (async () => {
      try {
        const briefs = await runSprintBriefPass(ctx, accountId, workspaceId);
        if (briefs.state !== 'done' || briefs.stoppedBy === 'runtime') return;
        await runSprintThemePass(ctx, accountId, workspaceId);
        // The STORY reads the themes, so it follows them (whatever the theme pass answered).
        await runSprintStoryPass(ctx, accountId, workspaceId);
      } finally {
        markSprintStoryQueued(accountId, workspaceId, false);
      }
    })().catch((err) => ctx.log.warn({ err: String(err).slice(0, 200) }, 'sprint briefs/themes: after-read failed'));
  });
}

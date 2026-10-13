import { setAfterSprintRead } from '../../tracker/sprint/hooks.js';
import type { AgentContext } from '../agent-context.js';
import { runSprintThemePass } from '../sprint-themes/manager.js';
import { runSprintBriefPass } from './manager.js';

// Registered ONLY from `registerAgenticRoutes` (local; cloud registers nothing agentic): every stored
// sprint read hands its workspace to the brief pass (./manager.ts) and, once that pass has finished, to
// the sprint-wide THEME pass (../sprint-themes/), which runs only when the keys + summaries changed. A
// brief pass that answered 'busy' starts no theme pass: the running one re-runs and its own caller
// themes after it. It REPLACES the free story-label trigger This sprint used to have; the story labels
// themselves (Reports → Stories, the story report) are untouched and run on their own triggers.
export function registerSprintBriefs(ctx: AgentContext): void {
  setAfterSprintRead((accountId, workspaceId) => {
    void (async () => {
      const briefs = await runSprintBriefPass(ctx, accountId, workspaceId);
      if (briefs.state === 'done' && briefs.stoppedBy !== 'runtime') await runSprintThemePass(ctx, accountId, workspaceId);
    })().catch((err) => ctx.log.warn({ err: String(err).slice(0, 200) }, 'sprint briefs/themes: after-read failed'));
  });
}

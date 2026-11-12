import { storyBuildGateCount, storyBuildRingProgress, type StoryBuildActivity, type StoryBuildGate } from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useStoryBuildActivity } from '../../hooks/useStoryBuild.js';
import { useOpenStoryBuild } from '../../lib/storyBuildTab.js';
import { useFilters } from '../../store/filters.js';
import { HeaderToast, ToastList, ToastRow } from '../HeaderToasts.js';
import { HammerIcon } from '../Icons.js';

// THE BUILDS TOAST (docs/STORY-BUILD.md § The builds toast): ONE circle in the ONE toast cluster
// (HeaderToasts.tsx) while any Implement / Fill gaps build of the workspace runs or waits for the reader.
//   • A PROGRESS RING while an agent or the review loop works (the least advanced running build).
//   • A COUNT BADGE and the alert ring for the builds at a GATE: the plan waits, the build waits for Push,
//     the review loop paused, a failure, or (approved automatically) the ticket changes after the PR opened.
// The cluster opens the panel; each row opens that build's tab as it is now (`useOpenStoryBuild`).
// Data: `GET /api/story-builds/active?workspace=` (DB only), polled 5 s while a build runs, 30 s otherwise,
// and refetched after every build action (`invalidateBuild`). Shared `storyBuildActivityOf` is the fold.

const GATE_WORDS: Record<StoryBuildGate, string> = {
  plan: 'Approve the plan',
  push: 'Push',
  paused: 'Continue',
  failed: 'Failed',
  ticket: 'Check the ticket',
};

export function StoryBuildsToast(): JSX.Element | null {
  const enabled = useAiCapabilities().enabled;
  const workspaceId = useFilters((s) => s.workspaceId);
  const q = useStoryBuildActivity(workspaceId, enabled);
  const builds = q.data?.builds ?? [];
  if (!enabled || builds.length === 0) return null;
  const running = builds.filter((b) => b.running).length;
  const gates = storyBuildGateCount(builds);
  const ring = storyBuildRingProgress(builds);
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (gates > 0) parts.push(`${gates} ${gates === 1 ? 'needs' : 'need'} you`);
  return (
    <HeaderToast
      testId="story-builds-toast"
      tone="ai"
      label="Builds"
      icon={<HammerIcon size={13} />}
      summary={parts.join(', ')}
      progress={ring != null ? { value: ring, label: 'Build progress' } : null}
      count={gates}
      alert={gates > 0}
    >
      <ToastList>
        {builds.map((b) => (
          <BuildRow key={b.id} b={b} />
        ))}
      </ToastList>
    </HeaderToast>
  );
}

function BuildRow({ b }: { b: StoryBuildActivity }): JSX.Element {
  const openBuild = useOpenStoryBuild();
  return (
    <ToastRow>
      <button
        type="button"
        data-testid="story-builds-toast-row"
        data-gate={b.gate ?? undefined}
        onClick={() => openBuild({ ident: b.ident, key: b.ticketKey, title: b.ticketTitle })}
        className="hit block w-full text-left"
        title="Open this build"
      >
        <div className="flex items-center gap-1.5">
          {b.running ? (
            <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-ui-line border-t-ai-signal" />
          ) : (
            <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${b.gate === 'failed' ? 'bg-ui-danger' : 'bg-ui-accent'}`} />
          )}
          <span className="truncate font-medium text-ui-ink hover:underline">
            {b.ticketKey}
            {b.ticketTitle != null && <span className="font-normal text-ui-mute"> · {b.ticketTitle}</span>}
          </span>
          {b.gate != null && (
            <span className={`ml-auto shrink-0 rounded-ui px-1.5 text-meta font-medium ${b.gate === 'failed' ? 'bg-ui-danger/10 text-ui-danger' : 'bg-ui-raise text-ui-ink'}`}>
              {GATE_WORDS[b.gate]}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-ui-mute">{b.step}</div>
        {b.running && (
          <div
            role="progressbar"
            aria-label={`${b.ticketKey} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={b.progress}
            className="mt-1 h-[3px] overflow-hidden rounded-[2px] bg-ui-hover"
          >
            <div className="h-full rounded-[2px] bg-ai-signal-fill motion-safe:transition-all motion-safe:duration-500" style={{ width: `${b.progress}%` }} />
          </div>
        )}
      </button>
    </ToastRow>
  );
}

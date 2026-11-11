import type { StoryBuild } from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { useStoryBuildAutoPush } from '../../hooks/useStoryBuild.js';
import { autoPushEditable, autoPushRunning, autoPushWaitsForNextBuild, storyBuildErrorText } from '../../lib/storyBuild.js';
import { InfoButton } from '../InfoModal.js';
import { CheckboxBox } from '../ui/FormControls.js';

// PUSH AUTOMATICALLY (docs/STORY-BUILD.md § Push automatically): the reader's opt-in on Implement and
// Fill gaps, OFF by default. Ticked in the Start panel (`autoPush: true` on the start body, sent only
// when ticked), changeable here until the build pushed or the automatic push started (`POST …/auto-push`,
// its own mutation key: a running turn never blocks it). Then the line says what happened: pushing, or
// the one recorded failure (the item's own card offers the rename after BRANCH_EXISTS).

export const AUTO_PUSH_LABEL = 'Push and open the pull request when the build finishes';

/** The ⓘ beside the option: what it does, in the fewest honest words. */
export function AutoPushInfo(): JSX.Element {
  return (
    <InfoButton title="Push automatically">
      <p>
        When a build finishes, Limn pushes it with your GitHub login and opens the pull request ready for review, not as a
        draft. It does this once per session. If the push fails, it says why here and you press Push yourself.
      </p>
      <p className="mt-2">Limn's own auto review skips pull requests Limn opened. Run AI Review on it from its PR tab.</p>
    </InfoButton>
  );
}

/** The option in an open session's tab: the switch until it can no longer change, then its outcome. */
export function AutoPushLine({ build }: { build: StoryBuild }): JSX.Element | null {
  const set = useStoryBuildAutoPush(build.workspaceId, build.ident);
  const on = build.autoPush === true;
  if (build.autoPushError != null && !build.pushedAll) {
    return (
      <p data-testid="story-build-auto-push" data-state="failed" className="mt-3 text-meta text-ui-danger">
        Automatic push failed: {build.autoPushError}
      </p>
    );
  }
  if (autoPushRunning(build)) {
    return (
      <p data-testid="story-build-auto-push" data-state="pushing" className="mt-3 text-meta text-ui-mute">
        Pushing and opening the pull request…
      </p>
    );
  }
  if (!autoPushEditable(build)) return null;
  const err = set.error == null ? null : storyBuildErrorText(set.error instanceof ApiError ? set.error : { message: (set.error as Error).message });
  return (
    <div className="mt-3">
      <label data-testid="story-build-auto-push" data-state={on ? 'on' : 'off'} className="flex w-fit cursor-pointer items-center gap-1.5 text-body text-ui-ink">
        <CheckboxBox checked={on} disabled={set.isPending} onChange={(e) => set.mutate({ id: build.id, on: e.target.checked })} />
        {AUTO_PUSH_LABEL}
        <AutoPushInfo />
      </label>
      {autoPushWaitsForNextBuild(build) && <p className="mt-1 text-meta text-ui-mute">Limn pushes when the next build finishes.</p>}
      {err != null && <p className="mt-1 text-meta text-ui-danger">{err}</p>}
    </div>
  );
}

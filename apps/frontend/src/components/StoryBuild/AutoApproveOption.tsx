import type { StoryBuild } from '@pierre-review/shared';
import { useStoryBuildAutoApprove } from '../../hooks/useStoryBuild.js';
import { InfoButton } from '../InfoModal.js';
import { CheckboxBox } from '../ui/FormControls.js';

// "APPROVE THE PLAN AUTOMATICALLY" (docs/STORY-BUILD.md § Approve automatically). OFF by default. Ticked at
// Start (`autoApprovePlan: true`), or in the tab until the plan is approved (`POST …/auto-approve`). When a
// plan turn ends with a usable plan, Limn takes every open point as Agree, approves it and starts the build
// (sandbox/session/plan.ts). The ticket is NOT written: once the pull request is open, the tab shows the
// ticket changes for the reader to update or leave (TicketStep in StoryBuildTabView).
//
// With the review loop ticked too, Start → planned → built → reviewed and fixed → pull request, with no
// other press. Both boxes REMEMBER the reader's last choice in this browser (`START_PREFS_KEY`).

export const AUTO_APPROVE_LABEL = 'Approve the plan automatically';

/** The Start panel's remembered boxes (this browser only; the server stores each build's own choice). */
export const START_PREFS_KEY = 'limn.storyBuild.startPrefs';
export interface StartPrefs {
  autoApprovePlan: boolean;
  autoPush: boolean;
}
export const START_PREFS_DEFAULT: StartPrefs = { autoApprovePlan: false, autoPush: false };

export function AutoApproveInfo(): JSX.Element {
  return (
    <InfoButton title="Approve automatically">
      <p>Limn agrees with every change the plan proposes, approves it and starts the build. You are not asked.</p>
      <p className="mt-2">
        The ticket is not changed. After the pull request opens, the build shows the ticket changes the plan suggested, so you
        can update the ticket or leave it.
      </p>
    </InfoButton>
  );
}

/** The tab's switch: shown until the plan is approved. It acts when the next plan is ready. */
export function AutoApproveSetting({ build }: { build: StoryBuild }): JSX.Element | null {
  const set = useStoryBuildAutoApprove(build.workspaceId, build.ident);
  if (build.session?.plan == null || build.session.plan.approvedRevision != null) return null;
  const on = build.autoApprovePlan === true;
  return (
    <label data-testid="story-build-auto-approve" className="mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-body text-ui-ink">
      <CheckboxBox checked={on} disabled={set.isPending} onChange={(e) => set.mutate({ id: build.id, on: e.target.checked })} />
      {AUTO_APPROVE_LABEL}
      <InfoButton title="Approve automatically">
        <p>When the next plan is ready, Limn agrees with every change it proposes, approves it and starts the build.</p>
        <p className="mt-2">A plan that is already waiting is not approved by this: press Approve and start.</p>
        <p className="mt-2">The ticket is not changed. After the pull request opens, the build shows the ticket changes.</p>
      </InfoButton>
    </label>
  );
}

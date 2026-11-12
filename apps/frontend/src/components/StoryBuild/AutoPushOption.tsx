import { STORY_BUILD_LOOP_ROUNDS_DEFAULT, STORY_BUILD_LOOP_ROUNDS_MAX, STORY_BUILD_LOOP_ROUNDS_MIN, type StoryBuild } from '@pierre-review/shared';
import { ApiError } from '../../api/client.js';
import { useStoryBuildLoopSettings } from '../../hooks/useStoryBuild.js';
import { autoPushRunning, loopEditable, storyBuildErrorText } from '../../lib/storyBuild.js';
import { InfoButton } from '../InfoModal.js';
import { MinusIcon, PlusIcon } from '../Icons.js';
import { CheckboxBox } from '../ui/FormControls.js';

// THE REVIEW LOOP'S OPT-IN (docs/STORY-BUILD.md § The review loop): "After the build: review and fix, then
// open the pull request", OFF by default, on Implement and Fill gaps. It reuses `story_builds.auto_push` as
// the switch, with a rounds number N (1..6, default 4). Ticked in the Start panel (`autoPush: true` +
// `loopRounds` on the start body, sent only when ticked); changeable here until the loop starts or
// something was pushed (`POST …/loop/settings`, its own mutation key: a running turn never blocks it).
// Once the loop runs, the tab's ReviewLoopSection says what it does.

export const AUTO_PUSH_LABEL = 'After the build: review and fix, then open the pull request';

/** The ⓘ beside the option: what it does, in the fewest honest words. */
export function AutoPushInfo(): JSX.Element {
  return (
    <InfoButton title="Review and fix">
      <p>
        Limn pushes the branch, then reviews it the way it reviews a pull request (your workspace’s AI review setting) and
        checks it against the ticket.
      </p>
      <p className="mt-2">The agent fixes, answers or pushes back on every point, and Limn reviews again.</p>
      <p className="mt-2">
        The review stays in Limn. After the last round Limn opens the pull request, ready for review. Each round uses your AI
        allowance.
      </p>
    </InfoButton>
  );
}

/** "Rounds [-] 3 [+]": the review + fix rounds before the pull request opens. */
export function LoopRoundsControl({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (n: number) => void;
}): JSX.Element {
  const step = (d: number) => () => onChange(Math.min(STORY_BUILD_LOOP_ROUNDS_MAX, Math.max(STORY_BUILD_LOOP_ROUNDS_MIN, value + d)));
  const btn = 'hit inline-flex h-6 w-6 items-center justify-center rounded-ui bg-ui-raise text-ui-ink hover:bg-ui-hover disabled:opacity-50';
  return (
    <span data-testid="story-build-loop-rounds" className="ml-6 mt-1.5 flex w-fit items-center gap-1.5 text-body text-ui-ink">
      Rounds
      <button type="button" className={btn} aria-label="Fewer rounds" disabled={disabled || value <= STORY_BUILD_LOOP_ROUNDS_MIN} onClick={step(-1)}>
        <MinusIcon size={11} />
      </button>
      <span data-testid="story-build-loop-rounds-value" className="w-4 text-center tabular-nums">
        {value}
      </span>
      <button type="button" className={btn} aria-label="More rounds" disabled={disabled || value >= STORY_BUILD_LOOP_ROUNDS_MAX} onClick={step(1)}>
        <PlusIcon size={11} />
      </button>
      <InfoButton title="Rounds">
        <p>Each round, Limn reviews the code and the agent answers every point. After the last round, Limn opens the pull request.</p>
      </InfoButton>
    </span>
  );
}

/** The option in an open session's tab: the switch and the rounds until the loop starts. */
export function AutoPushLine({ build }: { build: StoryBuild }): JSX.Element | null {
  const set = useStoryBuildLoopSettings(build.workspaceId, build.ident);
  const on = build.autoPush === true;
  // A build of the old automatic push (claimed before the review loop existed) keeps its recorded outcome.
  if (build.loop == null && build.autoPushError != null && !build.pushedAll) {
    return (
      <p data-testid="story-build-auto-push" data-state="failed" className="mt-3 text-meta text-ui-danger">
        Automatic push failed: {build.autoPushError}
      </p>
    );
  }
  if (build.loop == null && autoPushRunning(build)) {
    return (
      <p data-testid="story-build-auto-push" data-state="pushing" className="mt-3 text-meta text-ui-mute">
        Pushing and opening the pull request…
      </p>
    );
  }
  if (!loopEditable(build)) return null;
  const rounds = build.loop?.rounds ?? STORY_BUILD_LOOP_ROUNDS_DEFAULT;
  const err = set.error == null ? null : storyBuildErrorText(set.error instanceof ApiError ? set.error : { message: (set.error as Error).message });
  return (
    <div className="mt-3">
      <label data-testid="story-build-auto-push" data-state={on ? 'on' : 'off'} className="flex w-fit cursor-pointer items-center gap-1.5 text-body text-ui-ink">
        <CheckboxBox checked={on} disabled={set.isPending} onChange={(e) => set.mutate({ id: build.id, on: e.target.checked })} />
        {AUTO_PUSH_LABEL}
        <AutoPushInfo />
      </label>
      {on && <LoopRoundsControl value={rounds} disabled={set.isPending} onChange={(n) => set.mutate({ id: build.id, rounds: n })} />}
      {on && build.session?.phase === 'built' && build.loop?.state == null && (
        <p className="mt-1 text-meta text-ui-mute">Limn starts when the next build finishes.</p>
      )}
      {err != null && <p className="mt-1 text-meta text-ui-danger">{err}</p>}
    </div>
  );
}

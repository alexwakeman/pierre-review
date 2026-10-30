import { useEffect, useId, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  aiProviderName,
  aiRunProviderName,
  STORY_BUILD_BRANCH_MAX,
  STORY_BUILD_MESSAGE_MAX,
  type StoryBuild,
  type StoryBuildPlanRepo,
  type StoryBuildProgress,
  type StoryBuildRepo,
} from '@pierre-review/shared';
import { useFollowUpProvider } from '../../hooks/useModelPick.js';
import { storyBuildMutationKey, useStoryBuildCancel, useStoryBuildChecks, useStoryBuildMessage } from '../../hooks/useStoryBuild.js';
import { STORY_BUILD_PHASE_LABEL, storyBuildProgressPct } from '../../lib/aiFixProgress.js';
import { branchNameProblem, defaultBranch, plannedRepos, storyBuildErrorText, type RepoChoice } from '../../lib/storyBuild.js';
import { ApiError } from '../../api/client.js';
import { RegenProgressBar } from '../Activity/RegenProgressBar.js';
import { CARD_NEUTRAL_CHIP, PrCardChips, PrCardFrame, PrCardMeta, PrCardTitle } from '../Activity/PrCardShell.js';
import { PlanMessageBox, PlanTranscript } from '../AiFix/PlanChat.js';
import { RunTestsOption, runTestsState, useRunTestsMemory } from '../AiFix/RunTests.js';
import { AiRunGate } from '../AiSetup.js';
import { DesignGrid } from '../DesignGrid.js';
import { ChevronIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { CheckboxBox } from '../ui/FormControls.js';
import { StoryBuildSection } from './StoryBuildSection.js';
import { storyBuildRefAnchor } from './CoverageSection.js';

// THE PLAN: the 2–3 sentence summary, one card per repository the plan CHANGES (the One PR card shell
// look; build order = card order) with its why, the base, an editable branch, Include, Run tests and the
// steps behind Details; the repositories it only reads, one line; the risks; the planned design (the
// shared DesignGrid, cells not clickable — no pull request exists yet); and the steering chat (the AI
// Fix plan chat, `AiFix/PlanChat.tsx`) gated on `story_plan` on the session's own provider.

const REF_CHIP = 'inline-flex items-center rounded-ui bg-ui-raise px-1.5 py-px font-mono text-meta text-ui-ink hover:bg-ui-hover';

function jumpToRef(ref: string): void {
  document.getElementById(storyBuildRefAnchor(ref))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** A gap ref as a chip that scrolls to its row in "Already done". */
export function GapRefChip({ refId }: { refId: string }): JSX.Element {
  return (
    <button type="button" className={REF_CHIP} onClick={() => jumpToRef(refId)} aria-label={`${refId}: show the criterion`}>
      {refId}
    </button>
  );
}

export function PlanSection({
  build,
  progress,
  choices,
  setChoice,
  editable,
}: {
  build: StoryBuild;
  progress: StoryBuildProgress | null;
  choices: ReadonlyMap<number, Partial<RepoChoice>>;
  setChoice: (repoId: number, c: Partial<RepoChoice>) => void;
  /** plan_ready, before Accept: the cards' controls work. */
  editable: boolean;
}): JSX.Element | null {
  const plan = build.plan;
  const planning = build.status === 'planning' || build.status === 'assessing';
  if (plan == null && !planning) return null;
  const repos = plannedRepos(build);
  const byRepoId = new Map((plan?.repos ?? []).map((r) => [r.repoId, r]));
  const candidateName = new Map(build.candidates.map((c) => [c.repoId, c.fullName]));
  const refNames = new Map(build.candidates.map((c) => [c.ref, c.fullName.split('/').pop() ?? c.fullName]));
  const notPlanned = (plan?.criteria ?? []).filter((c) => c.how === 'not_planned');
  return (
    <StoryBuildSection
      testId="story-build-plan"
      title="Plan"
      info={
        <InfoButton title="The plan">
          <p>The AI read the story and the code and wrote this plan. It changed nothing.</p>
          <p>
            Each card is a repository it will change, built one at a time in this order. A later repository can read what the earlier
            ones built.
          </p>
          <p>Edit a branch name, leave a repository out or tick Run tests before you accept. Tell the AI what to change below.</p>
        </InfoButton>
      }
      end={
        plan != null && build.planRevision > 1 ? <span className="text-meta text-ui-mute">Version {build.planRevision}</span> : null
      }
    >
      {plan != null ? (
        <>
          <p data-testid="story-build-summary" className="max-w-3xl text-body text-ui-ink">
            {plan.summary}
          </p>
          <ul className="mt-3 space-y-2">
            {repos.map((r, i) => (
              <PlanRepoCard
                key={r.repoId}
                build={build}
                repo={r}
                position={i + 1}
                planRepo={byRepoId.get(r.repoId) ?? null}
                choice={choices.get(r.repoId) ?? {}}
                setChoice={(c) => setChoice(r.repoId, c)}
                editable={editable}
              />
            ))}
          </ul>
          {plan.readOnlyRepos.length > 0 && (
            <p data-testid="story-build-read-only" className="mt-3 text-meta text-ui-mute">
              Read, not changed:{' '}
              {plan.readOnlyRepos.map((r, i) => (
                <span key={r.ref}>
                  {i > 0 && '; '}
                  <span className="font-medium text-ui-ink">{candidateName.get(r.repoId) ?? r.ref}</span> ({r.why})
                </span>
              ))}
            </p>
          )}
          {notPlanned.length > 0 && (
            <div className="mt-3">
              <h4 className="text-meta font-medium text-ui-mute">Not in the plan</h4>
              <ul className="mt-1 space-y-1">
                {notPlanned.map((c) => (
                  <li key={c.ref} className="flex flex-wrap items-baseline gap-2 text-body text-ui-ink">
                    <GapRefChip refId={c.ref} />
                    <span>{c.reason ?? 'No reason given.'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.risks.length > 0 && (
            <div className="mt-3">
              <h4 className="text-meta font-medium text-ui-mute">Risks</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-body text-ui-ink">
                {plan.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {build.design != null && (
            <div data-testid="story-build-design" className="mt-4">
              <h4 className="mb-2 flex items-center gap-1 text-meta font-medium text-ui-mute">
                Design
                <InfoButton title="The planned design">
                  <p>How the plan builds the story: stages across, layers down, one card per responsibility.</p>
                  <p>Each card names the repository that does it. Nothing is built yet, so the cards open nothing.</p>
                </InfoButton>
              </h4>
              <DesignGrid design={build.design} label={`Planned design for ${build.ticketKey}`} refNames={refNames} />
            </div>
          )}
          {build.wantDiagram && build.design == null && build.status === 'plan_ready' && (
            <p className="mt-3 text-meta text-ui-mute">Couldn&rsquo;t draw the design.</p>
          )}
        </>
      ) : null}
      <PlanChatBlock build={build} progress={progress} />
    </StoryBuildSection>
  );
}

/** The chat and the pass in flight (its bar, its step, Cancel). */
function PlanChatBlock({ build, progress }: { build: StoryBuild; progress: StoryBuildProgress | null }): JSX.Element | null {
  const plannedBy = aiRunProviderName(build);
  const passProvider = useFollowUpProvider(build.provider ?? null, 'story_plan');
  const name = aiProviderName(passProvider);
  const ident = build.ident;
  const message = useStoryBuildMessage(build.workspaceId, ident);
  const cancel = useStoryBuildCancel(build.workspaceId, ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(ident) }) > 0;
  const [draft, setDraft] = useState('');
  const passRunning = build.status === 'planning' || build.status === 'assessing';
  const ready = build.status === 'plan_ready' && build.plan != null;
  const text = draft.trim();
  const send = (): void => {
    if (!ready || busy || text === '' || text.length > STORY_BUILD_MESSAGE_MAX) return;
    message.mutate({ id: build.id, text }, { onSuccess: () => setDraft('') });
  };
  const err = message.error ?? cancel.error;
  return (
    <div data-testid="story-build-chat" className="mt-3">
      {/* A re-plan that failed keeps the plan above; the reason sits here. */}
      {build.error != null && build.status === 'plan_ready' && <p className="mt-2 rounded-ui bg-ui-raise p-2 text-meta text-ui-warn">{build.error}</p>}
      <PlanTranscript transcript={build.transcript} plannedBy={plannedBy} />
      {passRunning && (
        <div className="mt-3">
          <RegenProgressBar
            active
            label={build.plan != null ? 'Updating the plan' : 'Making the plan'}
            value={storyBuildProgressPct(progress)}
            timeConstantSec={45}
          />
          <div className="mt-1 flex items-center gap-2 text-meta text-ui-mute">
            {STORY_BUILD_PHASE_LABEL[progress?.phase ?? build.phase ?? 'reading_story']}
            <Button size="sm" variant="secondary" data-story-build-action="cancel" onClick={() => cancel.mutate(build.id)}>
              Cancel
            </Button>
          </div>
          {progress?.recentActivity != null && progress.recentActivity.length > 0 && (
            <pre className="mt-1 max-h-32 overflow-auto rounded-ui bg-ui-surface p-2 text-meta leading-relaxed text-ui-mute">
              {progress.recentActivity.slice(-8).join('\n')}
            </pre>
          )}
        </div>
      )}
      {ready && (
        <div className="mt-3">
          <AiRunGate kind="story_plan" meter={false} followUp provider={passProvider}>
            <PlanMessageBox name={name} draft={draft} setDraft={setDraft} busy={busy} maxChars={STORY_BUILD_MESSAGE_MAX} onSend={send} />
          </AiRunGate>
        </div>
      )}
      {err != null && (
        <p className="mt-1 text-meta text-ui-danger">{storyBuildErrorText(err instanceof ApiError ? err : { message: (err as Error).message })}</p>
      )}
    </div>
  );
}

function PlanRepoCard({
  build,
  repo,
  position,
  planRepo,
  choice,
  setChoice,
  editable,
}: {
  build: StoryBuild;
  repo: StoryBuildRepo;
  position: number;
  planRepo: StoryBuildPlanRepo | null;
  choice: Partial<RepoChoice>;
  setChoice: (c: Partial<RepoChoice>) => void;
  editable: boolean;
}): JSX.Element {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const include = choice.include ?? repo.include;
  const branch = choice.branch ?? defaultBranch(build, repo);
  const problem = include ? branchNameProblem(branch) : null;
  // "Run tests": remembered per repository; the checks list is read only once ticked (one GitHub read).
  const memory = useRunTestsMemory(repo.fullName);
  const checks = useStoryBuildChecks(build.id, repo.repoId, editable && memory.memory.on);
  const runTests = runTestsState(memory, checks);
  const names = runTests.names.join('\u0000');
  useEffect(() => {
    if (!editable) return;
    setChoice({ checks: names === '' ? [] : names.split('\u0000') });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report only when the ticked names change
  }, [names, editable]);
  const refs = [...new Set((planRepo?.steps ?? []).flatMap((s) => s.refs))];
  const ticked = editable ? runTests.names : repo.checksWanted;
  return (
    <PrCardFrame labelledBy={titleId}>
      <div data-testid="story-build-plan-repo" data-repo={repo.fullName} data-include={include ? 'true' : 'false'}>
        <PrCardTitle
          id={titleId}
          after={<span className="shrink-0 text-meta text-ui-mute">Built {ordinal(position)}</span>}
        >
          {repo.fullName}
        </PrCardTitle>
        {planRepo != null && <p className="mt-1 text-body text-ui-ink">{planRepo.why}</p>}
        <PrCardChips>
          {refs.map((r) => (
            <GapRefChip key={r} refId={r} />
          ))}
          {!include && <span className={CARD_NEUTRAL_CHIP}>Left out</span>}
        </PrCardChips>
        <PrCardMeta
          parts={[
            <span key="base">
              From <span className="font-mono">{repo.baseRef}</span>
            </span>,
            planRepo != null ? `${planRepo.steps.length} step${planRepo.steps.length === 1 ? '' : 's'}` : null,
            ticked.length > 0 ? `Tests: ${ticked.join(', ')}` : null,
          ]}
        />
        {repo.baseNote != null && <p className="mt-1 text-meta text-ui-mute">{repo.baseNote}</p>}
        {editable && (
          <div className="mt-2 flex flex-col gap-2" data-noactivate>
            <label className="flex cursor-pointer items-center gap-2 text-meta text-ui-ink">
              <CheckboxBox checked={include} onChange={(e) => setChoice({ include: e.target.checked })} />
              Include this repository
            </label>
            <label className="flex flex-wrap items-center gap-2 text-meta text-ui-ink">
              Branch
              <input
                type="text"
                value={branch}
                maxLength={STORY_BUILD_BRANCH_MAX}
                disabled={!include}
                aria-invalid={problem != null}
                spellCheck={false}
                onChange={(e) => setChoice({ branch: e.target.value })}
                className="h-7 min-w-0 max-w-full flex-1 rounded-ui bg-ui-raise px-2 font-mono text-meta text-ui-ink ring-1 ring-inset ring-ui-line focus:outline-none focus:ring-2 focus:ring-ui-accent disabled:opacity-50 sm:max-w-sm"
              />
            </label>
            {problem != null && <p className="text-meta text-ui-danger">{problem}</p>}
            {include && <RunTestsOption state={runTests} disabled={false} />}
          </div>
        )}
        {!editable && repo.branch != null && (
          <p className="mt-1 text-meta text-ui-mute">
            Branch <span className="font-mono text-ui-ink">{repo.branch}</span>
          </p>
        )}
        {planRepo != null && (planRepo.steps.length > 0 || planRepo.tests.length > 0) && (
          <>
            <button
              type="button"
              className="hit mt-2 inline-flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <ChevronIcon dir={open ? 'down' : 'right'} />
              Details
            </button>
            {open && <PlanRepoSteps planRepo={planRepo} />}
          </>
        )}
      </div>
    </PrCardFrame>
  );
}

/** The steps (title, files, change, the gaps each closes), then the tests the plan expects. */
function PlanRepoSteps({ planRepo }: { planRepo: StoryBuildPlanRepo }): JSX.Element {
  return (
    <div data-testid="story-build-steps-detail" className="mt-2 space-y-3 text-meta text-ui-ink">
      {planRepo.steps.length > 0 && (
        <ol className="list-decimal space-y-2 pl-5">
          {planRepo.steps.map((s, i) => (
            <li key={i}>
              <div className="font-medium text-ui-ink">{s.title}</div>
              {s.files.length > 0 && <div className="mt-0.5 break-all font-mono text-meta text-ui-mute">{s.files.join(', ')}</div>}
              <p className="mt-0.5 whitespace-pre-wrap">{s.change}</p>
              {s.refs.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.refs.map((r) => (
                    <GapRefChip key={r} refId={r} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {planRepo.tests.length > 0 && (
        <div>
          <div className="mb-1 font-medium text-ui-mute">Tests it expects to add or change</div>
          <ul className="list-disc space-y-0.5 pl-5">
            {planRepo.tests.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ordinal(n: number): string {
  return ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n] ?? `${n}th`;
}

import { fixWaitingLine } from '../lib/aiFixProgress.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  aiProviderName,
  aiRunProvider,
  aiRunProviderName,
  aiRunLabel,
  AI_FIX_REVIEW_ITEM_LABELS,
  DEFAULT_AI_FIX_MODEL,
  type AiFix,
  type AiFixMerge,
  type AiFixSummary,
  type PrDetail,
  type PrHeadInfo,
  type SandboxNetworkAllowBody,
  type SandboxSessionRepo,
  type StoryBuildSession,
} from '@pierre-review/shared';
import { relativeTime, safeExternalUrl } from '../lib/ui.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { AiRunGate } from './AiSetup.js';
import { useMe } from '../hooks/useTriage.js';
import { aiProviderReadyFor } from '../lib/aiCapabilities.js';
import { useModelPick } from '../hooks/useModelPick.js';
import { ModelPicker } from './ModelPicker.js';
import { useFilters } from '../store/filters.js';
import {
  aiFixSessionMutationKey,
  aiFixStartMutationKey,
  useAiFix,
  useAiFixPreview,
  useCancelFix,
  useDiscardFix,
  useFixAllow,
  useFixMessage,
  useFixSessionStream,
  usePushFix,
  useResumeFix,
  useStartFix,
  useStartFixBuild,
  useStartPlan,
} from '../hooks/useAiFix.js';
import { useSandboxRuntime } from '../hooks/useStoryBuild.js';
import { mergeSessionViews, sessionCanDiscard, sessionTurnRunning } from '../lib/sandboxSession.js';
import {
  fixErrorTone,
  fixMergeBlockedLine,
  fixMergeLine,
  fixPushable,
  fixRepoStatus,
  fixSessionHoldsPr,
  fixSessionShown,
  fixSessionStatusLine,
  leftOutLine,
} from '../lib/aiFixSession.js';
import { ApprovedPlanNote, PlanHistory } from './AiFix/PlanPanel.js';
import { useClaudeReview, useClaudeReviewById } from '../hooks/useClaudeReview.js';
import { fixSourceReviewId, olderSourceNote } from '../lib/aiFixSource.js';
import { ApiError } from '../api/client.js';
import { FixReport, fixSourceLine } from './AiFix/FixReport.js';
import { FixPicker } from './AiFix/FixPicker.js';
import { budgetCutKeys, onlySectionOverrides, pickedKeys, type PickerOverrides } from './AiFix/fixPickerModel.js';
import { Markdown } from './Markdown.js';
import { DiffWrapToggle, FileDiffView, type DiffFile } from './diff/FileDiffView.js';
import { parseGitPatch } from '../lib/diff.js';
import { InfoButton } from './InfoModal.js';
import { CheckboxBox, RadioBox } from './ui/FormControls.js';
import { useLocalStorage } from '../hooks/useLocalStorage.js';
import { ChecksReport, ChecksStatus } from './AiFix/RunTests.js';
import { RailSection, SharedSessionView, type SessionActions, type SessionWords } from './sandbox/SessionView.js';
import { SandboxRuntimeLine } from './StoryBuild/SandboxSetupHelp.js';
import { Button } from './ui/Button.js';
import { CheckIcon, ConflictIcon, WarningIcon } from './Icons.js';

/** "Push when done" (ON by default): this browser remembers the reader's last choice. */
const AI_FIX_PUSH_WHEN_DONE_KEY = 'limn.aiFix.pushWhenDone';

const BTN_PRIMARY =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';
function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

const BTN_SECONDARY =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';

function SectionTitle({
  children,
  info,
}: {
  children: React.ReactNode;
  info?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 px-4 pb-2 pt-4 text-title text-ui-ink md:px-5">
      <h3>{children}</h3>
      {info}
    </div>
  );
}

// THE AI FIX TAB (docs/FRONTEND.md § The AI Fix tab; docs/SANDBOX.md § AI Fix sessions). Every fix runs
// as a WORKSPACE SESSION: a sandbox on this computer with every repository of the workspace, the PR's
// repository checked out at the PR's head. Top to bottom: the FIX PICKER (AiFix/FixPicker.tsx: the
// server lists every item with a stable key and its default, the reader ticks) with Start fix and Plan
// first — or, with no container runtime, ONE line and How to set up in place of the buttons; then the
// session (the boot, the conversation, Stop, follow-ups, Start fix after a plan, Discard, Resume — the
// shared components/sandbox/SessionView.tsx); then the result (the per-change report, the diff, Push to
// the PR's branch) and the earlier fixes. Nothing is pushed before Push.
export function AiFixTab({ pr }: { pr: PrDetail }): JSX.Element {
  // FREE and local-only (`me.ai`).
  const aiFix = useAiCapabilities().enabled;
  const aiFixTabFocus = useFilters((s) => s.aiFixTabFocus);
  const consumeAiFixTabFocus = useFilters((s) => s.consumeAiFixTabFocus);

  // The review picked in the Claude Review tab ("Generate fix from this review"), delivered via the
  // store and consumed into local state on arrival. Absent ⇒ the PR's latest review.
  const [handoffReviewId, setHandoffReviewId] = useState<number | null>(null);
  // "Fix with AI" from the CI check section: tick only the CI failures once the picker loads.
  const [onlySection, setOnlySection] = useState<'ci_failures' | null>(null);
  useEffect(() => {
    if (aiFixTabFocus && aiFixTabFocus.prId === pr.id) {
      if (aiFixTabFocus.reviewId != null) setHandoffReviewId(aiFixTabFocus.reviewId);
      if (aiFixTabFocus.only != null) setOnlySection(aiFixTabFocus.only);
      consumeAiFixTabFocus();
    }
  }, [aiFixTabFocus, pr.id, consumeAiFixTabFocus]);

  if (!aiFix) return <></>;

  return (
    <div className="pb-6">
      <FixerSection
        pr={pr}
        handoffReviewId={handoffReviewId}
        onlySection={onlySection}
        onOnlySectionApplied={() => setOnlySection(null)}
      />
    </div>
  );
}

// ---- The fixer ----

function FixerSection({
  pr,
  handoffReviewId,
  onlySection,
  onOnlySectionApplied,
}: {
  pr: PrDetail;
  handoffReviewId: number | null;
  onlySection: 'ci_failures' | null;
  onOnlySectionApplied: () => void;
}): JSX.Element {
  const { data, isLoading } = useAiFix(pr.id, true);
  // The review the fix is built from: the one handed over from the Claude Review tab, else the
  // PR's newest SUCCEEDED review (a failed newer run never hides it). A DB-only read the Claude
  // Review tab already makes.
  const { data: reviewData, isLoading: reviewLoading } = useClaudeReview(pr.id);
  const latest = reviewData?.review ?? null;
  const reviewId = fixSourceReviewId(handoffReviewId, latest, reviewData?.history ?? []);
  const olderNote = olderSourceNote(handoffReviewId, reviewId, latest);
  const setPrDetailTab = useFilters((s) => s.setPrDetailTab);

  // THE PER-RUN MODEL MENU (lib/modelPick.ts): every signed-in provider that can run a fix, opening on
  // the DEFAULT provider's model at the shared default's depth (Opus 5.5, at Settings → AI → Effort,
  // read server-side) — the same constant the start route falls back to.
  const modelPick = useModelPick('fix', DEFAULT_AI_FIX_MODEL);
  // The info text names the provider the menu PICKED (the run about to start), not the default.
  const pickedName = aiProviderName(modelPick.chosen.provider);
  const me = useMe().data;
  const startFix = useStartFix(pr.id);
  const startPlan = useStartPlan(pr.id);
  // "Plan first" (manual only): the session opens in chat mode, makes a plan from the picked items and
  // waits for Start fix. Off by default. When the PICKED provider cannot run a plan, there is no
  // checkbox and none is sent — the plan would only fail.
  const ai = useAiCapabilities();
  const canPlan = aiProviderReadyFor(me, modelPick.chosen.provider, 'plan');
  const [planFirstPicked, setPlanFirst] = useState(false);
  const planFirst = planFirstPicked && canPlan;
  // "PUSH WHEN DONE" (docs/CLAUDE-REVIEW.md § AI Fix): ON by default, remembered in this browser. A fix that
  // finishes cleanly on your own PR is pushed to its branch without a press; otherwise it waits for Push and
  // the session says why (the server decides: coding/ai-fix/auto-push.ts `pushWhenDoneHold`).
  const [pushWhenDone, setPushWhenDone] = useLocalStorage<boolean>(AI_FIX_PUSH_WHEN_DONE_KEY, true);

  const noteAiFixRun = useFilters((s) => s.noteAiFixRun);
  // In-flight read off the SHARED start key, not this mount's `startFix.isPending` — a per-mount
  // flag resets on a tab switch mid-start, inviting a second BILLED agent turn.
  const fixStarting =
    useIsMutating({ mutationKey: aiFixStartMutationKey(pr.id) }) > 0;

  const fix = data?.fix ?? null;

  // THE SESSION: the query's read, and — while the sandbox runs — its SSE stream on top
  // (`mergeSessionViews`: the stream owns what it streams, the read the rest).
  const read = fix?.session ?? null;
  const live = read?.live === true;
  const stream = useFixSessionStream(pr.id, fix?.id ?? null, live);
  const session = read != null ? mergeSessionViews(read, live || stream.done ? stream.session : null) : null;
  const sessionShown = fix != null && session != null && fixSessionShown(session);
  const turnRunning = session != null && sessionTurnRunning(session);
  // A live session holds the PR: the picker waits until it ends.
  // THE FIX START QUEUE: a fix waiting for a free sandbox holds the PR too (it starts by itself).
  const waiting = data?.waiting ?? null;
  const holdsPr = fixSessionHoldsPr(session) || fixStarting || waiting != null;

  // The picker: the server's items for this review, the reader's ticks on top. A new review (or a
  // hand-over) starts from the defaults again.
  // With NO succeeded AI review, the same read without an id answers THE CI-ONLY preview (the CI
  // check's fixable items at the current head) — or a 409, which simply leaves "Open AI Review".
  const preview = useAiFixPreview(pr.id, reviewId, data?.enabled !== false && (reviewId != null || !reviewLoading));
  const ciOnly = reviewId == null && preview.data != null && preview.data.sourceReviewId == null && preview.data.items.length > 0;
  const fixSource = reviewId != null || ciOnly;
  // The source review in full, so the picker can draw each item with the Claude Review tab's own
  // card: the latest is already loaded; an older hand-over is one DB-only read (the history
  // selector's query).
  const olderSource = useClaudeReviewById(reviewId != null && latest?.id !== reviewId ? reviewId : null);
  const sourceReview = reviewId != null && latest?.id === reviewId ? latest : (olderSource.data ?? null);
  const [overrides, setOverrides] = useState<PickerOverrides>({});
  useEffect(() => setOverrides({}), [reviewId]);
  // With a finished fix on screen the picker folds away behind "New fix"; it is open otherwise.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Declared AFTER the reset above, so a hand-over that also changes the review keeps its ticks.
  // The reader asked for a fix, so the picker opens even over a finished one.
  useEffect(() => {
    if (onlySection == null || !preview.data) return;
    setOverrides(onlySectionOverrides(preview.data, onlySection));
    setPickerOpen(true);
    onOnlySectionApplied();
  }, [onlySection, preview.data, onOnlySectionApplied]);
  const showPicker = !holdsPr && (pickerOpen || !fix || fix.status !== 'succeeded');

  // THE CONTAINER RUNTIME (docs/SANDBOX.md § Setting up a runtime). Read only while the picker shows
  // (DB-free; the server caches it). None ⇒ the picker stays (what would be fixed) and the run row is
  // ONE line + How to set up — hidden, never disabled.
  const runtime = useSandboxRuntime(showPicker && fixSource);
  const noRuntime = runtime.data != null && !runtime.data.available;

  // Merge conflicts are a PICKER ITEM ('conflict:merge', section 'conflicts'; the server offers it when
  // the PR conflicts and the reader can push): the agent merges the base and resolves in the sandbox,
  // first, then fixes the rest on top. There is no separate conflict run any more.

  const picked = preview.data ? pickedKeys(preview.data, overrides) : [];
  const cutCount = preview.data ? budgetCutKeys(preview.data, overrides).size : 0;

  const startFromReview = (): void => {
    if (!fixSource || !preview.data || picked.length === 0) return;
    // The run goes to the provider the menu picked (the server validates the pair). No review id ⇒
    // the CI-only seed.
    const body = {
      model: modelPick.chosen.model,
      provider: modelPick.chosen.provider,
      seed: 'review' as const,
      ...(reviewId != null ? { sourceReviewId: reviewId } : {}),
      include: picked,
      pushWhenDone,
    };
    if (planFirst) {
      // The plan is read here, in the session; the banner follows the fix from Start fix.
      startPlan.mutate(body, { onSuccess: () => setPickerOpen(false) });
    } else {
      // The bottom-right AiFixBanner follows the run once the reader leaves this tab.
      noteAiFixRun({
        prId: pr.id,
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
        prTitle: pr.title,
      });
      startFix.mutate(body, { onSuccess: () => setPickerOpen(false) });
    }
  };

  return (
    <div>
      <SectionTitle
        info={
          <InfoButton title="AI Fix">
            <p>
              {pickedName} reads the PR's code and fixes it in a sandbox on this computer. The sandbox holds
              every repository in the workspace; the PR's repository is at the PR's latest commit. There{' '}
              {pickedName} can run the project's own tests, lint and type checks, and start the services you
              picked for integration tests.
            </p>
            <p>
              A fix starts from an AI review. Pick what it should work on: the review's findings,
              earlier findings still open, threads the review says need a fix, unanswered threads, CI
              failures and ticket gaps are ticked; style bot comments are not.
            </p>
            <p>
              With no AI review, a fix can start from a finished CI check: it works on the failures
              the check says this PR can fix.
            </p>
            <p>
              When the PR conflicts with its base branch, Resolve merge conflicts is ticked too. {pickedName}{' '}
              merges the base first and resolves each conflict, then fixes the other items on top. Limn checks
              the merge commit before Push. You can still resolve conflicts by hand with Resolve conflicts.
            </p>
            <p>
              Start fix starts at once. Watch it work, press Stop, or ask for more in the same session.
              Tick Plan first to read and discuss {pickedName}'s plan before anything changes, then press
              Start fix.
            </p>
            <p>{pickedName} reports what it changed in each file and what it left alone, and why.</p>
            <p>
              Only the PR's repository is pushed, to the PR's own branch. Edits in other repositories are
              shown and left out. Nothing is pushed until you press Push. An automatic fix on your own PR is
              pushed for you only when Push automatically is on in Settings.
            </p>
          </InfoButton>
        }
      >
        AI Fix
      </SectionTitle>
      <div className="px-4">
        {data?.enabled === false ? (
          <p className="text-body text-ui-mute">
            The agentic fixer is turned off.
          </p>
        ) : (
          <>
            {waiting != null && <FixWaitingLine prId={pr.id} line={fixWaitingLine(waiting)} />}

            {!holdsPr && !fixSource && !reviewLoading && !preview.isLoading && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-meta text-ui-mute">
                  {latest?.status === 'running' || latest?.status === 'queued'
                    ? 'A fix starts from an AI review. One is running.'
                    : 'A fix starts from a finished AI review.'}
                </p>
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  onClick={() => setPrDetailTab(pr.id, 'claude_review')}
                >
                  Open AI Review
                </button>
              </div>
            )}

            {!holdsPr && fixSource && !showPicker && (
              <button type="button" className={BTN_SECONDARY} onClick={() => setPickerOpen(true)}>
                New fix
              </button>
            )}

            {fixSource && showPicker && (
              <div>
                {olderNote && (
                  <p className="mb-2 text-meta text-ui-mute">{olderNote}</p>
                )}
                {ciOnly && preview.data?.items.some((i) => i.section === 'ci_failures') && (
                  <p className="mb-2 text-meta text-ui-mute">No AI review yet. This fix works on the CI check’s failures.</p>
                )}
                {preview.isLoading && (
                  <p className="text-meta text-ui-mute">Loading…</p>
                )}
                {preview.isError && reviewId != null && (
                  <p className="text-meta text-ui-danger">{errText(preview.error)}</p>
                )}
                {preview.data && (
                  <FixPicker
                    preview={preview.data}
                    overrides={overrides}
                    onChange={setOverrides}
                    disabled={fixStarting}
                    pr={pr}
                    review={sourceReview}
                  />
                )}
                {preview.data && preview.data.items.length > 0 && noRuntime && (
                  // No container runtime: the picker shows what would be fixed; the run row is this
                  // ONE line and How to set up (the line Implement shows).
                  <div className="mt-3" data-testid="ai-fix-no-runtime">
                    <SandboxRuntimeLine status={runtime.data} loading={false} testId="ai-fix-runtime-line" />
                  </div>
                )}
                {preview.data && preview.data.items.length > 0 && !noRuntime && (
                  // THE RUN ROW. Below md it is a sticky footer (the side panel's action-bar look):
                  // the picker list runs several screens on a phone, and the model, Plan first and
                  // Start fix must stay in reach while ticking. Same controls, same AiRunGate.
                  <div className="mt-3 flex flex-wrap items-center gap-2 max-md:sticky max-md:bottom-0 max-md:z-20 max-md:-mx-4 max-md:bg-ui-surface max-md:px-4 max-md:py-3">
                    <ModelPicker state={modelPick} onPick={modelPick.pick} disabled={fixStarting} />
                    {canPlan && (
                      <label className="flex cursor-pointer items-center gap-1.5 text-meta text-ui-ink">
                        <CheckboxBox
                          checked={planFirst}
                          disabled={fixStarting}
                          onChange={(e) => setPlanFirst(e.target.checked)}
                        />
                        Plan first
                      </label>
                    )}
                    <label data-testid="ai-fix-push-when-done" className="flex cursor-pointer items-center gap-1.5 text-meta text-ui-ink">
                      <CheckboxBox checked={pushWhenDone} disabled={fixStarting} onChange={(e) => setPushWhenDone(e.target.checked)} />
                      Push when done
                      <InfoButton title="Push when done">
                        <p>When the fix finishes on your own pull request, Limn pushes it to the pull request's branch. You do not press Push.</p>
                        <p className="mt-2">
                          It waits for your press instead when the agent says something is not fixed, its report does not cover
                          every item, or the pull request is someone else's. The session says which.
                        </p>
                        <p className="mt-2">A push ends the session, so untick this to keep talking to the agent first.</p>
                      </InfoButton>
                    </label>
                    {/* No AI runtime or no Claude credential: one line (or the one-time setup) in
                        place of the start button. */}
                    {/* Any provider that can fix may run it (the menu lists those); "Plan first" shows
                        only when the PICKED one can also plan (canPlan). */}
                    <AiRunGate kind="fix" auth={data?.auth} anyProvider provider={modelPick.chosen.provider}>
                      <button
                        type="button"
                        className={BTN_PRIMARY}
                        data-ai-fix-action="start"
                        disabled={fixStarting || picked.length === 0}
                        onClick={startFromReview}
                      >
                        {fixStarting ? 'Starting…' : planFirst ? 'Make a plan' : 'Start fix'}
                      </button>
                    </AiRunGate>
                    <span className="text-meta text-ui-mute">
                      {picked.length === 0
                        ? 'Nothing ticked.'
                        : `${picked.length - cutCount} item${picked.length - cutCount === 1 ? '' : 's'}`}
                    </span>
                    {fix?.status === 'succeeded' && (
                      <button type="button" className={BTN_SECONDARY} onClick={() => setPickerOpen(false)}>
                        Close
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {(startFix.isError || startPlan.isError) && (
              <p className="mt-1 text-meta text-ui-danger">
                {errText(startFix.error ?? startPlan.error)}
              </p>
            )}

            {sessionShown && fix != null && session != null && (
              <FixSession pr={pr} fix={fix} session={session} partials={stream.partials} headRef={data?.headInfo?.headRef ?? pr.headRefName ?? null} />
            )}

            {fix && !turnRunning && session?.phase !== 'booting' && (
              <FixResult
                pr={pr}
                fix={fix}
                headInfo={data?.headInfo ?? null}
                viewerCanPush={data?.viewerCanPush ?? false}
              />
            )}
            {isLoading && !fix && (
              <p className="mt-3 text-meta text-ui-mute">Loading…</p>
            )}
          </>
        )}
        <FixHistory
          history={data?.history ?? []}
          currentFixId={data?.fix?.id ?? null}
        />
      </div>
    </div>
  );
}

// ---- The session ----

const FIX_WORDS: SessionWords = {
  startBuild: 'Start fix',
  startBuildTitle: 'The agent changes the code and runs the checks. The words in the box go with it.',
  // The first press reads "Start fix" itself, and a follow-up after it is a build turn too.
  readerBuildLabel: 'You · Build turn',
  empty: 'The agent has read the items to fix and the repositories.',
  chatPlaceholder: 'Ask about the plan, or say what to change in it.',
  buildPlaceholder: 'Ask for more. It is a build turn: the agent may edit and test.',
  resumeNote: 'Resume starts a new sandbox with this fix. The agent does not remember the conversation.',
  // A chat turn (Plan first) is a plan pass; every build turn is a fix.
  gate: { chat: 'plan', build: 'fix' },
};

function fixActions(prId: number, fixId: number, workspaceId: number | null, noteBuild: () => void): SessionActions {
  return {
    busyKey: aiFixSessionMutationKey(prId),
    useSend() {
      const m = useFixMessage(prId);
      return { run: (text, done) => m.mutate({ fixId, text }, { onSuccess: done }), pending: m.isPending, error: m.error, succeeded: m.isSuccess };
    },
    useStartBuild() {
      const m = useStartFixBuild(prId);
      // The bottom-right banner follows the fix from Start fix (noted BEFORE the POST, like a start).
      return { run: (text, done) => (noteBuild(), m.mutate({ fixId, text }, { onSuccess: done })), pending: m.isPending, error: m.error, succeeded: m.isSuccess };
    },
    useStop() {
      const m = useCancelFix(prId);
      return { run: (_v, done) => m.mutate(undefined, { onSuccess: done }), pending: m.isPending, error: m.error, succeeded: m.isSuccess };
    },
    useResume() {
      const m = useResumeFix(prId);
      return { run: (_v, done) => m.mutate(fixId, { onSuccess: done }), pending: m.isPending, error: m.error, succeeded: m.isSuccess };
    },
    useAllow() {
      const m = useFixAllow(prId, workspaceId);
      return {
        run: (body: SandboxNetworkAllowBody, done) => m.mutate({ fixId, body }, { onSuccess: done }),
        pending: m.isPending,
        error: m.error,
        succeeded: m.isSuccess,
      };
    },
  };
}

/** The fix's workspace session: its status line, then the shared view (conversation, rail). */
function FixSession({
  pr,
  fix,
  session,
  partials,
  headRef,
}: {
  pr: PrDetail;
  fix: AiFix;
  session: StoryBuildSession;
  partials: ReadonlyMap<string, string>;
  headRef: string | null;
}): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const noteAiFixRun = useFilters((s) => s.noteAiFixRun);
  const actions = useMemo(
    () =>
      fixActions(pr.id, fix.id, workspaceId, () =>
        noteAiFixRun({ prId: pr.id, repoFullName: pr.repoFullName, prNumber: pr.number, prTitle: pr.title }),
      ),
    [pr.id, pr.repoFullName, pr.number, pr.title, fix.id, workspaceId, noteAiFixRun],
  );
  const leftOut = fix.leftOut ?? [];
  const repoStatus = (r: SandboxSessionRepo) =>
    fixRepoStatus(r, { prRepoId: pr.repoId, headRef, filesChanged: fix.filesChanged.length, pushed: fix.pushedAt != null, leftOut, merge: fix.merge ?? null });
  return (
    <div data-testid="ai-fix-session" className="mt-3">
      <p data-testid="ai-fix-session-status" className="flex flex-wrap items-center gap-2 text-meta text-ui-mute">
        {fix.trigger === 'auto' && <AutoFixChip />}
        <span>{fixMergeBlockedLine(fix.merge, session) ?? fixSessionStatusLine(session, fix.unattended === true)}</span>
        {session.model != null && <span>· {aiRunLabel(session.provider, session.model, session.effort)}</span>}
      </p>
      <SharedSessionView
        session={session}
        partials={partials}
        actions={actions}
        words={FIX_WORDS}
        provider={providerOf(fix)}
        testPrefix="fix-session"
        actionAttr="data-ai-fix-action"
        railTop={<WhatToFixPanel pr={pr} fix={fix} />}
        repoStatus={repoStatus}
        composerExtra={sessionCanDiscard(session) && session.phase !== 'pushed' ? <DiscardFixButton prId={pr.id} fixId={fix.id} live={session.live} /> : null}
      />
    </div>
  );
}

/** The rail's first panel: the items the fix was given (frozen at the start), as the report's chips. */
function WhatToFixPanel({ pr, fix }: { pr: PrDetail; fix: AiFix }): JSX.Element {
  const items = (fix.reviewItems ?? []).filter((i) => i.included);
  return (
    <RailSection title="What to fix" testId="fix-session-items">
      {fix.seed === 'plain' ? (
        <p className="text-meta text-ui-mute">Your instruction.</p>
      ) : items.length === 0 ? (
        <p className="text-meta text-ui-mute">{fixSourceLine(fix)}</p>
      ) : (
        <ul className="space-y-1 text-meta text-ui-ink">
          {items.map((i) => (
            <li key={i.ref} className="break-words">
              <span className="font-mono text-ui-mute">{i.ref}</span>{' '}
              <span className="text-ui-mute">{AI_FIX_REVIEW_ITEM_LABELS[i.kind]}</span> {i.title}
              {i.path != null && (
                <span className="block break-all font-mono text-ui-mute">
                  {i.path}
                  {i.line != null && `:${i.line}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-meta text-ui-mute">
        Pushes only to <span className="font-mono">{pr.repoFullName}</span>.
      </p>
    </RailSection>
  );
}

/** Discard asks once while the sandbox runs (it ends the agent and removes the sandbox). Runs no model. */
function DiscardFixButton({ prId, fixId, live }: { prId: number; fixId: number; live: boolean }): JSX.Element {
  const discard = useDiscardFix(prId);
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="flex items-center gap-1.5 text-meta text-ui-ink">
        <span>{live ? 'Stop the agent and remove the sandbox? Nothing is pushed.' : 'Drop this fix? Nothing is pushed.'}</span>
        <Button size="sm" variant="secondary" data-ai-fix-action="discard-confirm" disabled={discard.isPending} onClick={() => discard.mutate(fixId, { onSettled: () => setAsking(false) })}>
          Discard
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
          Keep
        </Button>
      </span>
    );
  }
  return (
    <Button size="sm" variant="ghost" data-ai-fix-action="discard" onClick={() => setAsking(true)}>
      Discard
    </Button>
  );
}

// A fix the auto review started (after an auto review of the reader's own PR). It waits for Push
// like any other, unless the workspace switched "Push automatically" on.
function AutoFixChip(): JSX.Element {
  return (
    <span className="inline-flex items-center rounded-ui bg-ui-raise px-1.5 py-px text-meta font-medium text-ui-mute">
      Auto fix
    </span>
  );
}

/** The provider that ran a fix (its stored provider, else read from its model id). */
function providerOf(run: Pick<AiFix, 'provider' | 'model'>): ReturnType<typeof aiRunProvider> {
  return aiRunProvider(run.provider, run.model);
}

/** Who built the fix: the provider and the model that ran (packages/shared `aiRunLabel`). */
function runLabelOf(run: Pick<AiFix, 'provider' | 'model' | 'effort'>): string {
  return aiRunLabel(run.provider, run.model, run.effort);
}

function FixResult({
  pr,
  fix,
  headInfo,
  viewerCanPush,
}: {
  pr: PrDetail;
  fix: AiFix;
  headInfo: PrHeadInfo | null;
  viewerCanPush: boolean;
}): JSX.Element {
  const diffFiles = useMemo<DiffFile[]>(
    () => parseGitPatch(fix.patch),
    [fix.patch],
  );
  const merge = fix.merge ?? null;

  // Plan mode: a first planning pass that produced no plan, and a plan the reader discarded.
  if (fix.status === 'failed' && fix.plan?.status === 'failed') {
    return (
      <div className="mt-3 rounded-ui border border-ui-danger/40 bg-ui-danger/10 p-2 text-meta text-ui-danger">
        {aiRunProviderName(fix.plan ?? fix)} could not make a plan: {fix.error ?? 'unknown error'}
      </div>
    );
  }
  if (fix.status === 'cancelled' && fix.plan?.status === 'discarded') {
    return <p className="mt-3 text-meta text-ui-mute">The plan was discarded.</p>;
  }
  if (fix.status === 'failed') {
    return (
      <div className="mt-3 rounded-ui border border-ui-danger/40 bg-ui-danger/10 p-2 text-meta text-ui-danger">
        The fix run failed: {fix.error ?? 'unknown error'}
      </div>
    );
  }
  if (fix.status === 'cancelled') {
    return (
      <p className="mt-3 text-meta text-ui-mute">
        {fix.session != null ? 'The fix was stopped or discarded. Nothing was pushed.' : 'The fix run was cancelled.'}
      </p>
    );
  }
  if (fix.status !== 'succeeded') return <></>;

  const noFixChanges = !fix.patch || fix.filesChanged.length === 0;
  // A fix with the merge: Push sends a VALID merge (and the fix on top, if any); anything else sends nothing.
  const pushable = fixPushable(fix);
  const errorTone = fixErrorTone(fix);
  const leftOut = (fix.leftOut ?? []).filter((x) => x.files.length > 0);

  return (
    <div className="mt-3 border-t border-ui-line pt-3">
      <p className="mb-1 text-meta text-ui-mute">
        {fix.trigger === 'auto' && (
          <>
            <AutoFixChip />{' '}
          </>
        )}
        {fixSourceLine(fix)}
        {' · '}
        {runLabelOf(fix)}
        {fix.finishedAt && <> · {relativeTime(fix.finishedAt)}</>}
      </p>
      {/* An AUTOMATIC push that failed (auto-push.ts): recorded on the succeeded row's `error`,
          never retried — Push below still works. */}
      {fix.pushedAt == null && errorTone === 'warn' && (
        <p className="mb-2 rounded-ui bg-ui-raise p-2 text-meta text-ui-warn">
          {fix.error}
        </p>
      )}
      {/* A closed session's line (idle close, a restart) on a kept fix: a note, not a warning. Shown
          only when the session view is not already saying it is closed. */}
      {fix.pushedAt == null && errorTone === 'note' && fix.session?.resumable !== true && (
        <p className="mb-2 text-meta text-ui-mute">{fix.error}</p>
      )}
      <ApprovedPlanNote fix={fix} />
      <PlanHistory fix={fix} />
      {fix.summary && (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <Markdown>{fix.summary}</Markdown>
        </div>
      )}
      {/* Mounted ABOVE the "no changes" branch: a run that judged every item wrong produces no
          diff at all, and that is exactly the run whose "Not addressed" list matters most. */}
      <FixReport pr={pr} fix={fix} />
      {/* Edits the agent made in other repositories of the workspace: shown, never pushed. */}
      {leftOut.length > 0 && (
        <ul data-testid="ai-fix-left-out" className="mt-2 space-y-0.5 text-meta text-ui-mute">
          {leftOut.map((x) => (
            <li key={x.repoId}>
              {leftOutLine(x, pr.repoFullName)}{' '}
              <span className="font-mono">{x.files.slice(0, 5).join(', ')}{x.files.length > 5 ? `, and ${x.files.length - 5} more` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {/* "Run tests" on an older row: Limn's own run of the chosen checks (read-only history). */}
      <ChecksReport checks={fix.checks} />
      {merge != null && <MergeResult merge={merge} headSha={fix.baseSha} />}
      {noFixChanges ? (
        <p className="mt-2 text-meta text-ui-mute">
          {merge != null ? 'No other changes on top of the merge.' : 'No files changed.'}
        </p>
      ) : (
        <div data-testid="ai-fix-changes">
          <div className="mb-1 mt-2 flex items-center justify-between gap-3 text-meta text-ui-mute">
            {/* The agent ran the repository's own checks in the sandbox and says so in its last
                message (the conversation above); this line states only the size. */}
            <span>
              {merge != null && <span className="font-semibold text-ui-ink">Fixes on top of the merge · </span>}
              {fix.filesChanged.length} file
              {fix.filesChanged.length === 1 ? '' : 's'} changed
            </span>
            <DiffWrapToggle />
          </div>
          <div className="overflow-hidden rounded-ui bg-ui-surface text-ui-ink">
            <FileDiffView files={diffFiles} />
          </div>
        </div>
      )}
      {pushable && (
        <PushControls
          pr={pr}
          fix={fix}
          headInfo={headInfo}
          viewerCanPush={viewerCanPush}
        />
      )}
    </div>
  );
}

/**
 * THE MERGE of a fix with the "Resolve merge conflicts" item: Limn's check of the merge commit (its
 * parents, the conflict markers), the files that were in conflict, and the RESOLUTION — the agent's merge
 * commit against git's automatic merge with the markers, so each hunk shows how a conflict was settled —
 * apart from the fixes on top.
 */
function MergeResult({ merge, headSha }: { merge: AiFixMerge; headSha: string | null }): JSX.Element {
  const files = useMemo<DiffFile[]>(() => parseGitPatch(merge.resolutionDiff), [merge.resolutionDiff]);
  const line = fixMergeLine(merge, headSha);
  const n = merge.conflictedFiles.length;
  return (
    <div data-testid="ai-fix-merge" data-merge-status={merge.status} className="mt-2">
      <div className="mb-1 flex items-center gap-1.5 text-meta font-semibold text-ui-ink">
        <ConflictIcon size={12} />
        Merge of <span className="font-mono">{merge.baseRef}</span>
        <InfoButton title="How the conflicts were resolved">
          <p>
            The agent merged {merge.baseRef} into the PR in the sandbox and made a merge commit. Limn then
            checked it: the merge commit's parents must be the PR head and the {merge.baseRef} commit Limn
            picked, no conflict markers may be left in the files that were in conflict, and every other change
            must sit on top of the merge.
          </p>
          <p>
            The diff below compares the merge commit with git's own merge, conflict markers and all. Each
            hunk shows how one conflict was settled. Check for lines that are doubled or dropped.
          </p>
          <p>Push sends the merge commit and the fixes on top to the PR's branch. A merge that fails the check sends nothing.</p>
        </InfoButton>
      </div>
      <p
        data-testid="ai-fix-merge-check"
        className={`flex items-start gap-1.5 text-meta ${line.tone === 'ok' ? 'text-ui-success' : line.tone === 'bad' ? 'text-ui-danger' : 'text-ui-mute'}`}
      >
        {line.tone === 'ok' ? <CheckIcon size={12} className="mt-0.5 shrink-0" /> : line.tone === 'bad' ? <WarningIcon size={12} className="mt-0.5 shrink-0" /> : null}
        <span>{line.text}</span>
      </p>
      {n > 0 && (
        <p className="mt-0.5 break-words text-meta text-ui-mute">
          In conflict: <span className="font-mono">{merge.conflictedFiles.slice(0, 8).join(', ')}</span>
          {n > 8 ? `, and ${n - 8} more` : ''}
        </p>
      )}
      {files.length > 0 ? (
        <div data-testid="ai-fix-resolution" className="mt-2">
          <div className="mb-1 text-meta text-ui-mute">
            <span className="font-semibold text-ui-ink">How the conflicts were resolved</span> · {files.length} file
            {files.length === 1 ? '' : 's'}
          </div>
          <div className="overflow-hidden rounded-ui bg-ui-surface text-ui-ink">
            <FileDiffView files={files} />
          </div>
        </div>
      ) : (
        merge.status === 'valid' && n > 0 && (
          <p className="mt-1 text-meta text-ui-mute">The merge commit matches git's own merge outside the conflicts.</p>
        )
      )}
    </div>
  );
}

function PushedCard({ fix }: { fix: AiFix }): JSX.Element {
  return (
    <div className="mb-2 rounded-ui bg-ui-raise p-2 text-meta text-ui-success">
      <div>
        Pushed to <span className="font-mono">{fix.pushedBranch}</span>
        {fix.pushedPrUrl && (
          <>
            {' · '}
            <a
              href={safeExternalUrl(fix.pushedPrUrl)}
              target="_blank"
              rel="noreferrer"
              className="hit underline"
            >
              PR #{fix.pushedPrNumber}
            </a>
          </>
        )}
        {fix.pushedAt && <> · {relativeTime(fix.pushedAt)}</>}
      </div>
      {fix.commitMessage && (
        <div className="mt-1 font-mono text-meta text-ui-success">
          {fix.commitMessage}
        </div>
      )}
    </div>
  );
}

// The record of every EARLIER fix Pierre pushed for this PR (branch + commit message +
// where it landed). Surfaced because multiple fixes on one PR are common. The current
// fix (`currentFixId`) is excluded — it's already shown above as the result / PushedCard.
function FixHistory({
  history,
  currentFixId,
}: {
  history: AiFixSummary[];
  currentFixId: number | null;
}): JSX.Element | null {
  const pushed = history.filter(
    (h) => h.pushedAt != null && h.id !== currentFixId,
  );
  if (pushed.length === 0) return null;
  return (
    <div className="mt-6">
      <div className="mb-2 text-title text-ui-ink">
        Earlier fixes pushed
      </div>
      <ul className="space-y-2">
        {pushed.map((h) => (
          <li key={h.id} className="text-meta">
            <div className="font-mono text-ui-ink">
              {h.commitMessage ?? '(no commit message)'}
            </div>
            <div className="mt-0.5 text-meta text-ui-faint">
              {h.pushedBranch && (
                <span className="font-mono">{h.pushedBranch}</span>
              )}
              {h.pushedPrUrl && (
                <>
                  {' · '}
                  <a
                    href={safeExternalUrl(h.pushedPrUrl)}
                    target="_blank"
                    rel="noreferrer"
                    className="hit underline"
                  >
                    PR #{h.pushedPrNumber}
                  </a>
                </>
              )}
              {h.pushedAt && <> · {relativeTime(h.pushedAt)}</>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Push a finished fix as it is: onto the PR's own branch, or onto a new branch with a PR opened.
// There is no trunk step — no check against the trunk on mount and no rebase. A fix that conflicts
// with the trunk pushes as-is and the PR shows as conflicted on GitHub, unless the fix had the
// "Resolve merge conflicts" item: then it pushes only to the PR's own branch, and only a valid merge. The server never force-pushes this and refuses a push to the
// PR's own branch if that branch moved since the fix was generated.
function PushControls({
  pr,
  fix,
  headInfo,
  viewerCanPush,
}: {
  pr: PrDetail;
  fix: AiFix;
  headInfo: PrHeadInfo | null;
  viewerCanPush: boolean;
}): JSX.Element {
  const push = usePushFix(pr.id);

  const canPushSameBranch = headInfo?.canPushSameBranch ?? false;
  // A fix with the merge pushes ONLY to the PR's own branch (GitHub sees the conflict resolved there).
  const mergeOnly = fix.merge != null;
  const [target, setTarget] = useState<'existing' | 'new'>(
    canPushSameBranch ? 'existing' : 'new',
  );
  const [branch, setBranch] = useState(headInfo?.suggestedBranch ?? '');
  const branchRef = useRef(false);

  useEffect(() => {
    if (!branchRef.current && headInfo?.suggestedBranch) {
      setBranch(headInfo.suggestedBranch);
      branchRef.current = true;
      if (!headInfo.canPushSameBranch && !mergeOnly) setTarget('new');
    }
  }, [headInfo, mergeOnly]);

  // A pushed fix — to the PR's own branch or to a new one — is a record, nothing more.
  if (fix.pushedAt != null) return <PushedCard fix={fix} />;

  if (!viewerCanPush) {
    return (
      <p className="mt-2 text-meta text-ui-mute">
        You need write access to push this fix.
      </p>
    );
  }
  if (mergeOnly && !canPushSameBranch) {
    return (
      <p className="mt-2 text-meta text-ui-mute">
        A fix with a merge pushes only to the PR's own branch, and you can't push to it.
      </p>
    );
  }

  const effectiveTarget = mergeOnly ? 'existing' : target;
  const branchInvalid = effectiveTarget === 'new' && branch.trim().length === 0;
  const busy = push.isPending;

  const doPush = (): void => {
    push.mutate({
      fixId: fix.id,
      body: {
        target: effectiveTarget,
        branch: target === 'new' && !mergeOnly ? branch.trim() : undefined,
      },
    });
  };

  return (
    <div className="mt-3 rounded-ui bg-ui-surface p-2">
      {fix.commitMessage && (
        <div
          className="mb-2 rounded-ui bg-ui-surface px-2 py-1 font-mono text-meta text-ui-ink"
          title="Commit message"
        >
          {fix.commitMessage}
        </div>
      )}

      <label
        className={`flex items-center gap-2 text-meta ${
          canPushSameBranch ? '' : 'opacity-40'
        }`}
        title={
          canPushSameBranch
            ? undefined
            : 'The PR head is a fork you cannot push to — use a new branch'
        }
      >
        <RadioBox
          className="mt-0"
          checked={effectiveTarget === 'existing'}
          disabled={!canPushSameBranch || busy}
          onChange={() => setTarget('existing')}
        />
        Push to the PR branch
        {headInfo?.headRef && (
          <span className="font-mono text-ui-faint">({headInfo.headRef})</span>
        )}
      </label>
      {!mergeOnly && (
        <label className="mt-1 flex items-center gap-2 text-meta">
          <RadioBox
            className="mt-0"
            checked={target === 'new'}
            disabled={busy}
            onChange={() => setTarget('new')}
          />
          New branch + open a PR
        </label>
      )}
      {target === 'new' && !mergeOnly && (
        <input
          type="text"
          className="mt-1 w-full rounded-ui bg-ui-raise px-2 py-1 font-mono text-meta ring-1 ring-inset ring-ui-line focus:outline-none focus:ring-2 focus:ring-ui-accent touch:min-h-10"
          value={branch}
          disabled={busy}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="branch-name"
        />
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={busy || branchInvalid}
          onClick={doPush}
        >
          {busy ? 'Pushing…' : effectiveTarget === 'new' ? 'Push + open PR' : 'Push'}
        </button>
        {/* "Run tests": the results' one line. Push works whatever they say. */}
        <ChecksStatus checks={fix.checks} />
      </div>

      {push.isError && (
        <div className="mt-2 text-meta text-ui-danger">{errText(push.error)}</div>
      )}
    </div>
  );
}

/** THE FIX START QUEUE: the PR's fix waits for a free sandbox; Cancel takes it out of line (nothing ran). */
function FixWaitingLine({ prId, line }: { prId: number; line: string | null }): JSX.Element {
  const cancel = useCancelFix(prId);
  return (
    <div data-testid="ai-fix-waiting" className="mb-3 flex flex-wrap items-center gap-2 rounded-ui bg-ui-raise px-3 py-2 text-meta text-ui-ink">
      <span>{line}</span>
      <button type="button" className={BTN_SECONDARY} disabled={cancel.isPending} onClick={() => cancel.mutate()}>
        Cancel
      </button>
    </div>
  );
}

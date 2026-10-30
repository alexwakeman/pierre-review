import { useEffect, useMemo, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  aiPickerRequestModel,
  aiProviderName,
  aiRunProviderName,
  aiRunLabel,
  DEFAULT_AI_FIX_MODEL,
  type AiFix,
  type AiFixStatus,
  type AiFixSummary,
  type PrDetail,
  type PrHeadInfo,
} from '@pierre-review/shared';
import { relativeTime, safeExternalUrl } from '../lib/ui.js';
// The fix run's phase ladder lives in lib/ so this tab and the bottom-right AiFixBanner cannot
// print two different percentages for one run.
import { PHASE_LABEL, fixProgressPct } from '../lib/aiFixProgress.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { AiRunGate } from './AiSetup.js';
import { useMe } from '../hooks/useTriage.js';
import { aiProviderReadyFor } from '../lib/aiCapabilities.js';
import { useModelPick } from '../hooks/useModelPick.js';
import { ModelPicker } from './ModelPicker.js';
import { useFilters } from '../store/filters.js';
import {
  aiFixStartMutationKey,
  useAiFix,
  useAiFixPreview,
  useAiFixStream,
  useCancelFix,
  usePushFix,
  useStartFix,
  useStartPlan,
} from '../hooks/useAiFix.js';
import { ApprovedPlanNote, PlanPanel } from './AiFix/PlanPanel.js';
import { useClaudeReview, useClaudeReviewById } from '../hooks/useClaudeReview.js';
import { fixSourceReviewId, olderSourceNote } from '../lib/aiFixSource.js';
import { ApiError } from '../api/client.js';
import { FixReport, fixSourceLine } from './AiFix/FixReport.js';
import { FixPicker } from './AiFix/FixPicker.js';
import { budgetCutKeys, pickedKeys, type PickerOverrides } from './AiFix/fixPickerModel.js';
import { Markdown } from './Markdown.js';
import { DiffWrapToggle, FileDiffView, type DiffFile } from './diff/FileDiffView.js';
import { parseGitPatch } from '../lib/diff.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { InfoButton } from './InfoModal.js';
import { ConflictAiCard, resolverTargetOf, usePrConflictsResolvable } from './AiFix/ConflictAiCard.js';
import { startConflictAiRun } from '../hooks/useConflictAiResolve.js';

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

// THE AI FIX TAB is the fixer and nothing else: the CI list, the AI summary and the free-text
// instruction box left it (the start route still accepts a plain seed, for history; the SPA no
// longer offers one). A fix is always seeded from a SUCCEEDED Claude review, through the FIX PICKER
// (AiFix/FixPicker.tsx): the server lists every item with a stable key and its default, the reader
// ticks, Start sends the ticked keys.
export function AiFixTab({ pr }: { pr: PrDetail }): JSX.Element {
  // FREE and local-only (`me.ai`).
  const aiFix = useAiCapabilities().enabled;
  const aiFixTabFocus = useFilters((s) => s.aiFixTabFocus);
  const consumeAiFixTabFocus = useFilters((s) => s.consumeAiFixTabFocus);

  // The review picked in the Claude Review tab ("Generate fix from this review"), delivered via the
  // store and consumed into local state on arrival. Absent ⇒ the PR's latest review.
  const [handoffReviewId, setHandoffReviewId] = useState<number | null>(null);
  useEffect(() => {
    if (aiFixTabFocus && aiFixTabFocus.prId === pr.id) {
      if (aiFixTabFocus.reviewId != null) setHandoffReviewId(aiFixTabFocus.reviewId);
      consumeAiFixTabFocus();
    }
  }, [aiFixTabFocus, pr.id, consumeAiFixTabFocus]);

  if (!aiFix) return <></>;

  return (
    <div className="pb-6">
      <FixerSection pr={pr} handoffReviewId={handoffReviewId} />
    </div>
  );
}

// ---- The agentic fixer ----

function FixerSection({
  pr,
  handoffReviewId,
}: {
  pr: PrDetail;
  handoffReviewId: number | null;
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
  const cancelFix = useCancelFix(pr.id);
  // "Plan first" (plan mode, manual only): a read-only planning pass the reader steers and approves
  // before anything is built. Off by default. When the PICKED provider cannot run a plan, there is no
  // checkbox and none is sent — "Make a plan" would only fail.
  const ai = useAiCapabilities();
  const canPlan = aiProviderReadyFor(me, modelPick.chosen.provider, 'plan');
  const [planFirstPicked, setPlanFirst] = useState(false);
  const planFirst = planFirstPicked && canPlan;

  const noteAiFixRun = useFilters((s) => s.noteAiFixRun);
  // In-flight read off the SHARED start key, not this mount's `startFix.isPending` — a per-mount
  // flag resets on a tab switch mid-start, inviting a second BILLED agent turn.
  const fixStarting =
    useIsMutating({ mutationKey: aiFixStartMutationKey(pr.id) }) > 0;

  const dbStatus = data?.fix?.status ?? null;
  // A row holding an open plan ('planned'): its passes are shown by the plan panel, never as a build.
  const planRow = dbStatus === 'planned';
  const planPassInDb = planRow && data?.fix?.plan?.status === 'planning';
  // ⚠ NOT while a plan action's POST is in flight (message, approve): the row still reads
  // 'planned' until it answers, a stream opened then closes on that, and `active` would stay true
  // through the refetch, so it never reopened for the pass or the build. The POST's refetch
  // (planning / queued) is what opens the stream; the plan panel shows the wait meanwhile.
  const active = dbStatus === 'running' || dbStatus === 'queued' || fixStarting || planPassInDb;
  const { status: liveStatus } = useAiFixStream(pr.id, active);
  const displayStatus: AiFixStatus | 'idle' =
    liveStatus?.status ?? dbStatus ?? 'idle';
  const liveRunning = displayStatus === 'running' || displayStatus === 'queued';
  const isRunning = liveRunning && !planRow;
  const planPassRunning = planRow && (planPassInDb || liveRunning);
  // An open plan: being made, or waiting for the reader. The picker stays shut until it ends.
  const planOpen = planRow && (data?.fix?.plan?.status === 'planning' || data?.fix?.plan?.status === 'plan_ready');

  const fix = data?.fix ?? null;

  // The picker: the server's items for this review, the reader's ticks on top. A new review (or a
  // hand-over) starts from the defaults again.
  const preview = useAiFixPreview(pr.id, reviewId, data?.enabled !== false);
  // The source review in full, so the picker can draw each item with the Claude Review tab's own
  // card: the latest is already loaded; an older hand-over is one DB-only read (the history
  // selector's query).
  const olderSource = useClaudeReviewById(reviewId != null && latest?.id !== reviewId ? reviewId : null);
  const sourceReview = reviewId != null && latest?.id === reviewId ? latest : (olderSource.data ?? null);
  const [overrides, setOverrides] = useState<PickerOverrides>({});
  useEffect(() => setOverrides({}), [reviewId]);
  // With a finished fix on screen the picker folds away behind "New fix"; it is open otherwise.
  const [pickerOpen, setPickerOpen] = useState(false);
  const showPicker = !planOpen && (pickerOpen || !fix || fix.status !== 'succeeded');

  // "Resolve with Claude", offered beside a review fix ONLY when the branch conflicts (the
  // resolver entry's own gate). OFF by default; a separate run with a separate result — the merge
  // lands from the resolver as its own commit, never folded into the fix.
  const conflictsResolvable = usePrConflictsResolvable(pr);
  const [alsoResolve, setAlsoResolve] = useState(false);

  const picked = preview.data ? pickedKeys(preview.data, overrides) : [];
  const cutCount = preview.data ? budgetCutKeys(preview.data, overrides).size : 0;

  const startFromReview = (): void => {
    if (reviewId == null || !preview.data || picked.length === 0) return;
    // The run goes to the provider the menu picked (the server validates the pair).
    const body = {
      model: modelPick.chosen.model,
      provider: modelPick.chosen.provider,
      seed: 'review' as const,
      sourceReviewId: reviewId,
      include: picked,
    };
    if (planFirst) {
      // A plan is read in this tab; the banner follows the BUILD, from "Approve and build".
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
    // The merge half: its own run, opening the resolver when Claude's answer is ready. Started on
    // the PRESS, not in a mutate()-scoped callback (lost if this tab unmounts before the fix POST
    // answers) — it does not depend on the fix's result.
    // The resolver has no model menu: it runs on the DEFAULT provider, at the picked depth.
    if (alsoResolve && conflictsResolvable)
      startConflictAiRun(resolverTargetOf(pr), {
        model: aiPickerRequestModel(modelPick.chosen.model),
        providerName: ai.providerName,
      });
  };

  return (
    <div>
      <SectionTitle
        info={
          <InfoButton title="AI Fix">
            <p>
              {pickedName} reads the PR's code and edits files in a private copy. It has no shell, so it
              installs, builds and tests nothing.
            </p>
            <p>
              A fix starts from an AI review. Pick what it should work on: the review's findings,
              earlier findings still open, threads the review says need a fix, unanswered threads, CI
              failures and ticket gaps are ticked; style bot comments are not.
            </p>
            <p>
              Tick Plan first to read {pickedName}'s plan, steer it and approve it before anything changes.
            </p>
            <p>{pickedName} reports what it changed in each file and what it left alone, and why.</p>
            <p>
              Nothing is pushed until you press Push. An automatic fix on your own PR is pushed for
              you only when Push automatically is on in Settings.
            </p>
          </InfoButton>
        }
      >
        AI Fix
      </SectionTitle>
      <div className="px-4">
        {conflictsResolvable && <ConflictAiCard pr={pr} />}
        {data?.enabled === false ? (
          <p className="text-body text-gray-500 dark:text-gray-400">
            The agentic fixer is turned off.
          </p>
        ) : (
          <>
            {!isRunning && !planOpen && reviewId == null && !reviewLoading && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-meta text-gray-600 dark:text-gray-300">
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

            {!isRunning && !planOpen && reviewId != null && !showPicker && (
              <button type="button" className={BTN_SECONDARY} onClick={() => setPickerOpen(true)}>
                New fix
              </button>
            )}

            {!isRunning && reviewId != null && showPicker && (
              <div>
                {olderNote && (
                  <p className="mb-2 text-meta text-gray-500 dark:text-gray-400">{olderNote}</p>
                )}
                {preview.isLoading && (
                  <p className="text-meta text-gray-500 dark:text-gray-400">Loading…</p>
                )}
                {preview.isError && (
                  <p className="text-meta text-red-600 dark:text-red-400">{errText(preview.error)}</p>
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
                {preview.data && preview.data.items.length > 0 && conflictsResolvable && (
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-meta text-gray-800 dark:text-gray-100">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-ui-accent-fill"
                      checked={alsoResolve}
                      disabled={fixStarting}
                      onChange={(e) => setAlsoResolve(e.target.checked)}
                    />
                    <span>
                      Also resolve merge conflicts with {pr.baseRefName ?? 'the base branch'}
                      <span className="block text-meta text-gray-600 dark:text-gray-300">
                        You check the merge in the resolver. It lands as its own commit, apart from the fix.
                      </span>
                    </span>
                  </label>
                )}
                {preview.data && preview.data.items.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <ModelPicker state={modelPick} onPick={modelPick.pick} disabled={fixStarting} />
                    {canPlan && (
                      <label className="flex cursor-pointer items-center gap-1.5 text-meta text-gray-800 dark:text-gray-100">
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 accent-ui-accent-fill"
                          checked={planFirst}
                          disabled={fixStarting}
                          onChange={(e) => setPlanFirst(e.target.checked)}
                        />
                        Plan first
                      </label>
                    )}
                    {/* No AI runtime or no Claude credential: one line (or the one-time setup) in
                        place of the start button. */}
                    {/* Any provider that can fix may run it (the menu lists those); "Plan first" shows
                        only when the PICKED one can also plan (canPlan). */}
                    <AiRunGate kind="fix" auth={data?.auth} anyProvider provider={modelPick.chosen.provider}>
                      <button
                        type="button"
                        className={BTN_PRIMARY}
                        disabled={fixStarting || picked.length === 0}
                        onClick={startFromReview}
                      >
                        {planFirst ? 'Make a plan' : 'Start fix'}
                      </button>
                    </AiRunGate>
                    <span className="text-meta text-gray-500 dark:text-gray-400">
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

            {isRunning && (
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => cancelFix.mutate()}
              >
                Cancel
              </button>
            )}
            {(startFix.isError || startPlan.isError) && (
              <p className="mt-1 text-meta text-red-600 dark:text-red-400">
                {errText(startFix.error ?? startPlan.error)}
              </p>
            )}

            {fix && planRow && (
              <PlanPanel
                pr={pr}
                fix={fix}
                liveStatus={liveStatus}
                passRunning={planPassRunning}
                auth={data?.auth}
              />
            )}

            {isRunning && (
              <div className="mt-3">
                {fix && <ApprovedPlanNote fix={fix} />}
                <RegenProgressBar
                  active
                  label="Running AI fix"
                  value={fixProgressPct(liveStatus)}
                  timeConstantSec={40}
                />
                <div className="mt-1 flex items-center gap-2 text-meta text-gray-500 dark:text-gray-400">
                  {fix?.trigger === 'auto' && <AutoFixChip />}
                  {PHASE_LABEL[liveStatus?.progress?.phase ?? ''] ?? 'Working…'}
                </div>
                {liveStatus?.progress?.recentActivity &&
                  liveStatus.progress.recentActivity.length > 0 && (
                    <pre className="mt-1 max-h-32 overflow-auto rounded-ui bg-gray-50 p-2 text-meta leading-relaxed text-gray-500 dark:text-gray-400 dark:bg-gray-900">
                      {liveStatus.progress.recentActivity.slice(-8).join('\n')}
                    </pre>
                  )}
              </div>
            )}

            {!isRunning && fix && !planRow && (
              <FixResult
                pr={pr}
                fix={fix}
                headInfo={data?.headInfo ?? null}
                viewerCanPush={data?.viewerCanPush ?? false}
              />
            )}
            {isLoading && !fix && (
              <p className="mt-3 text-meta text-gray-500 dark:text-gray-400">Loading…</p>
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

// A fix the auto review started (after an auto review of the reader's own PR). It waits for Push
// like any other, unless the workspace switched "Push automatically" on.
function AutoFixChip(): JSX.Element {
  return (
    <span className="inline-flex items-center rounded-ui bg-gray-500/10 px-1.5 py-px text-meta font-medium text-gray-600 dark:text-gray-300">
      Auto fix
    </span>
  );
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

  // Plan mode: a first planning pass that produced no plan, and a plan the reader discarded.
  if (fix.status === 'failed' && fix.plan?.status === 'failed') {
    return (
      <div className="mt-3 rounded-ui border border-red-200 bg-red-50 p-2 text-meta text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
        {aiRunProviderName(fix.plan ?? fix)} could not make a plan: {fix.error ?? 'unknown error'}
      </div>
    );
  }
  if (fix.status === 'cancelled' && fix.plan?.status === 'discarded') {
    return <p className="mt-3 text-meta text-gray-500 dark:text-gray-400">The plan was discarded.</p>;
  }
  if (fix.status === 'failed') {
    return (
      <div className="mt-3 rounded-ui border border-red-200 bg-red-50 p-2 text-meta text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
        The fix run failed: {fix.error ?? 'unknown error'}
      </div>
    );
  }
  if (fix.status === 'cancelled') {
    return (
      <p className="mt-3 text-meta text-gray-500 dark:text-gray-400">The fix run was cancelled.</p>
    );
  }
  if (fix.status !== 'succeeded') return <></>;

  const noChanges = !fix.patch || fix.filesChanged.length === 0;

  return (
    <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-800">
      <p className="mb-1 text-meta text-gray-500 dark:text-gray-400">
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
      {fix.pushedAt == null && fix.error && (
        <p className="mb-2 rounded-ui border border-amber-200 bg-amber-50 p-2 text-meta text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          {fix.error}
        </p>
      )}
      <ApprovedPlanNote fix={fix} />
      {fix.summary && (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <Markdown>{fix.summary}</Markdown>
        </div>
      )}
      {/* Mounted ABOVE the "no changes" branch: a run that judged every item wrong produces no
          diff at all, and that is exactly the run whose "Not addressed" list matters most. */}
      <FixReport pr={pr} fix={fix} />
      {noChanges ? (
        <p className="mt-2 text-meta text-gray-500 dark:text-gray-400">
          No files changed.
        </p>
      ) : (
        <>
          <div className="mb-1 mt-2 flex items-center justify-between gap-3 text-meta text-gray-500 dark:text-gray-400">
            {/* "Not built or tested here." is TEMPLATED and sits beside the diff, above Push: the
                fixer has no shell (coding/agent.ts FIX_TOOLS), and a diff above a Push button
                invites the reader to assume verification. It states what we know and STOPS —
                it must not promise CI either (`ciStatusFrom(null)` is 'unknown' for whole repos;
                CLAUDE.md § The fix agent has no shell). */}
            <span>
              {fix.filesChanged.length} file
              {fix.filesChanged.length === 1 ? '' : 's'} changed · Not built or tested here.
            </span>
            <DiffWrapToggle />
          </div>
          <div className="overflow-hidden rounded-ui bg-ui-surface text-ui-ink">
            <FileDiffView files={diffFiles} />
          </div>
          <PushControls
            pr={pr}
            fix={fix}
            headInfo={headInfo}
            viewerCanPush={viewerCanPush}
          />
        </>
      )}
    </div>
  );
}

function PushedCard({ fix }: { fix: AiFix }): JSX.Element {
  return (
    <div className="mb-2 rounded-ui border border-green-200 bg-green-50 p-2 text-meta text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300">
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
        <div className="mt-1 font-mono text-meta text-green-800 dark:text-green-300">
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
            <div className="font-mono text-gray-700 dark:text-gray-200">
              {h.commitMessage ?? '(no commit message)'}
            </div>
            <div className="mt-0.5 text-meta text-gray-400">
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
// There is no trunk step — no check against the trunk on mount, no rebase or merge, and no
// "let Claude resolve conflicts". A fix that conflicts with the trunk pushes as-is and the PR
// shows as conflicted on GitHub. The server never force-pushes this and refuses a push to the
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
  const [target, setTarget] = useState<'existing' | 'new'>(
    canPushSameBranch ? 'existing' : 'new',
  );
  const [branch, setBranch] = useState(headInfo?.suggestedBranch ?? '');
  const branchRef = useRef(false);

  useEffect(() => {
    if (!branchRef.current && headInfo?.suggestedBranch) {
      setBranch(headInfo.suggestedBranch);
      branchRef.current = true;
      if (!headInfo.canPushSameBranch) setTarget('new');
    }
  }, [headInfo]);

  // A pushed fix — to the PR's own branch or to a new one — is a record, nothing more.
  if (fix.pushedAt != null) return <PushedCard fix={fix} />;

  if (!viewerCanPush) {
    return (
      <p className="mt-2 text-meta text-gray-500 dark:text-gray-400">
        You need write access to push this fix.
      </p>
    );
  }

  const branchInvalid = target === 'new' && branch.trim().length === 0;
  const busy = push.isPending;

  const doPush = (): void => {
    push.mutate({
      fixId: fix.id,
      body: {
        target,
        branch: target === 'new' ? branch.trim() : undefined,
      },
    });
  };

  return (
    <div className="mt-3 rounded-ui bg-ui-surface p-2">
      {fix.commitMessage && (
        <div
          className="mb-2 rounded-ui bg-gray-50 px-2 py-1 font-mono text-meta text-gray-700 dark:bg-gray-900 dark:text-gray-200"
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
        <input
          type="radio"
          className="h-4 w-4 shrink-0 accent-ui-accent-fill"
          checked={target === 'existing'}
          disabled={!canPushSameBranch || busy}
          onChange={() => setTarget('existing')}
        />
        Push to the PR branch
        {headInfo?.headRef && (
          <span className="font-mono text-gray-400">({headInfo.headRef})</span>
        )}
      </label>
      <label className="mt-1 flex items-center gap-2 text-meta">
        <input
          type="radio"
          className="h-4 w-4 shrink-0 accent-ui-accent-fill"
          checked={target === 'new'}
          disabled={busy}
          onChange={() => setTarget('new')}
        />
        New branch + open a PR
      </label>
      {target === 'new' && (
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
          {busy ? 'Pushing…' : target === 'new' ? 'Push + open PR' : 'Push'}
        </button>
      </div>

      {push.isError && (
        <div className="mt-2 text-meta text-red-500">{errText(push.error)}</div>
      )}
    </div>
  );
}

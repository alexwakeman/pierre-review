import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CLAUDE_REVIEW_MODELS,
  CLAUDE_REVIEW_MODEL_LABELS,
  type AiConfidence,
  type AiFix,
  type AiFixMergePreview,
  type AiFixModel,
  type AiFixPushStrategy,
  type AiFixResolved,
  type AiFixResolveStatusResponse,
  type AiFixSeed,
  type AiFixStatus,
  type AiFixStatusResponse,
  type AiFixSummary,
  type FailingCheckInput,
  type PrDetail,
  type PrHeadInfo,
} from '@pierre-review/shared';
import { ApiError } from '../api/client.js';
import { relativeTime, safeExternalUrl } from '../lib/ui.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { useFilters } from '../store/filters.js';
import {
  useAiFix,
  useAiFixJobStream,
  useAiFixStream,
  useCancelFix,
  useCancelPush,
  useCancelRebase,
  useCiAnalysis,
  useMergePreview,
  usePushFix,
  useRefreshCiAnalysis,
  useStartFix,
  useStartRebase,
} from '../hooks/useAiFix.js';
import { Markdown } from './Markdown.js';
import { FileDiffView, type DiffFile } from './diff/FileDiffView.js';
import { parseGitPatch } from '../lib/diff.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { ChecksList, CiRerunControl } from './CheckList.js';
import { AiSummary } from './AiSummary.js';

const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const BTN_SECONDARY =
  'whitespace-nowrap rounded border border-gray-300 px-2.5 py-1 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';

const PHASE_LABEL: Record<string, string> = {
  fetching_diff: 'Reading the PR',
  cloning: 'Checking out the code',
  fixing: 'Applying the fix',
  capturing: 'Capturing changes',
  persisting: 'Saving',
};

// Map the live phase (+ activity depth) to a determinate 0–100 reading.
function fixProgressPct(status: AiFixStatusResponse | null): number | null {
  if (!status || status.status === 'idle') return null;
  if (status.status === 'queued') return 6;
  const p = status.progress;
  if (!p) return 10;
  switch (p.phase) {
    case 'fetching_diff':
      return 12;
    case 'cloning':
      return 28;
    case 'fixing':
      return Math.min(90, 45 + (p.recentActivity?.length ?? 0) * 3);
    case 'capturing':
      return 92;
    case 'persisting':
      return 96;
    default:
      return 20;
  }
}

const RESOLVE_PHASE_LABEL: Record<string, string> = {
  cloning: 'Checking out the code',
  applying_fix: 'Applying the fix',
  fetching_trunk: 'Fetching the trunk',
  rebasing: 'Rebasing onto the trunk',
  merging: 'Merging the trunk in',
  resolving_conflicts: 'Resolving conflicts with Claude',
  verifying: 'Verifying the result',
  pushing: 'Pushing',
};

// Map the resolve/merge/push phases to a determinate 0–100 reading.
function resolveProgressPct(status: AiFixResolveStatusResponse | null): number | null {
  if (!status || status.status === 'idle') return null;
  if (status.status === 'queued') return 6;
  const p = status.progress;
  if (!p) return 10;
  switch (p.phase) {
    case 'cloning':
      return 15;
    case 'applying_fix':
      return 25;
    case 'fetching_trunk':
      return 35;
    case 'rebasing':
    case 'merging':
      return 45;
    case 'resolving_conflicts':
      return Math.min(90, 55 + (p.recentActivity?.length ?? 0) * 3);
    case 'verifying':
      return 92;
    case 'pushing':
      return 96;
    default:
      return 20;
  }
}

function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
      {children}
    </div>
  );
}

const CONFIDENCE_STYLE: Record<AiConfidence, string> = {
  high: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  low: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
};

function ConfidenceBadge({
  label,
  value,
}: {
  label: string;
  value: AiConfidence | null;
}): JSX.Element | null {
  if (!value) return null;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${CONFIDENCE_STYLE[value]}`}
      title={
        label === 'Fixability'
          ? "How confident the analysis is that Pierre's agent could fix this"
          : 'How confident the analysis is about the root cause'
      }
    >
      {label}: {value}
    </span>
  );
}

export function AiFixTab({ pr }: { pr: PrDetail }): JSX.Element {
  const { aiAnalysis, aiFix } = useProCapabilities();
  const aiFixTabFocus = useFilters((s) => s.aiFixTabFocus);
  const consumeAiFixTabFocus = useFilters((s) => s.consumeAiFixTabFocus);

  // A review to seed the fixer with, delivered via the store from ClaudeReviewTab's
  // "Generate fix from this review". Consumed into local state on arrival.
  const [seedReviewText, setSeedReviewText] = useState<string | null>(null);
  useEffect(() => {
    if (aiFixTabFocus && aiFixTabFocus.prId === pr.id) {
      if (aiFixTabFocus.reviewText) setSeedReviewText(aiFixTabFocus.reviewText);
      consumeAiFixTabFocus();
    }
  }, [aiFixTabFocus, pr.id, consumeAiFixTabFocus]);

  if (!aiAnalysis && !aiFix) {
    return (
      <div className="p-4 text-sm text-gray-500">
        AI Analysis and Fix is not enabled.
      </div>
    );
  }

  return (
    <div className="pb-6">
      {aiAnalysis && (
        <div className="border-b border-gray-200 dark:border-gray-800">
          <AiSummary pr={pr} />
        </div>
      )}
      <CiStatusSection pr={pr} />
      {aiAnalysis && <CiAnalysisSection pr={pr} canFix={aiFix} />}
      {aiFix && (
        <FixerSection
          pr={pr}
          seedReviewText={seedReviewText}
          onSeedConsumed={() => setSeedReviewText(null)}
        />
      )}
    </div>
  );
}

// ---- CI status (the same checks list as the Overview tab, plus re-trigger) ----

function CiStatusSection({ pr }: { pr: PrDetail }): JSX.Element | null {
  const checks = pr.checkRuns;
  if (checks.length === 0) return null;
  return (
    <div className="border-b border-gray-200 dark:border-gray-800">
      <SectionTitle>CI status</SectionTitle>
      <div className="px-4 pb-3">
        <ChecksList prId={pr.id} checks={checks} />
        <CiRerunControl
          prId={pr.id}
          checks={checks}
          viewerCanPush={pr.viewerCanPush}
        />
      </div>
    </div>
  );
}

// ---- CI failure analysis ----

function CiAnalysisSection({
  pr,
  canFix,
}: {
  pr: PrDetail;
  canFix: boolean;
}): JSX.Element | null {
  const { data } = useCiAnalysis(pr.id, true);
  const refresh = useRefreshCiAnalysis(pr.id);
  const startFix = useStartFix(pr.id);

  // ALL failing checks (name + optional Actions jobId), not just Actions jobs — so an
  // external gate (SonarCloud etc.) with no jobId is still analyzed.
  const failingChecks: FailingCheckInput[] = useMemo(
    () =>
      pr.checkRuns
        .filter((c) => c.state === 'failure' || c.state === 'error')
        .map((c) => ({ name: c.name, jobId: c.jobId, state: c.state })),
    [pr.checkRuns],
  );
  const hasFailures = failingChecks.length > 0 || (data?.hasFailures ?? false);

  // Only offer CI analysis when there's actually a failure to analyze.
  if (!hasFailures && !data?.analysis) return null;

  const lowFixability = data?.fixability === 'low';

  return (
    <div className="border-b border-gray-200 dark:border-gray-800">
      <SectionTitle>CI failure analysis</SectionTitle>
      <div className="px-4 pb-3">
        {data?.analysis && (data.rootCauseConfidence || data.fixability) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className="text-[10px] font-semibold uppercase tracking-wide text-gray-400"
              title="How confident the analysis is — not a severity rating"
            >
              Confidence
            </span>
            <ConfidenceBadge label="Root cause" value={data.rootCauseConfidence} />
            <ConfidenceBadge label="Fixability" value={data.fixability} />
          </div>
        )}
        {data?.analysis ? (
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <Markdown>{data.analysis}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            Diagnose the failing CI: likely root cause + a suggested fix, from the
            full logs of every failing check.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN_SECONDARY}
            disabled={refresh.isPending || failingChecks.length === 0}
            onClick={() => refresh.mutate(failingChecks)}
          >
            {refresh.isPending
              ? 'Analyzing…'
              : data?.analysis
                ? 'Re-analyze'
                : 'Analyze CI failure'}
          </button>
          {canFix && data?.analysis && (
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={startFix.isPending}
              onClick={() =>
                startFix.mutate({ model: 'claude-sonnet-5', seed: 'ci_analysis' })
              }
              title="Launch an agent to fix the CI failure"
            >
              Fix it →
            </button>
          )}
          {canFix && lowFixability && data?.analysis && (
            <span className="text-[11px] text-gray-500">
              low confidence this is auto-fixable
            </span>
          )}
          {refresh.isError && (
            <span className="text-[11px] text-red-500">
              {errText(refresh.error)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- The agentic fixer ----

function FixerSection({
  pr,
  seedReviewText,
  onSeedConsumed,
}: {
  pr: PrDetail;
  seedReviewText: string | null;
  onSeedConsumed: () => void;
}): JSX.Element {
  const { data, isLoading } = useAiFix(pr.id, true);
  const [model, setModel] = useState<AiFixModel>('claude-sonnet-5');
  const startFix = useStartFix(pr.id);
  const cancelFix = useCancelFix(pr.id);

  const dbStatus = data?.fix?.status ?? null;
  const active =
    dbStatus === 'running' || dbStatus === 'queued' || startFix.isPending;
  const { status: liveStatus } = useAiFixStream(pr.id, active);
  const displayStatus: AiFixStatus | 'idle' =
    liveStatus?.status ?? dbStatus ?? 'idle';
  const isRunning = displayStatus === 'running' || displayStatus === 'queued';

  const seed: AiFixSeed = seedReviewText
    ? 'review'
    : 'plain';

  const start = (): void => {
    startFix.mutate(
      {
        model,
        seed,
        reviewText: seedReviewText ?? undefined,
      },
      { onSuccess: () => onSeedConsumed() },
    );
  };

  const fix = data?.fix ?? null;

  return (
    <div>
      <SectionTitle>AI Fix</SectionTitle>
      <div className="px-4">
        {data?.enabled === false ? (
          <p className="text-sm text-gray-500">
            The agentic fixer is disabled.
          </p>
        ) : data?.auth === 'none' ? (
          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            {data.authMessage ??
              'No Claude authentication found. Sign in to Claude or set an API key, then restart.'}
          </p>
        ) : (
          <>
            {seedReviewText && !isRunning && (
              <div className="mb-2 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
                Ready to generate a fix from the selected review.
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded border border-gray-300 bg-transparent px-2 py-1 text-xs dark:border-gray-700"
                value={model}
                onChange={(e) => setModel(e.target.value as AiFixModel)}
                disabled={isRunning}
              >
                {CLAUDE_REVIEW_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {CLAUDE_REVIEW_MODEL_LABELS[m]}
                  </option>
                ))}
              </select>
              {isRunning ? (
                <button
                  type="button"
                  className={BTN_SECONDARY}
                  onClick={() => cancelFix.mutate()}
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  disabled={startFix.isPending}
                  onClick={start}
                >
                  {fix ? 'Generate new fix' : 'Generate fix'}
                </button>
              )}
              {startFix.isError && (
                <span className="text-[11px] text-red-500">
                  {errText(startFix.error)}
                </span>
              )}
            </div>

            {isRunning && (
              <div className="mt-3">
                <RegenProgressBar
                  active
                  label="Running AI fix"
                  value={fixProgressPct(liveStatus)}
                  timeConstantSec={40}
                />
                <div className="mt-1 text-[11px] text-gray-500">
                  {PHASE_LABEL[liveStatus?.progress?.phase ?? ''] ?? 'Working…'}
                </div>
                {liveStatus?.progress?.recentActivity &&
                  liveStatus.progress.recentActivity.length > 0 && (
                    <pre className="mt-1 max-h-32 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-500 dark:bg-gray-900">
                      {liveStatus.progress.recentActivity.slice(-8).join('\n')}
                    </pre>
                  )}
              </div>
            )}

            {!isRunning && fix && (
              <FixResult
                pr={pr}
                fix={fix}
                headInfo={data?.headInfo ?? null}
                viewerCanPush={data?.viewerCanPush ?? false}
              />
            )}
            {isLoading && !fix && (
              <p className="mt-3 text-xs text-gray-400">Loading…</p>
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

  if (fix.status === 'failed') {
    return (
      <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
        The fix run failed: {fix.error ?? 'unknown error'}
      </div>
    );
  }
  if (fix.status === 'cancelled') {
    return (
      <p className="mt-3 text-xs text-gray-500">The fix run was cancelled.</p>
    );
  }
  if (fix.status !== 'succeeded') return <></>;

  const noChanges = !fix.patch || fix.filesChanged.length === 0;

  return (
    <div className="mt-3">
      {fix.summary && (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <Markdown>{fix.summary}</Markdown>
        </div>
      )}
      {noChanges ? (
        <p className="mt-2 text-xs text-gray-500">The agent made no changes.</p>
      ) : (
        <>
          <div className="mb-1 mt-2 text-[11px] text-gray-500">
            {fix.filesChanged.length} file
            {fix.filesChanged.length === 1 ? '' : 's'} changed
          </div>
          <div className="overflow-hidden rounded border border-gray-200 text-gray-800 dark:border-gray-800 dark:text-gray-200">
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
    <div className="mb-2 rounded border border-green-200 bg-green-50 p-2 text-xs text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300">
      <div>
        Pushed to <span className="font-mono">{fix.pushedBranch}</span>
        {fix.pushedPrUrl && (
          <>
            {' · '}
            <a
              href={safeExternalUrl(fix.pushedPrUrl)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              PR #{fix.pushedPrNumber}
            </a>
          </>
        )}
        {fix.pushedAt && <> · {relativeTime(fix.pushedAt)}</>}
      </div>
      {fix.commitMessage && (
        <div className="mt-1 font-mono text-[11px] text-green-800 dark:text-green-300">
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
    <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Fixes pushed via Pierre
      </div>
      <ul className="space-y-2">
        {pushed.map((h) => (
          <li key={h.id} className="text-xs">
            <div className="font-mono text-gray-700 dark:text-gray-200">
              {h.commitMessage ?? '(no commit message)'}
            </div>
            <div className="mt-0.5 text-[11px] text-gray-400">
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
                    className="underline"
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

// The fix branch's state vs the trunk, once the preview lands.
function TrunkStatus({
  preview,
  loading,
}: {
  preview: AiFixMergePreview | null;
  loading: boolean;
}): JSX.Element | null {
  if (loading) {
    return (
      <p className="text-[11px] text-gray-400">Checking against the trunk…</p>
    );
  }
  if (!preview || !preview.available || !preview.trunkSha) return null;
  if (!preview.clean) {
    const files = preview.conflictFiles;
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-700 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
        ⚠ Conflicts with <span className="font-mono">{preview.trunk}</span>
        {files.length > 0 ? (
          <>
            {' in '}
            {files.length} file{files.length === 1 ? '' : 's'}
            <span className="text-amber-600/90 dark:text-amber-400/90">
              {': '}
              {files.slice(0, 6).join(', ')}
              {files.length > 6 ? '…' : ''}
            </span>
          </>
        ) : null}
        . Resolving before you push avoids a conflicted PR.
      </div>
    );
  }
  if (preview.behindBy > 0) {
    return (
      <p className="text-[11px] text-gray-500">
        <span className="font-mono">{preview.trunk}</span> is {preview.behindBy}{' '}
        commit{preview.behindBy === 1 ? '' : 's'} ahead — the fix merges cleanly.
      </p>
    );
  }
  return (
    <p className="text-[11px] text-green-600 dark:text-green-400">
      Up to date with <span className="font-mono">{preview.trunk}</span> — no
      conflicts.
    </p>
  );
}

// The reviewable result of a rebase resolution: shown before the force-with-lease push.
function ResolvedReview({
  resolved,
  target,
  pushing,
  onPush,
  onRedo,
  disabled,
}: {
  resolved: AiFixResolved;
  target: 'existing' | 'new';
  pushing: boolean;
  onPush: () => void;
  onRedo: () => void;
  disabled: boolean;
}): JSX.Element {
  const files = useMemo<DiffFile[]>(
    () => parseGitPatch(resolved.diff),
    [resolved.diff],
  );
  return (
    <div className="mt-2 space-y-2">
      <div className="rounded border border-green-200 bg-green-50 p-2 text-[11px] text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300">
        Rebased onto <span className="font-mono">{resolved.trunk}</span>.
        {resolved.resolvedConflicts
          ? ` Claude resolved conflicts in ${resolved.conflictFiles.length} file${
              resolved.conflictFiles.length === 1 ? '' : 's'
            }${
              resolved.conflictFiles.length
                ? `: ${resolved.conflictFiles.join(', ')}`
                : ''
            }.`
          : ' No conflicts.'}{' '}
        Review the result below, then push.
      </div>
      <div className="text-[11px] text-gray-500">
        {resolved.filesChanged.length} file
        {resolved.filesChanged.length === 1 ? '' : 's'} in the rebased result
      </div>
      <div className="overflow-hidden rounded border border-gray-200 text-gray-800 dark:border-gray-800 dark:text-gray-200">
        <FileDiffView files={files} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={pushing || disabled}
          onClick={onPush}
        >
          {pushing
            ? 'Pushing…'
            : target === 'new'
              ? 'Push rebased + open PR'
              : 'Push rebased (force-with-lease)'}
        </button>
        <button
          type="button"
          className={BTN_SECONDARY}
          disabled={pushing}
          onClick={onRedo}
        >
          Re-rebase
        </button>
      </div>
    </div>
  );
}

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
  const startRebase = useStartRebase();
  const cancelRebase = useCancelRebase();
  const cancelPush = useCancelPush();
  const previewM = useMergePreview();

  const canPushSameBranch = headInfo?.canPushSameBranch ?? false;
  const [target, setTarget] = useState<'existing' | 'new'>(
    canPushSameBranch ? 'existing' : 'new',
  );
  const [branch, setBranch] = useState(headInfo?.suggestedBranch ?? '');
  const [autoResolve, setAutoResolve] = useState(true);
  const [mode, setMode] = useState<'idle' | 'rebasing' | 'pushing'>('idle');
  const [jobError, setJobError] = useState<string | null>(null);
  const branchRef = useRef(false);
  const previewRef = useRef(false);

  useEffect(() => {
    if (!branchRef.current && headInfo?.suggestedBranch) {
      setBranch(headInfo.suggestedBranch);
      branchRef.current = true;
      if (!headInfo.canPushSameBranch) setTarget('new');
    }
  }, [headInfo]);

  const pushed = fix.pushedAt != null;
  // A fix pushed to the PR's OWN head branch (no new PR opened) can be reconciled
  // against a moved trunk in place — a rebase force-with-lease replaces the branch tip.
  // A fix pushed to a NEW branch lives on its own PR; the merge-preview (bound to the
  // original PR) wouldn't describe it and a non-force re-push would be rejected, so we
  // don't offer reconciliation there — just the pushed record.
  const pushedToOwnBranch = pushed && fix.pushedPrNumber == null;
  const showReconcile = !pushed || pushedToOwnBranch;

  // Auto-check the trunk once the push panel first renders — INCLUDING after a push to
  // the PR's own branch, so a fix pushed a while ago is re-evaluated against a trunk
  // that may have moved (the "do I need to rebase/merge again?" case). A manual
  // Re-check button re-runs it.
  useEffect(() => {
    if (!previewRef.current && viewerCanPush && showReconcile) {
      previewRef.current = true;
      previewM.mutate(fix.id);
    }
  }, [viewerCanPush, showReconcile, fix.id]);
  const preview = previewM.data ?? null;

  const { status: rebaseStatus } = useAiFixJobStream(
    pr.id,
    fix.id,
    'rebase',
    mode === 'rebasing',
  );
  const { status: pushStatus } = useAiFixJobStream(
    pr.id,
    fix.id,
    'push',
    mode === 'pushing',
  );

  useEffect(() => {
    if (
      mode === 'rebasing' &&
      rebaseStatus &&
      rebaseStatus.status !== 'running' &&
      rebaseStatus.status !== 'queued'
    ) {
      setMode('idle');
      if (rebaseStatus.error) setJobError(rebaseStatus.error);
    }
  }, [mode, rebaseStatus]);

  useEffect(() => {
    if (
      mode === 'pushing' &&
      pushStatus &&
      pushStatus.status !== 'running' &&
      pushStatus.status !== 'queued'
    ) {
      setMode('idle');
      if (pushStatus.error) setJobError(pushStatus.error);
    }
  }, [mode, pushStatus]);

  if (!viewerCanPush) {
    return pushed ? (
      <PushedCard fix={fix} />
    ) : (
      <p className="mt-2 text-xs text-gray-500">
        You need write access to this repository to push this fix.
      </p>
    );
  }

  // Pushed to a new branch → just the record; reconciliation doesn't apply (above).
  if (pushed && !pushedToOwnBranch) return <PushedCard fix={fix} />;

  const branchInvalid = target === 'new' && branch.trim().length === 0;
  const busy = mode !== 'idle' || push.isPending || startRebase.isPending;
  const model = fix.model as AiFixModel;
  // After a push, the trunk may be clean+current — nothing left to reconcile.
  const nothingToReconcile =
    pushed && !!preview && preview.available && preview.clean && preview.behindBy === 0;

  const doPush = (strategy: AiFixPushStrategy): void => {
    setJobError(null);
    push.mutate(
      {
        fixId: fix.id,
        body: {
          target,
          branch: target === 'new' ? branch.trim() : undefined,
          strategy,
          autoResolve,
          model,
        },
      },
      {
        onSuccess: (res) => {
          // plain resolves to the full result; merge/rebase resolve to a queued job.
          if (!('pushedBranch' in res)) setMode('pushing');
        },
      },
    );
  };

  const doRebase = (): void => {
    setJobError(null);
    startRebase.mutate(
      { fixId: fix.id, body: { autoResolve, model } },
      { onSuccess: () => setMode('rebasing') },
    );
  };

  const activeStatus = mode === 'rebasing' ? rebaseStatus : pushStatus;
  const resolved = fix.resolved;

  return (
    <div className="mt-3 rounded border border-gray-200 p-2 dark:border-gray-800">
      {pushed && <PushedCard fix={fix} />}
      <div className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
        {pushed ? 'Reconcile with the trunk' : 'Push this fix'}
      </div>

      {!pushed && fix.commitMessage && (
        <div className="mb-2 rounded bg-gray-50 p-2 text-[11px] dark:bg-gray-900">
          <span className="uppercase tracking-wide text-gray-400">
            Commit message
          </span>
          <div className="mt-0.5 font-mono text-gray-700 dark:text-gray-200">
            {fix.commitMessage}
          </div>
        </div>
      )}

      <label
        className={`flex items-center gap-2 text-xs ${
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
          checked={target === 'existing'}
          disabled={!canPushSameBranch || busy}
          onChange={() => setTarget('existing')}
        />
        Push to the PR branch
        {headInfo?.headRef && (
          <span className="font-mono text-gray-400">({headInfo.headRef})</span>
        )}
      </label>
      <label className="mt-1 flex items-center gap-2 text-xs">
        <input
          type="radio"
          checked={target === 'new'}
          disabled={busy}
          onChange={() => setTarget('new')}
        />
        New branch + open a PR
      </label>
      {target === 'new' && (
        <input
          type="text"
          className="mt-1 w-full rounded border border-gray-300 bg-transparent px-2 py-1 font-mono text-xs dark:border-gray-700"
          value={branch}
          disabled={busy}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="branch-name"
        />
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <TrunkStatus preview={preview} loading={previewM.isPending} />
        </div>
        <button
          type="button"
          className={BTN_SECONDARY}
          disabled={previewM.isPending || busy}
          onClick={() => previewM.mutate(fix.id)}
          title="Re-check this fix against the current trunk"
        >
          {previewM.isPending ? 'Checking…' : 'Re-check trunk'}
        </button>
        {previewM.isError && !previewM.isPending && (
          <span className="text-[11px] text-red-500">
            Couldn't check the trunk — try again.
          </span>
        )}
      </div>

      {mode !== 'idle' ? (
        <div className="mt-2">
          <RegenProgressBar
            active
            label={mode === 'rebasing' ? 'Rebasing & resolving' : 'Pushing'}
            value={resolveProgressPct(activeStatus)}
            timeConstantSec={40}
          />
          <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
            <span>
              {RESOLVE_PHASE_LABEL[activeStatus?.progress?.phase ?? ''] ??
                'Working…'}
            </span>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() =>
                mode === 'rebasing'
                  ? cancelRebase.mutate(fix.id)
                  : cancelPush.mutate(fix.id)
              }
            >
              Cancel
            </button>
          </div>
          {activeStatus?.progress?.recentActivity &&
            activeStatus.progress.recentActivity.length > 0 && (
              <pre className="mt-1 max-h-32 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-500 dark:bg-gray-900">
                {activeStatus.progress.recentActivity.slice(-8).join('\n')}
              </pre>
            )}
        </div>
      ) : resolved ? (
        <ResolvedReview
          resolved={resolved}
          target={target}
          pushing={push.isPending}
          disabled={branchInvalid}
          onPush={() => doPush('rebase')}
          onRedo={doRebase}
        />
      ) : nothingToReconcile ? (
        <p className="mt-2 text-[11px] text-gray-500">
          No trunk changes to reconcile — the pushed fix is up to date with{' '}
          <span className="font-mono">{preview?.trunk}</span>.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {preview && preview.available && !preview.clean && (
            <div className="text-[11px] text-gray-500">
              Recommended: rebase onto{' '}
              <span className="font-mono">{preview.trunk}</span> — Claude resolves
              the conflicts and you review the result before it pushes.
            </div>
          )}
          <label className="flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={autoResolve}
              onChange={(e) => setAutoResolve(e.target.checked)}
            />
            Let Claude resolve conflicts
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={preview && !preview.clean ? BTN_PRIMARY : BTN_SECONDARY}
              disabled={busy || branchInvalid}
              onClick={doRebase}
              title="Rebase the fix onto the trunk; Claude resolves conflicts and you review before a force-with-lease push"
            >
              Rebase onto {preview?.trunk ?? 'trunk'}
            </button>
            {/* Merge + plain push rebuild history from baseSha and push WITHOUT force,
                so they only make sense before the first push — after a push the branch
                head already carries the fix commit and a non-force push would be
                rejected as non-fast-forward. Post-push, only Rebase (force-with-lease)
                can safely reconcile with a moved trunk. */}
            {!pushed && (
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={busy || branchInvalid}
                onClick={() => doPush('merge')}
                title="Merge the trunk into the fix branch (a merge commit; never force-pushes)"
              >
                Merge {preview?.trunk ?? 'trunk'} in
              </button>
            )}
            {!pushed && (
              <button
                type="button"
                className={
                  !preview || preview.clean ? BTN_PRIMARY : BTN_SECONDARY
                }
                disabled={busy || branchInvalid}
                onClick={() => doPush('plain')}
                title="Push the fix as-is (never force-pushes). If it conflicts with the trunk, the PR will show as conflicted."
              >
                {target === 'new' ? 'Push + open PR' : 'Push'}
                {preview && !preview.clean ? ' anyway' : ''}
              </button>
            )}
          </div>
          {pushed && (
            <p className="text-[11px] text-gray-400">
              Rebasing replays the fix onto{' '}
              <span className="font-mono">{preview?.trunk ?? 'the trunk'}</span>{' '}
              and force-pushes (with lease) onto the PR branch — the safe way to
              reconcile an already-pushed fix.
            </p>
          )}
          {target === 'existing' && (
            <p className="text-[11px] text-gray-400">
              Rebase force-pushes (with lease) onto{' '}
              <span className="font-mono">{headInfo?.headRef}</span>; merge and
              push do not.
            </p>
          )}
        </div>
      )}

      {(jobError || push.isError || startRebase.isError) && (
        <div className="mt-2 text-[11px] text-red-500">
          {jobError ?? errText(push.error ?? startRebase.error)}
        </div>
      )}
    </div>
  );
}

function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

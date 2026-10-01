import { useEffect, useMemo, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  CLAUDE_REVIEW_MODELS,
  CLAUDE_REVIEW_MODEL_LABELS,
  DEFAULT_AI_FIX_MODEL,
  type AiFix,
  type AiFixModel,
  type AiFixSeed,
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
import { AiCloudNote, AiRunGate } from './AiSetup.js';
import { useFilters } from '../store/filters.js';
import {
  aiFixStartMutationKey,
  useAiFix,
  useAiFixStream,
  useCancelFix,
  usePushFix,
  useStartFix,
} from '../hooks/useAiFix.js';
import { CiAnalysisCard, errText } from './CiAnalysisCard.js';
import { CommentPicker } from './AiFix/CommentPicker.js';
import { CommentFixReport } from './AiFix/CommentFixReport.js';
import {
  useAiFixCommentActions,
  useAiFixSelection,
} from '../store/aiFixComments.js';
import { Markdown } from './Markdown.js';
import { DiffWrapToggle, FileDiffView, type DiffFile } from './diff/FileDiffView.js';
import { parseGitPatch } from '../lib/diff.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { ChecksList, CiRerunControl } from './CheckList.js';
import { AiSummary } from './AiSummary.js';

const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const BTN_SECONDARY =
  'whitespace-nowrap rounded border border-gray-300 px-2.5 py-1 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';

function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
      {children}
    </div>
  );
}

export function AiFixTab({ pr }: { pr: PrDetail }): JSX.Element {
  // FREE and local-only (`me.ai`). The tab's two Pro halves — the AI summary and the CI-analysis
  // card — gate themselves on the Pro `prSummary` capability, so they simply render nothing here
  // without the plugin.
  const aiFix = useAiCapabilities().enabled;
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

  if (!aiFix) {
    return (
      <div className="p-4">
        <AiCloudNote />
      </div>
    );
  }

  return (
    <div className="pb-6">
      <div className="border-b border-gray-200 empty:hidden dark:border-gray-800">
        <AiSummary pr={pr} />
      </div>
      <CiStatusSection pr={pr} />
      <FixerSection
        pr={pr}
        seedReviewText={seedReviewText}
        onSeedConsumed={() => setSeedReviewText(null)}
      />
    </div>
  );
}

// ---- CI status (the same checks list as the Overview tab, plus re-trigger) ----

function CiStatusSection({ pr }: { pr: PrDetail }): JSX.Element | null {
  const checks = pr.checkRuns;
  // Mirrors the Overview's Checks row: a PR whose ciStatus is red but whose checkRuns did not
  // hydrate (lean storage / SAML-SSO) still reaches a stored diagnosis, instead of the whole
  // section vanishing. The list + re-run control stay inner-gated on there being checks.
  const ciFailed = pr.ciStatus === 'failure' || pr.ciStatus === 'error';
  if (checks.length === 0 && !ciFailed) return null;
  return (
    <div className="border-b border-gray-200 dark:border-gray-800">
      <SectionTitle>CI status</SectionTitle>
      <div className="px-4 pb-3">
        {checks.length > 0 && (
          <>
            <ChecksList prId={pr.id} prGithubUrl={pr.githubUrl} checks={checks} />
            <CiRerunControl
              prId={pr.id}
              checks={checks}
              viewerCanPush={pr.viewerCanPush}
            />
          </>
        )}
        {/* The diagnosis, next to the checks. The SAME card is mounted on the Overview's
            Checks row (ChecksTab) — that is its primary home, since "why did CI fail?" is
            asked on the default tab. Both mounts share the `['ai-fix-ci', prId]` query key
            AND the refresh mutation key, and PrDetail renders one tab body at a time, so
            there is no double fetch and no way to start two paid runs. BOTH mounts now carry
            the "Fix it" button: the run is watchable from the bottom-right AiFixBanner
            wherever it was started, and the start mutation key (`['ai-fix-start', prId]`) is
            shared, so a tab switch mid-run cannot offer a second billed run. */}
        <CiAnalysisCard pr={pr} />
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
  // Opens on the shared default (Opus 5.5, effort pinned to medium server-side) — the same
  // constant the CI card's "Fix it" sends and the start route falls back to.
  const [model, setModel] = useState<AiFixModel>(DEFAULT_AI_FIX_MODEL);
  const startFix = useStartFix(pr.id);
  const cancelFix = useCancelFix(pr.id);

  const noteAiFixRun = useFilters((s) => s.noteAiFixRun);
  // In-flight read off the SHARED start key, not this mount's `startFix.isPending` — the
  // CI-analysis card starts the same run from the Overview tab, and a per-mount flag resets to
  // "Generate fix" on a tab switch mid-run, inviting a second BILLED agent turn.
  const fixStarting =
    useIsMutating({ mutationKey: aiFixStartMutationKey(pr.id) }) > 0;

  const dbStatus = data?.fix?.status ?? null;
  const active = dbStatus === 'running' || dbStatus === 'queued' || fixStarting;
  const { status: liveStatus } = useAiFixStream(pr.id, active);
  const displayStatus: AiFixStatus | 'idle' =
    liveStatus?.status ?? dbStatus ?? 'idle';
  const isRunning = displayStatus === 'running' || displayStatus === 'queued';

  // The comments the user dragged into the fix scope (in-session, per PR). A non-empty
  // basket WINS over a pending review seed: the basket is visible right above this control
  // and the button names what it will do, whereas the review seed is a one-shot handoff
  // from another tab that the user may well have forgotten about.
  const selection = useAiFixSelection(pr.id);
  const { clear: clearSelection } = useAiFixCommentActions();
  const seed: AiFixSeed =
    selection.length > 0 ? 'comments' : seedReviewText ? 'review' : 'plain';

  const start = (): void => {
    // The bottom-right AiFixBanner follows the run once the reader leaves this tab.
    noteAiFixRun({
      prId: pr.id,
      repoFullName: pr.repoFullName,
      prNumber: pr.number,
      prTitle: pr.title,
    });
    startFix.mutate(
      {
        model,
        seed,
        reviewText: seed === 'review' ? seedReviewText ?? undefined : undefined,
        commentTargets: seed === 'comments' ? selection : undefined,
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
          <p className="text-sm text-gray-500 dark:text-gray-400">
            The agentic fixer is turned off.
          </p>
        ) : (
          <>
            {/* Pick the comments to work through. Rendered above the launch control because
                it is what the launch control's label is derived from. Disabled (not hidden)
                while a run is in flight — the basket is the record of what that run was
                given, so hiding it mid-run would remove the only context for the progress. */}
            <CommentPicker pr={pr} disabled={isRunning} />
            {seedReviewText && !isRunning && (
              <div className="mb-2 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
                {seed === 'comments'
                  ? 'A review is queued as a seed, but the comments in the fix scope take precedence — clear them to fix from the review instead.'
                  : 'Ready to generate a fix from the selected review.'}
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
                // No AI runtime or no Claude credential: one line (or the one-time setup) in
                // place of the start button — the picker above stays usable.
                <AiRunGate auth={data?.auth}>
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  disabled={fixStarting}
                  onClick={start}
                  title={
                    seed === 'comments'
                      ? 'Work through each comment in the fix scope: assess whether it is valid, then fix it'
                      : undefined
                  }
                >
                  {seed === 'comments'
                    ? `Fix ${selection.length} comment${selection.length === 1 ? '' : 's'}`
                    : fix
                      ? 'Generate new fix'
                      : 'Generate fix'}
                </button>
                </AiRunGate>
              )}
              {seed === 'comments' && !isRunning && (
                <button
                  type="button"
                  className={BTN_SECONDARY}
                  onClick={() => clearSelection(pr.id)}
                >
                  Clear scope
                </button>
              )}
              {/* No "scope is full" line here on purpose — CommentPicker's header already says it,
                  next to the disabled + buttons it explains. Two copies of one sentence on one
                  screen reads as two different limits. */}
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
                <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                  {PHASE_LABEL[liveStatus?.progress?.phase ?? ''] ?? 'Working…'}
                </div>
                {liveStatus?.progress?.recentActivity &&
                  liveStatus.progress.recentActivity.length > 0 && (
                    <pre className="mt-1 max-h-32 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400 dark:bg-gray-900">
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
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">The fix run was cancelled.</p>
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
      {/* The per-comment verdicts, for a comments-seeded run. Mounted ABOVE the "no changes"
          branch on purpose: a run that correctly decided every comment was invalid produces
          no diff at all, and that is exactly the run whose report matters most. */}
      <CommentFixReport pr={pr} fix={fix} />
      {noChanges ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {fix.seed === 'comments'
            ? 'The agent changed no files — see the per-comment verdicts above for why.'
            : 'The agent made no changes.'}
        </p>
      ) : (
        <>
          <div className="mb-1 mt-2 flex items-center justify-between gap-3 text-[11px] text-gray-500 dark:text-gray-400">
            <span>
              {fix.filesChanged.length} file
              {fix.filesChanged.length === 1 ? '' : 's'} changed
            </span>
            <DiffWrapToggle />
          </div>
          <div className="overflow-hidden rounded border border-gray-200 text-gray-800 dark:border-gray-800 dark:text-gray-200">
            <FileDiffView files={diffFiles} />
          </div>
          {/* The fixer has no shell — it reads and edits, and nothing here was installed, built
              or run (apps/backend/src/coding/agent.ts, FIX_TOOLS). The run makes no verification
              claim of its own, but a diff sitting above a Push button invites the reader to
              assume one, so the fact is stated once, here, where they are about to press it.
              TEMPLATED, never asked of the model: a product fact does not belong in model prose
              (the Bot Tuning Advisor precedent).
              ⚠ IT STATES WHAT WE KNOW AND STOPS. It used to end "— CI will run on push", which is
              a promise about the REPOSITORY that this card cannot make: `ciStatusFrom(null)` is
              `'unknown'` for a PR with no check rollup at all, and whole repos here are like that
              (62 of 63 PRs on one, 1,014 of 9,544 overall). The sentence exists to stop the reader
              assuming verification, so a second clause inventing some is the thing it was written
              to remove. */}
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Not built or tested here.
          </p>
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
        Fixes pushed via Limn
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
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        You need write access to this repository to push this fix.
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
    <div className="mt-3 rounded border border-gray-200 p-2 dark:border-gray-800">
      <div className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
        Push this fix
      </div>

      {fix.commitMessage && (
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
        <div className="mt-2 text-[11px] text-red-500">{errText(push.error)}</div>
      )}
    </div>
  );
}

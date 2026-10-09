import { useEffect } from 'react';
import type { PrDetail } from '@pierre-review/shared';
import { mergeVerdict } from '../../lib/ui.js';
import { useConflictResolverEntry } from '../conflicts/ResolveConflictsButton.js';
import { openConflictResolver, type ResolverTarget } from '../../store/conflictResolver.js';
import {
  cancelConflictAiRun,
  conflictAiPhaseLabel,
  conflictAiRunActive,
  resumeConflictAiRun,
  startConflictAiRun,
  useConflictAiRun,
} from '../../hooks/useConflictAiResolve.js';
import { AiRunGate } from '../AiSetup.js';
import { RegenProgressBar } from '../Activity/RegenProgressBar.js';
import { SparkleIcon } from '../Icons.js';

const BTN =
  'whitespace-nowrap rounded border border-blue-400 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const BTN_SECONDARY =
  'whitespace-nowrap rounded border border-gray-300 px-2.5 py-1 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500';

export function resolverTargetOf(pr: PrDetail): ResolverTarget {
  return {
    prId: pr.id,
    repoId: pr.repoId,
    repoFullName: pr.repoFullName,
    prNumber: pr.number,
    prTitle: pr.title,
    githubUrl: pr.githubUrl,
  };
}

/** Does this PR conflict with its base, and can the reader resolve it here? The resolver entry's
 *  own gate (open, `conflicts` verdict, push access, the resolver exists) — never a second rule. */
export function usePrConflictsResolvable(pr: PrDetail): boolean {
  const verdict = mergeVerdict({
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    isDraft: pr.isDraft,
    inMergeQueue: pr.inMergeQueue === true,
  }).verdict;
  return useConflictResolverEntry({ state: pr.state, verdict, viewerCanPush: pr.viewerCanPush });
}

/**
 * The AI Fix tab's "Resolve merge conflicts with Claude" card — the same run as the split entry
 * button, so the two always agree. Mounted only when the PR conflicts and the reader can push.
 * The tab is the one place that RESUMES a run started elsewhere (one GET on mount, the PR pane
 * only — never a board).
 */
export function ConflictAiCard({ pr }: { pr: PrDetail }): JSX.Element {
  const run = useConflictAiRun(pr.id);
  const active = conflictAiRunActive(run);
  const base = pr.baseRefName ?? 'the base branch';
  useEffect(() => {
    void resumeConflictAiRun(pr.id);
  }, [pr.id]);
  const target = resolverTargetOf(pr);
  const done = run?.phase === 'succeeded' ? run.resolution : null;

  return (
    <div className="mb-3 rounded border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
        <SparkleIcon size={13} className="text-ai-signal" />
        This branch conflicts with {base}
      </div>
      <p className="mt-1 text-[12px] text-gray-600 dark:text-gray-300">
        Claude reads the code and picks a result for each conflict. You check its choices in the
        resolver before anything is pushed.
      </p>
      {active && run != null ? (
        <div className="mt-2">
          <RegenProgressBar active label="Resolving conflicts with Claude" timeConstantSec={60} />
          <div className="mt-1 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            {conflictAiPhaseLabel(run.phase)}
            <button type="button" className={BTN_SECONDARY} onClick={() => cancelConflictAiRun(pr.id)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <AiRunGate>
            <button type="button" className={BTN} onClick={() => startConflictAiRun(target)}>
              {done != null ? 'Run again' : 'Resolve merge conflicts with Claude'}
            </button>
          </AiRunGate>
          {done != null && (
            <>
              <button type="button" className={BTN_SECONDARY} onClick={() => openConflictResolver(target)}>
                Open the resolver
              </button>
              <span className="text-xs text-gray-600 dark:text-gray-300">
                Claude decided {done.choices.length} of {done.decidableTotal} change
                {done.decidableTotal === 1 ? '' : 's'}.
              </span>
            </>
          )}
          {run?.phase === 'failed' && run.error != null && (
            <span className="text-xs text-red-600 dark:text-red-400">{run.error}</span>
          )}
          {run?.phase === 'cancelled' && (
            <span className="text-xs text-gray-600 dark:text-gray-300">Cancelled.</span>
          )}
        </div>
      )}
    </div>
  );
}

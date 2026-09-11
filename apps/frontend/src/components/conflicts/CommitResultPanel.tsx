import type { ConflictCommitResult, ConflictSession } from '@pierre-review/shared';
import type { CommitPlan } from '../../lib/conflictCommit.js';
import { stillConflictingPaths } from '../../lib/conflictCommit.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { ExternalLinkIcon } from '../Icons.js';
import {
  AUTO_MERGE_DISARMED,
  CLOSE_RESOLVER,
  NOT_YET_VISIBLE,
  OPEN_COMPARE,
  baseAdvancedSentence,
  pushedTo,
  resolvedAcross,
  stillConflictSentence,
} from './copy.js';

// ── AFTER THE COMMIT ─────────────────────────────────────────────────────────────────────────
//
// ⚠ THE OVERLAY DOES NOT AUTO-CLOSE. This is the only place the per-file refusals are stated, and
// closing over them leaves the reader with a pull request that is still conflicted and nothing on
// screen saying why. One sentence per fact, in the order they matter, then a way out.
//
// ⚠ `visible: false` IS NOT A FAILURE, AND THE COPY CONTRACT IS A SAFETY RULE. A result with a
// real `commitSha` means the push SUCCEEDED and the resync tail merely could not confirm it in the
// local database yet. It says "it'll show up here shortly" and offers NO RETRY — a retry
// double-pushes, and once GitHub has taken the commit there is nothing left to retry.

export function CommitResultPanel({
  session,
  result,
  plan,
  onClose,
}: {
  session: ConflictSession;
  result: ConflictCommitResult;
  /** The reader's own view of what went in — the source of the half-decided files the server was
   *  never sent and therefore cannot name. */
  plan: CommitPlan;
  onClose: () => void;
}): JSX.Element {
  const stillConflicting = stillConflictingPaths(result, plan);
  // The numerator is the conflicts the reader answered in the files the SERVER says it committed —
  // one population, not our count against the server's file list.
  const committed = new Set(result.resolvedPaths);
  const conflicts = plan.resolved
    .filter((row) => committed.has(row.path))
    .reduce((n, row) => n + row.conflictsDecided, 0);
  const compareUrl = result.compareUrl == null ? undefined : safeExternalUrl(result.compareUrl);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div
        className="mx-auto flex w-full max-w-2xl flex-col gap-2 text-[12px] text-gray-800 dark:text-gray-100"
        aria-live="polite"
      >
        <p>
          {pushedTo(result.branch, result.commitSha)}{' '}
          {resolvedAcross(conflicts, result.resolvedPaths.length)}
        </p>

        {stillConflicting.length > 0 && <p>{stillConflictSentence(stillConflicting)}</p>}

        {result.baseAdvanced && (
          <p className="text-gray-700 dark:text-gray-200">
            {baseAdvancedSentence(session.baseRef)}
          </p>
        )}

        {result.autoMergeDisarmed && (
          <p className="text-gray-700 dark:text-gray-200">{AUTO_MERGE_DISARMED}</p>
        )}

        {/* ⚠ NEVER "it failed", NEVER a retry. See the module header. */}
        {!result.visible && <p className="text-gray-700 dark:text-gray-200">{NOT_YET_VISIBLE}</p>}

        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-800 hover:border-gray-400 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
          >
            {CLOSE_RESOLVER}
          </button>
          {compareUrl !== undefined && (
            <a
              href={compareUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-gray-600 underline underline-offset-2 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
            >
              {OPEN_COMPARE}
              <ExternalLinkIcon size={11} className="ml-0.5 inline-block align-[-0.1em]" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

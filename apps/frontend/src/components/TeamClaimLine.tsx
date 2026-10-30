import { useState } from 'react';
import type { ClaudeReviewResponse } from '@pierre-review/shared';
import { aiProviderName } from '@pierre-review/shared';
import { useClearTeamClaim } from '../hooks/useClaudeReview.js';
import { teamClaimRecordLine, teamClaimSkipLine } from '../lib/claudeAutoReview.js';

// TEAM CLAIMS ("Mark auto reviews on GitHub", docs/CLAUDE-REVIEW.md § Team claims) on the AI Review
// tab: why the auto review here was skipped (a teammate's Limn holds this commit), what the latest
// auto run's GitHub line did, and — when a pending Limn line sits on the PR's head — a Clear button
// that replaces it with "Cleared by <you>" so any Limn can review the commit. Renders nothing when
// none of it applies.
// ⚠ A TEAMMATE'S LIVE CLAIM (`mine: false`: their Limn is reviewing this commit now) is cleared only
// after a confirm that names them — clearing it frees the commit, so this Limn may review it a second
// time while theirs still runs. This machine's own unfinished line clears in one press.
export function TeamClaimLine({ prId, data }: { prId: number; data: ClaudeReviewResponse | undefined }): JSX.Element | null {
  const clear = useClearTeamClaim(prId);
  const [confirming, setConfirming] = useState(false);
  const skipLine = teamClaimSkipLine(data?.teamClaimSkip);
  const recordLine = data?.review?.trigger === 'auto' ? teamClaimRecordLine(data.review.teamClaim) : null;
  const pending = data?.teamClaimPending ?? null;
  if (skipLine == null && recordLine == null && pending == null) return null;
  const pendingLine =
    pending?.mine && skipLine == null ? 'Your auto review didn’t finish. Limn releases its pending GitHub line on its own.' : null;
  const refused = clear.data && !clear.data.ok ? (clear.data.message ?? 'Couldn’t clear it.') : null;
  return (
    <div className="mt-2 space-y-1 text-xs text-gray-600 dark:text-gray-400">
      {skipLine != null && <div>{skipLine}</div>}
      {skipLine == null && recordLine != null && pendingLine == null && <div>{recordLine}</div>}
      {pendingLine != null && <div>{pendingLine}</div>}
      {pending != null && (
        <div className="flex flex-wrap items-center gap-2">
          {confirming && !pending.mine ? (
            <>
              <span>@{pending.login} is reviewing this now. Clear anyway?</span>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  clear.mutate(pending.provider);
                }}
                disabled={clear.isPending}
                className="hit rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
              >
                Clear anyway
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="hit rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => (pending.mine ? clear.mutate(pending.provider) : setConfirming(true))}
              disabled={clear.isPending}
              title={`Replace the pending ${aiProviderName(pending.provider)} line with “Cleared by you”, so any Limn can review this commit.`}
              className="hit rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
            >
              {clear.isPending ? 'Clearing…' : 'Clear'}
            </button>
          )}
          {(refused != null || clear.isError) && (
            <span className="text-red-600 dark:text-red-400">
              {refused ?? (clear.error as Error)?.message ?? 'Couldn’t clear it.'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

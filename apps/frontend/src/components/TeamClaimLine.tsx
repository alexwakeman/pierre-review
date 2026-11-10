import { useState } from 'react';
import type { ClaudeReviewResponse } from '@pierre-review/shared';
import { aiProviderName } from '@pierre-review/shared';
import { useClearTeamClaim } from '../hooks/useClaudeReview.js';
import { teamClaimSkipLine, teammateReviewLine } from '../lib/claudeAutoReview.js';
import { ReviewingNowIcon } from './Icons.js';

// TEAM CLAIMS ("Mark auto reviews on GitHub", docs/CLAUDE-REVIEW.md § Team claims) on the AI Review
// tab: why the auto review here was skipped (a teammate's Limn holds this commit) and — when a
// pending Limn line sits on the PR's head — a Clear button that replaces it with "Cleared by <you>",
// so any Limn can review the commit. Renders nothing when none of it applies. What the reader's own
// auto run did on GitHub ("Marked on GitHub") is not shown (2026-11-10), and neither is a teammate's
// FINISHED review of this commit ("@robin reviewed this commit with Claude · approved", "Auto review
// skipped: already reviewed by …") — "Where this PR stands" holds their verdict (2026-11-10). Only a
// teammate's Limn reviewing NOW is named here.
// ⚠ A TEAMMATE'S LIVE CLAIM (`mine: false`: their Limn is reviewing this commit now) is cleared only
// after a confirm that names them — clearing it frees the commit, so this Limn may review it a second
// time while theirs still runs. This machine's own unfinished line clears in one press.
export function TeamClaimLine({ prId, data }: { prId: number; data: ClaudeReviewResponse | undefined }): JSX.Element | null {
  const clear = useClearTeamClaim(prId);
  const [confirming, setConfirming] = useState(false);
  // The teammates this Limn stood down for at this commit (durable), else the in-memory skip.
  const allTeammates = data?.teamClaimTeammates ?? [];
  const teammates = allTeammates.filter((t) => t.kind === 'reviewing').map((t) => ({ line: teammateReviewLine(t), live: true }));
  const skip = allTeammates.length > 0 ? null : (data?.teamClaimSkip ?? null);
  const skipLive = skip?.kind === 'reviewing';
  const skipLine = skipLive ? teamClaimSkipLine(skip) : null;
  const pending = data?.teamClaimPending ?? null;
  if (teammates.length === 0 && skipLine == null && pending == null) return null;
  const pendingLine =
    pending?.mine && skip == null && allTeammates.length === 0 ? 'Your auto review didn’t finish. Limn releases its pending GitHub line on its own.' : null;
  const refused = clear.data && !clear.data.ok ? (clear.data.message ?? 'Couldn’t clear it.') : null;
  return (
    <div className="mt-2 space-y-1 text-meta text-ui-mute">
      {/* A teammate's Limn reviewing NOW is the one line that must stand out: the ink colour and the
          pulsing sparkle. "Reviewed" stays quiet. */}
      {teammates.map(({ line, live }) =>
        live ? (
          <div key={line} className="flex items-center gap-1.5 text-ui-ink" data-testid="teammate-reviewing-now">
            <ReviewingNowIcon />
            <span>{line}</span>
          </div>
        ) : (
          <div key={line}>{line}</div>
        ),
      )}
      {skipLine != null &&
        (skipLive ? (
          <div className="flex items-center gap-1.5 text-ui-ink" data-testid="teammate-reviewing-now">
            <ReviewingNowIcon />
            <span>{skipLine}</span>
          </div>
        ) : (
          <div>{skipLine}</div>
        ))}
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
                className="hit bg-ui-raise rounded-ui px-2 py-0.5 text-meta hover:bg-ui-hover disabled:opacity-50"
              >
                Clear anyway
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="hit bg-ui-raise rounded-ui px-2 py-0.5 text-meta hover:bg-ui-hover"
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
              className="hit bg-ui-raise rounded-ui px-2 py-0.5 text-meta hover:bg-ui-hover disabled:opacity-50"
            >
              {clear.isPending ? 'Clearing…' : 'Clear'}
            </button>
          )}
          {(refused != null || clear.isError) && (
            <span className="text-ui-danger">
              {refused ?? (clear.error as Error)?.message ?? 'Couldn’t clear it.'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

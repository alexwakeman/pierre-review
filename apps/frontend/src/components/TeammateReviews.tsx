import type { ClaudeReviewVerdict, ClaudeTeammatePoster, ClaudeTeammateReview } from '@pierre-review/shared';
import { safeExternalUrl } from '../lib/ui.js';
import { VERDICT_CLASS } from '../lib/claudeReviewFollowUp.js';
import { teammateName } from '../lib/teammateReviews.js';
import { VERDICT_PILL } from './Activity/ClaudeReviewCell.js';
import { Monogram } from './CommentCard.js';
import { ExternalLinkIcon } from './Icons.js';
import { Markdown } from './Markdown.js';
import { useRailWide } from './RailLayout.js';
import { ReviewSection } from './ReviewSection.js';
import { VerdictIcon } from './VerdictIcon.js';

// TEAMMATES' POSTED REVIEWS IN THE ONE REVIEW (docs/CLAUDE-REVIEW.md § Teammates' reviews → One
// review). The server folds them with the reader's own (`ClaudeReviewResponse.teamView`); these are
// the read-only pieces: the summary when a teammate's review is the newest (or opened from Reviews on
// this PR), their avatar and the "who raised it" chip. Their findings are drawn with the reader's own
// card (ClaudeReviewTab.tsx `PointFindingCard`, lib/teamReview.ts `pointCard`): Copy and "Post
// reminder" (as the reader) only — no Post, Re-post, Reword or Ignore: the finding is theirs, on GitHub.

const VERDICT_WORD: Record<ClaudeReviewVerdict, string> = {
  COMMENT: 'Comment',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
};

const LINK = 'inline-flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink hover:underline';

function TeammateVerdict({ verdict }: { verdict: ClaudeReviewVerdict }): JSX.Element {
  return (
    <span className={`${VERDICT_PILL} ${VERDICT_CLASS[verdict]}`}>
      <VerdictIcon verdict={verdict} size={12} />
      {VERDICT_WORD[verdict]}
    </span>
  );
}

/** A teammate's avatar (their initials without one). */
export function TeammateAvatar({
  poster,
  size = 16,
}: {
  poster: Pick<ClaudeTeammatePoster, 'login' | 'displayName' | 'avatarUrl'>;
  size?: number;
}): JSX.Element {
  return poster.avatarUrl ? (
    <img
      src={safeExternalUrl(poster.avatarUrl)}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full"
      style={{ width: size, height: size }}
    />
  ) : (
    <Monogram label={poster.displayName || poster.login} size={size} />
  );
}

/** "Robin" with their avatar: who raised a finding. */
export function TeammateChip({
  by,
  label,
  title,
}: {
  by: readonly ClaudeTeammatePoster[];
  label: string;
  title: string;
}): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-ui bg-ui-raise px-1.5 py-0.5 text-meta text-ui-ink"
      title={title}
      data-testid="teammate-chip"
    >
      {by[0] != null && <TeammateAvatar poster={by[0]} size={14} />}
      {label}
    </span>
  );
}

/**
 * THE SUMMARY WHEN A TEAMMATE'S REVIEW IS THE NEWEST: "Summary", its verdict (unless "Where this PR
 * stands" names it), a link to it on GitHub, and its summary. No "Robin's review" title and no "posted
 * … ago" (2026-11-10): who and when are in "Where this PR stands" and "Reviews on this PR".
 */
export function TeammateLeadSection({
  review: r,
  showVerdict = true,
}: {
  review: ClaudeTeammateReview;
  // false: "Where this PR stands" already names the verdict.
  showVerdict?: boolean;
}): JSX.Element {
  const inRail = useRailWide('review');
  const url = safeExternalUrl(r.githubUrl);
  return (
    <ReviewSection
      title="Summary"
      section="review"
      pills={
        <>
          {showVerdict && r.verdict != null && <TeammateVerdict verdict={r.verdict} />}
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className={LINK} title={`${teammateName(r.poster)}’s review on GitHub`}>
              Open on GitHub
              <ExternalLinkIcon size={11} aria-hidden />
            </a>
          )}
        </>
      }
    >
      <div data-testid="teammate-lead">
        {r.summary.trim() !== '' ? (
          <div className={inRail ? 'reading-measure' : undefined}>
            <Markdown prRefs>{r.summary}</Markdown>
          </div>
        ) : (
          <div className="text-meta text-ui-mute">No summary.</div>
        )}
      </div>
    </ReviewSection>
  );
}

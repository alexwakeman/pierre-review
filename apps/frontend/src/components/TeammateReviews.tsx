import type { ReactNode } from 'react';
import type { ClaudeReviewVerdict, ClaudeTeamFinding, ClaudeTeammatePoster, ClaudeTeammateReview } from '@pierre-review/shared';
import { relativeTime, safeExternalUrl } from '../lib/ui.js';
import { SEVERITY_CLASS, VERDICT_CLASS } from '../lib/claudeReviewFollowUp.js';
import { REVIEW_ITEM_CARD, REVIEW_META } from '../lib/reviewStyles.js';
import { teamFindingByLabel, teammateReviewTitle } from '../lib/teammateReviews.js';
import { VERDICT_PILL } from './Activity/ClaudeReviewCell.js';
import { Monogram } from './CommentCard.js';
import { ExternalLinkIcon } from './Icons.js';
import { Markdown } from './Markdown.js';
import { RailPiece, useRailWide } from './RailLayout.js';
import { ReviewSection } from './ReviewSection.js';
import { VerdictIcon } from './VerdictIcon.js';

// TEAMMATES' POSTED REVIEWS IN THE ONE REVIEW (docs/CLAUDE-REVIEW.md § Teammates' reviews → One
// review). The server folds them with the reader's own (`ClaudeReviewResponse.teamView`); these are
// the read-only pieces: the summary when a teammate's review is the newest, and a teammate's still-open
// finding in the Findings list. No Post, Re-post, Reword or Ignore: the finding is theirs, on GitHub.
// Reply and Resolve are on its thread (the path opens it in Changes).

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
export function TeammateAvatar({ poster, size = 16 }: { poster: ClaudeTeammatePoster; size?: number }): JSX.Element {
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
 * THE SUMMARY WHEN A TEAMMATE'S REVIEW IS THE NEWEST: "Robin's review", its verdict, posted on
 * GitHub, its summary. The reader's own older review stays in the history list.
 */
export function TeammateLeadSection({ review: r }: { review: ClaudeTeammateReview }): JSX.Element {
  const inRail = useRailWide('review');
  const title = teammateReviewTitle(r);
  const url = safeExternalUrl(r.githubUrl);
  const posted: ReactNode = (
    <>
      <span title={new Date(r.postedAt).toLocaleString()}>Posted on GitHub {relativeTime(r.postedAt)}</span>
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className={LINK}>
          Open
          <ExternalLinkIcon size={11} aria-hidden />
        </a>
      )}
    </>
  );
  return (
    <>
      <RailPiece slot="status">
        <div className="space-y-1.5" data-testid="review-rail-status">
          <p className="text-meta text-ui-mute">{title}</p>
          {r.verdict != null && (
            <div className="flex flex-wrap items-center gap-2">
              <TeammateVerdict verdict={r.verdict} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-ui-mute">{posted}</div>
        </div>
      </RailPiece>
      <ReviewSection
        title={title}
        section="review"
        pills={
          inRail ? null : (
            <>
              {r.verdict != null && <TeammateVerdict verdict={r.verdict} />}
              <span className={`flex flex-wrap items-center gap-x-2 ${REVIEW_META}`}>{posted}</span>
            </>
          )
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
    </>
  );
}

/** A teammate's still-open finding in the one Findings list. Read-only. */
export function TeamFindingRow({
  finding: f,
  onOpenThread,
}: {
  finding: ClaudeTeamFinding;
  onOpenThread?: (threadId: number) => void;
}): JSX.Element {
  const url = safeExternalUrl(f.githubUrl);
  const where = f.path !== '' ? (f.line != null ? `${f.path}:${f.line}` : f.path) : null;
  const names = teamFindingByLabel(f.by);
  return (
    <li className={REVIEW_ITEM_CARD} data-testid="team-finding">
      <div className="flex items-start gap-2">
        {f.severity != null && (
          <span
            className={`mt-0.5 inline-flex shrink-0 items-center rounded-ui px-1.5 py-0.5 text-meta font-semibold capitalize ${SEVERITY_CLASS[f.severity]}`}
          >
            {f.severity}
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          {/* The title is the text's first line (as posted), so the text alone says it. */}
          <div className="flex flex-wrap items-center gap-2">
            <TeammateChip by={f.by} label={names} title={`From ${names}’s review, on GitHub`} />
          </div>
          <div className="text-body">
            <Markdown>{f.body}</Markdown>
          </div>
          <div className={`flex flex-wrap items-center gap-x-3 ${REVIEW_META}`}>
            {where != null &&
              (f.threadId != null && onOpenThread ? (
                <button
                  type="button"
                  onClick={() => onOpenThread(f.threadId as number)}
                  className="hit break-all text-left font-mono text-meta text-ui-ink hover:underline"
                >
                  {where}
                </button>
              ) : (
                <span className="break-all font-mono">{where}</span>
              ))}
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className={LINK}>
                On GitHub
                <ExternalLinkIcon size={11} aria-hidden />
              </a>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

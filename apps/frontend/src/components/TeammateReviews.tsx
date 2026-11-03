import { useState } from 'react';
import type { ClaudeReviewVerdict, ClaudeTeammateFinding, ClaudeTeammateReview } from '@pierre-review/shared';
import { relativeTime, safeExternalUrl } from '../lib/ui.js';
import { SEVERITY_CLASS, VERDICT_CLASS } from '../lib/claudeReviewFollowUp.js';
import { REVIEW_ITEM_CARD, REVIEW_ITEM_GROUP, REVIEW_ITEM_TITLE, REVIEW_META } from '../lib/reviewStyles.js';
import { teammateReviewMeta, teammateReviewTitle } from '../lib/teammateReviews.js';
import { VERDICT_PILL } from './Activity/ClaudeReviewCell.js';
import { Monogram } from './CommentCard.js';
import { ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { Markdown } from './Markdown.js';
import { VerdictIcon } from './VerdictIcon.js';

const VERDICT_WORD: Record<ClaudeReviewVerdict, string> = {
  COMMENT: 'Comment',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
};

const LINK = 'inline-flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink hover:underline';

/**
 * TEAMMATES' POSTED REVIEWS (docs/CLAUDE-REVIEW.md § Teammates' reviews): reviews a teammate's Limn
 * posted to GitHub, shown READ-ONLY beside the reader's own — whose they are, that they are on GitHub,
 * what ran them. No Post, Re-post, Delete or auto-post control: the findings link to their threads.
 * Renders nothing when there are none.
 */
export function TeammateReviews({
  reviews,
  onOpenThread,
}: {
  reviews: readonly ClaudeTeammateReview[] | undefined;
  onOpenThread?: (threadId: number) => void;
}): JSX.Element | null {
  if (reviews == null || reviews.length === 0) return null;
  return (
    <section aria-label="Teammates’ reviews" className="mt-4 space-y-2">
      <div className="flex items-center gap-1">
        <h3 className="text-meta font-semibold text-ui-ink">Teammates’ reviews</h3>
        <InfoButton title="Teammates’ reviews">
          <p>
            Reviews a teammate’s Limn posted on this pull request. They are read from GitHub and can’t be
            changed or posted here. A review a teammate kept in their own Limn isn’t shown.
          </p>
        </InfoButton>
      </div>
      <ul className={REVIEW_ITEM_GROUP}>
        {reviews.map((r) => (
          <TeammateReviewCard key={r.reviewId} review={r} onOpenThread={onOpenThread} />
        ))}
      </ul>
    </section>
  );
}

function TeammateReviewCard({
  review: r,
  onOpenThread,
}: {
  review: ClaudeTeammateReview;
  onOpenThread?: (threadId: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const title = teammateReviewTitle(r);
  const url = safeExternalUrl(r.githubUrl);
  const count = r.findings.length;
  return (
    <li className={REVIEW_ITEM_CARD} data-testid="teammate-review">
      <div className="flex items-start gap-2">
        {r.poster.avatarUrl ? (
          <img
            src={safeExternalUrl(r.poster.avatarUrl)}
            alt=""
            width={20}
            height={20}
            className="mt-0.5 shrink-0 rounded-full"
            style={{ width: 20, height: 20 }}
          />
        ) : (
          <Monogram label={r.poster.displayName || r.poster.login} size={20} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className={`hit inline-flex items-center gap-1 ${REVIEW_ITEM_TITLE} hover:underline`}
            >
              <ChevronIcon dir={open ? 'down' : 'right'} size={11} aria-hidden />
              {title}
            </button>
            {r.verdict != null && (
              <span className={`${VERDICT_PILL} ${VERDICT_CLASS[r.verdict]}`}>
                <VerdictIcon verdict={r.verdict} size={12} />
                {VERDICT_WORD[r.verdict]}
              </span>
            )}
            <span className={REVIEW_META}>
              {count === 0 ? 'No comments' : `${count} ${count === 1 ? 'comment' : 'comments'}`}
            </span>
          </div>
          <div className={`mt-0.5 flex flex-wrap items-center gap-x-2 ${REVIEW_META}`}>
            <span title={r.headInferred ? 'The commit is the newest one when it was posted.' : undefined}>
              {teammateReviewMeta(r)}
            </span>
            <span>{relativeTime(r.postedAt)}</span>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className={LINK}>
                On GitHub
                <ExternalLinkIcon size={11} aria-hidden />
              </a>
            )}
          </div>
        </div>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {r.summary.trim() !== '' && (
            <div className="text-body">
              <Markdown>{r.summary}</Markdown>
            </div>
          )}
          {count > 0 && (
            <ul className={REVIEW_ITEM_GROUP}>
              {r.findings.map((f) => (
                <TeammateFindingRow key={f.id} finding={f} onOpenThread={onOpenThread} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function TeammateFindingRow({
  finding: f,
  onOpenThread,
}: {
  finding: ClaudeTeammateFinding;
  onOpenThread?: (threadId: number) => void;
}): JSX.Element {
  const url = safeExternalUrl(f.githubUrl);
  const where = f.path !== '' ? (f.line != null ? `${f.path}:${f.line}` : f.path) : null;
  return (
    <li className={REVIEW_ITEM_CARD}>
      <div className="flex items-start gap-2">
        {f.severity != null && (
          <span
            className={`mt-0.5 inline-flex shrink-0 items-center rounded-ui px-1.5 py-0.5 text-meta font-semibold capitalize ${SEVERITY_CLASS[f.severity]}`}
          >
            {f.severity}
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
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

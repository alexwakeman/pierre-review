import type { AiReviewCard, ClaudeReviewVerdict, User } from '@pierre-review/shared';
import { VERDICT_CLASS } from '../../lib/claudeReviewFollowUp.js';
import { relativeTime } from '../../lib/ui.js';
import { groupAiReviews } from '../../lib/aiReviewsLedger.js';
import { useAiReviewsLedger } from '../../store/aiReviewsSeen.js';
import { useFilters } from '../../store/filters.js';
import { PendingClaudeReviewIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { TeammateAvatar } from '../TeammateReviews.js';
import { VerdictIcon } from '../VerdictIcon.js';
import { cx, FOCUS_RING, TEXT_LINK } from '../ui/index.js';
import { VERDICT_PILL } from './ClaudeReviewCell.js';
import { metaFor } from './AttentionCards.js';

// PENDING → "AI REVIEWS": THE NEWEST AI REVIEW ON EACH PR (docs/FRONTEND.md § The AI reviews list).
// One row per PR — the PR, who ran its newest review (the reader's own Limn or a teammate's), the
// verdict and findings, and when. A row opens the PR's AI Review tab. Read-only, unscored, newest
// first, at most 100. A STABLE list: looking never removes a row. Rows newer than the stamp the
// visit started with (hooks/useAiReviewsSeen.ts) sit under "New"; below, one block per earlier visit
// in this browser ("Seen today 14:32"), then the rest with no heading (lib/aiReviewsLedger.ts).

const VERDICT_WORD: Record<ClaudeReviewVerdict, string> = {
  COMMENT: 'Comment',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
};

const LINK = cx('rounded-ui text-left', TEXT_LINK, FOCUS_RING);

/** Who ran it, in words: "Your Limn" (an auto run says so) or "Robin's Limn". Pure. */
export function aiReviewRanBy(card: Pick<AiReviewCard, 'ranByUserId' | 'auto'>, user: User | undefined): string {
  if (card.ranByUserId == null) return card.auto ? 'Your Limn, auto review' : 'Your Limn';
  const name = user != null ? user.displayName || user.githubLogin : 'A teammate';
  return `${name}’s Limn`;
}

/** "No findings" / "1 finding" / "4 findings". Pure. */
export function aiReviewFindings(n: number): string {
  return n === 0 ? 'No findings' : n === 1 ? '1 finding' : `${n} findings`;
}

export function PendingAiReviews({
  rows,
  usersById,
  baseline,
  visitStartMs,
}: {
  rows: readonly AiReviewCard[];
  usersById: Map<number, User>;
  /** The last-look stamp the visit started with (ms); null = never looked. */
  baseline: number | null;
  /** When this visit started (ms); null = no visit yet. */
  visitStartMs: number | null;
}): JSX.Element | null {
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const ledger = useAiReviewsLedger((s) => s.ledger);
  if (rows.length === 0) return null;
  const blocks = groupAiReviews(rows, ledger, baseline, visitStartMs, Date.now());
  return (
    <section className="px-5 pb-2 pt-4 max-md:px-2" aria-label="AI reviews" data-testid="pending-ai-reviews">
      <h3 className="flex items-center gap-1 px-2 text-meta font-medium text-ui-mute">
        Latest AI review on each pull request
        <InfoButton title="AI reviews">
          <p>
            The newest AI review on each pull request in this workspace, your Limn’s and your teammates’, open or
            closed. Newest first, up to 100.
          </p>
          <p className="mt-2">
            Reviews since you last opened this tab are under New. Below them, the reviews you saw on each earlier visit,
            newest visit first. This browser remembers those visits for 60 days. Opening the tab removes nothing.
          </p>
        </InfoButton>
      </h3>
      {blocks.map((block, bi) => (
        <div key={block.key} data-testid={`pending-ai-block-${block.kind}`}>
          {block.kind === 'seen' ? (
            <h4 className="mt-3 px-2 text-meta font-medium text-ui-mute" data-testid="pending-ai-seen-label">
              {block.label}
            </h4>
          ) : (
            // New rows carry their own tag; the unlabelled rest is set apart by a rule only.
            block.kind === 'rest' && bi > 0 && <div aria-hidden="true" className="mx-2 mt-3 border-t border-ui-line" />
          )}
          <ul className="mt-1 divide-y divide-ui-line">
            {block.rows.map((c) => {
              const user = c.ranByUserId != null ? usersById.get(c.ranByUserId) : undefined;
              return (
                <li key={c.id} className="flex items-start gap-2 px-2 py-2" data-testid="pending-ai-review-row">
                  {user != null ? (
                    <span className="mt-0.5">
                      <TeammateAvatar poster={{ login: user.githubLogin, displayName: user.displayName ?? null, avatarUrl: user.avatarUrl ?? null }} size={16} />
                    </span>
                  ) : (
                    <PendingClaudeReviewIcon size={14} className="mt-1 shrink-0 text-ai-signal" />
                  )}
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className={cx(LINK, 'text-body text-ui-ink')}
                      onClick={() => openClaudeReview(metaFor(c, usersById), { fromActivity: true })}
                    >
                      {c.prTitle}
                    </button>
                    {block.kind === 'new' && (
                      <span className="ml-2 rounded-ui bg-ui-sel px-1 align-middle text-meta font-medium text-ui-accent" data-testid="pending-ai-review-new">
                        New
                      </span>
                    )}
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-ui-mute">
                      <span>
                        {c.repoFullName}#{c.prNumber}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="text-ui-ink">{aiReviewRanBy(c, user)}</span>
                      {c.verdict != null && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className={cx(VERDICT_PILL, VERDICT_CLASS[c.verdict])}>
                            <VerdictIcon verdict={c.verdict} size={12} />
                            {VERDICT_WORD[c.verdict]}
                          </span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>{aiReviewFindings(c.findingCount)}</span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={c.at}>{relativeTime(c.at)}</time>
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

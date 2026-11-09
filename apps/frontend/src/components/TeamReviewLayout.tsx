import { Fragment, useState, type ReactNode } from 'react';
import type { ClaudeFinding, ClaudeReviewStandings, ClaudeTeamPoint, ClaudeTeammatePoster, ClaudeTeammateReview } from '@pierre-review/shared';
import { useMe } from '../hooks/useTriage.js';
import { VERDICT_CLASS } from '../lib/claudeReviewFollowUp.js';
import { dateTime, safeExternalUrl } from '../lib/ui.js';
import { REVIEW_ITEM_GROUP, REVIEW_META } from '../lib/reviewStyles.js';
import {
  itemShows,
  pointCard,
  raisedByLabel,
  reviewListLine,
  standingLine,
  standingRows,
  teamFindingRows,
  type FindingCard,
  type RaisedBy,
  type ReviewListItem,
  type ShownReview,
} from '../lib/teamReview.js';
import { FOCUS_RING, cx } from './ui/index.js';
import { ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection, SectionCount } from './ReviewSection.js';
import { teammateVersionLines } from '../lib/teammateReviews.js';
import { TeammateAvatar } from './TeammateReviews.js';
import { VerdictIcon } from './VerdictIcon.js';

// THE AI REVIEW TAB'S TEAM LAYOUT (docs/FRONTEND.md § The AI Review tab → Team layout). The pieces the
// "now" view adds over the reader's own run: where the PR stands (each Limn reviewer's newest verdict),
// every finding on the PR by its state now, and the list of every review. Words and rules:
// lib/teamReview.ts.

/** The reader's avatar (their initials without one). */
function YouAvatar({ size = 16 }: { size?: number }): JSX.Element {
  const me = useMe().data?.user ?? null;
  return <TeammateAvatar poster={{ login: me?.login ?? 'you', displayName: me?.displayName ?? 'You', avatarUrl: me?.avatarUrl ?? null }} size={size} />;
}

function PersonAvatar({ you, poster, size = 16 }: { you: boolean; poster: ClaudeTeammatePoster | null; size?: number }): JSX.Element {
  return you || poster == null ? <YouAvatar size={size} /> : <TeammateAvatar poster={poster} size={size} />;
}

/**
 * WHERE THIS PR STANDS: one line per Limn reviewer, newest review first — "You · Request changes ·
 * 3 Nov · 8a8ec14 · still blocking on GitHub". A Request changes still in force is flagged.
 */
export function StandingsSection({ standings }: { standings: ClaudeReviewStandings | null | undefined }): JSX.Element | null {
  const rows = standingRows(standings);
  if (rows.length === 0) return null;
  return (
    <ReviewSection
      title="Where this PR stands"
      info={
        <InfoButton title="Where this PR stands">
          <p>Each person’s newest Limn review on this PR.</p>
          <p>
            GitHub keeps a Request changes or an Approve in force until it is dismissed, or the same person
            reviews again with Request changes or Approve. A Comment does not replace it.
          </p>
        </InfoButton>
      }
    >
      <ul className="space-y-1" data-testid="review-standings" aria-label="Where this PR stands">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-body" title={standingLine(r)}>
            <PersonAvatar you={r.you} poster={r.poster} />
            <span className="font-medium text-ui-ink">{r.name}</span>
            {r.verdictKind != null ? (
              <span className={`inline-flex items-center gap-1 rounded-ui px-1.5 py-0.5 text-meta font-medium ${VERDICT_CLASS[r.verdictKind]}`}>
                <VerdictIcon verdict={r.verdictKind} size={12} />
                {r.verdict}
              </span>
            ) : (
              <span className="text-meta text-ui-mute">{r.verdict}</span>
            )}
            {r.day !== '' && (
              <span className={REVIEW_META} title={r.at != null ? dateTime(r.at) : undefined}>
                {r.day}
              </span>
            )}
            {r.sha != null && <span className="font-mono text-meta text-ui-mute">{r.sha}</span>}
            {r.note != null && (
              <span className={r.blocking ? 'text-meta font-medium text-ui-danger' : REVIEW_META} data-blocking={r.blocking || undefined}>
                {r.note}
              </span>
            )}
          </li>
        ))}
      </ul>
    </ReviewSection>
  );
}

/**
 * TEAMMATES ON AN OLD LIMN (docs/TEAM-REVIEW.md § 12): "Robin is on Limn 0.1.188 — update for
 * still-open replies and claim fixes." Read from the `lv=` on each teammate's newest review here.
 */
export function TeammateVersionNotes({ reviews }: { reviews: readonly ClaudeTeammateReview[] | null | undefined }): JSX.Element | null {
  const lines = teammateVersionLines(reviews);
  if (lines.length === 0) return null;
  return (
    <ul className="space-y-0.5" data-testid="teammate-version-notes">
      {lines.map((l) => (
        <li key={l} className="text-meta text-ui-warn">
          {l}
        </li>
      ))}
    </ul>
  );
}

/**
 * FINDINGS BY THEIR STATE NOW, across every review on the PR (`teamView.allFindings`): "Open", then a
 * collapsed "Resolved or addressed (n)" saying why each one closed. Every row names who raised it.
 * EVERY ROW IS THE READER'S OWN CARD (`FindingRow`): the latest run's own findings keep Post / Reword /
 * Ignore (`renderOwn`); every other point is drawn by `renderPoint` from `pointCard` — the same
 * fields, Copy, and "Post reminder" on a teammate's open point.
 */
export function TeamFindingsSection({
  points,
  ownFindings,
  hiddenFindingIds,
  pairReviewIds,
  renderOwn,
  renderPoint,
  pills,
}: {
  points: readonly ClaudeTeamPoint[];
  // The latest run's own findings shown in this list (story-placed ones already left out).
  ownFindings: readonly ClaudeFinding[];
  // Findings shown elsewhere (under Story check): left out here.
  hiddenFindingIds: ReadonlySet<number>;
  pairReviewIds: ReadonlySet<number>;
  renderOwn: (f: ClaudeFinding, raisedBy: RaisedBy | null) => JSX.Element;
  renderPoint: (card: FindingCard, raisedBy: RaisedBy) => JSX.Element;
  pills?: ReactNode;
}): JSX.Element {
  const [showClosed, setShowClosed] = useState(false);
  const { open, closed } = teamFindingRows(points, ownFindings, hiddenFindingIds);
  const rows = open.map((e) => {
    if (e.kind === 'own') return { key: `o-${e.finding.id}`, el: renderOwn(e.finding, null) };
    const p = e.point;
    const by = raisedByLabel(p, pairReviewIds);
    return {
      key: `p-${p.findingId}`,
      el:
        e.own != null ? renderOwn(e.own, by) : <Fragment key={`p-${p.findingId}`}>{renderPoint(pointCard(p), by)}</Fragment>,
    };
  });
  return (
    <ReviewSection
      title="Findings"
      section="findings"
      pills={
        <>
          <SectionCount>{`${rows.length} open`}</SectionCount>
          {pills}
        </>
      }
    >
      <div className="space-y-3" data-testid="team-findings">
        <div className="space-y-1.5">
          <h4 className="text-meta font-medium text-ui-mute">Open</h4>
          {rows.length > 0 ? (
            <ul className={REVIEW_ITEM_GROUP}>{rows.map((r) => r.el)}</ul>
          ) : (
            <div className="text-meta text-ui-mute">Nothing open.</div>
          )}
        </div>
        {closed.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowClosed((o) => !o)}
              aria-expanded={showClosed}
              className={cx('hit inline-flex items-center gap-1 text-meta font-medium text-ui-ink', FOCUS_RING)}
            >
              <ChevronIcon dir={showClosed ? 'down' : 'right'} className="shrink-0" />
              Resolved or addressed ({closed.length})
            </button>
            {showClosed && (
              <ul className={`mt-1.5 ${REVIEW_ITEM_GROUP}`} data-testid="team-findings-closed">
                {closed.map((p) => (
                  <Fragment key={`c-${p.findingId}`}>{renderPoint(pointCard(p), raisedByLabel(p, pairReviewIds))}</Fragment>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </ReviewSection>
  );
}

/**
 * REVIEWS ON THIS PR: every review, newest first — who, verdict, when, commit, and running or failed.
 * The first row is now; any other opens that review read-only.
 */
export function ReviewsOnPrSection({
  items,
  nowKey,
  shown,
  countLine,
  onShow,
}: {
  items: readonly ReviewListItem[];
  // The row that IS now (`nowReviewKey`), by identity — never by position: a newer replies pass sits
  // above the latest full review in the list, and opens as a past run like any other.
  nowKey: string | null;
  // null = now.
  shown: ShownReview | null;
  countLine: string | null;
  onShow: (target: ShownReview | null) => void;
}): JSX.Element | null {
  if (items.length < 2) return countLine != null ? <div className="text-meta text-ui-mute" data-testid="review-count">{countLine}</div> : null;
  return (
    <ReviewSection title="Reviews on this PR">
      {countLine != null && (
        <div className="text-meta text-ui-mute" data-testid="review-count">
          {countLine}
        </div>
      )}
      <ul className="space-y-0.5" data-testid="reviews-on-pr">
        {items.map((item) => {
          const isNow = item.key === nowKey;
          const current = shown == null ? isNow : itemShows(item, shown);
          const target = item.target;
          if (target == null) {
            // A DECISION-ONLY row (a teammate's replies pass): nothing to open in Limn.
            const href = safeExternalUrl(item.githubUrl);
            return (
              <li
                key={item.key}
                title={dateTime(item.at)}
                className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 px-1.5 py-1 text-meta text-ui-ink"
                data-testid="review-decision-row"
              >
                <PersonAvatar you={item.you} poster={item.poster} size={14} />
                <span className="shrink-0 font-medium">{item.who}</span>
                <span className="min-w-0 flex-1 truncate text-ui-mute">{reviewListLine(item)}</span>
                {href != null && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open this review on GitHub"
                    title="Open on GitHub"
                    className={cx('hit inline-flex shrink-0 items-center rounded-ui p-0.5 text-ui-mute hover:text-ui-ink', FOCUS_RING)}
                  >
                    <ExternalLinkIcon size={12} />
                  </a>
                )}
              </li>
            );
          }
          return (
            <li key={item.key}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => onShow(isNow ? null : target)}
                title={dateTime(item.at)}
                className={cx(
                  'hit -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-ui px-1.5 py-1 text-left text-meta',
                  current ? 'bg-ui-sel text-ui-ink' : 'text-ui-ink hover:bg-ui-hover',
                  FOCUS_RING,
                )}
              >
                <PersonAvatar you={item.you} poster={item.poster} size={14} />
                <span className="shrink-0 font-medium">{item.who}</span>
                <span
                  className={cx(
                    'min-w-0 flex-1 truncate',
                    item.status === 'failed' ? 'text-ui-danger' : 'text-ui-mute',
                  )}
                >
                  {reviewListLine(item)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </ReviewSection>
  );
}

/** Above a past review: who and when, read-only, and the way back. */
export function PastReviewBar({ label, onBack }: { label: string; onBack: () => void }): JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-ui bg-ui-raise px-3 py-2 text-body text-ui-ink"
      data-testid="past-review-bar"
    >
      <span className="min-w-0 flex-1">{label}</span>
      <button
        type="button"
        onClick={onBack}
        className={cx('inline-flex h-7 items-center rounded-ui px-2 text-meta font-medium text-ui-ink hover:bg-ui-hover touch:h-10', FOCUS_RING)}
      >
        Back to now
      </button>
    </div>
  );
}

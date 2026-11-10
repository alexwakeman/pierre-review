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
  reviewListCells,
  reviewListLine,
  REVIEWS_LIST_MAX,
  standingLine,
  standingRows,
  teamFindingRows,
  visibleReviewItems,
  type FindingCard,
  type RaisedBy,
  type ReviewListItem,
  type ShownReview,
} from '../lib/teamReview.js';
import { FOCUS_RING, cx } from './ui/index.js';
import { ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { CopyButton } from './CopyButton.js';
import { pushedCommitHref } from '../lib/pushedSince.js';
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
 * WHERE THIS PR STANDS: the PR's latest commit (the cross-reference for every review's commit below,
 * in the same 7-character form), then one line per Limn reviewer, newest review first — "You ·
 * Request changes · 3 Nov · 8a8ec14 · still blocking on GitHub". A Request changes still in force is
 * flagged. The latest commit shows whenever it is known; the reviewer lines only on now.
 */
export function StandingsSection({
  standings,
  headSha,
  prUrl,
}: {
  standings: ClaudeReviewStandings | null | undefined;
  // The PR's synced head (full sha); null when not synced.
  headSha: string | null;
  prUrl: string | null;
}): JSX.Element | null {
  const rows = standingRows(standings);
  if (rows.length === 0 && headSha == null) return null;
  return (
    <ReviewSection
      title="Where this PR stands"
      info={
        <InfoButton title="Where this PR stands">
          <p>The PR’s latest commit, and each person’s newest Limn review on this PR.</p>
          <p>
            GitHub keeps a Request changes or an Approve in force until it is dismissed, or the same person
            reviews again with Request changes or Approve. A Comment does not replace it.
          </p>
        </InfoButton>
      }
    >
      <div className="space-y-2">
        {headSha != null && <HeadCommitLine sha={headSha} prUrl={prUrl} />}
        {rows.length > 0 && (
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
        )}
      </div>
    </ReviewSection>
  );
}

/** "Latest commit 8a8ec14" — linked to the commit on GitHub (under the PR), and copyable. */
function HeadCommitLine({ sha, prUrl }: { sha: string; prUrl: string | null }): JSX.Element {
  const short = sha.slice(0, 7);
  const href = safeExternalUrl(pushedCommitHref(prUrl, sha));
  return (
    <div className="flex items-center gap-2 text-meta text-ui-mute" data-testid="review-head-commit">
      <span>Latest commit</span>
      {href != null ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={`${sha} on GitHub`}
          className={cx('rounded-ui font-mono font-medium text-ui-ink underline decoration-dotted underline-offset-2 hover:decoration-solid', FOCUS_RING)}
        >
          {short}
        </a>
      ) : (
        <span className="font-mono font-medium text-ui-ink" title={sha}>
          {short}
        </span>
      )}
      <CopyButton text={sha} what="commit sha" title="Copy the full commit sha" />
    </div>
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

/** Every finding id a point's row stands for: its own, and everyone's who raised it too. */
export function pointIds(p: Pick<ClaudeTeamPoint, 'findingId' | 'alsoRaisedBy'>): number[] {
  return [p.findingId, ...p.alsoRaisedBy.map((o) => o.findingId)];
}

/**
 * The findings that are no longer open, collapsed under ONE heading: "Resolved or addressed (n)".
 * Shared by the team layout and a past run's plain list.
 */
export function ResolvedGroup({ count, children }: { count: number; children: ReactNode }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cx('hit inline-flex items-center gap-1 text-meta font-medium text-ui-ink', FOCUS_RING)}
      >
        <ChevronIcon dir={open ? 'down' : 'right'} className="shrink-0" />
        Resolved or addressed ({count})
      </button>
      {open && (
        <ul className={`mt-1.5 ${REVIEW_ITEM_GROUP}`} data-testid="team-findings-closed">
          {children}
        </ul>
      )}
    </div>
  );
}

/**
 * FINDINGS BY THEIR STATE NOW, across every review on the PR (`teamView.allFindings`): "Open", then a
 * collapsed "Resolved or addressed (n)" saying why each one closed. Every row names who raised it.
 * EVERY ROW IS THE READER'S OWN CARD (`FindingRow`): the latest run's own findings keep Post / Reword /
 * Ignore (`renderOwn`); every other point is drawn by `renderPoint` from `pointCard` — the same
 * fields, Copy, and "Post reminder" on a teammate's open point. Each renderer gets the finding ids the
 * row stands for, so the caller can hang what the latest run said about it on the row (the one-line
 * how, the reply; there is no separate "Previous review" section). `moreOpen` / `moreClosed`: the
 * earlier findings no row here shows, in the same groups.
 */
export function TeamFindingsSection({
  points,
  ownFindings,
  hiddenFindingIds,
  pairReviewIds,
  renderOwn,
  renderPoint,
  pills,
  moreOpen = [],
  moreClosed = [],
  openNote = null,
}: {
  points: readonly ClaudeTeamPoint[];
  // The latest run's own findings shown in this list (story-placed ones already left out).
  ownFindings: readonly ClaudeFinding[];
  // Findings shown elsewhere (under Story check): left out here.
  hiddenFindingIds: ReadonlySet<number>;
  pairReviewIds: ReadonlySet<number>;
  renderOwn: (f: ClaudeFinding, raisedBy: RaisedBy | null, ids: readonly number[]) => JSX.Element;
  renderPoint: (card: FindingCard, raisedBy: RaisedBy, ids: readonly number[]) => JSX.Element;
  pills?: ReactNode;
  moreOpen?: readonly JSX.Element[];
  moreClosed?: readonly JSX.Element[];
  // Under the open rows (the earlier findings the latest run did not check, by reason).
  openNote?: ReactNode;
}): JSX.Element {
  const { open, closed } = teamFindingRows(points, ownFindings, hiddenFindingIds);
  const rows = open.map((e) => {
    if (e.kind === 'own') return { key: `o-${e.finding.id}`, el: renderOwn(e.finding, null, [e.finding.id]) };
    const p = e.point;
    const by = raisedByLabel(p, pairReviewIds);
    const ids = pointIds(p);
    return {
      key: `p-${p.findingId}`,
      el: e.own != null ? renderOwn(e.own, by, ids) : <Fragment key={`p-${p.findingId}`}>{renderPoint(pointCard(p), by, ids)}</Fragment>,
    };
  });
  const openCount = rows.length + moreOpen.length;
  return (
    <ReviewSection
      title="Findings"
      section="findings"
      pills={
        <>
          <SectionCount>{`${openCount} open`}</SectionCount>
          {pills}
        </>
      }
    >
      <div className="space-y-3" data-testid="team-findings">
        <div className="space-y-1.5">
          <h4 className="text-meta font-medium text-ui-mute">Open</h4>
          {openCount > 0 ? (
            <ul className={REVIEW_ITEM_GROUP}>
              {rows.map((r) => r.el)}
              {moreOpen}
            </ul>
          ) : (
            <div className="text-meta text-ui-mute">Nothing open.</div>
          )}
          {openNote}
        </div>
        <ResolvedGroup count={closed.length + moreClosed.length}>
          {closed.map((p) => (
            <Fragment key={`c-${p.findingId}`}>{renderPoint(pointCard(p), raisedByLabel(p, pairReviewIds), pointIds(p))}</Fragment>
          ))}
          {moreClosed}
        </ResolvedGroup>
      </div>
    </ReviewSection>
  );
}

/**
 * REVIEWS ON THIS PR: every review, newest first, IN COLUMNS — who, when, commit (the same 7-character
 * form as "Latest commit" above), outcome, and what ran it. The newest REVIEWS_LIST_MAX show; "Show all
 * n" opens the rest (local to the tab). The now row is the reader's latest review; any other opens that
 * review read-only.
 */
// Fixed column widths, so every row's cells line up: avatar · who · when · commit · outcome · what ran.
const REVIEW_ROW_GRID =
  'grid grid-cols-[14px_minmax(0,4rem)_3rem_4.5rem_minmax(4rem,1fr)_minmax(0,5.5rem)] items-center gap-x-1.5';

function ReviewRowCells({ item, failed, trailing }: { item: ReviewListItem; failed: boolean; trailing?: ReactNode }): JSX.Element {
  const c = reviewListCells(item);
  return (
    <>
      <PersonAvatar you={item.you} poster={item.poster} size={14} />
      <span className="truncate font-medium" title={item.who}>
        {item.who}
      </span>
      <span className="truncate tabular-nums text-ui-mute">{c.day}</span>
      <span className="truncate font-mono tabular-nums text-ui-mute">{c.sha}</span>
      <span className={cx('truncate', failed ? 'text-ui-danger' : 'text-ui-ink')} title={c.outcome}>
        {c.outcome}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-1 text-ui-mute">
        <span className="truncate" title={c.what}>
          {c.what}
        </span>
        {trailing}
      </span>
    </>
  );
}

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
  const [expanded, setExpanded] = useState(false);
  if (items.length < 2) return countLine != null ? <div className="text-meta text-ui-mute" data-testid="review-count">{countLine}</div> : null;
  const visible = visibleReviewItems(items, expanded);
  return (
    <ReviewSection title="Reviews on this PR">
      {countLine != null && (
        <div className="text-meta text-ui-mute" data-testid="review-count">
          {countLine}
        </div>
      )}
      <ul className="space-y-0.5" data-testid="reviews-on-pr">
        {visible.map((item) => {
          const isNow = item.key === nowKey;
          const current = shown == null ? isNow : itemShows(item, shown);
          const target = item.target;
          const line = `${item.who} · ${reviewListLine(item)} · ${dateTime(item.at)}`;
          if (target == null) {
            // A DECISION-ONLY row (a teammate's replies pass): nothing to open in Limn.
            const href = safeExternalUrl(item.githubUrl);
            return (
              <li
                key={item.key}
                title={line}
                className={cx('-mx-1.5 w-[calc(100%+0.75rem)] px-1.5 py-1 text-meta text-ui-ink', REVIEW_ROW_GRID)}
                data-testid="review-decision-row"
              >
                <ReviewRowCells
                  item={item}
                  failed={false}
                  trailing={
                    href != null ? (
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
                    ) : undefined
                  }
                />
              </li>
            );
          }
          return (
            <li key={item.key}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => onShow(isNow ? null : target)}
                title={line}
                className={cx(
                  'hit -mx-1.5 w-[calc(100%+0.75rem)] rounded-ui px-1.5 py-1 text-left text-meta',
                  REVIEW_ROW_GRID,
                  current ? 'bg-ui-sel text-ui-ink' : 'text-ui-ink hover:bg-ui-hover',
                  FOCUS_RING,
                )}
              >
                <ReviewRowCells item={item} failed={item.status === 'failed'} />
              </button>
            </li>
          );
        })}
      </ul>
      {items.length > REVIEWS_LIST_MAX && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className={cx('hit mt-1 inline-flex items-center gap-1 rounded-ui text-meta font-medium text-ui-ink', FOCUS_RING)}
          data-testid="reviews-on-pr-toggle"
        >
          <ChevronIcon dir={expanded ? 'up' : 'down'} className="shrink-0" />
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
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

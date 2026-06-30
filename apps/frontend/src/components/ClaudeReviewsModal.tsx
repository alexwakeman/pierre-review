import { useEffect, useState } from 'react';
import type {
  ClaudeReviewListItem,
  ClaudeReviewVerdict,
  ReviewAction,
  ReviewLearningKind,
} from '@pierre-review/shared';
import { useAllClaudeReviews } from '../hooks/useClaudeReview.js';
import { useReviewActions } from '../hooks/useReviewActions.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { useFilters } from '../store/filters.js';
import { isReviewSoundMuted, setReviewSoundMuted } from '../lib/sound.js';
import { relativeTime } from '../lib/ui.js';

const VERDICT_LABEL: Record<ClaudeReviewVerdict, string> = {
  COMMENT: 'Comment',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
};

const VERDICT_CLASS: Record<ClaudeReviewVerdict, string> = {
  APPROVE: 'bg-green-500/10 text-green-700 dark:text-green-400',
  REQUEST_CHANGES: 'bg-red-500/10 text-red-700 dark:text-red-400',
  COMMENT: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
};

function VerdictBadge({ verdict }: { verdict: ClaudeReviewVerdict }): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${VERDICT_CLASS[verdict]}`}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

// Action-kind glyph + short label for the per-review action log (Surface 2). Glyphs
// reuse the app's existing vocabulary (✓ keep, ✕ dismiss, ✎ reword, ↗ posted, ⚡ run).
const ACTION_META: Record<ReviewLearningKind, { icon: string; label: string }> = {
  finding_dismissed: { icon: '✕', label: 'dismissed' },
  finding_kept: { icon: '✓', label: 'kept' },
  finding_reworded: { icon: '✎', label: 'reworded' },
  finding_reword_cleared: { icon: '↺', label: 'reword cleared' },
  finding_posted: { icon: '↗', label: 'posted' },
  review_body_rewritten: { icon: '✎', label: 'rewrote body' },
  verdict_overridden: { icon: '⚖', label: 'verdict' },
  review_posted: { icon: '📨', label: 'submitted' },
  run_requested: { icon: '⚡', label: 'run requested' },
};

function ActionLogRow({ action }: { action: ReviewAction }): JSX.Element {
  const meta = ACTION_META[action.kind];
  const isReword =
    action.kind === 'finding_reworded' || action.kind === 'review_body_rewritten';
  const isVerdict = action.kind === 'verdict_overridden';
  return (
    <li className="px-2 py-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span aria-hidden="true" className="w-3 shrink-0 text-center text-gray-400">
          {meta.icon}
        </span>
        <span className="font-medium text-gray-600 dark:text-gray-300">{meta.label}</span>
        {action.category != null && <span className="text-gray-400">{action.category}</span>}
        {action.glob != null && (
          <span className="truncate font-mono text-gray-400">{action.glob}</span>
        )}
        {action.postedCommentKind != null && (
          <span className="text-gray-400">({action.postedCommentKind})</span>
        )}
        <span className="ml-auto shrink-0 text-gray-400">
          {relativeTime(action.createdAt)}
        </span>
      </div>
      {isVerdict && (
        <div className="ml-4 text-[11px] text-gray-500 dark:text-gray-400">
          Claude {action.claudeVerdict ?? '—'} → you {action.userVerdict ?? '—'}
        </div>
      )}
      {isReword && (action.claudeText != null || action.userText != null) && (
        <div className="ml-4 mt-0.5 space-y-0.5 text-[11px]">
          {action.claudeText != null && (
            <div>
              <span className="font-medium text-gray-400">Claude: </span>
              <span className="text-gray-600 dark:text-gray-300">“{action.claudeText}”</span>
            </div>
          )}
          {action.userText != null && (
            <div>
              <span className="font-medium text-gray-400">You: </span>
              <span className="text-gray-600 dark:text-gray-300">“{action.userText}”</span>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// Surface 2 (Pro): a collapsible log of the reviewer's actions on one review run.
// Collapsed by default; fetches only on expand (so the common zero-action case never
// hits the network until the user asks). Once loaded empty it reads "Actions (0)".
function ActionsDisclosure({ reviewId }: { reviewId: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useReviewActions(reviewId, open);
  const actions = data?.actions ?? [];
  const count = data != null ? actions.length : null;
  const emptyLoaded = count === 0;
  return (
    <div className="px-3 pb-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={emptyLoaded}
        className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 disabled:cursor-default disabled:opacity-60 dark:hover:text-gray-200"
        aria-expanded={open}
      >
        <span aria-hidden="true">{open && !emptyLoaded ? '▾' : '▸'}</span>
        Actions on this review{count != null ? ` (${count})` : ''}
      </button>
      {open && !emptyLoaded && (
        <ul className="mt-0.5 divide-y divide-gray-100 rounded border border-gray-100 dark:divide-gray-800 dark:border-gray-800">
          {isLoading ? (
            <li className="px-2 py-1.5 text-[11px] text-gray-400">Loading…</li>
          ) : (
            actions.map((a) => <ActionLogRow key={a.id} action={a} />)
          )}
        </ul>
      )}
    </div>
  );
}

function ReviewRow({
  item,
  onSelect,
  reviewMemory,
}: {
  item: ClaudeReviewListItem;
  onSelect: () => void;
  reviewMemory: boolean;
}): JSX.Element {
  const when = item.finishedAt ?? item.createdAt;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="block w-full rounded px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60"
        title="Open this review"
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
            {item.prTitle}{' '}
            <span className="font-normal text-gray-400">#{item.prNumber}</span>
          </span>
          {item.verdict != null && <VerdictBadge verdict={item.verdict} />}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
          <span className="truncate">{item.repoFullName}</span>
          <span className="text-gray-300 dark:text-gray-600">·</span>
          <span className="shrink-0">{relativeTime(when)}</span>
        </div>
        {item.summary != null && item.summary !== '' && (
          <div className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
            {item.summary}
          </div>
        )}
      </button>
      {/* Surface 2 (Pro): per-run action log. Renders nothing in OSS mode. */}
      {reviewMemory && <ActionsDisclosure reviewId={item.reviewId} />}
    </li>
  );
}

// History of Claude reviews — one entry per PR (its most-recent succeeded run)
// within the timeline window. Opened from the header "Claude Reviews" button.
// Clicking an entry reveals it via the store's openClaudeReview (selects the PR
// + switches PrDetail to its Claude Review tab) and closes the modal. Dismissed
// by the backdrop, the X, or Escape (capture-phase, so it doesn't reach the
// global keyboard hook). Footer hosts the completion-sound mute toggle.
export function ClaudeReviewsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const { reviewMemory } = useProCapabilities();
  const { data, isLoading, isError, error } = useAllClaudeReviews(open);
  const [muted, setMuted] = useState(() => isReviewSoundMuted());
  // Paginate the list past 5 entries so a long history doesn't overcrowd the modal.
  const PAGE_SIZE = 5;
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // Reset to the first page each time the modal opens.
  useEffect(() => {
    if (open) setPage(0);
  }, [open]);

  if (!open) return null;

  const reviews = data?.reviews ?? [];
  const pageCount = Math.max(1, Math.ceil(reviews.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const paged = reviews.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const paginated = reviews.length > PAGE_SIZE;
  const rangeStart = reviews.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const rangeEnd = Math.min(reviews.length, safePage * PAGE_SIZE + PAGE_SIZE);

  const toggleMute = (): void => {
    const next = !muted;
    setMuted(next);
    setReviewSoundMuted(next);
  };

  const select = (prId: number): void => {
    openClaudeReview(prId);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[80vh] w-[34rem] max-w-[92vw] flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Claude reviews"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Claude reviews
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
          {isLoading ? (
            <div className="px-3 py-6 text-center text-sm text-gray-400">
              Loading…
            </div>
          ) : isError ? (
            <div className="px-3 py-6 text-center text-sm text-red-500">
              {(error as Error)?.message ?? 'Failed to load reviews.'}
            </div>
          ) : reviews.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-gray-400">
              No Claude reviews yet. Open a PR and run one from its{' '}
              <span className="font-medium">Claude Review</span> tab.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {paged.map((item) => (
                <ReviewRow
                  key={item.reviewId}
                  item={item}
                  onSelect={() => select(item.prId)}
                  reviewMemory={reviewMemory}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-200 px-4 py-2 dark:border-gray-800">
          <span className="shrink-0 text-xs text-gray-400">
            {reviews.length > 0
              ? paginated
                ? `${rangeStart}–${rangeEnd} of ${reviews.length} PRs`
                : `${reviews.length} PR${reviews.length === 1 ? '' : 's'} reviewed`
              : ''}
          </span>
          <div className="flex items-center gap-2">
            {paginated && (
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="rounded border border-gray-300 px-1.5 py-0.5 hover:border-gray-400 disabled:opacity-30 dark:border-gray-700 dark:hover:border-gray-500"
                  aria-label="Previous page"
                >
                  ← Prev
                </button>
                <span className="px-1 tabular-nums text-gray-400">
                  {safePage + 1}/{pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  className="rounded border border-gray-300 px-1.5 py-0.5 hover:border-gray-400 disabled:opacity-30 dark:border-gray-700 dark:hover:border-gray-500"
                  aria-label="Next page"
                >
                  Next →
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={toggleMute}
              className="flex items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
              title={
                muted
                  ? 'Completion sound muted — click to unmute'
                  : 'Completion sound on — click to mute'
              }
              aria-pressed={muted}
            >
              <span aria-hidden="true">{muted ? '🔇' : '🔔'}</span>
              {muted ? 'Sound off' : 'Sound on'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

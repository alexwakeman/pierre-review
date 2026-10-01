import { useEffect, useState, type MouseEvent } from 'react';
import type { ClaudeReviewPrState } from '@pierre-review/shared';
import {
  isAutoReviewHoldError,
  useClaudeReviewStarting,
  useStartReviewFromList,
} from '../../hooks/useClaudeReview.js';
import { heldByAutoReview, reviewCellFor } from '../../lib/claudeReviewColumn.js';
import { AUTO_REVIEW_LABEL } from './pendingLabels.js';
import { unlockReviewSound } from '../../lib/sound.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';

// One row's "Claude review" cell in the Open PRs table. Rendered ONLY when the Claude Review
// capability is on (OpenPrsTable decides). Reads the table's ONE batched states answer — it
// fetches nothing on mount; the only requests it makes follow a click.
//
// ⚠ The row is WHOLE-ROW clickable (it opens the PR), so every control here stops propagation.

const BUTTON =
  'rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:cursor-default disabled:opacity-60 dark:border-gray-700 dark:hover:border-gray-500';
const MUTED = 'text-[11px] text-gray-500 dark:text-gray-400';
const NOTE_MS = 6000;

// The small marker on a run the workspace's auto review started (queued, running or finished).
function AutoMark(): JSX.Element {
  return <span className={MUTED}>{AUTO_REVIEW_LABEL}</span>;
}

export function ClaudeReviewCell({
  prId,
  state,
  onOpenReview,
}: {
  prId: number;
  state: ClaudeReviewPrState | undefined;
  onOpenReview: () => void;
}): JSX.Element {
  const start = useStartReviewFromList(prId);
  // Shared with the PR's own Claude Review tab: a start from either surface disables both.
  const starting = useClaudeReviewStarting(prId);
  const cell = reviewCellFor(state, starting);
  const held = heldByAutoReview(state);
  // A 409 AutoReviewInProgress says so only while the hold lasts; after it, the Review button is
  // back and the refusal is history.
  const showError = start.isError && !starting && (held || !isAutoReviewHoldError(start.error));

  // The short "without a user story" note, shown for a few seconds after a start.
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (note == null) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  // Not set up yet (no AI runtime, or no Claude credential detected): Review opens the PR's
  // Claude Review tab, which says what is missing in place of its own Run button. A row has no
  // room for that sentence, and a start here would only fail.
  const ready = useAiCapabilities().ready;
  const run = (e: MouseEvent): void => {
    e.stopPropagation();
    if (!ready) {
      onOpenReview();
      return;
    }
    // Gesture-gated WebAudio: unlock now so the completion chime can play later.
    unlockReviewSound();
    setNote(null);
    start.mutate({ previous: state }, { onSuccess: (r) => setNote(r.note) });
  };

  const stop = (e: MouseEvent): void => e.stopPropagation();

  let body: JSX.Element;
  switch (cell.kind) {
    case 'start':
      body = (
        <button type="button" onClick={run} className={BUTTON}>
          Review
        </button>
      );
      break;
    case 'starting':
      body = (
        <button type="button" disabled onClick={stop} className={BUTTON}>
          Starting…
        </button>
      );
      break;
    case 'queued':
      body = (
        <span className="inline-flex items-center gap-1.5">
          <button type="button" disabled onClick={stop} className={BUTTON}>
            Queued
          </button>
          {cell.auto && <AutoMark />}
        </span>
      );
      break;
    case 'running':
      body = (
        <span className="inline-flex items-center gap-1.5">
          <button type="button" disabled onClick={stop} className={BUTTON}>
            Reviewing…
          </button>
          {cell.auto && <AutoMark />}
        </span>
      );
      break;
    case 'done':
      body = (
        <span className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenReview();
            }}
            className="text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
            title="Open this review"
          >
            {cell.verdictLabel}
          </button>
          {cell.auto && <AutoMark />}
          {cell.headMoved && (
            <button
              type="button"
              onClick={run}
              className={BUTTON}
              title="New commits since this review"
            >
              Re-review
            </button>
          )}
        </span>
      );
      break;
  }

  return (
    <div className="whitespace-nowrap" onClick={stop}>
      {body}
      {showError && (
        <div className="mt-0.5 max-w-[14rem] whitespace-normal text-[11px] text-red-600 dark:text-red-400">
          {start.error.message || 'Could not start the review.'}
        </div>
      )}
      {note != null && !start.isError && (
        <div className={`mt-0.5 max-w-[14rem] whitespace-normal ${MUTED}`}>{note}</div>
      )}
    </div>
  );
}

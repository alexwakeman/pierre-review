import type { MouseEvent, ReactNode } from 'react';
import type { CiReviewState, ClaudeReviewPrState } from '@pierre-review/shared';
import {
  isAutoReviewHoldError,
  useClaudeReviewStarting,
  useStartReviewFromList,
} from '../../hooks/useClaudeReview.js';
import {
  findingTotal,
  followUpTally,
  heldByAutoReview,
  reviewCurrency,
  reviewCellFor,
  severityPills,
  threadsToFixLabel,
} from '../../lib/claudeReviewColumn.js';
import {
  CLEAN_CLASS,
  FOLLOW_UP_STATUS_CLASS,
  OUTDATED_CLASS,
  SEVERITY_CLASS,
  VERDICT_CLASS,
} from '../../lib/claudeReviewFollowUp.js';
import { fixPillLabel } from '../../lib/claudeAutoReview.js';
import { unlockReviewSound } from '../../lib/sound.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { CheckIcon, SparkleIcon } from '../Icons.js';
import { VerdictIcon } from '../VerdictIcon.js';
import { AutoMark, GREY_PILL, MUTED, PILL } from './ClaudeReviewCell.js';
import { ReviewedAgo } from '../ReviewedAgo.js';
import { ciCardPill } from '../../lib/ciReview.js';

// ── THE PENDING CARD'S CLAUDE: ONE LINE, ITS BUTTONS IN THE CARD'S ACTION ROW, THE REST IN DETAILS ──
//
// The Open PRs card keeps the full panel above. A Pending card (layout B) says Claude in ONE line —
// the verdict and the finding counts, or on a red-build card (instead of the verdict) how many
// failures Claude explained — puts Claude's buttons in the card's own left-aligned action row, and
// leaves the currency, "Earlier", threads-to-fix, CI-diagnosis, posted and design pills to the
// card's Details. All three read the board's ONE batched states answers (the code review's and the
// CI review's — a separate run): nothing here fetches on mount, and the only request is a click on
// "Review".

/** One Pending card's Claude line, or nothing when Claude has not looked (an offer is a button in
 *  the action row, not a line). `omitVerdict` on a card whose heading already names the verdict;
 *  `ci` on a red-build card, where the diagnosis is what matters. A finished run always says how
 *  long ago it ran; `reviewedAt` is the card's own copy of that time (a `claude_review` My Turn
 *  card's `since`), used only when the batched state carries none. */
export function ClaudeReviewLine({
  prId,
  state,
  omitVerdict = false,
  ci = false,
  ciState,
  reviewedAt = null,
  onOpenReview,
}: {
  prId: number;
  state: ClaudeReviewPrState | undefined;
  omitVerdict?: boolean;
  ci?: boolean;
  // The CI review's state for this PR (its own run), from the board's batched CI states.
  ciState?: CiReviewState;
  reviewedAt?: string | null;
  onOpenReview: () => void;
}): JSX.Element | null {
  const starting = useClaudeReviewStarting(prId);
  const cell = reviewCellFor(state, starting);
  // On a red-build card the CI review IS the line, whether or not the code was reviewed.
  const ciPill = ci ? ciCardPill(ciState) : null;
  if (cell.kind === 'start' && !cell.failed && ciPill == null) return null;
  const open = (e: MouseEvent): void => {
    e.stopPropagation();
    onOpenReview();
  };
  const LINK = 'cursor-pointer hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
  let lead: ReactNode = null;
  switch (cell.kind) {
    case 'start':
      lead = (
        <button type="button" onClick={open} className={`${PILL} ${SEVERITY_CLASS.blocker} ${LINK}`}>
          Review failed
        </button>
      );
      break;
    case 'starting':
      lead = <span className={GREY_PILL}>Starting…</span>;
      break;
    case 'queued':
      lead = (
        <>
          <span className={GREY_PILL}>Queued</span>
          {cell.auto && <AutoMark />}
        </>
      );
      break;
    case 'running':
      lead = (
        <>
          <button type="button" onClick={open} className={`${PILL} bg-ai-signal/10 text-ai-signal ${LINK}`}>
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai-signal-fill" />
            Reviewing…
          </button>
          {cell.auto && <AutoMark />}
        </>
      );
      break;
    case 'done':
      lead = omitVerdict ? null : (
        <button
          type="button"
          onClick={open}
          title="Open the review"
          className={`${PILL} ${
            cell.verdict != null ? VERDICT_CLASS[cell.verdict] : 'bg-gray-500/10 text-gray-600 dark:text-gray-300'
          } ${LINK}`}
        >
          {cell.verdict != null && <VerdictIcon verdict={cell.verdict} size={11} />}
            {cell.verdictLabel}
        </button>
      );
      break;
  }
  const summary = cell.kind === 'done' ? state?.summary : undefined;
  // On a red-build card the diagnosis IS the line, so the VERDICT pill steps aside — only the verdict:
  // a queued, running or failed code review keeps its lead beside the CI pill. Everywhere else
  // the line is the verdict and its finding counts only — the threads-to-fix and CI-diagnosis pills
  // live in Details (`ClaudeReviewExtras`), so a card whose fact line already says CI is red does
  // not say it again here.
  const pills = summary != null ? severityPills(summary) : [];
  if (ciPill != null && cell.kind === 'done') lead = null;
  return (
    <div
      className="mt-1.5 flex min-w-0 cursor-default flex-wrap items-center gap-1.5 text-[12px]"
      onClick={(e) => e.stopPropagation()}
      role="group"
      aria-label="Claude review"
    >
      <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-ai-ink">
        <SparkleIcon size={12} className="text-ai-signal" />
        Claude
      </span>
      {lead}
      {ciPill != null ? (
        <button type="button" onClick={open} title="Open the CI check" className={`text-gray-700 dark:text-gray-300 ${LINK}`}>
          {ciPill.label}
        </button>
      ) : (
        summary != null && (
          <>
            {pills.length > 0 ? (
              pills.map((p) => (
                <span key={p.severity} className={`${PILL} ${SEVERITY_CLASS[p.severity]}`}>
                  {p.label}
                </span>
              ))
            ) : (
              <span className={`${PILL} ${CLEAN_CLASS}`}>
                <CheckIcon size={11} />
                No issues
              </span>
            )}
          </>
        )
      )}
      {ciPill != null
        ? !ciPill.running && <ReviewedAgo at={ciState?.checkedAt} className="text-[12px]" />
        : cell.kind === 'done' && <ReviewedAgo at={state?.finishedAt ?? reviewedAt} className="text-[12px]" />}
    </div>
  );
}

/** The card action row's button style for a Claude control. */
export const PENDING_AI_BUTTON =
  'whitespace-nowrap rounded-md border border-ai-border bg-ai-surface px-2.5 py-1 text-[12px] font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:cursor-default disabled:opacity-60';

/**
 * Claude's buttons for a Pending card's action row: "Open review" (or "Re-review" once the head has
 * moved), "Review" where `offerStart` and nothing has run, and AI Fix — its live state when one is
 * running or ready, else an "AI Fix" button where `offerFix` (a red build on your own PR).
 */
export function ClaudeReviewActions({
  prId,
  state,
  onOpenReview,
  onOpenFix,
  offerStart = false,
  offerFix = false,
  withOpen = true,
  buttonClass,
}: {
  prId: number;
  state: ClaudeReviewPrState | undefined;
  onOpenReview: () => void;
  onOpenFix: () => void;
  offerStart?: boolean;
  offerFix?: boolean;
  /** Offer "Open review" on a finished run. False where the card's own primary already opens it. */
  withOpen?: boolean;
  /** The plain secondary button style of the card's row. */
  buttonClass: string;
}): JSX.Element | null {
  const start = useStartReviewFromList(prId);
  const starting = useClaudeReviewStarting(prId);
  const ready = useAiCapabilities().ready;
  const cell = reviewCellFor(state, starting);
  const held = heldByAutoReview(state);
  const showError = start.isError && !starting && (held || !isAutoReviewHoldError(start.error));
  const run = (e: MouseEvent): void => {
    e.stopPropagation();
    if (!ready) {
      onOpenReview();
      return;
    }
    unlockReviewSound();
    start.mutate();
  };
  const fixLabel = fixPillLabel(state?.fix);
  const parts: JSX.Element[] = [];
  if (cell.kind === 'done' && (withOpen || cell.headMoved)) {
    parts.push(
      cell.headMoved ? (
        <button key="rr" type="button" onClick={run} className={PENDING_AI_BUTTON}>
          Re-review
        </button>
      ) : (
        <button
          key="open"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenReview();
          }}
          className={buttonClass}
        >
          Open review
        </button>
      ),
    );
  } else if (cell.kind === 'start' && (offerStart || cell.failed)) {
    parts.push(
      <button key="run" type="button" onClick={run} className={PENDING_AI_BUTTON}>
        {cell.failed ? 'Review again' : 'Review with Claude'}
      </button>,
    );
  }
  if (fixLabel != null || offerFix) {
    parts.push(
      <button
        key="fix"
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenFix();
        }}
        className={PENDING_AI_BUTTON}
        title={state?.fix === 'ready' ? 'Review and push the fix in the AI Fix tab' : 'Open the AI Fix tab'}
      >
        {state?.fix === 'running' && (
          <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ai-signal-fill" />
        )}
        {fixLabel ?? 'AI Fix'}
      </button>,
    );
  }
  if (showError) {
    parts.push(
      <span key="err" className="text-[12px] text-red-600 dark:text-red-400">
        {start.error.message || 'Could not start the review.'}
      </span>,
    );
  }
  return parts.length > 0 ? <>{parts}</> : null;
}

/** What the one-line Claude summary leaves out, for the card's Details: is the review on the
 *  latest commit, what happened to the previous review's findings, what was posted, design. */
export function ClaudeReviewExtras({
  state: reviewState,
  ciState,
}: {
  state: ClaudeReviewPrState | undefined;
  // The CI review's state (its own run): the CI-diagnosis pill reads it, not the code review.
  ciState?: CiReviewState;
}): JSX.Element | null {
  const ciPill = ciCardPill(ciState);
  const state = reviewState?.status === 'succeeded' ? reviewState : null;
  if (state == null && ciPill == null) return null;
  const summary = state?.summary;
  const currency =
    state != null
      ? reviewCurrency({
          reviewedHeadSha: state.reviewedHeadSha,
          currentHeadSha: state.currentHeadSha,
          commitsSince: state.commitsSince,
        })
      : null;
  const tally = summary != null ? followUpTally(summary.followUp) : null;
  const toFix = summary != null ? threadsToFixLabel(summary) : null;
  const ciLabel = ciPill?.label ?? null;
  const total = summary != null ? findingTotal(summary) : 0;
  const design = summary?.lenses.design ?? 0;
  const posted =
    summary == null
      ? null
      : summary.postedFindings > 0
        ? `${summary.postedFindings} of ${total} posted`
        : summary.reviewPosted
          ? 'Posted'
          : total > 0
            ? 'Not posted'
            : null;
  if (currency == null && tally == null && posted == null && design === 0 && toFix == null && ciLabel == null) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <span className="inline-flex items-center gap-1 font-semibold text-ai-ink">
        <SparkleIcon size={12} className="text-ai-signal" />
        Claude
      </span>
      {currency != null && (
        <span className={`${PILL} ${currency.className}`} title={currency.title}>
          {currency.label}
        </span>
      )}
      {tally != null && (
        <span className="inline-flex items-center gap-1" title="Findings from the previous review">
          <span className={MUTED}>Earlier:</span>
          {tally.fixed > 0 && <span className={`${PILL} ${FOLLOW_UP_STATUS_CLASS.addressed}`}>{tally.fixed} fixed</span>}
          {tally.settled > 0 && (
            <span className={`${PILL} ${FOLLOW_UP_STATUS_CLASS.reply_accepted}`}>{tally.settled} settled</span>
          )}
          {tally.open > 0 && (
            <span className={`${PILL} ${FOLLOW_UP_STATUS_CLASS.not_addressed}`}>{tally.open} still open</span>
          )}
        </span>
      )}
      {toFix != null && <span className={`${PILL} ${OUTDATED_CLASS}`}>{toFix}</span>}
      {ciLabel != null && <span className={`${PILL} ${OUTDATED_CLASS}`}>{ciLabel}</span>}
      {posted != null && <span className={MUTED}>{posted}</span>}
      {design > 0 && <span className={GREY_PILL}>{design} design</span>}
    </div>
  );
}

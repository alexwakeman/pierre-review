import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { TICKET_ALIGNMENT_LABEL, type ClaudeReviewPrState } from '@pierre-review/shared';
import {
  isAutoReviewHoldError,
  useClaudeReviewStarting,
  useStartReviewFromList,
} from '../../hooks/useClaudeReview.js';
import {
  ALIGNMENT_SHORT,
  findingTotal,
  followUpTally,
  heldByAutoReview,
  outdatedLabel,
  reviewCellFor,
  severityPills,
} from '../../lib/claudeReviewColumn.js';
import {
  CLEAN_CLASS,
  FOLLOW_UP_STATUS_CLASS,
  OUTDATED_CLASS,
  SEVERITY_CLASS,
  TICKET_ALIGNMENT_CLASS,
  VERDICT_CLASS,
} from '../../lib/claudeReviewFollowUp.js';
import { AUTO_REVIEW_LABEL } from './pendingLabels.js';
import { unlockReviewSound } from '../../lib/sound.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { CheckIcon, SparkleIcon } from '../Icons.js';

// One card's Claude Review STRIP in the Open PRs list (the card's second row). Rendered ONLY when
// agentic AI is on (OpenPrsTable decides). Reads the list's ONE batched states answer — it fetches
// nothing on mount; the only requests it makes follow a click.
//
// Five cells on the list's shared `--opr-strip` grid, so every card's strip lines up:
//   outcome (state / verdict, auto mark, how far behind) · findings by severity · posted + design ·
//   stories, the previous review's findings, other reviewers' threads · the action button.
// Every figure comes from the server's `summary`, present only on a finished run — nothing here
// prints a zero it does not know.
//
// ⚠ The card is WHOLE-CARD clickable (it opens the PR), so every control here stops propagation.

const BUTTON =
  'rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:cursor-default disabled:opacity-60 dark:border-gray-700 dark:hover:border-gray-500';
const MUTED = 'text-[11px] text-gray-500 dark:text-gray-400';
const PILL = 'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium';
const GREY_PILL = `${PILL} bg-gray-500/10 text-gray-600 dark:text-gray-300`;
const NOTE_MS = 6000;

// The small marker on a run the workspace's auto review started (queued, running or finished).
function AutoMark(): JSX.Element {
  return <span className={MUTED}>{AUTO_REVIEW_LABEL}</span>;
}

function Cell({ children, className = '' }: { children?: ReactNode; className?: string }): JSX.Element {
  return <div className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}>{children}</div>;
}

export function ClaudeReviewStrip({
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
  // Claude Review tab, which says what is missing in place of its own Run button. A strip has no
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

  // ---- outcome ----
  let outcome: JSX.Element;
  let action: JSX.Element | null = null;
  switch (cell.kind) {
    case 'start':
      outcome = cell.failed ? (
        <span className={`${PILL} ${SEVERITY_CLASS.blocker}`}>Review failed</span>
      ) : (
        <span className={MUTED}>Not reviewed</span>
      );
      action = (
        <button type="button" onClick={run} className={BUTTON}>
          Review
        </button>
      );
      break;
    case 'starting':
      outcome = <span className={GREY_PILL}>Starting…</span>;
      break;
    case 'queued':
      outcome = (
        <>
          <span className={GREY_PILL}>Queued</span>
          {cell.auto && <AutoMark />}
        </>
      );
      break;
    case 'running':
      outcome = (
        <>
          <span className={`${PILL} bg-ai-signal/10 text-ai-signal`}>
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai-signal-fill" />
            Reviewing…
          </span>
          {cell.auto && <AutoMark />}
        </>
      );
      break;
    case 'done': {
      const behind = state != null ? outdatedLabel(state) : null;
      outcome = (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenReview();
            }}
            className={`${PILL} hover:underline ${cell.verdict != null ? VERDICT_CLASS[cell.verdict] : GREY_PILL}`}
            title="Open this review"
          >
            {cell.verdictLabel}
          </button>
          {cell.auto && <AutoMark />}
          {behind != null && (
            <span className={`${PILL} ${OUTDATED_CLASS}`} title="The PR has changed since this review">
              {behind}
            </span>
          )}
        </>
      );
      if (cell.headMoved) {
        action = (
          <button type="button" onClick={run} className={BUTTON}>
            Re-review
          </button>
        );
      }
      break;
    }
  }

  // ---- what the finished run found (only a succeeded run carries a summary) ----
  const summary = cell.kind === 'done' ? state?.summary : undefined;
  const pills = summary != null ? severityPills(summary) : [];
  const total = summary != null ? findingTotal(summary) : 0;
  const design = summary?.lenses.design ?? 0;
  const tally = summary != null ? followUpTally(summary.followUp) : null;
  const threads = summary?.threadAssessments;
  const stories = (summary?.tickets ?? []).filter((t) => t.alignment != null);

  return (
    <div
      role="cell"
      className="grid items-center gap-x-2.5 gap-y-1 [grid-template-columns:var(--opr-strip)] xl:[grid-template-columns:var(--opr-strip-xl)]"
      onClick={stop}
    >
      <Cell>
        {/* The model's mark only where a run exists; an unreviewed PR keeps the space so text aligns. */}
        {cell.kind === 'start' && !cell.failed ? (
          <span aria-hidden className="inline-block w-3 shrink-0" />
        ) : (
          <SparkleIcon size={12} className="shrink-0 text-ai-signal" />
        )}
        {outcome}
      </Cell>

      <Cell>
        {summary != null &&
          (pills.length > 0 ? (
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
          ))}
      </Cell>

      <Cell>
        {summary != null &&
          (summary.reviewPosted || summary.postedFindings > 0 ? (
            <span className={MUTED} title="Posted to GitHub">
              {summary.postedFindings > 0 ? `${summary.postedFindings} of ${total} posted` : 'Posted'}
            </span>
          ) : (
            total > 0 && <span className={MUTED}>Not posted</span>
          ))}
        {design > 0 && (
          <span className={GREY_PILL} title="Findings about the design, from a deep review">
            {design} design
          </span>
        )}
      </Cell>

      <Cell>
        {showError && (
          <span className="text-[11px] text-red-600 dark:text-red-400">
            {start.error.message || 'Could not start the review.'}
          </span>
        )}
        {note != null && !start.isError && <span className={MUTED}>{note}</span>}
        {stories.map((t, i) => (
          <span
            key={i}
            className={`${PILL} ${TICKET_ALIGNMENT_CLASS[t.alignment!]}`}
            title={`${t.title ?? 'User story'}: ${TICKET_ALIGNMENT_LABEL[t.alignment!]}`}
          >
            {t.key ?? (stories.length > 1 ? `Story ${i + 1}` : 'Story')} · {ALIGNMENT_SHORT[t.alignment!]}
          </span>
        ))}
        {tally != null && (
          <span className="inline-flex items-center gap-1" title="Findings from the previous review">
            <span className={MUTED}>Earlier:</span>
            {tally.fixed > 0 && (
              <span className={`${PILL} ${FOLLOW_UP_STATUS_CLASS.addressed}`}>{tally.fixed} fixed</span>
            )}
            {tally.open > 0 && (
              <span className={`${PILL} ${FOLLOW_UP_STATUS_CLASS.not_addressed}`}>
                {tally.open} still open
              </span>
            )}
          </span>
        )}
        {threads != null && threads.validUnaddressed > 0 && (
          <span
            className={`${PILL} ${OUTDATED_CLASS}`}
            title="Other reviewers' threads Claude judged valid and not yet addressed"
          >
            {threads.validUnaddressed} reviewer thread{threads.validUnaddressed === 1 ? '' : 's'} still valid
          </span>
        )}
      </Cell>

      <Cell className="justify-end">{action}</Cell>
    </div>
  );
}

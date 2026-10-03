import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { TICKET_ALIGNMENT_LABEL, type ClaudeReviewPrState } from '@pierre-review/shared';
import {
  isAutoReviewHoldError,
  useClaudeReviewStarting,
  useStartReviewFromList,
} from '../../hooks/useClaudeReview.js';
import {
  ALIGNMENT_SHORT,
  ciDiagnosisLabel,
  findingTotal,
  followUpTally,
  heldByAutoReview,
  reviewCurrency,
  reviewCellFor,
  reviewTone,
  severityPills,
  threadsToFixLabel,
  type ReviewTone,
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
import { fixPillLabel } from '../../lib/claudeAutoReview.js';
import { unlockReviewSound } from '../../lib/sound.js';
import { assessedStoryPills } from '../../lib/storyTabs.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { CheckIcon, SparkleIcon } from '../Icons.js';

// One Open PRs card's CLAUDE REVIEW PANEL — the card's last block, on the AI surface (`--ai-*`),
// with a left accent coloured by the run's outcome (`reviewTone`). Rendered ONLY when agentic AI
// is on (OpenPrsCards decides). Reads the list's ONE batched states answer — it fetches nothing on
// mount; the only requests it makes follow a click.
//
// Reading order, left to right, most important first:
//   "Claude" · the outcome (verdict / in flight / not reviewed, auto mark, on the latest commit or
//   how far behind) ·
//   findings by severity · CI failures explained · reviewer threads to fix · user stories ·
//   the previous review's findings · posted + design (muted) … right: AI Fix state + the action.
// Every figure comes from the server's `summary`, present only on a finished run — nothing here
// prints a zero it does not know.
//
// ⚠ The card is WHOLE-CARD clickable (it opens the PR), so every control here stops propagation.

const PILL = 'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium';
const GREY_PILL = `${PILL} bg-gray-500/10 text-gray-600 dark:text-gray-300`;
// The verdict is the panel's headline: a size up from the pills beside it.
const VERDICT_PILL =
  'inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold';
const MUTED = 'text-[11px] text-ai-muted';
// The AI surface's own button (the Claude Review tab's Run button idiom).
const AI_BUTTON =
  'whitespace-nowrap rounded border border-ai-border bg-white/70 px-2 py-0.5 text-[11px] font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:cursor-default disabled:opacity-60 dark:bg-gray-900/50';
const PLAIN_BUTTON =
  'whitespace-nowrap rounded border border-ai-border bg-white/70 px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:border-gray-400 dark:bg-gray-900/50 dark:text-gray-200 dark:hover:border-gray-500';
const NOTE_MS = 6000;

// The panel's left accent, by outcome. `none` keeps the plain AI border (an offer, not a result).
const ACCENT: Record<ReviewTone, string> = {
  none: 'border-l-ai-border',
  active: 'border-l-sky-400 dark:border-l-sky-500',
  bad: 'border-l-red-500',
  ok: 'border-l-green-500',
  neutral: 'border-l-gray-400 dark:border-l-gray-500',
};

// The small marker on a run the workspace's auto review started (queued, running or finished).
function AutoMark(): JSX.Element {
  return <span className={MUTED}>{AUTO_REVIEW_LABEL}</span>;
}

/** A thin vertical rule between the panel's groups. Paint only. */
function Rule(): JSX.Element {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-ai-border" />;
}

function Group({ children }: { children: ReactNode }): JSX.Element {
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-1">{children}</span>;
}

export function ClaudeReviewPanel({
  prId,
  state,
  onOpenReview,
  onOpenFix,
}: {
  prId: number;
  state: ClaudeReviewPrState | undefined;
  onOpenReview: () => void;
  onOpenFix: () => void;
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
  // Claude Review tab, which says what is missing in place of its own Run button. The panel has
  // no room for that sentence, and a start here would only fail.
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

  // The outcome pill IS a link to the review: the reader's eye lands on it first.
  const open = (e: MouseEvent): void => {
    e.stopPropagation();
    onOpenReview();
  };
  const OUTCOME_LINK =
    'cursor-pointer hover:brightness-95 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:brightness-125';

  // ---- the outcome (the panel's headline) and the action on the right ----
  let outcome: JSX.Element;
  let action: JSX.Element | null = null;
  switch (cell.kind) {
    case 'start':
      outcome = cell.failed ? (
        <button type="button" onClick={open} className={`${VERDICT_PILL} ${SEVERITY_CLASS.blocker} ${OUTCOME_LINK}`}>
          Review failed
        </button>
      ) : (
        <span className="text-xs text-ai-muted">Not reviewed</span>
      );
      action = (
        <button type="button" onClick={run} className={AI_BUTTON}>
          Review
        </button>
      );
      break;
    case 'starting':
      outcome = <span className={`${VERDICT_PILL} bg-gray-500/10 text-gray-600 dark:text-gray-300`}>Starting…</span>;
      break;
    case 'queued':
      outcome = (
        <>
          <span className={`${VERDICT_PILL} bg-gray-500/10 text-gray-600 dark:text-gray-300`}>Queued</span>
          {cell.auto && <AutoMark />}
        </>
      );
      break;
    case 'running':
      outcome = (
        <>
          <button type="button" onClick={open} className={`${VERDICT_PILL} bg-ai-signal/10 text-ai-signal ${OUTCOME_LINK}`}>
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai-signal-fill" />
            Reviewing…
          </button>
          {cell.auto && <AutoMark />}
        </>
      );
      break;
    case 'done': {
      // On the PR's current commit, or how far behind it — the same helper as the review pane.
      const currency =
        state != null
          ? reviewCurrency({
              reviewedHeadSha: state.reviewedHeadSha,
              currentHeadSha: state.currentHeadSha,
              commitsSince: state.commitsSince,
            })
          : null;
      outcome = (
        <>
          <button
            type="button"
            onClick={open}
            title="Open the review"
            className={`${VERDICT_PILL} ${
              cell.verdict != null ? VERDICT_CLASS[cell.verdict] : 'bg-gray-500/10 text-gray-600 dark:text-gray-300'
            } ${OUTCOME_LINK}`}
          >
            {cell.verdictLabel}
          </button>
          {cell.auto && <AutoMark />}
          {currency != null && (
            <span className={`${PILL} ${currency.className}`} title={currency.title}>
              {currency.label}
            </span>
          )}
        </>
      );
      action = cell.headMoved ? (
        <button type="button" onClick={run} className={AI_BUTTON}>
          Re-review
        </button>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenReview();
          }}
          className={PLAIN_BUTTON}
        >
          Open review
        </button>
      );
      break;
    }
  }

  // ---- what the finished run found (only a succeeded run carries a summary) ----
  const summary = cell.kind === 'done' ? state?.summary : undefined;
  const pills = summary != null ? severityPills(summary) : [];
  const total = summary != null ? findingTotal(summary) : 0;
  const design = summary?.lenses.design ?? 0;
  const tally = summary != null ? followUpTally(summary.followUp) : null;
  const ciLabel = summary != null ? ciDiagnosisLabel(summary.ci) : null;
  const toFix = summary != null ? threadsToFixLabel(summary) : null;
  const stories = assessedStoryPills(summary?.tickets ?? []);
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
  const fixLabel = fixPillLabel(state?.fix);

  return (
    <div
      className={`mt-1.5 flex cursor-default flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border border-l-[3px] border-ai-border bg-ai-surface px-2.5 py-1.5 ${ACCENT[reviewTone(cell)]}`}
      onClick={stop}
      role="group"
      aria-label="Claude review"
    >
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-ai-ink">
        <SparkleIcon size={12} className="text-ai-signal" />
        Claude
      </span>
      <Group>{outcome}</Group>

      {summary != null && (
        <>
          <Rule />
          <Group>
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
            {ciLabel != null && (
              <span className={`${PILL} ${OUTDATED_CLASS}`} title="Failing checks on the reviewed commit">
                {ciLabel}
              </span>
            )}
            {toFix != null && (
              <span
                className={`${PILL} ${OUTDATED_CLASS}`}
                title="Other reviewers' threads Claude judged right and not yet dealt with"
              >
                {toFix}
              </span>
            )}
          </Group>
        </>
      )}

      {(stories.length > 0 || tally != null) && (
        <>
          <Rule />
          <Group>
            {stories.map(({ ticket: t, label }) => (
              <span
                key={label}
                className={`${PILL} ${TICKET_ALIGNMENT_CLASS[t.alignment!]}`}
                title={`${t.title ?? 'User story'}: ${TICKET_ALIGNMENT_LABEL[t.alignment!]}`}
              >
                {label} · {ALIGNMENT_SHORT[t.alignment!]}
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
          </Group>
        </>
      )}

      {(posted != null || design > 0) && (
        <Group>
          {posted != null && (
            <span className={MUTED} title="Findings posted to GitHub">
              {posted}
            </span>
          )}
          {design > 0 && (
            <span className={GREY_PILL} title="Findings about the design, from a deep review">
              {design} design
            </span>
          )}
        </Group>
      )}

      {showError && (
        <span className="text-[11px] text-red-600 dark:text-red-400">
          {start.error.message || 'Could not start the review.'}
        </span>
      )}
      {note != null && !start.isError && <span className={MUTED}>{note}</span>}

      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
        {/* AI Fix on this PR (from the same batched answer): a run in flight, or a finished fix
            for the current head that nobody has pushed yet. Opens the PR's AI Fix tab. */}
        {fixLabel != null && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenFix();
            }}
            className={`${state?.fix === 'ready' ? `${PILL} ${CLEAN_CLASS}` : GREY_PILL} hover:underline`}
            title={state?.fix === 'ready' ? 'Review and push the fix in the AI Fix tab' : 'Open the AI Fix tab'}
          >
            {state?.fix === 'running' && (
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai-signal-fill" />
            )}
            {fixLabel}
          </button>
        )}
        {action}
      </span>
    </div>
  );
}

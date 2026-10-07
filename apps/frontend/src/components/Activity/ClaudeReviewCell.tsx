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
  ignoredLabel,
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
  VERDICT_CLASS,
} from '../../lib/claudeReviewFollowUp.js';
import { AUTO_REVIEW_LABEL } from './pendingLabels.js';
import { ReviewedAgo } from '../ReviewedAgo.js';
import { ciCardPill } from '../../lib/ciReview.js';
import { fixPillLabel } from '../../lib/claudeAutoReview.js';
import { unlockReviewSound } from '../../lib/sound.js';
import type { CardTicketPill, CoverageTone } from '../../lib/ticketReview.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { CheckIcon, SparkleIcon, WarningIcon } from '../Icons.js';
import { VerdictIcon } from '../VerdictIcon.js';

// One Open PRs card's CLAUDE REVIEW PANEL — the card's last block, on the AI surface (`--ai-*`),
// with a left accent coloured by the run's outcome (`reviewTone`). Rendered ONLY when agentic AI
// is on (OpenPrsCards decides). Reads the list's ONE batched states answer — it fetches nothing on
// mount; the only requests it makes follow a click.
//
// Reading order, left to right, most important first:
//   "Claude" · the outcome (verdict / in flight / not reviewed, auto mark, on the latest commit or
//   how far behind) ·
//   findings by severity · reviewer threads to fix · CI failures explained (the CI REVIEW's state —
//   its own run, from the list's ONE batched CI states answer) · the PR's tickets (the
//   TICKET review's coverage, from the board's ONE batched states answer) ·
//   the previous review's findings · posted (muted) … right: AI Fix state + the action.
// Every figure comes from the server's `summary`, present only on a finished run — nothing here
// prints a zero it does not know.
//
// ⚠ The card is WHOLE-CARD clickable (it opens the PR), and so is THIS PANEL: a click anywhere on
// it that is not one of its own controls opens the PR's Claude Review tab. Every control here
// stops propagation (so a button does its own job, never also opening the tab), and the keyboard
// route is the "Claude" label, a real button — never a role=button wrapper around buttons.

export const PILL = 'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium';
export const GREY_PILL = `${PILL} bg-gray-500/10 text-gray-600 dark:text-gray-300`;
// The verdict is the panel's headline: a size up from the pills beside it. Shared with the Claude
// Review tab's header, which leads with the same pill.
export const VERDICT_PILL =
  'inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold';
export const MUTED = 'text-[11px] text-ai-muted';
// The AI surface's own button (the Claude Review tab's Run button idiom).
const AI_BUTTON =
  'whitespace-nowrap rounded border border-ai-border bg-white/70 px-2 py-0.5 text-[11px] font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:cursor-default disabled:opacity-60 dark:bg-gray-900/50';
const PLAIN_BUTTON =
  'whitespace-nowrap rounded border border-ai-border bg-white/70 px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:border-gray-400 dark:bg-gray-900/50 dark:text-gray-200 dark:hover:border-gray-500';

// A ticket pill's colour by coverage (all met / some partly or can't tell / some not met).
const TICKET_TONE: Record<CoverageTone, string> = {
  ok: CLEAN_CLASS,
  partial: OUTDATED_CLASS,
  bad: SEVERITY_CLASS.blocker,
  muted: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
};

// The panel's left accent, by outcome. `none` keeps the plain AI border (an offer, not a result).
const ACCENT: Record<ReviewTone, string> = {
  none: 'border-l-ai-border',
  active: 'border-l-sky-400 dark:border-l-sky-500',
  bad: 'border-l-red-500',
  ok: 'border-l-green-500',
  neutral: 'border-l-gray-400 dark:border-l-gray-500',
};

// The small marker on a run the workspace's auto review started (queued, running or finished).
export function AutoMark(): JSX.Element {
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
  ticketPills = [],
  ciState,
}: {
  prId: number;
  state: ClaudeReviewPrState | undefined;
  // The CI review's state for this PR: "2 CI failures explained" while current, "Checking CI…".
  ciState?: CiReviewState;
  onOpenReview: () => void;
  onOpenFix: () => void;
  // The ticket review's reading of this PR's tickets ("BMD-1 · 4 of 6 met"); [] = none to show.
  ticketPills?: readonly CardTicketPill[];
}): JSX.Element {
  const start = useStartReviewFromList(prId);
  // Shared with the PR's own Claude Review tab: a start from either surface disables both.
  const starting = useClaudeReviewStarting(prId);
  const cell = reviewCellFor(state, starting);
  const held = heldByAutoReview(state);
  // A 409 AutoReviewInProgress says so only while the hold lasts; after it, the Review button is
  // back and the refusal is history.
  const showError = start.isError && !starting && (held || !isAutoReviewHoldError(start.error));

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
    start.mutate();
  };

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
            {cell.verdict != null && <VerdictIcon verdict={cell.verdict} size={13} />}
            {cell.verdictLabel}
          </button>
          {cell.auto && <AutoMark />}
          {currency != null && (
            <span className={`${PILL} ${currency.className}`} title={currency.title}>
              {currency.label}
            </span>
          )}
          <ReviewedAgo at={state?.finishedAt} />
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
  const tally = summary != null ? followUpTally(summary.followUp) : null;
  const ciPill = ciCardPill(ciState);
  const toFix = summary != null ? threadsToFixLabel(summary) : null;
  // Ignored findings are out of the pills and the posted total; the panel says how many instead.
  const ignored = summary != null ? ignoredLabel(summary) : null;
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
      className={`mt-1.5 flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border border-l-[3px] border-ai-border bg-ai-surface px-2.5 py-1.5 hover:bg-ai-surface-2 ${ACCENT[reviewTone(cell)]}`}
      // The whole panel opens the Claude Review tab (mouse); the "Claude" button below is the
      // keyboard route. Inner controls stop propagation, so they never also land here.
      onClick={open}
      role="group"
      aria-label="Claude review"
    >
      <button
        type="button"
        onClick={open}
        title="Open the Claude review"
        className="inline-flex shrink-0 items-center gap-1 rounded text-[11px] font-semibold text-ai-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <SparkleIcon size={12} className="text-ai-signal" />
        Claude
      </button>
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
            ) : ignored == null ? (
              <span className={`${PILL} ${CLEAN_CLASS}`}>
                <CheckIcon size={11} />
                No issues
              </span>
            ) : null}
            {ignored != null && (
              <span className={GREY_PILL} title="Findings you chose to ignore">
                {ignored}
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

      {ciPill != null && (
        <>
          <Rule />
          <Group>
            <span
              className={ciPill.running ? GREY_PILL : `${PILL} ${OUTDATED_CLASS}`}
              title="Claude's check of the failing CI on the PR's latest commit"
            >
              {ciPill.running && (
                <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai-signal-fill" />
              )}
              {ciPill.label}
            </span>
          </Group>
        </>
      )}

      {(ticketPills.length > 0 || tally != null) && (
        <>
          <Rule />
          <Group>
            {ticketPills.map((t) => (
              <span key={t.key} className={`${PILL} ${TICKET_TONE[t.tone]}`} title={t.title}>
                {t.running && <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai-signal-fill" />}
                {t.key} · {t.label}
                {t.stale && (
                  <>
                    <WarningIcon size={10} />
                    <span className="sr-only">(changed since)</span>
                  </>
                )}
              </span>
            ))}
            {tally != null && (
              <span className="inline-flex items-center gap-1" title="Findings from the previous review">
                <span className={MUTED}>Earlier:</span>
                {tally.fixed > 0 && (
                  <span className={`${PILL} ${FOLLOW_UP_STATUS_CLASS.addressed}`}>{tally.fixed} fixed</span>
                )}
                {tally.settled > 0 && (
                  <span className={`${PILL} ${FOLLOW_UP_STATUS_CLASS.reply_accepted}`}>{tally.settled} settled</span>
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

      {posted != null && (
        <Group>
          <span className={MUTED} title="Findings posted to GitHub">
            {posted}
          </span>
        </Group>
      )}

      {showError && (
        <span className="text-[11px] text-red-600 dark:text-red-400">
          {start.error.message || 'Could not start the review.'}
        </span>
      )}

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


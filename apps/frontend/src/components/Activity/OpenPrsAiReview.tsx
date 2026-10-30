import { Fragment, type ReactNode } from 'react';
import type { CiReviewState, ClaudeReviewPrState, ClaudeReviewVerdict, ClaudeTeamClaimSkip } from '@pierre-review/shared';
import { pairModelsLabel } from '@pierre-review/shared';
import { isAutoReviewHoldError, useClaudeReviewStarting, useStartReviewFromList } from '../../hooks/useClaudeReview.js';
import {
  findingTotal,
  followUpTally,
  heldByAutoReview,
  ignoredLabel,
  reviewCellFor,
  reviewCurrency,
  severityPills,
  threadsToFixLabel,
} from '../../lib/claudeReviewColumn.js';
import { ciCardPill } from '../../lib/ciReview.js';
import { fixPillLabel } from '../../lib/claudeAutoReview.js';
import { unlockReviewSound } from '../../lib/sound.js';
import type { CardTicketPill } from '../../lib/ticketReview.js';
import { dateTime, relativeTime } from '../../lib/ui.js';
import { AiRunGate } from '../AiSetup.js';
import { CheckIcon, CommitIcon, SparkleIcon, WarningIcon } from '../Icons.js';
import { VerdictIcon } from '../VerdictIcon.js';
import { Button, cx, FOCUS_RING, TEXT_LINK } from '../ui/index.js';
import { AUTO_REVIEW_LABEL } from './pendingLabels.js';

// THE OPEN PRS SIDE PANEL'S "AI REVIEW" SECTION — the drawer's own presentation of the list's ONE
// batched Claude Review states answer (the cards keep ClaudeReviewCell's strip). It follows the
// panel's fact list: a label column and a value column, the same gutters and the four type sizes.
// Reading order: the verdict and the commit it is on, what it found, the earlier review, CI, the
// stories, what was posted, when it ran and on what, AI Fix, then the ONE action. Every figure is
// the server's `summary` (a finished run only) — nothing here prints a zero it does not know, and
// nothing fetches on mount: the only requests follow a click.

/** One fact: label column + value column (the panel's own row, shared with OpenPrsRows). */
export function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-7 items-start gap-3 py-1">
      <dt className="w-24 shrink-0 pt-px text-meta text-ui-faint">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 text-body text-ui-ink">{children}</dd>
    </div>
  );
}

// Underlined at every width: in a panel of facts, a link must read as one at a glance.
const LINK = cx('hit inline-flex min-w-0 items-center gap-1.5 rounded-ui text-left', TEXT_LINK, FOCUS_RING);
const SEP = <span aria-hidden className="text-ui-faint"> · </span>;
const PULSE = <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ai-signal-fill motion-safe:animate-pulse" />;
// Red means blocks: a request for changes. Approval is the news, so it reads green. A comment is ink.
const VERDICT_TONE: Record<ClaudeReviewVerdict, string> = {
  REQUEST_CHANGES: 'text-ui-danger',
  APPROVE: 'text-ui-success',
  COMMENT: 'text-ui-ink',
};

/** "a · b · c" from the parts that exist. */
function Dotted({ parts }: { parts: ReadonlyArray<ReactNode | null | false> }): JSX.Element {
  const shown = parts.filter((p): p is ReactNode => p != null && p !== false);
  return (
    <span>
      {shown.map((p, i) => (
        // Each part keeps its words together; the line breaks at a separator.
        <Fragment key={i}>
          {i > 0 && SEP}
          <span className="whitespace-nowrap">{p}</span>
        </Fragment>
      ))}
    </span>
  );
}

export function DrawerAiReview({
  prId,
  state,
  ciState,
  teamClaimSkip,
  ticketPills,
  onOpenReview,
  onOpenFix,
}: {
  prId: number;
  state: ClaudeReviewPrState | undefined;
  ciState: CiReviewState | undefined;
  teamClaimSkip: Pick<ClaudeTeamClaimSkip, 'kind' | 'login'> | null;
  ticketPills: readonly CardTicketPill[];
  onOpenReview: () => void;
  onOpenFix: () => void;
}): JSX.Element {
  const start = useStartReviewFromList(prId);
  // Shared with the PR's Claude Review tab: a start from either surface disables both.
  const starting = useClaudeReviewStarting(prId);
  const cell = reviewCellFor(state, starting);
  const held = heldByAutoReview(state);
  // A 409 AutoReviewInProgress says so only while the hold lasts.
  const showError = start.isError && !starting && (held || !isAutoReviewHoldError(start.error));
  const auto = 'auto' in cell && cell.auto === true;
  const autoWord = auto ? <span className="text-meta text-ui-mute">{AUTO_REVIEW_LABEL}</span> : null;

  // ---- the verdict (or where the run is), always first ----
  let status: ReactNode;
  switch (cell.kind) {
    case 'start':
      status = cell.failed ? (
        <button type="button" onClick={onOpenReview} className={cx(LINK, 'text-ui-danger')} title="Open the AI review">
          <WarningIcon size={13} className="shrink-0" />
          Review failed
        </button>
      ) : teamClaimSkip ? (
        <span className="text-ui-mute">
          {teamClaimSkip.kind === 'reviewed' ? `Reviewed by @${teamClaimSkip.login}` : `Being reviewed by @${teamClaimSkip.login}`}
        </span>
      ) : (
        <span className="text-ui-mute">Not reviewed</span>
      );
      break;
    case 'starting':
      status = <span className="text-ui-mute">Starting…</span>;
      break;
    case 'queued':
      status = <Dotted parts={[<span className="text-ui-mute">Queued</span>, autoWord]} />;
      break;
    case 'running':
      status = (
        <Dotted
          parts={[
            <button type="button" onClick={onOpenReview} className={LINK} title="Open the AI review">
              {PULSE}
              Reviewing…
            </button>,
            autoWord,
          ]}
        />
      );
      break;
    case 'done':
      status = (
        <Dotted
          parts={[
            <button
              type="button"
              onClick={onOpenReview}
              title="Open the AI review"
              className={cx(LINK, 'font-medium', cell.verdict != null ? VERDICT_TONE[cell.verdict] : 'text-ui-ink')}
            >
              {cell.verdict != null && <VerdictIcon verdict={cell.verdict} size={13} />}
              {cell.verdictLabel}
            </button>,
            autoWord,
          ]}
        />
      );
      break;
  }

  // ---- the commit it is on (a finished run) ----
  const currency =
    cell.kind === 'done' && state != null
      ? reviewCurrency({ reviewedHeadSha: state.reviewedHeadSha, currentHeadSha: state.currentHeadSha, commitsSince: state.commitsSince })
      : null;

  // ---- what the finished run found ----
  const summary = cell.kind === 'done' ? state?.summary : undefined;
  const pills = summary != null ? severityPills(summary) : [];
  const total = summary != null ? findingTotal(summary) : 0;
  const ignored = summary != null ? ignoredLabel(summary) : null;
  const toFix = summary != null ? threadsToFixLabel(summary) : null;
  const tally = summary != null ? followUpTally(summary.followUp) : null;
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
  const ciPill = ciCardPill(ciState);
  const fixLabel = fixPillLabel(state?.fix);
  const ranOn = state?.ranOn != null && state.ranOn.length > 0 ? pairModelsLabel(state.ranOn) : null;
  const finishedAt = state?.finishedAt ?? null;

  // ---- the ONE action: start a review (through the gate), or open the finished one ----
  const canStart = cell.kind === 'start' || (cell.kind === 'done' && cell.headMoved);
  const run = (): void => {
    unlockReviewSound(); // gesture-gated WebAudio, so the completion chime can play later
    start.mutate();
  };

  return (
    <section role="group" aria-label="AI review" data-testid="open-prs-panel-ai-review">
      <h3 className="mb-1 text-meta text-ui-faint">AI review</h3>
      <dl className="m-0">
        <Fact label={cell.kind === 'done' ? 'Verdict' : 'Status'}>{status}</Fact>

        {currency != null && (
          <Fact label="Commit">
            <span className="inline-flex min-w-0 items-center gap-1.5" title={currency.title}>
              {currency.tone === 'current' ? (
                <CommitIcon size={13} className="shrink-0 text-ui-faint" />
              ) : (
                <WarningIcon size={13} className="shrink-0 text-ui-warn" />
              )}
              <span className={currency.tone === 'current' ? 'text-ui-mute' : undefined}>{currency.label}</span>
              <span className="font-mono text-meta text-ui-faint">{currency.sha}</span>
            </span>
          </Fact>
        )}

        {summary != null && (
          <Fact label="Findings">
            {pills.length > 0 || ignored != null ? (
              <span className="tabular-nums">
                <Dotted
                  parts={[
                    ...pills.map((p) =>
                      p.severity === 'blocker' ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ui-danger" />
                          {p.label}
                        </span>
                      ) : (
                        <span className="text-ui-mute">{p.label}</span>
                      ),
                    ),
                    ignored != null && (
                      <span className="text-ui-faint" title="Findings you chose to ignore">
                        {ignored}
                      </span>
                    ),
                  ]}
                />
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-ui-mute">
                <CheckIcon size={13} className="shrink-0 text-ui-faint" />
                No issues
              </span>
            )}
            {toFix != null && (
              // The threads it names are listed in the AI review — the link goes there.
              <p className="m-0 mt-0.5 text-meta text-ui-mute">
                <button
                  type="button"
                  onClick={onOpenReview}
                  className={LINK}
                  title="Other reviewers' threads the review judged right and not yet dealt with"
                >
                  {toFix}
                </button>
              </p>
            )}
          </Fact>
        )}

        {tally != null && (
          <Fact label="Earlier">
            <span className="tabular-nums text-ui-mute" title="Findings from the previous review">
              <Dotted
                parts={[
                  tally.fixed > 0 && `${tally.fixed} fixed`,
                  tally.settled > 0 && `${tally.settled} settled`,
                  tally.open > 0 && <span className="text-ui-ink">{tally.open} still open</span>,
                ]}
              />
            </span>
          </Fact>
        )}

        {ciPill != null && (
          <Fact label="CI">
            <span className="inline-flex items-center gap-1.5" title="The AI check of the failing CI on the PR's latest commit">
              {ciPill.running && PULSE}
              <span className={ciPill.running ? 'text-ui-mute' : undefined}>{ciPill.label}</span>
            </span>
          </Fact>
        )}

        {ticketPills.length > 0 && (
          <Fact label="Story check">
            <ul className="m-0 list-none space-y-0.5 p-0">
              {ticketPills.map((t) => (
                <li key={t.key} className="flex min-w-0 items-center gap-1.5" title={t.title}>
                  {t.running && PULSE}
                  <span className="shrink-0 font-mono text-meta text-ui-mute">{t.key}</span>
                  <span className={cx('min-w-0 truncate', t.tone === 'bad' ? 'text-ui-danger' : t.tone === 'muted' ? 'text-ui-mute' : undefined)}>
                    {t.label}
                  </span>
                  {t.stale && (
                    <>
                      <WarningIcon size={12} className="shrink-0 text-ui-warn" />
                      <span className="sr-only">(changed since)</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </Fact>
        )}

        {posted != null && (
          <Fact label="Posted">
            <span className="tabular-nums text-ui-mute" title="Findings posted to GitHub">
              {posted}
            </span>
          </Fact>
        )}

        {(finishedAt != null || ranOn != null) && (
          <Fact label={finishedAt != null ? 'Last run' : 'Running on'}>
            <span className="text-ui-mute">
              <Dotted
                parts={[
                  finishedAt != null && <span title={dateTime(finishedAt)}>{relativeTime(finishedAt)}</span>,
                  ranOn,
                ]}
              />
            </span>
          </Fact>
        )}

        {fixLabel != null && (
          <Fact label="AI Fix">
            <button
              type="button"
              onClick={onOpenFix}
              className={LINK}
              title={state?.fix === 'ready' ? 'Review and push the fix in the AI Fix tab' : 'Open the AI Fix tab'}
            >
              {state?.fix === 'running' && PULSE}
              {fixLabel}
            </button>
          </Fact>
        )}
      </dl>

      {/* The action sits in the value column, under the facts it acts on. */}
      <div className="mt-1.5 flex gap-3">
        <span aria-hidden className="w-24 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
          {canStart ? (
            <AiRunGate kind="review">
              <Button size="sm" icon={<SparkleIcon size={12} />} onClick={run}>
                {cell.kind === 'done' ? 'Re-review' : 'Review'}
              </Button>
            </AiRunGate>
          ) : cell.kind === 'done' ? (
            <Button size="sm" variant="ghost" className="-ml-2 touch:-ml-3" onClick={onOpenReview}>
              Open review
            </Button>
          ) : null}
          {showError && <p className="m-0 w-full text-meta text-ui-danger">{start.error.message || 'Could not start the review.'}</p>}
        </div>
      </div>
    </section>
  );
}

// THE STORY PEEK (docs/FRONTEND.md § Activity → This Sprint): what a This Sprint ticket card shows IN
// PLACE when clicked — enough to judge the ticket without leaving the board. Mounted only while the
// card's popover is open, so its reads run ON CLICK (nothing on a board fetches on mount).
//
//   1. the TICKET REVIEW's result when one exists: its summary, then each acceptance criterion with
//      its status chip (Met, Partly met, Not met, …), and the currency pill when it is not current;
//   2. else the sprint BRIEF: its summary and numbered criteria, "Not checked against the code yet";
//   3. else "Reading this ticket…" while the brief pass will still read it;
//   4. else the start of the ticket's own text.
// No docs check, no design, no pull requests — "Open story" goes to the story tab for those.
//
// The same fold as the Story section (lib/ticketStory.ts `storySummaryOf`); the reads are the Story
// section's own hooks, on the same query keys.
import { TICKET_CRITERION_STATUS_LABEL, type SprintGraphNode } from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useTicketStory } from '../../hooks/useTicketPrs.js';
import { useTicketReviewById, useTicketReviewStates } from '../../hooks/useTicketReview.js';
import { TICKET_CRITERION_STATUS_CLASS } from '../../lib/claudeReviewFollowUp.js';
import { REVIEW_CHIP } from '../../lib/reviewStyles.js';
import { ticketCurrency } from '../../lib/ticketReview.js';
import { storySummaryOf } from '../../lib/ticketStory.js';
import { useFilters } from '../../store/filters.js';
import { ArrowIcon } from '../Icons.js';
import { CurrencyPill } from '../TicketReviewParts.js';

const MUTED = 'text-gray-600 dark:text-gray-300';

export function StoryPeek({ node, onOpenStory }: { node: SprintGraphNode; onOpenStory: () => void }): JSX.Element {
  const ai = useAiCapabilities();
  const workspaceId = useFilters((s) => s.workspaceId);
  const statesQ = useTicketReviewStates([node.ident], ai.enabled);
  const state = statesQ.data?.states.find((s) => s.ident === node.ident);
  const storyQ = useTicketStory(workspaceId, node.ident);
  const summary = storySummaryOf(state, storyQ.data);
  const reviewQ = useTicketReviewById(summary.kind === 'review' ? summary.runId : null);
  const loading = (ai.enabled && statesQ.isLoading) || storyQ.isLoading || (summary.kind === 'review' && reviewQ.isLoading);

  let body: JSX.Element;
  if (loading) body = <p className={`text-[12px] ${MUTED}`}>Loading…</p>;
  else if (summary.kind === 'review' && reviewQ.data?.status === 'succeeded' && reviewQ.data.assessment != null) {
    const a = reviewQ.data.assessment;
    const currency = state != null ? ticketCurrency(state) : null;
    body = (
      <div className="space-y-2" data-testid="story-peek-review">
        {currency != null && currency.tone !== 'current' && (
          <div>
            <CurrencyPill currency={currency} />
          </div>
        )}
        {a.summary != null && a.summary !== '' && <p className="whitespace-pre-wrap text-[12px] text-gray-800 dark:text-gray-100">{a.summary}</p>}
        {a.criteria.length > 0 ? (
          <ul aria-label="Acceptance criteria" className="space-y-1">
            {a.criteria.map((c) => (
              <li key={c.ref} className="flex items-start gap-1.5 text-[12px] leading-snug">
                <span className={`${REVIEW_CHIP} ${TICKET_CRITERION_STATUS_CLASS[c.status]}`}>{TICKET_CRITERION_STATUS_LABEL[c.status]}</span>
                <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-100">{c.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={`text-[12px] ${MUTED}`}>No acceptance criteria.</p>
        )}
      </div>
    );
  } else if (summary.kind === 'brief') {
    const b = summary.brief;
    body = (
      <div className="space-y-2" data-testid="story-peek-brief">
        {b.summary !== '' && <p className="text-[12px] text-gray-800 dark:text-gray-100">{b.summary}</p>}
        {b.criteria.length > 0 ? (
          <>
            <ol aria-label="Acceptance criteria" className="space-y-0.5">
              {b.criteria.map((c) => (
                <li key={c.n} className="flex items-start gap-1.5 text-[12px] leading-snug">
                  <span className={`shrink-0 font-mono text-[11px] ${MUTED}`}>{c.n}.</span>
                  <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-100">{c.text}</span>
                </li>
              ))}
            </ol>
            <p className={`text-[12px] ${MUTED}`}>Not checked against the code yet.</p>
          </>
        ) : (
          <p className={`text-[12px] ${MUTED}`}>No acceptance criteria.</p>
        )}
      </div>
    );
  } else if (summary.kind === 'reading') body = <p className={`text-[12px] ${MUTED}`}>Reading this ticket…</p>;
  else {
    const text = storyQ.data?.story?.description.trim() ?? '';
    body =
      text !== '' ? (
        <p className="line-clamp-6 whitespace-pre-wrap break-words text-[12px] text-gray-800 dark:text-gray-100">{text}</p>
      ) : (
        <p className={`text-[12px] ${MUTED}`}>No summary yet.</p>
      );
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="font-mono text-[11px] font-semibold text-gray-700 dark:text-gray-200">
          {node.key}
          {node.status != null && <span className={`ml-1.5 font-sans font-normal ${MUTED}`}>{node.status.name}</span>}
        </p>
        <p className="text-[12px] font-semibold leading-snug text-gray-900 dark:text-gray-50">{node.title !== '' ? node.title : 'Not read'}</p>
      </div>
      {body}
      <button
        type="button"
        onClick={onOpenStory}
        className="inline-flex items-center gap-1 rounded text-[12px] font-medium text-sky-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
      >
        Open story
        <ArrowIcon size={11} />
      </button>
    </div>
  );
}

// THE WHOLE STORY, ONCE — the Open PRs ticket stack's "Story check" panel, below the stack header and
// above its open PR cards. The PR pane shows only that PR's share (TicketCoverage.tsx) and links
// here ("See the whole story in Open PRs", store/stackStoryCheck.ts).
//
// ⚠ NOTHING FETCHES ON MOUNT. The panel is COLLAPSED by default (open state per session, in
// memory); its body — the ticket review read by the states' `latestRunId` — is mounted only while
// open, so a board of stacks makes no request per stack. The header's coverage pill and
// "reviewed X ago" come from the ONE batched states request the list already made.
//
// The body is the same pieces as the pane (TicketReviewParts.tsx) with no viewed PR: the summary
// (markdown, PR refs open the PR in Limn through ReviewPrRefsProvider), every criterion with who
// delivers it or where it belongs, the missing and not-asked-for items, the currency pill and the
// story, and "What each PR adds" — every member's contribution card at its current head (a member
// with none shows nothing), riding the same review read. No Post buttons: posting stays per PR, in
// the pane.
import { useId, useMemo } from 'react';
import type { TicketRef, TicketReviewState } from '@pierre-review/shared';
import { useTicketReviewById } from '../../hooks/useTicketReview.js';
import { memberLabel, ticketCurrency } from '../../lib/ticketReview.js';
import { reviewTexts, type KnownPr } from '../../lib/reviewPrRefs.js';
import type { CardTicket } from '../../lib/cardTickets.js';
import { useStackStoryCheck } from '../../store/stackStoryCheck.js';
import { ChevronIcon } from '../Icons.js';
import { ReviewPrRefsProvider } from '../ReviewPrRefs.js';
import { CurrencyPill, MemberCards, TicketResults } from '../TicketReviewParts.js';
import { StoryDisclosure } from '../TicketStory.js';

const MUTED = 'text-gray-500 dark:text-gray-400';

export function StackStoryCheck({
  stackId,
  ticket,
  state,
  storyPrId,
}: {
  stackId: string;
  ticket: CardTicket;
  state: TicketReviewState;
  /** Any open PR on the ticket — the stored Jira row is read through its workspace. */
  storyPrId: number;
}): JSX.Element | null {
  const open = useStackStoryCheck((s) => s.open.has(stackId));
  const toggle = useStackStoryCheck((s) => s.toggle);
  const bodyId = useId();
  if (state.latestRunId == null) return null;
  return (
    <div className="px-3 pb-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => toggle(stackId)}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-gray-600 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:text-gray-50"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
        Story check
      </button>
      {open && (
        <div
          id={bodyId}
          className="mt-1.5 space-y-2 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950"
        >
          <StoryCheckBody runId={state.latestRunId} ticket={ticket} state={state} storyPrId={storyPrId} />
        </div>
      )}
    </div>
  );
}

function StoryCheckBody({
  runId,
  ticket,
  state,
  storyPrId,
}: {
  runId: number;
  ticket: CardTicket;
  state: TicketReviewState;
  storyPrId: number;
}): JSX.Element {
  const { data: review, isLoading, isError } = useTicketReviewById(runId);
  const members = useMemo(() => review?.members ?? [], [review]);
  const known = useMemo<KnownPr[]>(
    () => members.map((m) => ({ prId: m.prId, repoFullName: m.repo, number: m.number, title: m.title })),
    [members],
  );
  const texts = useMemo(() => (review != null ? reviewTexts(null, [review]) : []), [review]);
  // The stored Jira row when Limn has read it (opened on demand), else the story as judged.
  const jiraRef = useMemo<TicketRef | null>(
    () =>
      ticket.ident != null && ticket.url != null
        ? { key: ticket.key, url: ticket.url, provider: 'jira', canFetchDetails: true }
        : null,
    [ticket.ident, ticket.key, ticket.url],
  );
  if (isLoading) return <p className={`text-xs ${MUTED}`}>Loading…</p>;
  if (isError || review == null) return <p className="text-xs text-red-600 dark:text-red-400">Could not load the story check.</p>;
  const labelOf = (prId: number): string | null => {
    const m = members.find((x) => x.prId === prId);
    return m != null ? memberLabel(m) : null;
  };
  const currency = ticketCurrency(state, labelOf);
  // A bare "#12" in the text reads as the repo of the PR that started the run.
  const home = members.find((m) => m.prId === review.originPrId) ?? members[0];
  return (
    <ReviewPrRefsProvider
      // No PR is "the one being viewed" here, so every ref is a link.
      currentPrId={-1}
      currentRepoFullName={home?.repo ?? ''}
      known={known}
      texts={texts}
    >
      {currency != null && (
        <div>
          <CurrencyPill currency={currency} />
        </div>
      )}
      {review.status === 'succeeded' ? (
        <TicketResults review={review} viewedPrId={null} />
      ) : (
        <p className={`text-xs ${MUTED}`}>No result stored.</p>
      )}
      <MemberCards members={members} />
      <StoryDisclosure prId={storyPrId} jiraRef={jiraRef} stored={[review.ticket]} url={ticket.url} />
    </ReviewPrRefsProvider>
  );
}

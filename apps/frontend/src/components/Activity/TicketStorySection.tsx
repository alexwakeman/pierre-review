// THE STORY SECTION — one ticket's story, in ONE component for both of its mounts (docs/FRONTEND.md §
// The story view):
//
//   • the Open PRs ticket stack (OpenPrsCards' `TicketStack`), COLLAPSED by default (open state per
//     session, store/stackStoryCheck.ts — the PR pane's "See the whole story in Open PRs" opens it);
//   • the story view (the ticket tab, Ticket/TicketTabView.tsx), OPEN by default.
//
// In order, and nothing else (no dependency or reference cards, ever):
//   1. CLAUDE'S SUMMARY AND CRITERIA (`storySummaryOf`, lib/ticketStory.ts): the ticket review's result
//      when one exists — the currency pill, the summary, every criterion with who delivers it, the
//      missing and not-asked-for items, and "What each PR adds"; otherwise the sprint brief's summary
//      and numbered criteria ("Worked out from the description" when derived); otherwise nothing.
//   2. THE TICKET AS WRITTEN — the StoryDisclosure ("As written in Jira"): the stored tracker row read
//      through any PR on the ticket, else the ticket review's snapshot, else the sprint read's text.
//   3. THE STORY'S DESIGN (StoryDesignSection.tsx) — only where agentic AI runs and the ticket has a PR.
//
// Between 1 and 2, where agentic AI runs: the DOCS CHECK (StoryDocsAlignment.tsx) — a click checks the
// story against the workspace's reference docs. Its per-criterion notes sit UNDER the criteria rows of
// 1 (both lists, through `docsItems`) only when the run was written against that same list
// (`criteriaMatch`, lib/storyDocsAlignment.ts); otherwise the docs block draws its own numbered list.
//
// ⚠ NOTHING FETCHES ON MOUNT. The body (and every read in it) is mounted only while the section is open,
// so a board of stacks makes no request per stack. The brief read (`GET /api/ticket-story`) runs only
// when there is no ticket review to show.
import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  TRACKER_PROVIDER_LABEL,
  storyDocsItemsByN,
  type SprintBrief,
  type StoryDocsCriterion,
  type StoryDocsCriterionItem,
  type TicketRef,
  type TicketReviewState,
} from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useStartStoryDocsAlignment, useStoryDocsAlignment, useStoryDocsStarting } from '../../hooks/useStoryDocsAlignment.js';
import { useTicketReviewById } from '../../hooks/useTicketReview.js';
import { criteriaMatch, shownRun, type StorySummaryKind } from '../../lib/storyDocsAlignment.js';
import { useTicketStory } from '../../hooks/useTicketPrs.js';
import type { CardTicket } from '../../lib/cardTickets.js';
import { memberLabel, ticketCurrency } from '../../lib/ticketReview.js';
import { reviewTexts, type KnownPr } from '../../lib/reviewPrRefs.js';
import { storyDesignOffered, storyFallbackTicket, storySummaryOf } from '../../lib/ticketStory.js';
import { useFilters } from '../../store/filters.js';
import { ChevronIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { ReviewPrRefsProvider } from '../ReviewPrRefs.js';
import { CurrencyPill, MemberCards, TicketResults } from '../TicketReviewParts.js';
import { StoryDisclosure } from '../TicketStory.js';
import { StoryDesignSection } from './StoryDesignSection.js';
import { StoryDocsAlignmentBlock, StoryDocsCriterionDetail } from './StoryDocsAlignment.js';

const MUTED = 'text-gray-500 dark:text-gray-400';
/** Criteria listed before "Show all" (real stories itemise up to ~35). */
const CRITERIA_SHOWN = 10;
const NO_DOCS_ITEMS: ReadonlyMap<number, StoryDocsCriterionItem> = new Map();

export function TicketStorySection({
  ticket,
  state,
  storyPrId,
  prCount,
  open,
  onToggle,
}: {
  /** The ticket; only one with an `ident` has a story section. */
  ticket: CardTicket & { ident: string };
  /** The ticket review's state; undefined = never reviewed (or no AI here). */
  state: TicketReviewState | undefined;
  /** Any PR on the ticket — the stored tracker row is read through its workspace; null = no PR. */
  storyPrId: number | null;
  /** Open + merged PRs on the ticket (the design needs one). */
  prCount: number;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const bodyId = useId();
  return (
    <div className="px-3 pb-2" data-testid="story-section">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-gray-600 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:text-gray-50"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
        Story
      </button>
      {open && (
        <div
          id={bodyId}
          className="mt-1.5 space-y-3 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950"
        >
          <StoryBody ticket={ticket} state={state} storyPrId={storyPrId} prCount={prCount} />
        </div>
      )}
    </div>
  );
}

function StoryBody({
  ticket,
  state,
  storyPrId,
  prCount,
}: {
  ticket: CardTicket & { ident: string };
  state: TicketReviewState | undefined;
  storyPrId: number | null;
  prCount: number;
}): JSX.Element {
  const ai = useAiCapabilities();
  const workspaceId = useFilters((s) => s.workspaceId);
  const reviewed = state?.latestRunId != null;
  // The brief (and the sprint read's text) only when there is no ticket review to lead with.
  const storyQ = useTicketStory(reviewed ? null : workspaceId, reviewed ? null : ticket.ident);
  const summary = storySummaryOf(state, storyQ.data);
  const jiraRef = useMemo<TicketRef | null>(
    () => (ticket.url != null ? { key: ticket.key, url: ticket.url, provider: ticket.provider ?? 'jira', canFetchDetails: true } : null),
    [ticket.key, ticket.url, ticket.provider],
  );
  const tracker = TRACKER_PROVIDER_LABEL[ticket.provider ?? 'jira'];
  const fallback = useMemo(() => storyFallbackTicket(storyQ.data, ticket.key, ticket.url), [storyQ.data, ticket.key, ticket.url]);
  // THE DOCS CHECK. Read only here, in the open body. The review's criteria are known only inside
  // ReviewSummary (its own read), so each summary folds `useDocsNotes` against the list it renders.
  const docsQ = useStoryDocsAlignment(workspaceId, ticket.ident);
  const docsStart = useStartStoryDocsAlignment(workspaceId, ticket.ident);
  const docsStarting = useStoryDocsStarting(workspaceId, ticket.ident);
  const docs: DocsCheck | null = ai.enabled ? { q: docsQ, start: docsStart, starting: docsStarting } : null;
  const brief = summary.kind === 'brief' ? summary.brief : null;
  const briefCriteria = useMemo<StoryDocsCriterion[] | null>(
    () => brief?.criteria.map((c) => ({ n: c.n, text: c.text })) ?? null,
    [brief],
  );
  const briefNotes = useDocsNotes(docs, summary.kind, briefCriteria);
  return (
    <>
      {summary.kind === 'review' && state != null ? (
        <ReviewSummary runId={summary.runId} ticket={ticket} state={state} storyPrId={storyPrId} jiraRef={jiraRef} tracker={tracker} docs={docs} />
      ) : (
        <>
          {summary.kind === 'brief' && <BriefSummary brief={summary.brief} docsItems={briefNotes.items} />}
          {summary.kind === 'reading' && <p className={`text-xs ${MUTED}`}>Reading this ticket…</p>}
          {briefNotes.block}
          <StoryDisclosure
            prId={storyPrId}
            jiraRef={jiraRef}
            stored={[fallback]}
            url={ticket.url}
            label={`As written in ${tracker}`}
          />
        </>
      )}
      {storyDesignOffered(ai.enabled, prCount) && <StoryDesignSection key={ticket.ident} ident={ticket.ident} />}
    </>
  );
}

/** The docs check's server state, read once per open body and handed to whichever summary leads. */
interface DocsCheck {
  q: ReturnType<typeof useStoryDocsAlignment>;
  start: ReturnType<typeof useStartStoryDocsAlignment>;
  starting: boolean;
}

/** The docs check's notes for the criteria list a summary renders (empty unless `criteriaMatch`), and
 *  the block itself (null where agentic AI is off). */
function useDocsNotes(
  docs: DocsCheck | null,
  kind: StorySummaryKind,
  shownCriteria: readonly StoryDocsCriterion[] | null,
): { items: ReadonlyMap<number, StoryDocsCriterionItem>; block: ReactNode } {
  const run = shownRun(docs?.q.data);
  const attached = criteriaMatch(run, kind, shownCriteria);
  const items = useMemo(() => (attached ? storyDocsItemsByN(run?.result) : NO_DOCS_ITEMS), [attached, run]);
  const block =
    docs != null ? <StoryDocsAlignmentBlock q={docs.q} start={docs.start} starting={docs.starting} attached={attached} /> : null;
  return { items, block };
}

/** The sprint brief: Claude Haiku's summary and the criteria, numbered, one sentence each. */
function BriefSummary({
  brief,
  docsItems = NO_DOCS_ITEMS,
}: {
  brief: SprintBrief;
  /** The docs check's notes by criterion number, when written against this list. */
  docsItems?: ReadonlyMap<number, StoryDocsCriterionItem>;
}): JSX.Element {
  const [all, setAll] = useState(false);
  // Collapsed, a row past CRITERIA_SHOWN still shows when it carries a docs note — the note is drawn
  // only under its row here (the block's own list is empty when attached), so hiding the row hides it.
  const shown = all ? brief.criteria : brief.criteria.filter((c, i) => i < CRITERIA_SHOWN || docsItems.has(c.n));
  return (
    <div className="space-y-2" data-testid="story-brief">
      <div className="flex items-start gap-1.5">
        {brief.summary !== '' ? (
          <p className="min-w-0 flex-1 text-sm text-gray-800 dark:text-gray-100">{brief.summary}</p>
        ) : (
          <span className="flex-1" />
        )}
        <InfoButton title="Summary and criteria">
          <p>
            Claude Haiku reads the ticket and writes a short summary and its acceptance criteria, one sentence each. When the
            ticket lists no criteria of its own, they are worked out from the description.
          </p>
          <p>It reads the ticket again whenever its text changes.</p>
          <p>Once Claude has checked the ticket against its pull requests, that check shows here instead.</p>
        </InfoButton>
      </div>
      {brief.criteria.length > 0 ? (
        <>
          {brief.criteriaDerived && <p className={`text-xs ${MUTED}`}>Worked out from the description</p>}
          <ol className="space-y-1" aria-label="Acceptance criteria">
            {shown.map((c) => {
              const docs = docsItems.get(c.n);
              return (
                <li key={c.n} className="flex flex-col px-1 text-[13px] text-gray-800 dark:text-gray-100">
                  <div className="flex items-baseline gap-2">
                    <span className={`w-5 shrink-0 text-right font-mono text-xs ${MUTED}`}>{c.n}</span>
                    <span className="min-w-0 break-words">{c.text}</span>
                  </div>
                  {docs != null && (
                    <div className="pl-7">
                      <StoryDocsCriterionDetail item={docs} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {brief.criteria.length > CRITERIA_SHOWN && (
            <button
              type="button"
              aria-expanded={all}
              onClick={() => setAll((v) => !v)}
              className="px-1 text-xs text-sky-700 hover:underline dark:text-sky-300"
            >
              {all ? 'Show fewer' : `Show all ${brief.criteria.length} criteria`}
            </button>
          )}
        </>
      ) : (
        <p className={`text-xs ${MUTED}`}>No acceptance criteria.</p>
      )}
    </div>
  );
}

/** The ticket review's whole story (the same pieces as the PR pane, TicketReviewParts.tsx, with no
 *  viewed PR) and, under it, the ticket as written. No Post buttons: posting stays per PR, in the pane. */
function ReviewSummary({
  runId,
  ticket,
  state,
  storyPrId,
  jiraRef,
  tracker,
  docs,
}: {
  runId: number;
  ticket: CardTicket;
  state: TicketReviewState;
  storyPrId: number | null;
  jiraRef: TicketRef | null;
  tracker: string;
  /** The docs check (null where agentic AI is off), drawn after the result, before the ticket as written. */
  docs: DocsCheck | null;
}): JSX.Element {
  const { data: review, isLoading, isError } = useTicketReviewById(runId);
  const reviewCriteria = useMemo<StoryDocsCriterion[] | null>(() => {
    const a = review?.status === 'succeeded' ? review.assessment : null;
    return a != null ? a.criteria.map((c, i) => ({ n: i + 1, text: c.text })) : null;
  }, [review]);
  const docsNotes = useDocsNotes(docs, 'review', reviewCriteria);
  const members = useMemo(() => review?.members ?? [], [review]);
  const known = useMemo<KnownPr[]>(
    () => members.map((m) => ({ prId: m.prId, repoFullName: m.repo, number: m.number, title: m.title })),
    [members],
  );
  const texts = useMemo(() => (review != null ? reviewTexts(null, [review]) : []), [review]);
  if (isLoading) return <p className={`text-xs ${MUTED}`}>Loading…</p>;
  if (isError || review == null) {
    // The docs check does not need the review: with no criteria it draws the run's own numbered list.
    return (
      <div className="space-y-2">
        <p className="text-xs text-red-600 dark:text-red-400">Could not load the story.</p>
        {docsNotes.block}
      </div>
    );
  }
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
      <div className="space-y-2" data-testid="story-review">
        {currency != null && (
          <div>
            <CurrencyPill currency={currency} />
          </div>
        )}
        {review.status === 'succeeded' ? (
          <TicketResults review={review} viewedPrId={null} docsItems={docsNotes.items} />
        ) : (
          <p className={`text-xs ${MUTED}`}>No result stored.</p>
        )}
        <MemberCards members={members} />
        {docsNotes.block}
        <StoryDisclosure
          prId={storyPrId ?? review.originPrId}
          jiraRef={jiraRef}
          stored={[review.ticket]}
          url={ticket.url}
          label={`As written in ${tracker}`}
        />
      </div>
    </ReviewPrRefsProvider>
  );
}

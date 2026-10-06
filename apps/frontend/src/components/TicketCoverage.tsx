// THE TICKET REVIEW in the PR pane — the "Story check" section, a SIBLING of Claude's PR review in
// the Claude Review tab (ClaudeReviewTab.tsx), drawn through the same ReviewSection shell.
//
// One review per TICKET across every PR that names it (open and merged), never one per PR. So a
// block here can say "Done in api#88": the criterion is delivered by ANOTHER PR on the ticket. The
// pure half (labels, currency words, post targets, what Check sends) is lib/ticketReview.ts.
//
//   - one block per ticket the PR is on (`GET /api/prs/:id/ticket-reviews`), each with its own
//     Check / Re-check (mutation key `['ticket-review-start', ident]`, shared with Open PRs);
//   - a currency pill the SERVER computed ("Checked against 3 PRs", "web#412 pushed since"), and
//     how long ago the shown run finished ("reviewed 2 hours ago");
//   - criteria with status and attribution; one Post per unmet item, on the PR it belongs to;
//   - SLIM where an Open PRs ticket stack holds the whole story (`slimStoryCheck`: a tracker ticket,
//     `issueLinks`, an open PR on it): only THIS PR's share (`prTicketShare`, lib/ticketShare.ts) —
//     what it delivers, what belongs in it, each with its Post — "What this PR adds" (its contribution
//     card at its current head, when it has one), a count of the rest, and "See the
//     whole story in Open PRs" (`showStoryInOpenPrs`). A pasted (`manual:`) story keeps the full
//     view: no stack exists for it. The result pieces are shared with the stack
//     (TicketReviewParts.tsx);
//   - a collapsible "Story" per block (TicketStory.tsx): the ticket as markdown, read on open;
//   - an older PR review's stories that no ticket review covers, as blocks of their own marked
//     "Checked on this PR only" (ONE story section; the old "User stories" section is gone);
//   - the story panel (pasted stories + the Jira picker) behind a plain "+ Add story" link, whose
//     Check starts a one-PR check per pasted story. The PR review's Run button no longer takes a
//     story.
//
// Rules: every string from Claude renders as PLAIN TEXT (no href built from it), except the run's
// summary, which is markdown (one lead sentence + a bullet per gap) through the sanitizing
// <Markdown>; a PR reference in any of it ("api#12") is an in-app button via ReviewPrRefs.tsx. A
// story's own text renders as markdown only inside the Story disclosure. Type scale:
// lib/reviewStyles.ts (the Findings card is the reference); icons from Icons.tsx; the explanation
// lives in the ⓘ.
// ⚠ Posting follows the post-write copy contract: once GitHub answered with a comment id, the
// button never comes back (a retry double-posts).
import { useMemo, useState, type ReactNode } from 'react';
import {
  TICKET_ALIGNMENT_LABEL,
  type ClaudeFinding,
  type ClaudeReviewTicketEntry,
  type PrDetail,
  type PrTicketReviewsResponse,
  type TicketReview,
} from '@pierre-review/shared';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { useWorkspaces } from '../hooks/useWorkspaces.js';
import {
  useStartStoryCheck,
  useStartTicketReview,
  useTicketReviewById,
  useTicketReviewStarting,
  useTicketReviewStream,
  useTicketReviews,
} from '../hooks/useTicketReview.js';
import {
  TICKET_ALIGNMENT_CLASS,
  checkTicketDrafts,
  createTicketDraftStore,
  ticketInputFromStored,
  ticketsRequestFromCheck,
  type TicketDraft,
} from '../lib/claudeReviewFollowUp.js';
import {
  TICKET_PHASE_LABEL,
  coverageLabel,
  itemsByRef,
  memberLabel,
  planStoryStart,
  recheckBody,
  refusalSentence,
  ticketCurrency,
  ticketProgressPct,
} from '../lib/ticketReview.js';
import { prCardOf, prTicketShare, shareRestLine, slimStoryCheck } from '../lib/ticketShare.js';
import { jiraRefFor, storyUrlOf } from '../lib/ticketStory.js';
import { showStoryInOpenPrs } from '../store/stackStoryCheck.js';
import { AiRunGate } from './AiSetup.js';
import { ClaudeReviewTicketPanel, ClaudeReviewTicketResults, storyLabel } from './ClaudeReviewFollowUp.js';
import { JiraKeyLink } from './ClaudeReviewTickets.js';
import { StoryDisclosure } from './TicketStory.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection, SectionCount } from './ReviewSection.js';
import { REVIEW_CHIP } from '../lib/reviewStyles.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { ReviewedAgo } from './ReviewedAgo.js';
import {
  CriterionRow,
  CurrencyPill,
  MissingList,
  NotRequestedList,
  PrCardDisclosure,
  TicketResults,
  type OpenInChanges,
} from './TicketReviewParts.js';

const CHIP = REVIEW_CHIP;
const MUTED = 'text-gray-500 dark:text-gray-400';
const ERROR_TEXT = 'text-red-600 dark:text-red-400';
const BTN =
  'whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';
const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';

// The reader's half-typed stories, per PR, for this session (survives a tab switch or a PR change).
const storyDrafts = createTicketDraftStore<TicketDraft[]>();

/**
 * THIS PR's share of a ticket review (the slim block): the criteria it delivers, the unmet
 * criteria and missing items that belong in it (each with its Post), what it does that was not
 * asked for, a count of the rest, and the jump to the whole story in Open PRs.
 */
function TicketShare({
  review,
  pr,
  ticketKey,
  changedPaths,
  onOpenInChanges,
}: {
  review: TicketReview;
  pr: PrDetail;
  ticketKey: string;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const a = review.assessment;
  const share = useMemo(
    () => (a != null ? prTicketShare(a, review.items, { id: pr.id, repoId: pr.repoId }) : null),
    [a, review.items, pr.id, pr.repoId],
  );
  const byRef = useMemo(() => itemsByRef(review.items), [review.items]);
  const card = prCardOf(review.members, pr.id);
  if (share == null) return <p className={`text-xs ${MUTED}`}>No result stored.</p>;
  const ctx = { review, viewedPrId: pr.id, changedPaths, onOpenInChanges };
  const rest = shareRestLine(share);
  const empty = share.criteria.length === 0 && share.missing.length === 0 && share.notRequested.length === 0;
  return (
    <div className="space-y-3">
      {empty && <p className={`text-xs ${MUTED}`}>No criteria are this PR’s.</p>}
      {share.criteria.length > 0 && (
        <ul className="space-y-1.5">
          {share.criteria.map((c) => (
            <CriterionRow key={c.ref} c={c} item={byRef.get(c.ref)} {...ctx} />
          ))}
        </ul>
      )}
      <MissingList items={share.missing} {...ctx} />
      <NotRequestedList items={share.notRequested} {...ctx} />
      {card != null && <PrCardDisclosure card={card} />}
      <p className={`text-xs ${MUTED}`}>
        {rest != null && <>{rest} </>}
        <button
          type="button"
          onClick={() => showStoryInOpenPrs(ticketKey)}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          See the whole story in Open PRs
        </button>
      </p>
    </div>
  );
}

type TicketEntry = PrTicketReviewsResponse['tickets'][number];

/** One ticket: header (key, title, result, currency, Check), progress, then its results. */
function TicketBlock({
  entry,
  pr,
  changedPaths,
  onOpenInChanges,
}: {
  entry: TicketEntry;
  pr: PrDetail;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const { ident, state, review } = entry;
  const start = useStartTicketReview(ident);
  const starting = useTicketReviewStarting(ident);
  const running = state.status === 'running';
  const stream = useTicketReviewStream(state.runningRunId, running);
  // The result shown is the latest SUCCEEDED run: `review` when it is that run, else read by id.
  const latestOk = review?.status === 'succeeded' ? review : null;
  const { data: earlier } = useTicketReviewById(
    latestOk == null && state.latestRunId != null ? state.latestRunId : null,
  );
  const shown = latestOk ?? (earlier?.status === 'succeeded' ? earlier : null);

  const members = shown?.members ?? review?.members ?? [];
  const labelOf = (prId: number): string | null => {
    const m = members.find((x) => x.prId === prId);
    return m != null ? memberLabel(m) : null;
  };
  const currency = ticketCurrency(state, labelOf);
  const counts = coverageLabel(state.counts);
  // A refusal from the start answer (no row written) or from the latest run.
  const startRefusal = start.data?.runs.find((r) => r.ident === ident)?.refused ?? null;
  const refused = startRefusal ?? (review?.status === 'failed' ? review.refused : null);
  const failed = review?.status === 'failed' && review.refused == null ? (review.error ?? 'The check failed.') : null;
  const title = entry.ticketTitle ?? review?.ticketTitle ?? null;
  const snapshot = shown?.ticket ?? review?.ticket ?? null;
  const jiraRef = jiraRefFor(pr.tickets, entry.ticketKey);
  const url = storyUrlOf(jiraRef, [snapshot]);
  // Where the Open PRs stack holds the whole story, the pane shows only THIS PR's share of it.
  const issueLinks = useProCapabilities().issueLinks;
  const slim = slimStoryCheck({
    ident,
    ticketKey: entry.ticketKey,
    issueLinks,
    prOpen: pr.state === 'open',
    members,
  });

  return (
    <div aria-label={`Story ${entry.ticketKey ?? title ?? ''}`} className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {entry.ticketKey != null &&
            (url != null ? (
              <JiraKeyLink ticketKey={entry.ticketKey} url={url} />
            ) : (
              <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">{entry.ticketKey}</span>
            ))}
          {title != null && title !== '' && (
            <span className="min-w-0 break-words text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</span>
          )}
        </h4>
        {state.alignment != null && (
          <span className={`${CHIP} ${TICKET_ALIGNMENT_CLASS[state.alignment]}`}>
            {TICKET_ALIGNMENT_LABEL[state.alignment]}
          </span>
        )}
        {!slim && counts != null && <span className={`text-xs ${MUTED}`}>{counts}</span>}
        {currency != null && <CurrencyPill currency={currency} />}
        {shown != null && <ReviewedAgo at={shown.completedAt} />}
        <span className="ml-auto">
          {!running && (
            <AiRunGate>
              <button
                type="button"
                disabled={starting}
                onClick={() => start.mutate(recheckBody(pr.id, ident, shown ?? review))}
                className={state.status === 'stale' ? BTN_PRIMARY : BTN}
              >
                {starting ? 'Starting…' : shown == null ? 'Check' : 'Re-check'}
              </button>
            </AiRunGate>
          )}
        </span>
      </div>
      <StoryDisclosure prId={pr.id} jiraRef={jiraRef} stored={[snapshot]} url={url} />
      <div className="empty:hidden">
        <RegenProgressBar
          active={running}
          label="Checking the story"
          value={ticketProgressPct(stream.progress)}
          timeConstantSec={30}
        />
      </div>
      {running && (
        <p className={`text-xs ${MUTED}`}>
          {stream.progress != null ? TICKET_PHASE_LABEL[stream.progress.phase] : 'Starting'}…
        </p>
      )}
      {start.isError && <p className={`text-xs ${ERROR_TEXT}`}>{start.error.message || 'Could not start the check.'}</p>}
      {refused != null && <p className={`text-xs ${ERROR_TEXT}`}>{refusalSentence(refused)}</p>}
      {failed != null && <p className={`text-xs ${ERROR_TEXT}`}>{failed}</p>}
      {shown != null ? (
        slim && entry.ticketKey != null ? (
          <TicketShare
            review={shown}
            pr={pr}
            ticketKey={entry.ticketKey}
            changedPaths={changedPaths}
            onOpenInChanges={onOpenInChanges}
          />
        ) : (
          <TicketResults review={shown} viewedPrId={pr.id} changedPaths={changedPaths} onOpenInChanges={onOpenInChanges} />
        )
      ) : (
        !running && refused == null && failed == null && <p className={`text-xs ${MUTED}`}>Not checked yet.</p>
      )}
    </div>
  );
}

/**
 * An older PR review's verdicts on a story NO ticket review covers yet — kept as the PR review
 * rendered them (each unmet item IS that run's finding card, so it is on screen once), under a
 * muted "Checked on this PR only", with Check to run the ticket check.
 */
export interface LegacyStories {
  entries: ClaudeReviewTicketEntry[];
  findingIds: ReadonlyMap<string, number>;
  findingsById: ReadonlyMap<number, ClaudeFinding>;
  renderFinding: (f: ClaudeFinding, chip: string) => ReactNode;
  // When that older PR review finished — its "reviewed X ago", beside the label.
  finishedAt?: string | null;
}

function LegacyBlock({
  entry,
  legacy,
  pr,
  known,
  changedPaths,
  onOpenInChanges,
}: {
  entry: ClaudeReviewTicketEntry;
  legacy: LegacyStories;
  pr: PrDetail;
  known: readonly TicketEntry[];
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const start = useStartStoryCheck(pr.id);
  const { ticket } = entry;
  const jiraRef = jiraRefFor(pr.tickets, ticket.key);
  const url = storyUrlOf(jiraRef, [ticket]);
  const hasTitle = ticket.title != null && ticket.title.trim() !== '';
  const refusals = (start.data?.runs ?? []).filter((r) => r.refused != null && r.ticketReviewId == null);
  return (
    <ClaudeReviewTicketResults
      entry={entry}
      label={ticket.key ?? (hasTitle ? null : storyLabel(ticket, entry.index))}
      findingIds={legacy.findingIds}
      findingsById={legacy.findingsById}
      renderFinding={legacy.renderFinding}
      changedPaths={changedPaths}
      onOpenInChanges={onOpenInChanges}
      aside={
        <span className="ml-auto inline-flex flex-wrap items-center gap-2">
          <span className={`text-xs ${MUTED}`}>Checked on this PR only</span>
          <ReviewedAgo at={legacy.finishedAt} />
          <AiRunGate>
            <button
              type="button"
              disabled={start.isPending}
              onClick={() => start.mutate(planStoryStart([ticketInputFromStored(ticket)], known))}
              className={BTN}
            >
              {start.isPending ? 'Starting…' : 'Check'}
            </button>
          </AiRunGate>
          {start.isError && <span className={`text-xs ${ERROR_TEXT}`}>{start.error.message || 'Could not start the check.'}</span>}
          {refusals.map((r) => (
            <span key={r.ident} className={`text-xs ${ERROR_TEXT}`}>
              {refusalSentence(r.refused!)}
            </span>
          ))}
        </span>
      }
      below={<StoryDisclosure prId={pr.id} jiraRef={jiraRef} stored={[ticket]} url={url} />}
    />
  );
}

/** The story panel: pasted stories + the Jira picker, and the Check that sends them. */
function StoryInput({ pr, entries }: { pr: PrDetail; entries: readonly TicketEntry[] }): JSX.Element {
  const [drafts, setDraftsState] = useState<TicketDraft[]>(() => storyDrafts.get(pr.id) ?? []);
  const setDrafts = (d: TicketDraft[]): void => {
    storyDrafts.set(pr.id, d);
    setDraftsState(d);
  };
  const check = useMemo(() => checkTicketDrafts(drafts), [drafts]);
  const plan = useMemo(
    () => planStoryStart(ticketsRequestFromCheck(check) ?? [], entries),
    [check, entries],
  );
  const n = plan.idents.length + plan.pasted.length;
  const start = useStartStoryCheck(pr.id);
  // The workspace that OWNS this PR's repo — its Jira token is the one the picker uses.
  const { data: workspaces } = useWorkspaces();
  const prWorkspaceName = workspaces?.find((w) => w.repoIds.includes(pr.repoId))?.name ?? null;
  const refusals = (start.data?.runs ?? []).filter((r) => r.refused != null && r.ticketReviewId == null);
  // A ticket already shown as a block is not offered for pulling again: its Story is there.
  const unlisted = useMemo(() => {
    const listed = new Set(entries.map((e) => e.ticketKey?.trim().toUpperCase()).filter(Boolean));
    return (pr.tickets ?? []).filter((t) => !listed.has(t.key.trim().toUpperCase()));
  }, [entries, pr.tickets]);

  return (
    <div>
      <ClaudeReviewTicketPanel
        key={pr.id}
        // Detected Jira tickets are blocks above already; the panel pulls one only when asked.
        autoPullReady={false}
        value={drafts}
        onChange={setDrafts}
        check={check}
        prId={pr.id}
        tickets={unlisted}
        prWorkspaceName={prWorkspaceName}
      />
      {n > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <AiRunGate>
            <button
              type="button"
              disabled={!check.ok || start.isPending}
              onClick={() => start.mutate(plan)}
              className={BTN_PRIMARY}
            >
              {start.isPending ? 'Starting…' : n === 1 ? 'Check this story' : `Check ${n} stories`}
            </button>
          </AiRunGate>
          {start.isError && <span className={`text-xs ${ERROR_TEXT}`}>{start.error.message || 'Could not start the check.'}</span>}
        </div>
      )}
      {refusals.map((r) => (
        <p key={r.ident} className={`mt-1 text-xs ${ERROR_TEXT}`}>
          {refusalSentence(r.refused!)}
        </p>
      ))}
    </div>
  );
}

/** The "Story check" section of the Claude Review tab. Local only (`me.ai`); null otherwise. */
export function TicketCoverageSection({
  pr,
  changedPaths,
  onOpenInChanges,
  legacy = null,
}: {
  pr: PrDetail;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
  // The shown PR review's stories no ticket review covers (`legacyOnlyEntries`), with that run's
  // finding cards. null when no PR review is shown.
  legacy?: LegacyStories | null;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const { data, isLoading, isError } = useTicketReviews(pr.id, ai.enabled);
  if (!ai.enabled) return null;
  const entries = data?.tickets ?? [];
  const old = legacy?.entries ?? [];
  const n = entries.length + old.length;
  return (
    <ReviewSection
      title="Story check"
      pills={n > 0 ? <SectionCount>{`${n} ${n === 1 ? 'ticket' : 'tickets'}`}</SectionCount> : null}
      info={
        <InfoButton title="Story check">
          <p>
            Claude checks each ticket’s acceptance criteria against every open or merged PR that
            names it, together. A criterion done in another PR counts as met.
          </p>
          <p className="mt-2">
            When auto review is on, a ticket is checked again on its own once one of its PRs is
            pushed, joins or leaves. Nothing is posted until you press Post.
          </p>
          <p className="mt-2">
            A story marked “Checked on this PR only” was judged by an earlier PR review against
            this PR alone. Its unmet items are that review’s findings. Check runs the ticket check.
          </p>
        </InfoButton>
      }
    >
      {isLoading && <p className={`text-xs ${MUTED}`}>Loading…</p>}
      {isError && <p className={`text-xs ${ERROR_TEXT}`}>Could not load the story checks.</p>}
      {n > 0 && (
        <div className="divide-y divide-gray-200 dark:divide-gray-800">
          {entries.map((e) => (
            <div key={e.ident} className="py-4 first:pt-0 last:pb-0">
              <TicketBlock entry={e} pr={pr} changedPaths={changedPaths} onOpenInChanges={onOpenInChanges} />
            </div>
          ))}
          {legacy != null &&
            old.map((e) => (
              <div key={`legacy-${e.index}`} className="py-4 first:pt-0 last:pb-0">
                <LegacyBlock
                  entry={e}
                  legacy={legacy}
                  pr={pr}
                  known={entries}
                  changedPaths={changedPaths}
                  onOpenInChanges={onOpenInChanges}
                />
              </div>
            ))}
        </div>
      )}
      <StoryInput pr={pr} entries={entries} />
    </ReviewSection>
  );
}

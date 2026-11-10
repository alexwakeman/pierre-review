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
//   - criteria with status and attribution; ONE "Post N gaps to …" per PR the unmet items belong
//     on, each posting its gaps as one collated comment;
//   - SLIM where the story view holds the whole story (`slimStoryCheck`: a tracker ticket,
//     tracker on, an open PR on it): only THIS PR's share (`prTicketShare`, lib/ticketShare.ts) —
//     what it delivers, what belongs in it, one "Post N gaps to this PR" — and "See the whole
//     ticket", which opens the ticket's STORY VIEW tab (`useOpenStory`). The PR's contribution card
//     ("What this PR adds") and the counts of the rest are the story view's, not shown here. The
//     result pieces are shared with the stack (TicketReviewParts.tsx);
//   - NO "Ticket" disclosure (removed 2026-11-10): the PR's header links the ticket;
//   - an older PR review's stories that no ticket review covers, as read-only blocks of their own
//     marked "Checked on this PR only" (ONE story section; the old "User stories" section is gone);
//   - the paste box (TicketPasteBox.tsx): ticket links or keys, read from the PR's workspace
//     tracker. Typing or pasting a story's TEXT by hand was removed: every story comes from the
//     tracker.
//
// Rules: every string from Claude renders as PLAIN TEXT (no href built from it), except the run's
// summary (two plain sentences; only the leading prose of an older one), markdown through the sanitizing
// <Markdown>; a PR reference in any of it ("api#12") is an in-app button via ReviewPrRefs.tsx. Type scale:
// lib/reviewStyles.ts (the Findings card is the reference); icons from Icons.tsx; the explanation
// lives in the ⓘ.
// ⚠ Posting follows the post-write copy contract: once GitHub answered with a comment id, the
// button never comes back (a retry double-posts).
import { DocReferencesBlock } from './DocReferences.js';
import { useMemo, type ReactNode } from 'react';
import {
  TICKET_ALIGNMENT_LABEL,
  type ClaudeFinding,
  type ClaudeReviewTicketEntry,
  type PrDetail,
  type PrTicketReviewsResponse,
  type TicketReview,
} from '@pierre-review/shared';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import {
  useStartTicketReview,
  useTicketReviewById,
  useTicketReviewStarting,
  useTicketReviewStream,
  useTicketReviews,
} from '../hooks/useTicketReview.js';
import { TICKET_ALIGNMENT_CLASS } from '../lib/claudeReviewFollowUp.js';
import {
  TICKET_PHASE_LABEL,
  coverageLabel,
  itemsByRef,
  memberLabel,
  refusalSentence,
  newCommentsWords,
  ticketCurrency,
  ticketProgressPct,
} from '../lib/ticketReview.js';
import { prTicketShare, shareDocReferences, slimStoryCheck } from '../lib/ticketShare.js';
import { useOpenStory } from '../lib/ticketTab.js';
import { AiRunGate } from './AiSetup.js';
import { ClaudeReviewTicketResults, storyLabel } from './ClaudeReviewFollowUp.js';
import { TicketPasteBox } from './TicketPasteBox.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection, SectionCount } from './ReviewSection.js';
import { REVIEW_CHIP } from '../lib/reviewStyles.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { ReviewedAgo } from './ReviewedAgo.js';
import { AiRunLabel } from './AiRunLabel.js';
import { TicketAutoCheckLine } from './TicketAutoCheckLine.js';
import {
  CriterionRow,
  CurrencyPill,
  MissingList,
  NotRequestedList,
  StoryGapsPost,
  TicketResults,
  type OpenInChanges,
} from './TicketReviewParts.js';

const CHIP = REVIEW_CHIP;
const MUTED = 'text-ui-mute';
const ERROR_TEXT = 'text-ui-danger';
const BTN =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';
const BTN_PRIMARY =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';

/**
 * THIS PR's share of a ticket review (the slim block): the criteria it delivers, the unmet
 * criteria and missing items that belong in it (ONE "Post N gaps to this PR" for them), what it does
 * that was not asked for, and the link that opens the whole story (the story view tab, which holds
 * the counts of the rest and every PR's contribution card).
 */
function TicketShare({
  review,
  pr,
  ident,
  ticketKey,
  ticketTitle,
  changedPaths,
  onOpenInChanges,
}: {
  review: TicketReview;
  pr: PrDetail;
  ident: string;
  ticketKey: string;
  ticketTitle: string | null;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const a = review.assessment;
  const share = useMemo(
    () => (a != null ? prTicketShare(a, review.items, { id: pr.id, repoId: pr.repoId }) : null),
    [a, review.items, pr.id, pr.repoId],
  );
  const byRef = useMemo(() => itemsByRef(review.items), [review.items]);
  const openStory = useOpenStory();
  if (share == null) return <p className={`text-meta ${MUTED}`}>No result stored.</p>;
  const ctx = { review, viewedPrId: pr.id, changedPaths, onOpenInChanges };
  const empty = share.criteria.length === 0 && share.missing.length === 0 && share.notRequested.length === 0;
  return (
    <div className="space-y-3">
      {empty && <p className={`text-meta ${MUTED}`}>No criteria are this PR’s.</p>}
      <StoryGapsPost review={review} viewedPrId={pr.id} onlyThisPr />
      {share.criteria.length > 0 && (
        <ul className="space-y-1.5">
          {share.criteria.map((c) => (
            <CriterionRow key={c.ref} c={c} item={byRef.get(c.ref)} {...ctx} />
          ))}
        </ul>
      )}
      <MissingList items={share.missing} {...ctx} />
      <NotRequestedList items={share.notRequested} {...ctx} />
      <DocReferencesBlock references={shareDocReferences(a?.references, share)} />
      <p className="text-meta">
        <button
          type="button"
          onClick={() => openStory({ ident, key: ticketKey, title: ticketTitle })}
          className="hit text-ui-ink hover:underline text-link-phone"
        >
          See the whole ticket
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
    if (m != null) return memberLabel(m);
    return prId === pr.id ? memberLabel({ repo: pr.repoFullName, number: pr.number }) : null;
  };
  const currency = ticketCurrency(state, labelOf);
  const comments = newCommentsWords(state);
  const counts = coverageLabel(state.counts);
  // A refusal from the start answer (no row written) or from the latest run.
  const startRefusal = start.data?.runs.find((r) => r.ident === ident)?.refused ?? null;
  const refused = startRefusal ?? (review?.status === 'failed' ? review.refused : null);
  const failed = review?.status === 'failed' && review.refused == null ? (review.error ?? 'The check failed.') : null;
  const title = entry.ticketTitle ?? review?.ticketTitle ?? null;
  // Where the story view holds the whole story, the pane shows only THIS PR's share of it.
  // `pr.tickets` is null exactly when the PR's workspace has no tracker (core, free since
  // apiVersion 23) — the same fact the Open PRs stacks need, with no extra request.
  const slim = slimStoryCheck({
    ticketKey: entry.ticketKey,
    trackerOn: pr.tickets != null,
    prOpen: pr.state === 'open',
    members,
  });

  return (
    <div aria-label={`Ticket ${entry.ticketKey ?? title ?? ''}`} className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {/* Plain text: the PR's header links the ticket. No "Ticket" disclosure here (2026-11-10). */}
          {entry.ticketKey != null && (
            <span className="font-mono text-body font-semibold text-ui-ink">{entry.ticketKey}</span>
          )}
          {title != null && title !== '' && (
            <span className="min-w-0 break-words text-body font-semibold text-ui-ink">{title}</span>
          )}
        </h4>
        {state.alignment != null && (
          <span className={`${CHIP} ${TICKET_ALIGNMENT_CLASS[state.alignment]}`}>
            {TICKET_ALIGNMENT_LABEL[state.alignment]}
          </span>
        )}
        {!slim && counts != null && <span className={`text-meta ${MUTED}`}>{counts}</span>}
        {currency != null && <CurrencyPill currency={currency} />}
        {comments != null && (
          <span className={`text-meta ${MUTED}`} title={comments.title} data-testid="ticket-new-comments">
            {comments.label}
          </span>
        )}
        {shown != null && <ReviewedAgo at={shown.completedAt} />}
        {shown != null && <AiRunLabel provider={shown.provider} model={shown.model} />}
        <span className="ml-auto">
          {!running && (
            <AiRunGate kind="ticket_review">
              <button
                type="button"
                disabled={starting}
                onClick={() => start.mutate({ prId: pr.id, ident })}
                className={state.status === 'stale' ? BTN_PRIMARY : BTN}
              >
                {starting ? 'Starting…' : shown == null ? 'Check' : 'Re-check'}
              </button>
            </AiRunGate>
          )}
        </span>
      </div>
      {!running && <TicketAutoCheckLine autoCheck={state.autoCheck} labelOf={labelOf} className="block" />}
      <div className="empty:hidden">
        <RegenProgressBar
          active={running}
          label="Checking the story"
          value={ticketProgressPct(stream.progress)}
          timeConstantSec={30}
        />
      </div>
      {running && (
        <p className={`text-meta ${MUTED}`}>
          {stream.progress != null ? TICKET_PHASE_LABEL[stream.progress.phase] : 'Starting'}…
        </p>
      )}
      {start.isError && <p className={`text-meta ${ERROR_TEXT}`}>{start.error.message || 'Could not start the check.'}</p>}
      {refused != null && <p className={`text-meta ${ERROR_TEXT}`}>{refusalSentence(refused)}</p>}
      {failed != null && <p className={`text-meta ${ERROR_TEXT}`}>{failed}</p>}
      {shown != null ? (
        slim && entry.ticketKey != null ? (
          <TicketShare
            review={shown}
            pr={pr}
            ident={ident}
            ticketKey={entry.ticketKey}
            ticketTitle={title}
            changedPaths={changedPaths}
            onOpenInChanges={onOpenInChanges}
          />
        ) : (
          <TicketResults review={shown} viewedPrId={pr.id} changedPaths={changedPaths} onOpenInChanges={onOpenInChanges} />
        )
      ) : (
        !running && refused == null && failed == null && <p className={`text-meta ${MUTED}`}>Not checked yet.</p>
      )}
    </div>
  );
}

/**
 * An older PR review's verdicts on a story NO ticket review covers — kept as the PR review rendered
 * them (each unmet item IS that run's finding card, so it is on screen once), under a muted "Checked
 * on this PR only". Read-only history: a story outside the tracker cannot be checked again.
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
  changedPaths,
  onOpenInChanges,
}: {
  entry: ClaudeReviewTicketEntry;
  legacy: LegacyStories;
  pr: PrDetail;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const { ticket } = entry;
  const hasTitle = ticket.title != null && ticket.title.trim() !== '';
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
          <span className={`text-meta ${MUTED}`}>Checked on this PR only</span>
          <ReviewedAgo at={legacy.finishedAt} />
        </span>
      }
    />
  );
}

/** Add tickets to the PR by link or key (the paste box). Nothing when the PR's workspace has no tracker. */
function StoryInput({ pr }: { pr: PrDetail }): JSX.Element | null {
  // ⚠ `ticketsAddable`, not `tickets != null`: a GitHub Issues PR whose links are not read yet has
  // `tickets: null` but a tracker the paste box can add from.
  const hasTracker = pr.ticketsAddable ?? pr.tickets != null;
  if (!hasTracker) return null;
  return <TicketPasteBox key={pr.id} prId={pr.id} />;
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
      section="stories"
      pills={n > 0 ? <SectionCount>{`${n} ${n === 1 ? 'ticket' : 'tickets'}`}</SectionCount> : null}
      info={
        <InfoButton title="Story check">
          <p>
            {ai.providerName} checks each ticket’s acceptance criteria against every open or merged PR that
            names it, together. A criterion done in another PR counts as met.
          </p>
          <p className="mt-2">
            When auto review is on, a ticket is checked again on its own once one of its PRs is
            pushed, joins or leaves. Nothing is posted until you press Post: the gaps that belong on
            a PR go to it as one comment.
          </p>
          <p className="mt-2">
            A story marked “Checked on this PR only” was judged by an earlier PR review against
            this PR alone. Its unmet items are that review’s findings.
          </p>
        </InfoButton>
      }
    >
      {isLoading && <p className={`text-meta ${MUTED}`}>Loading…</p>}
      {isError && <p className={`text-meta ${ERROR_TEXT}`}>Could not load the story checks.</p>}
      {n > 0 && (
        <div className="divide-y divide-ui-line">
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
                  changedPaths={changedPaths}
                  onOpenInChanges={onOpenInChanges}
                />
              </div>
            ))}
        </div>
      )}
      <StoryInput key={pr.id} pr={pr} />
    </ReviewSection>
  );
}

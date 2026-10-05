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
  TICKET_CRITERION_STATUS_LABEL,
  type ClaudeFinding,
  type ClaudeFindingSide,
  type ClaudeReviewTicketEntry,
  type PrDetail,
  type PrTicketReviewsResponse,
  type TicketCriterion,
  type TicketEvidence,
  type TicketReview,
  type TicketReviewItem,
  type TicketReviewMember,
} from '@pierre-review/shared';
import { ApiError } from '../api/client.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useWorkspaces } from '../hooks/useWorkspaces.js';
import {
  useStartStoryCheck,
  useStartTicketReview,
  usePostTicketItem,
  useTicketReviewById,
  useTicketReviewStarting,
  useTicketReviewStream,
  useTicketReviews,
} from '../hooks/useTicketReview.js';
import {
  CLEAN_CLASS,
  OUTDATED_CLASS,
  TICKET_ALIGNMENT_CLASS,
  TICKET_CRITERION_STATUS_CLASS,
  anchorLabel,
  checkTicketDrafts,
  createTicketDraftStore,
  ticketInputFromStored,
  ticketsRequestFromCheck,
  type TicketDraft,
} from '../lib/claudeReviewFollowUp.js';
import {
  TICKET_PHASE_LABEL,
  coverageLabel,
  deliveredByLabel,
  expectedInLabel,
  itemsByRef,
  memberLabel,
  memberPrIdsOf,
  missingItems,
  planStoryStart,
  postButtonLabel,
  postTargetOf,
  postedLabel,
  recheckBody,
  refusalSentence,
  ticketCurrency,
  ticketProgressPct,
  type TicketCurrency,
} from '../lib/ticketReview.js';
import { jiraRefFor, storyUrlOf } from '../lib/ticketStory.js';
import { AiRunGate } from './AiSetup.js';
import { ClaudeReviewTicketPanel, ClaudeReviewTicketResults, storyLabel } from './ClaudeReviewFollowUp.js';
import { JiraKeyLink } from './ClaudeReviewTickets.js';
import { StoryDisclosure } from './TicketStory.js';
import { CheckIcon, WarningIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection, SectionCount } from './ReviewSection.js';
import { Markdown } from './Markdown.js';
import { MemberPrLink, PrRefText } from './ReviewPrRefs.js';
import {
  REVIEW_CHIP,
  REVIEW_ITEM_CARD,
  REVIEW_ITEM_TITLE,
  REVIEW_PROSE,
  REVIEW_SUBHEAD,
} from '../lib/reviewStyles.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { ReviewedAgo } from './ReviewedAgo.js';

type OpenInChanges = (path: string, line: number | null, side: ClaudeFindingSide) => void;

const CHIP = REVIEW_CHIP;
const MUTED = 'text-gray-500 dark:text-gray-400';
const ERROR_TEXT = 'text-red-600 dark:text-red-400';
const BTN =
  'whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';
const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const RUNNING_CLASS = 'bg-sky-500/10 text-sky-700 dark:text-sky-300';

const CURRENCY_CLASS: Record<TicketCurrency['tone'], string> = {
  current: CLEAN_CLASS,
  stale: OUTDATED_CLASS,
  running: RUNNING_CLASS,
};

// The reader's half-typed stories, per PR, for this session (survives a tab switch or a PR change).
const storyDrafts = createTicketDraftStore<TicketDraft[]>();

function CurrencyPill({ currency }: { currency: TicketCurrency }): JSX.Element {
  return (
    <span className={`${CHIP} ${CURRENCY_CLASS[currency.tone]}`} title={currency.title}>
      {currency.tone === 'current' ? (
        <CheckIcon size={11} />
      ) : currency.tone === 'stale' ? (
        <WarningIcon size={11} />
      ) : (
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
      )}
      {currency.label}
    </span>
  );
}

/** A code location: into the Changes tab when it is this PR's file, else plain text. */
function EvidenceRef({
  ev,
  viewedPrId,
  members,
  changedPaths,
  onOpenInChanges,
}: {
  ev: Pick<TicketEvidence, 'path' | 'line'> & { prId: number | null };
  viewedPrId: number;
  members: readonly TicketReviewMember[];
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const label = anchorLabel(ev.path, ev.line);
  if (ev.prId === viewedPrId && onOpenInChanges != null && changedPaths.has(ev.path)) {
    return (
      <button
        type="button"
        onClick={() => onOpenInChanges(ev.path, ev.line, 'RIGHT')}
        className="break-all text-left font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
      >
        {label}
      </button>
    );
  }
  const m = ev.prId != null && ev.prId !== viewedPrId ? members.find((x) => x.prId === ev.prId) : undefined;
  return (
    <span className={`break-all font-mono text-xs ${MUTED}`}>
      {m != null && (
        <>
          <MemberPrLink member={{ repo: m.repo, number: m.number, label: memberLabel(m) }} />
          {' · '}
        </>
      )}
      {label}
    </span>
  );
}

/** Post ONE item, on the PR it belongs to. Gone for good once GitHub gave a comment id. */
function ItemPost({
  item,
  review,
  viewedPrId,
}: {
  item: TicketReviewItem;
  review: TicketReview;
  viewedPrId: number;
}): JSX.Element | null {
  const post = usePostTicketItem(viewedPrId);
  const target = postTargetOf(item, viewedPrId, review.members);
  const posted = postedLabel(item, review.members, viewedPrId);
  if (posted != null)
    return (
      <span className={`text-xs ${MUTED}`}>
        <PrRefText text={posted} />
      </span>
    );
  if (post.isSuccess) {
    return (
      <span className={`text-xs ${MUTED}`}>
        {post.data.visible ? 'Posted' : 'Posted. It will show up here shortly.'}
      </span>
    );
  }
  // ⚠ Only 'AlreadyPosted' means a comment exists. The route also 409s 'HeadMoved' and
  // 'Superseded', where nothing was posted: those keep the button and print the server's reason.
  const already = post.error instanceof ApiError && post.error.status === 409 && post.error.code === 'AlreadyPosted';
  if (already) return <span className={`text-xs ${MUTED}`}>Already posted</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={post.isPending}
        onClick={() =>
          post.mutate({
            ticketReviewId: review.id,
            itemId: item.id,
            targetPrId: target.prId,
            memberPrIds: memberPrIdsOf(review),
          })
        }
        className={BTN_PRIMARY}
      >
        {post.isPending ? 'Posting…' : postButtonLabel(target, viewedPrId)}
      </button>
      {post.isError && <span className={`text-xs ${ERROR_TEXT}`}>{post.error.message || 'Could not post.'}</span>}
    </span>
  );
}

function CriterionRow({
  c,
  item,
  review,
  viewedPrId,
  changedPaths,
  onOpenInChanges,
}: {
  c: TicketCriterion;
  item: TicketReviewItem | undefined;
  review: TicketReview;
  viewedPrId: number;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const done = deliveredByLabel(c, review.members);
  const belongs = expectedInLabel(c.expectedIn, review.members);
  const refProps = { viewedPrId, members: review.members, changedPaths, onOpenInChanges };
  // MET is one compact line: tick, ref, criterion, who delivered it.
  if (c.status === 'met') {
    return (
      <li className="flex items-baseline gap-2 px-1 text-[13px]">
        <span className="shrink-0 self-center text-green-700 dark:text-green-400" aria-label="Met">
          <CheckIcon size={12} />
        </span>
        <span className={`shrink-0 font-mono text-xs ${MUTED}`}>{c.ref}</span>
        <span className="min-w-0 break-words">
          {c.text}
          {done != null && (
            <span className={`text-xs ${MUTED}`}>
              {' · '}
              <PrRefText text={done} />
            </span>
          )}
        </span>
      </li>
    );
  }
  return (
    <li className={REVIEW_ITEM_CARD}>
      <div className="flex items-start gap-2">
        <span className={`${CHIP} ${TICKET_CRITERION_STATUS_CLASS[c.status]}`}>
          {TICKET_CRITERION_STATUS_LABEL[c.status]}
        </span>
        <span className={`shrink-0 font-mono text-xs leading-5 ${MUTED}`}>{c.ref}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-semibold">{c.text}</span>
      </div>
      {(done != null || belongs != null) && (
        <div className={`mt-0.5 text-xs ${MUTED}`}>
          <PrRefText text={[done, belongs].filter(Boolean).join(' · ')} />
        </div>
      )}
      {c.evidence.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-3">
          {c.evidence.map((ev, i) => (
            <EvidenceRef key={i} ev={ev} {...refProps} />
          ))}
        </div>
      )}
      {c.explanation != null && c.explanation !== '' && (
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={c.explanation} />
        </p>
      )}
      {item != null && (
        <div className="mt-1.5">
          <ItemPost item={item} review={review} viewedPrId={viewedPrId} />
        </div>
      )}
    </li>
  );
}

function MissingRow({
  item,
  review,
  viewedPrId,
  changedPaths,
  onOpenInChanges,
}: {
  item: TicketReviewItem;
  review: TicketReview;
  viewedPrId: number;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const owner = item.ownerPrId != null ? review.members.find((m) => m.prId === item.ownerPrId) : undefined;
  return (
    <li className={REVIEW_ITEM_CARD}>
      <div className="flex items-start gap-2">
        <span className={`${CHIP} ${TICKET_CRITERION_STATUS_CLASS.not_met}`}>Not done</span>
        <span className={`shrink-0 font-mono text-xs leading-5 ${MUTED}`}>{item.ref}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-semibold">{item.title}</span>
      </div>
      {owner != null && (
        <div className={`mt-0.5 text-xs ${MUTED}`}>
          Belongs in <MemberPrLink member={{ repo: owner.repo, number: owner.number, label: memberLabel(owner) }} />
        </div>
      )}
      {item.path != null && item.path !== '' && (
        <div className="mt-0.5">
          <EvidenceRef
            ev={{ prId: item.ownerPrId ?? viewedPrId, path: item.path, line: item.line }}
            viewedPrId={viewedPrId}
            members={review.members}
            changedPaths={changedPaths}
            onOpenInChanges={onOpenInChanges}
          />
        </div>
      )}
      {item.body !== '' && (
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={item.body} />
        </p>
      )}
      <div className="mt-1.5">
        <ItemPost item={item} review={review} viewedPrId={viewedPrId} />
      </div>
    </li>
  );
}

/** What one SUCCEEDED run found for the ticket. */
function TicketResults({
  review,
  viewedPrId,
  changedPaths,
  onOpenInChanges,
}: {
  review: TicketReview;
  viewedPrId: number;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const a = review.assessment;
  const byRef = useMemo(() => itemsByRef(review.items), [review.items]);
  const missing = useMemo(() => missingItems(review.items), [review.items]);
  if (a == null) return <p className={`text-xs ${MUTED}`}>No result stored.</p>;
  const rowProps = { review, viewedPrId, changedPaths, onOpenInChanges };
  return (
    <div className="space-y-3">
      {a.summary != null && a.summary !== '' && (
        <Markdown prRefs>{a.summary}</Markdown>
      )}
      {a.criteria.length > 0 && (
        <ul className="space-y-1.5">
          {a.criteria.map((c) => (
            <CriterionRow key={c.ref} c={c} item={byRef.get(c.ref)} {...rowProps} />
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <div className="space-y-1.5">
          <h5 className={REVIEW_SUBHEAD}>{`Not done (${missing.length})`}</h5>
          <ul className="space-y-1.5">
            {missing.map((item) => (
              <MissingRow key={item.id} item={item} {...rowProps} />
            ))}
          </ul>
        </div>
      )}
      {a.notRequested.length > 0 && (
        <div className="space-y-1">
          <h5 className={REVIEW_SUBHEAD}>
            {`Not asked for (${a.notRequested.length})`}
          </h5>
          <ul className="space-y-1.5">
            {a.notRequested.map((g, i) => (
              <li key={i} className={REVIEW_ITEM_CARD}>
                <span className={`break-words ${REVIEW_ITEM_TITLE}`}>
                  <PrRefText text={g.title} />
                </span>
                {g.path != null && g.path !== '' && (
                  <>
                    <span className={`decorative-mark ${MUTED}`} aria-hidden="true">
                      {' · '}
                    </span>
                    <EvidenceRef
                      ev={{ prId: g.prId, path: g.path, line: g.line }}
                      viewedPrId={viewedPrId}
                      members={review.members}
                      changedPaths={changedPaths}
                      onOpenInChanges={onOpenInChanges}
                    />
                  </>
                )}
                {g.explanation != null && g.explanation !== '' && (
                  <p className={`mt-1 ${REVIEW_PROSE}`}>
                    <PrRefText text={g.explanation} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {review.members.some((m) => !m.checkedOut) && (
        <p className={`text-xs ${MUTED}`}>
          Not checked out:{' '}
          <PrRefText
            text={review.members
              .filter((m) => !m.checkedOut)
              .map(memberLabel)
              .join(', ')}
          />
          .
        </p>
      )}
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
        {counts != null && <span className={`text-xs ${MUTED}`}>{counts}</span>}
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
        <TicketResults review={shown} viewedPrId={pr.id} changedPaths={changedPaths} onOpenInChanges={onOpenInChanges} />
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

// The Claude Review tab's follow-up and user-story pieces, kept out of the 2,000-line tab:
//
//   ClaudeReviewTicketResults   — HISTORY: how an older PR review measured up against ONE user
//                                 story (read-only; its unmet items are findings). Shown INSIDE the
//                                 Story check section (TicketCoverage.tsx), and only for a story no
//                                 ticket review covers. New PR reviews carry no story.
//   EarlierFindingNote / FollowUpRow / SettledEarlierRow — what became of the previous review's
//                                 comments, ON THE FINDINGS LIST (ClaudeReviewTab.tsx): the note
//                                 rides on that finding's own row; an item no row shows gets a
//                                 FollowUpRow of its own. There is no "Previous review" section.
//
// Rules for all of them:
//  - Every string from Claude or from a user story renders as PLAIN TEXT: no Markdown,
//    and no href built from it — except a story's SUMMARY (markdown, so its bullets read as a list,
//    through the sanitizing <Markdown>), and PR references ("api#12"), which become in-app buttons
//    via <PrRefText> (ReviewPrRefs.tsx) when they name a known PR. A story READ FROM JIRA is the one exception, and it renders in
//    ClaudeReviewTickets.tsx (JiraStoryView), never here. A code anchor is a <button> into the Changes tab when the file is
//    in the PR, otherwise plain mono text.
//  - Statuses and counts come from the server's reconcile step, which never invents "addressed".
//    The sentences are templated in `@pierre-review/shared` (code-derived); Claude's explanations
//    are shown separately, unlabelled (everything here is Claude's).
//  - Chips are 11px or larger, sentences 12px or larger, no uppercase-with-tracking labels, and
//    every muted colour is paired for both themes (`textContrast.test.ts`).
import { Fragment, type ReactNode } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  FOLLOW_UP_STATUS_LABEL,
  TICKET_ALIGNMENT_LABEL,
  STORY_MISSING_HEADING,
  TICKET_CRITERION_STATUS_LABEL,
  criterionDone,
  ticketCriteriaSentence,
} from '@pierre-review/shared';
import type {
  ClaudeFinding,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeFollowUpItem,
  ClaudeSettledFinding,
  ClaudeReviewTicketEntry,
  ClaudeTicketCriterionResult,
  ClaudeTicketGap,
} from '@pierre-review/shared';
import { useResolveThread } from '../hooks/usePrWrites.js';
import { followUpReplyMutationKey, usePostFollowUpReply, useResolvePrLevelFinding } from '../hooks/useClaudeReview.js';
import { PrCommentLink, ReplyVerbLink } from './FollowUpGithubLinks.js';
import {
  FOLLOW_UP_STATUS_CLASS,
  SEVERITY_CLASS,
  TICKET_ALIGNMENT_CLASS,
  TICKET_CRITERION_STATUS_CLASS,
  anchorLabel,
  followUpAnchor,
  notCheckedReason,
  RESOLVED_ON_GITHUB_CHIP,
  isPrLevelItem,
  isResolvedPushback,
  replyActions,
  replyStatusHeading,
  settledEarlierHeading,
  raisedByLine,
  stillOpenPostable,
  storyFindingIdFor,
  storyItemChipLabel,
  earlierNoteChip,
  followUpOneLine,
} from '../lib/claudeReviewFollowUp.js';
import { CheckIcon, ChevronIcon } from './Icons.js';
import { PrRefText } from './ReviewPrRefs.js';
import { Markdown } from './Markdown.js';
import { REVIEW_CHIP, REVIEW_ITEM_CARD, REVIEW_ITEM_TITLE, REVIEW_PROSE, REVIEW_SUBHEAD } from '../lib/reviewStyles.js';

type OpenInChanges = (path: string, line: number | null, side: ClaudeFindingSide) => void;

const SEVERITY_WORD: Record<ClaudeFindingSeverity, string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  nit: 'Nit',
  question: 'Question',
  praise: 'Praise',
};

const CHIP = REVIEW_CHIP;
const MUTED = 'text-ui-mute';
const ERROR_TEXT = 'text-ui-danger';
const BTN =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';

// A path (and line) that jumps into the Changes tab when the file is in the PR, else plain text.
// A BUTTON, never an <a href="#…">: a hash navigation would write to the URL useUrlState owns.
function CodeAnchorRef({
  path,
  line,
  side,
  inChangeset,
  onOpenInChanges,
}: {
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  inChangeset: boolean;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const label = anchorLabel(path, line);
  if (inChangeset && onOpenInChanges != null) {
    return (
      <button
        type="button"
        onClick={() => onOpenInChanges(path, line, side)}
        className="hit break-all text-left font-mono text-meta text-ui-ink hover:underline text-link-phone"
      >
        {label}
      </button>
    );
  }
  return <span className={`break-all font-mono text-meta ${MUTED}`}>{label}</span>;
}

/** The label a story goes by in a run's results: its Jira key, else "Story N". */
export function storyLabel(d: { key?: string | null }, index: number): string {
  return d.key != null && d.key !== '' ? d.key : `Story ${index + 1}`;
}

// ---- (b) the results against the user story ----

// A criterion row with NO finding card: met, can't tell, not checked — or an unmet one on a run
// stored before story findings existed (the fallback, so an older run still reads sensibly).
function CriterionRow({
  c,
  changedPaths,
  onOpenInChanges,
}: {
  c: ClaudeTicketCriterionResult;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  // MET is one compact line: tick, ref, criterion, where. Nothing to act on, so no card.
  if (criterionDone(c.status)) {
    return (
      <li className="flex items-baseline gap-2 px-1 text-body">
        <span className="shrink-0 self-center text-ui-success" aria-label="Met">
          <CheckIcon size={12} />
        </span>
        <span className={`shrink-0 font-mono text-meta ${MUTED}`}>{c.ref}</span>
        <span className="min-w-0 break-words text-ui-ink">
          {c.text}
          {c.path != null && c.path !== '' && (
            <>
              <span className={MUTED} aria-hidden="true">
                {' · '}
              </span>
              <CodeAnchorRef
                path={c.path}
                line={c.line}
                side="RIGHT"
                inChangeset={changedPaths.has(c.path)}
                onOpenInChanges={onOpenInChanges}
              />
            </>
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
        <span className={`shrink-0 font-mono text-meta leading-5 ${MUTED}`}>{c.ref}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-semibold">{c.text}</span>
      </div>
      {c.path != null && c.path !== '' && (
        <div className="mt-0.5">
          <CodeAnchorRef
            path={c.path}
            line={c.line}
            side="RIGHT"
            inChangeset={changedPaths.has(c.path)}
            onOpenInChanges={onOpenInChanges}
          />
        </div>
      )}
      {c.explanation != null && c.explanation !== '' && (
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={c.explanation} />
        </p>
      )}
    </li>
  );
}

// A "Not done" item with no finding card (a run stored before story findings) — the fallback.
function MissingRow({
  g,
  changedPaths,
  onOpenInChanges,
}: {
  g: ClaudeTicketGap;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  return (
    <li className={REVIEW_ITEM_CARD}>
      <div className={`whitespace-pre-wrap break-words ${REVIEW_ITEM_TITLE}`}>
        <PrRefText text={g.title} />
      </div>
      {g.path != null && g.path !== '' && (
        <div className="mt-0.5">
          <CodeAnchorRef
            path={g.path}
            line={g.line}
            side="RIGHT"
            inChangeset={changedPaths.has(g.path)}
            onOpenInChanges={onOpenInChanges}
          />
        </div>
      )}
      {g.explanation != null && g.explanation !== '' && (
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={g.explanation} />
        </p>
      )}
    </li>
  );
}

// A sub-group heading inside one story ("Not done (1)").
function StoryGroupHeading({ children }: { children: string }): JSX.Element {
  return <h5 className={REVIEW_SUBHEAD}>{children}</h5>;
}

/**
 * How the run measured up against ONE user story, inside the Story check section. ⚠ LIKE FOR
 * LIKE WITH THE FINDINGS LIST: every not met / partly met criterion and every "Not done" item IS a
 * finding, and renders as THAT finding's card (`renderFinding`, the Findings list's own component,
 * with its Post / Reword / Copy / Ignore). The Findings list leaves those out, so each is on screen
 * once. Met criteria are one compact line; "Not asked for" is a compact informational list (adding
 * something is not a defect, so it is never a finding). A run stored before story findings has no
 * card to show, so its unmet items fall back to read-only rows.
 */
export function ClaudeReviewTicketResults({
  entry,
  label,
  findingIds,
  findingsById,
  renderFinding,
  changedPaths,
  onOpenInChanges,
  aside,
  below,
}: {
  entry: ClaudeReviewTicketEntry;
  // "PROJ-12" or "Story 2"; null for a lone story with no key (the section title already says
  // "User story", so the sub-header is just its title).
  label: string | null;
  // `storyFindingIds(review.findings)` — this run's story findings by `${index}:${ref}`.
  findingIds: ReadonlyMap<string, number>;
  findingsById: ReadonlyMap<number, ClaudeFinding>;
  // The Findings list's own card, for one story finding; `chip` names the item ("AC2 · Partly met").
  renderFinding: (f: ClaudeFinding, chip: string) => ReactNode;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
  // Story check: the muted provenance label + Check, at the end of the header row.
  aside?: ReactNode;
  // Story check: the "Story" disclosure, under the header.
  below?: ReactNode;
}): JSX.Element {
  const { ticket, assessment } = entry;
  const sentence = ticketCriteriaSentence(assessment);
  const cardFor = (id: number | null): ClaudeFinding | null => (id != null ? (findingsById.get(id) ?? null) : null);
  const rowProps = { changedPaths, onOpenInChanges };
  return (
    <div aria-label={`Story ${label ?? ticket.title ?? ''}`} className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {label != null && (
            <span
              className={`text-body font-semibold text-ui-ink ${ticket.key != null ? 'font-mono' : ''}`}
            >
              {label}
            </span>
          )}
          {ticket.title != null && ticket.title !== '' && (
            <span className="min-w-0 break-words text-body font-semibold text-ui-ink">
              {ticket.title}
            </span>
          )}
          {assessment != null && (
            <span className={`${CHIP} ${TICKET_ALIGNMENT_CLASS[assessment.alignment]}`}>
              {TICKET_ALIGNMENT_LABEL[assessment.alignment]}
            </span>
          )}
          {sentence != null && <span className={`text-meta font-normal ${MUTED}`}>{sentence.replace(/\.$/, '')}</span>}
        </h4>
        {aside}
      </div>
      {below}
      {assessment == null ? (
        <p className={`text-meta ${MUTED}`}>Not checked in this run.</p>
      ) : (
        <>
          {assessment.summary != null && assessment.summary !== '' && (
            <Markdown prRefs>{assessment.summary}</Markdown>
          )}
          {assessment.criteria.length > 0 && (
            <ul className="space-y-1.5">
              {assessment.criteria.map((c) => {
                const unmet = c.status === 'not_met' || c.status === 'partly_met';
                const f = unmet ? cardFor(storyFindingIdFor(findingIds, entry.index, { ref: c.ref })) : null;
                return f != null && (c.status === 'not_met' || c.status === 'partly_met') ? (
                  <Fragment key={c.ref}>{renderFinding(f, storyItemChipLabel(c.ref, c.status))}</Fragment>
                ) : (
                  <CriterionRow key={c.ref} c={c} {...rowProps} />
                );
              })}
            </ul>
          )}
          {assessment.missing.length > 0 && (
            <div className="space-y-1.5">
              <StoryGroupHeading>{`${STORY_MISSING_HEADING} (${assessment.missing.length})`}</StoryGroupHeading>
              <ul className="space-y-1.5">
                {assessment.missing.map((g, i) => {
                  const f = cardFor(storyFindingIdFor(findingIds, entry.index, { missingIndex: i }));
                  return f != null ? (
                    <Fragment key={i}>{renderFinding(f, storyItemChipLabel(f.story?.ref ?? '', null))}</Fragment>
                  ) : (
                    <MissingRow key={i} g={g} {...rowProps} />
                  );
                })}
              </ul>
            </div>
          )}
          {assessment.notRequested.length > 0 && (
            <div className="space-y-1">
              <StoryGroupHeading>{`Not asked for (${assessment.notRequested.length})`}</StoryGroupHeading>
              <ul className="space-y-1.5">
                {assessment.notRequested.map((g, i) => (
                  <li key={i} className={REVIEW_ITEM_CARD}>
                    <span className={`break-words ${REVIEW_ITEM_TITLE}`}>
                      <PrRefText text={g.title} />
                    </span>
                    {g.path != null && g.path !== '' && (
                      <>
                        <span className={MUTED} aria-hidden="true">
                          {' · '}
                        </span>
                        <CodeAnchorRef
                          path={g.path}
                          line={g.line}
                          side="RIGHT"
                          inChangeset={changedPaths.has(g.path)}
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
        </>
      )}
    </div>
  );
}

// ---- (c) the previous review ----

/**
 * A reply status's block: who replied (a short excerpt, plain text), what Limn says back, and what
 * was posted — or, when nothing was, the text as a draft with "Post reply" ("Reply and resolve" for
 * an accepted reply). The server builds the body and claims the thread's record before writing, so
 * a second click, a remount or an auto run that got there first can never post it twice.
 */
function ReplyBlock({
  item,
  prId,
  reviewId,
}: {
  item: ClaudeFollowUpItem;
  prId?: number;
  reviewId?: number;
}): JSX.Element | null {
  const post = usePostFollowUpReply(prId ?? 0, reviewId ?? 0, item.priorFindingId);
  // Shared key: a remount mid-post still sees the post in flight.
  const posting = useIsMutating({ mutationKey: followUpReplyMutationKey(reviewId ?? 0, item.priorFindingId) }) > 0;
  const resolve = useResolveThread();
  // A PR-LEVEL finding (a PR comment, no thread): "Mark resolved" hides the finding comment.
  const markResolved = useResolvePrLevelFinding(prId ?? 0, reviewId ?? 0, item.priorFindingId);
  const heading = replyStatusHeading(item);
  if (heading == null) return null;
  const actions = replyActions(item, reviewId ?? 0);
  const prLevel = isPrLevelItem(item);
  const threadId = item.threadId ?? null;
  const posted = post.isSuccess;
  const resolved = prLevel ? markResolved.isSuccess : resolve.isSuccess;
  const resolving = prLevel ? markResolved.isPending : resolve.isPending;
  const canWrite = prId != null && reviewId != null && (threadId != null || prLevel);
  const error = post.error ?? (prLevel ? markResolved.error : resolve.error);
  const accepted = item.status === 'reply_accepted';
  return (
    <div className="mt-1 space-y-1">
      {item.reply != null && (
        <p className={`text-meta ${MUTED}`}>
          @{item.reply.author} <ReplyVerbLink url={item.reply.url ?? null} verb={prLevel ? 'commented' : 'replied'} />: “
          {item.reply.excerpt}”
        </p>
      )}
      {item.deferralRefused === true && (
        <p className={`text-meta ${MUTED}`}>A blocker can’t wait for a later change.</p>
      )}
      {actions.showText && item.response != null && item.response !== '' && (
        <p className={REVIEW_PROSE}>
          <span className={MUTED}>{actions.note == null && !posted ? 'Draft reply: ' : 'Reply: '}</span>
          {item.response}
        </p>
      )}
      {actions.note != null && !posted && <p className={`text-meta ${MUTED}`}>{actions.note}</p>}
      {canWrite && (actions.canPost || actions.canResolve || posted) && (
        <div className="flex flex-wrap items-center gap-2">
          {actions.canPost && !posted && (
            <button type="button" className={BTN} disabled={posting} onClick={() => post.mutate()}>
              {posting ? 'Posting…' : accepted ? 'Reply and resolve' : 'Post reply'}
            </button>
          )}
          {posted && (
            <span className={`text-meta ${MUTED}`}>
              {post.data?.status === 'resolved' ? 'Replied and resolved.' : 'Reply posted.'}
            </span>
          )}
          {actions.canResolve && !resolved && !posted && (
            <button
              type="button"
              className={BTN}
              disabled={resolving || posting}
              onClick={() =>
                prLevel ? markResolved.mutate() : resolve.mutate({ prId: prId!, threadId: threadId!, resolved: true })
              }
            >
              {resolving ? 'Resolving…' : prLevel ? 'Mark resolved' : 'Resolve'}
            </button>
          )}
          {resolved && <span className={`text-meta ${MUTED}`}>Resolved.</span>}
        </div>
      )}
      {error != null && (
        <p className={`text-meta ${ERROR_TEXT}`}>{error instanceof Error ? error.message : String(error)}</p>
      )}
    </div>
  );
}

/**
 * A NOT (or partly) ADDRESSED finding on a thread the reader RESOLVED: Limn posts nothing there by
 * itself (a person's resolve is their decision), so the row offers "Post still open" — ONE
 * "Still open: <what is still needed>" reply. The server claims the thread's still-open record first,
 * so it can never post twice at one commit.
 */
function StillOpenBlock({
  item,
  prId,
  reviewId,
}: {
  item: ClaudeFollowUpItem;
  prId?: number;
  reviewId?: number;
}): JSX.Element | null {
  const post = usePostFollowUpReply(prId ?? 0, reviewId ?? 0, item.priorFindingId);
  const posting = useIsMutating({ mutationKey: followUpReplyMutationKey(reviewId ?? 0, item.priorFindingId) }) > 0;
  if (prId == null || reviewId == null || !stillOpenPostable(item)) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {post.isSuccess ? (
        <span className={`text-meta ${MUTED}`}>Posted.</span>
      ) : (
        <>
          <span className={`text-meta ${MUTED}`}>
            {isPrLevelItem(item) ? 'Not said on GitHub yet.' : 'You resolved this thread. Limn posted nothing there.'}
          </span>
          <button type="button" className={BTN} disabled={posting} onClick={() => post.mutate()}>
            {posting ? 'Posting…' : 'Post still open'}
          </button>
        </>
      )}
      {post.error != null && (
        <p className={`text-meta ${ERROR_TEXT}`}>{post.error instanceof Error ? post.error.message : String(post.error)}</p>
      )}
    </div>
  );
}

// EXPORTED FOR THE AI FIX PICKER (AiFix/FixPicker.tsx): the same card with `actions={false}` (no
// Post reply / Resolve, no "Raised again below") and its tick box in `selection`.
export function FollowUpRow({
  item,
  muted,
  findingsById,
  headMoved,
  changedPaths,
  onOpenInChanges,
  prId,
  reviewId,
  actions = true,
  selection = null,
  by,
  oneLine = false,
}: {
  item: ClaudeFollowUpItem;
  muted: boolean;
  findingsById: ReadonlyMap<number, ClaudeFinding>;
  headMoved: boolean;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
  prId?: number;
  reviewId?: number;
  // false ⇒ no buttons. Default true.
  actions?: boolean;
  // The provider that ran the review (absent ⇒ Claude).
  by?: string;
  // A leading control in the card's header (the fix picker's tick box).
  selection?: ReactNode;
  // The Findings list: the one-line how only (`followUpOneLine`), never the whole explanation.
  oneLine?: boolean;
}): JSX.Element {
  const replyHeading = replyStatusHeading(item);
  const anchor = followUpAnchor(item, findingsById, headMoved, changedPaths);
  const border =
    item.status === 'not_addressed' || item.status === 'partly_addressed' || item.status === 'reply_disputed'
      ? ''
      : '';
  const reraised =
    item.reraisedFindingId != null && findingsById.has(item.reraisedFindingId)
      ? item.reraisedFindingId
      : null;
  return (
    <li className={`rounded-ui bg-ui-surface px-3 py-2.5 text-body ${border}`}>
      <div className="flex flex-wrap items-center gap-2">
        {selection}
        <span className={`${CHIP} ${FOLLOW_UP_STATUS_CLASS[item.status]}`}>
          {replyHeading ?? FOLLOW_UP_STATUS_LABEL[item.status]}
        </span>
        <span className={`${CHIP} ${SEVERITY_CLASS[item.severity]}`}>
          {SEVERITY_WORD[item.severity]}
        </span>
        <span
          className={`min-w-0 break-words ${muted ? 'text-ui-mute' : REVIEW_ITEM_TITLE}`}
        >
          <PrRefText text={item.title} />
        </span>
        {isResolvedPushback(item) && (
          <span className={`${CHIP} ${RESOLVED_ON_GITHUB_CHIP.cls}`}>{RESOLVED_ON_GITHUB_CHIP.label}</span>
        )}
        {raisedByLine(item, by) != null ? (
          <span className={`text-meta ${MUTED}`}>{raisedByLine(item, by)}</span>
        ) : (
          item.carried && <span className={`text-meta ${MUTED}`}>from an earlier review</span>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2">
        <CodeAnchorRef
          path={anchor.path}
          line={anchor.line}
          side={anchor.side}
          inChangeset={anchor.inChangeset}
          onOpenInChanges={onOpenInChanges}
        />
        {isPrLevelItem(item) && <PrCommentLink url={item.prComment?.url ?? null} />}
      </div>
      {/* THE ONE-LINE HOW: how it was dealt with, or the one thing still needed. A row from before
          the field has none; its explanation (below) opens with the same sentence. */}
      {oneLine ? (
        followUpOneLine(item, by) != null && (
          <p className="mt-1 text-body font-medium text-ui-ink" data-testid="follow-up-how">
            <PrRefText text={followUpOneLine(item, by)!} />
          </p>
        )
      ) : item.how != null && item.how.trim() !== '' ? (
        <p className="mt-1 text-body font-medium text-ui-ink" data-testid="follow-up-how">
          <PrRefText text={item.how.trim()} />
        </p>
      ) : null}
      {oneLine ? null : item.explanation != null && item.explanation !== '' ? (
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={item.explanation} />
        </p>
      ) : item.status === 'not_checked' ? (
        <p className={`mt-1 text-meta ${MUTED}`}>{notCheckedReason(item, by)}</p>
      ) : null}
      {/* Without actions the block keeps its text and drops its buttons (they need prId + reviewId). */}
      <ReplyBlock item={item} prId={actions ? prId : undefined} reviewId={actions ? reviewId : undefined} />
      <StillOpenBlock item={item} prId={actions ? prId : undefined} reviewId={actions ? reviewId : undefined} />
      {actions && reraised != null && (
        <button
          type="button"
          onClick={() =>
            document
              .getElementById(`claude-finding-${reraised}`)
              ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
          className="hit mt-1 inline-flex items-center gap-1 text-meta text-ui-ink hover:underline"
        >
          Raised again below
          <ChevronIcon dir="down" size={11} />
        </button>
      )}
    </li>
  );
}

/**
 * A finding an EARLIER review settled by accepting a person's reply (read-only history): who
 * replied, an excerpt, and how it was accepted. It left the follow-up, so it has no status of this
 * run's and no buttons.
 */
export function SettledEarlierRow({
  item,
  changedPaths,
  onOpenInChanges,
}: {
  item: ClaudeSettledFinding;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  return (
    <li className="rounded-ui bg-ui-surface px-3 py-2.5 text-body">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${CHIP} ${FOLLOW_UP_STATUS_CLASS.reply_accepted}`}>{settledEarlierHeading(item)}</span>
        {item.severity != null && (
          <span className={`${CHIP} ${SEVERITY_CLASS[item.severity]}`}>{SEVERITY_WORD[item.severity]}</span>
        )}
        <span className="min-w-0 break-words text-ui-mute">
          <PrRefText text={item.title} />
        </span>
        <span className={`text-meta ${MUTED}`}>settled in an earlier review</span>
      </div>
      <div className="mt-0.5">
        <CodeAnchorRef
          path={item.path}
          line={null}
          side={item.side ?? 'RIGHT'}
          inChangeset={changedPaths.has(item.path)}
          onOpenInChanges={onOpenInChanges}
        />
      </div>
      {item.reply != null && (
        <p className={`mt-1 text-meta ${MUTED}`}>
          @{item.reply.author} replied: “{item.reply.excerpt}”
        </p>
      )}
    </li>
  );
}

/**
 * WHAT THE LATEST RUN SAID ABOUT AN EARLIER FINDING, on that finding's own row in Findings: its
 * status (unless the row already says it, `earlierNoteChip`), the one-line how, the reply it judged
 * with "Post reply" / "Resolve", and "Post still open" on a thread the reader resolved. A finding an
 * earlier review settled by accepting a reply shows who replied. Nothing when there is nothing to say.
 */
export function EarlierFindingNote({
  item,
  settled = null,
  row,
  by,
  prId,
  reviewId,
}: {
  item: ClaudeFollowUpItem | null;
  settled?: ClaudeSettledFinding | null;
  // What the row already says (so the chip is not said twice).
  row: { reraisedChip: boolean; closedReason: boolean };
  // The provider that ran the review (absent ⇒ Claude).
  by?: string;
  // The PR and the review, for the reply buttons (absent ⇒ the text only, no buttons).
  prId?: number;
  reviewId?: number;
}): JSX.Element | null {
  if (item == null) {
    if (settled == null) return null;
    return (
      <div className="mt-2 space-y-1 border-t border-ui-line pt-2" data-testid="earlier-note">
        <span className={`${CHIP} ${FOLLOW_UP_STATUS_CLASS.reply_accepted}`}>{settledEarlierHeading(settled)}</span>
        {settled.reply != null && (
          <p className={`text-meta ${MUTED}`}>
            @{settled.reply.author} replied: “{settled.reply.excerpt}”
          </p>
        )}
      </div>
    );
  }
  const chip = earlierNoteChip(item, row);
  const line = followUpOneLine(item, by);
  return (
    <div className="mt-2 space-y-1 border-t border-ui-line pt-2" data-testid="earlier-note">
      {(chip != null || line != null || isResolvedPushback(item)) && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {chip != null && <span className={`${CHIP} ${FOLLOW_UP_STATUS_CLASS[item.status]}`}>{chip}</span>}
          {isResolvedPushback(item) && (
            <span className={`${CHIP} ${RESOLVED_ON_GITHUB_CHIP.cls}`}>{RESOLVED_ON_GITHUB_CHIP.label}</span>
          )}
          {line != null && (
            <span className="min-w-0 break-words text-body font-medium text-ui-ink" data-testid="follow-up-how">
              <PrRefText text={line} />
            </span>
          )}
        </div>
      )}
      <ReplyBlock item={item} prId={prId} reviewId={reviewId} />
      <StillOpenBlock item={item} prId={prId} reviewId={reviewId} />
    </div>
  );
}

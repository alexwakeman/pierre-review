// THE TICKET REVIEW'S RESULT PIECES — shared by the PR pane's Story check (TicketCoverage.tsx) and
// the story view's Story section (Activity/TicketStorySection.tsx), so both draw one
// criterion, one missing item and one currency pill the same way.
//
// `viewedPrId` is the PR the reader is looking at, or null in the story view, where no PR is
// "this one": there a row shows who delivers it and where it belongs, and NO Post button (posting
// stays per PR, in the pane). A posted item still says where it was posted. In the pane, posting is
// ONE "Post N gaps to …" button per target PR (`storyGapGroups`): the gaps go to GitHub as ONE
// collated PR comment, never one comment per item.
//
// "What this PR adds" (`PrCardDisclosure`) is a member's CONTRIBUTION CARD at its current head: a
// model-written description of the PR, collapsed by default, drawn from the review already loaded
// (no request of its own). A member with no card shows nothing.
//
// Rules (unchanged from the pane): every string from Claude renders as PLAIN TEXT, except the run's
// summary — only its leading prose (shared `storySummaryProse`), markdown through the sanitizing
// <Markdown>; a PR reference in any of it
// ("api#12") is an in-app button via ReviewPrRefs.tsx. ⚠ Posting follows the post-write copy
// contract: once GitHub answered with a comment id, the button never comes back (a retry
// double-posts).
import { DocReferencesBlock } from './DocReferences.js';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  STORY_MISSING_EXPLAINER,
  STORY_MISSING_HEADING,
  TICKET_CRITERION_STATUS_LABEL,
  criterionDone,
  criterionTextOnly,
  storySummaryProse,
  type ClaudeFindingSide,
  type TicketCriterion,
  type TicketEvidence,
  type TicketNotRequestedItem,
  type TicketPrCard,
  type TicketReview,
  type TicketReviewItem,
  type TicketReviewMember,
  type StoryDocsCriterionItem,
} from '@pierre-review/shared';
import { StoryDocsCriterionDetail } from './Activity/StoryDocsAlignment.js';
import { ApiError } from '../api/client.js';
import { useIsMutating } from '@tanstack/react-query';
import { storyGapsPostKey, usePostStoryGaps } from '../hooks/useTicketReview.js';
import {
  CLEAN_CLASS,
  OUTDATED_CLASS,
  TICKET_CRITERION_STATUS_CLASS,
  anchorLabel,
} from '../lib/claudeReviewFollowUp.js';
import {
  expectedInLabel,
  metByWords,
  showTicketComment,
  itemsByRef,
  memberLabel,
  memberPrIdsOf,
  membersWithCards,
  missingItems,
  postGapsButtonLabel,
  storyGapGroups,
  notRequestedPostedLabel,
  postedLabel,
  type StoryGapGroup,
  TICKET_PR_CARD_CHANGE_LABEL,
  TICKET_PR_CARD_KIND_LABEL,
  type TicketCurrency,
} from '../lib/ticketReview.js';
import { CheckIcon, ChevronIcon, CommentIcon, WarningIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { formatDate } from '../lib/ui.js';
import { Markdown } from './Markdown.js';
import { autoPostFailureLine } from '../lib/autoPost.js';
import { MemberPrLink, PrRefText } from './ReviewPrRefs.js';
import { FloatingLayer } from './ui/FloatingLayer.js';
import { RailWideLeft, RailWideToggle } from './RailLayout.js';
import { useStorySectionLook } from './Ticket/StoryLayout.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { SendToChatButton } from './ClaudeReviewChat.js';
import {
  REVIEW_CHIP,
  REVIEW_ITEM_CARD,
  REVIEW_ITEM_TITLE,
  REVIEW_PROSE,
  REVIEW_SUBHEAD,
} from '../lib/reviewStyles.js';

export type OpenInChanges = (path: string, line: number | null, side: ClaudeFindingSide) => void;

const CHIP = REVIEW_CHIP;
const MUTED = 'text-ui-mute';
const ERROR_TEXT = 'text-ui-danger';
const BTN_PRIMARY =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';
const RUNNING_CLASS = 'bg-ui-sel text-ui-accent';
const NO_PATHS: ReadonlySet<string> = new Set();

const CURRENCY_CLASS: Record<TicketCurrency['tone'], string> = {
  current: CLEAN_CLASS,
  stale: OUTDATED_CLASS,
  running: RUNNING_CLASS,
};

export function CurrencyPill({ currency }: { currency: TicketCurrency }): JSX.Element {
  return (
    <span className={`${CHIP} ${CURRENCY_CLASS[currency.tone]}`} title={currency.title}>
      {currency.tone === 'current' ? (
        <CheckIcon size={11} />
      ) : currency.tone === 'stale' ? (
        <WarningIcon size={11} />
      ) : (
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ui-accent-fill" />
      )}
      {currency.label}
    </span>
  );
}

interface RowContext {
  review: TicketReview;
  viewedPrId: number | null;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}

// The AI Fix picker draws CriterionRow / MissingRow with `actions={false}` (no Post, no chat pin)
// and its tick box in `selection`. Story check passes neither.
interface PickerRowProps {
  actions?: boolean;
  selection?: ReactNode;
}

/** A code location: into the Changes tab when it is the viewed PR's file, else plain text. */
function EvidenceRef({
  ev,
  viewedPrId,
  members,
  changedPaths,
  onOpenInChanges,
}: {
  ev: Pick<TicketEvidence, 'path' | 'line'> & { prId: number | null };
  viewedPrId: number | null;
  members: readonly TicketReviewMember[];
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const label = anchorLabel(ev.path, ev.line);
  if (viewedPrId != null && ev.prId === viewedPrId && onOpenInChanges != null && changedPaths.has(ev.path)) {
    return (
      <button
        type="button"
        onClick={() => onOpenInChanges(ev.path, ev.line, 'RIGHT')}
        className="hit break-all text-left font-mono text-meta text-ui-ink hover:underline text-link-phone"
      >
        {label}
      </button>
    );
  }
  const m = ev.prId != null && ev.prId !== viewedPrId ? members.find((x) => x.prId === ev.prId) : undefined;
  return (
    <span className={`break-all font-mono text-meta ${MUTED}`}>
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

/**
 * ONE "Post N gaps to …" button for one target PR: every unposted gap whose comment lands there goes
 * in ONE collated PR comment. Gone for good once GitHub gave a comment id (the items then read
 * "Posted"). The "Posting…" state is shared across mounts through the mutation key.
 */
function StoryGapsPostButton({ group, review, viewedPrId }: { group: StoryGapGroup; review: TicketReview; viewedPrId: number }): JSX.Element {
  const post = usePostStoryGaps(viewedPrId, review.id, group.prId);
  const posting = useIsMutating({ mutationKey: storyGapsPostKey(review.id, group.prId) }) > 0;
  if (post.isSuccess) {
    return (
      <span className={`text-meta ${MUTED}`}>
        {post.data.visible ? 'Posted' : 'Posted. It will show up here shortly.'}
      </span>
    );
  }
  // ⚠ Only 'AlreadyPosted' means a comment exists. The route also 409s 'HeadMoved' and
  // 'Superseded', where nothing was posted: those keep the button and print the server's reason.
  const already = post.error instanceof ApiError && post.error.status === 409 && post.error.code === 'AlreadyPosted';
  if (already) return <span className={`text-meta ${MUTED}`}>Already posted</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={posting}
        onClick={() => post.mutate({ memberPrIds: memberPrIdsOf(review) })}
        className={BTN_PRIMARY}
      >
        {posting ? 'Posting…' : postGapsButtonLabel(group, viewedPrId)}
      </button>
      {post.isError && <span className={`text-meta ${ERROR_TEXT}`}>{post.error.message || 'Could not post.'}</span>}
    </span>
  );
}

/**
 * The pane's posting row: one button per PR the run's unposted gaps land on — or, in this PR's slim
 * share (`onlyThisPr`), the one for this PR. The count is the server's own selection (owner PR, else
 * the viewed PR), so it says exactly how many go in the comment.
 */
export function StoryGapsPost({
  review,
  viewedPrId,
  onlyThisPr = false,
}: {
  review: TicketReview;
  viewedPrId: number;
  onlyThisPr?: boolean;
}): JSX.Element | null {
  const groups = useMemo(
    () => storyGapGroups(review, viewedPrId).filter((g) => !onlyThisPr || g.prId === viewedPrId),
    [review, viewedPrId, onlyThisPr],
  );
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {groups.map((g) => (
        <StoryGapsPostButton key={g.prId} group={g} review={review} viewedPrId={viewedPrId} />
      ))}
    </div>
  );
}

/**
 * The item's action line: where it was posted, if it was (and Send to chat, while this PR's Review
 * chat is on screen) in the pane; in the stack only where it was posted. Posting itself is the ONE
 * "Post N gaps to …" button per PR above the list.
 */
function ItemAction({ item, review, viewedPrId }: { item: TicketReviewItem; review: TicketReview; viewedPrId: number | null }): JSX.Element | null {
  if (viewedPrId != null) {
    const posted = postedLabel(item, review.members, viewedPrId);
    // ⚠ The SERVER's rule (`resolveChatPins`): a story item can join this PR's chat only when this
    // PR started that ticket review or is one of its members. The ticket's latest review may predate
    // this PR joining the ticket — then it offers no pin that would 404.
    const chat = review.originPrId === viewedPrId || review.members.some((m) => m.prId === viewedPrId);
    if (posted == null && !chat) return null;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {posted != null && (
          <span className={`text-meta ${MUTED}`}>
            <PrRefText text={posted} />
          </span>
        )}
        {chat && (
        <SendToChatButton
          prId={viewedPrId}
          reviewId={null}
          pinRef={{ kind: 'story_item', ticketReviewId: review.id, itemId: item.id }}
          label={`${review.ticketKey != null ? `${review.ticketKey} ` : ''}${item.status === 'missing' ? '' : `${item.ref} · `}${item.status === 'missing' ? item.title : criterionTextOnly(item.title, item.ref)}`}
        />
        )}
      </div>
    );
  }
  const posted = postedLabel(item, review.members, -1);
  if (posted == null) return null;
  return (
    <div className={`mt-1 text-meta ${MUTED}`}>
      <PrRefText text={posted} />
    </div>
  );
}

export function CriterionRow({
  c,
  item,
  review,
  viewedPrId,
  changedPaths,
  onOpenInChanges,
  actions = true,
  selection = null,
  docs,
}: RowContext &
  PickerRowProps & {
    c: TicketCriterion;
    item: TicketReviewItem | undefined;
    /** The story docs check's note on this criterion (Story section only); absent ⇒ nothing drawn. */
    docs?: StoryDocsCriterionItem;
  }): JSX.Element {
  // ⚠ The server adds every evidence PR to `deliveredBy` (ticket-review/reconcile.ts). On a NOT MET
  // row that PR delivered nothing: it is named under "Code in" (with its files), never "Done in".
  const doneIn = criterionDoneIn(c, review.members);
  const belongs = expectedInLabel(c.expectedIn, review.members);
  const refProps = { viewedPrId, members: review.members, changedPaths, onOpenInChanges };
  // The criterion's ref ("AC1") opens the PRs that deliver it, or where it belongs (2026-11-01: listed
  // under every criterion they were clutter). An unmet row's code in OTHER PRs joins that popover too
  // (2026-11-03): only the viewed PR's own files stay under the row, as jumps into Changes.
  const codeIn = criterionDone(c.status) ? [] : evidenceElsewhere(c, review.members, viewedPrId, doneIn);
  const ownEvidence = c.evidence.filter((ev) => viewedPrId != null && ev.prId === viewedPrId);
  const ref = <CriterionRef label={c.ref} doneIn={doneIn} codeIn={codeIn} belongs={belongs} />;
  // MET is one compact line: tick, ref, criterion, who delivered it. MET OUTSIDE CODE CHANGES is the
  // same done line with a comment mark, its label, and the comment it rests on (a button that opens
  // the ticket's Comments at it).
  if (criterionDone(c.status)) {
    const outside = c.status === 'met_outside_code';
    const cite = outside ? metByWords(c.metBy, formatDate) : null;
    const line = (
      <>
        {/* The tick and the ref are ONE unit on the first line, however far the criterion wraps. */}
        <span className="inline-flex shrink-0 items-center gap-1.5 leading-5">
          <span className="text-ui-success" aria-label={TICKET_CRITERION_STATUS_LABEL[c.status]}>
            {outside ? <CommentIcon size={12} /> : <CheckIcon size={12} />}
          </span>
          {ref}
        </span>
        <span className="min-w-0 break-words leading-5">
          {criterionTextOnly(c.text, c.ref)}
          {outside && (
            <span className="block text-meta text-ui-mute">
              {TICKET_CRITERION_STATUS_LABEL.met_outside_code}
              {cite != null && c.metBy != null && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="hit underline decoration-dotted underline-offset-2 hover:text-ui-ink"
                    title="Show this comment in the ticket's comments"
                    onClick={() => showTicketComment(c.metBy!.commentId)}
                  >
                    {cite}
                  </button>
                </>
              )}
            </span>
          )}
        </span>
      </>
    );
    if (docs == null) return <li className="flex items-start gap-2 px-1 text-body">{line}</li>;
    return (
      <li className="flex flex-col px-1 text-body">
        <div className="flex items-start gap-2">{line}</div>
        <div className="pl-5">
          <StoryDocsCriterionDetail item={docs} />
        </div>
      </li>
    );
  }
  return (
    <li className={REVIEW_ITEM_CARD}>
      {/* Below sm the verdict sits ABOVE the criterion (beside it, a long "Can't tell from the
          code" squeezed the criterion into a column a few words wide). */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1 sm:flex-nowrap">
        {selection}
        <span className={`${CHIP} ${TICKET_CRITERION_STATUS_CLASS[c.status]}`}>
          {TICKET_CRITERION_STATUS_LABEL[c.status]}
        </span>
        <span className="flex min-w-0 basis-full items-start gap-2 sm:basis-auto sm:flex-1">
          <span className="leading-5">{ref}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-semibold">{criterionTextOnly(c.text, c.ref)}</span>
        </span>
      </div>
      {ownEvidence.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-3">
          {ownEvidence.map((ev, i) => (
            <EvidenceRef key={i} ev={ev} {...refProps} />
          ))}
        </div>
      )}
      {c.explanation != null && c.explanation !== '' && (
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={c.explanation} />
        </p>
      )}
      {actions && item != null && <ItemAction item={item} review={review} viewedPrId={viewedPrId} />}
      {docs != null && <StoryDocsCriterionDetail item={docs} />}
    </li>
  );
}

/** The member PRs that deliver a criterion (the ones the run knows), in its order. */
function deliveredByMembers(c: Pick<TicketCriterion, 'deliveredBy'>, members: readonly TicketReviewMember[]): TicketReviewMember[] {
  const byId = new Map(members.map((m) => [m.prId, m]));
  return c.deliveredBy.map((id) => byId.get(id)).filter((m): m is TicketReviewMember => m != null);
}

/** The "Done in" PRs of a criterion: its `deliveredBy`, less its evidence PRs when it is not met. */
export function criterionDoneIn(
  c: Pick<TicketCriterion, 'deliveredBy' | 'evidence' | 'status'>,
  members: readonly TicketReviewMember[],
): TicketReviewMember[] {
  const all = deliveredByMembers(c, members);
  if (c.status !== 'not_met') return all;
  const evidenced = new Set(c.evidence.map((ev) => ev.prId));
  return all.filter((m) => !evidenced.has(m.prId));
}

/** One member PR an unmet criterion's evidence points into, with the files it names there. */
export interface CriterionCodeIn {
  member: TicketReviewMember;
  paths: string[];
}

/**
 * The member PRs (other than the viewed one, and other than those already "Done in") that an unmet
 * criterion's evidence points into, in evidence order, each with its `path:line` labels. Evidence in
 * a PR the run does not know is dropped (there is nothing to link).
 */
export function evidenceElsewhere(
  c: Pick<TicketCriterion, 'evidence'>,
  members: readonly TicketReviewMember[],
  viewedPrId: number | null,
  doneIn: readonly TicketReviewMember[] = [],
): CriterionCodeIn[] {
  const byId = new Map(members.map((m) => [m.prId, m]));
  const skip = new Set(doneIn.map((m) => m.prId));
  const out = new Map<number, CriterionCodeIn>();
  for (const ev of c.evidence) {
    if (ev.prId === viewedPrId || skip.has(ev.prId)) continue;
    const m = byId.get(ev.prId);
    if (m == null) continue;
    const entry = out.get(m.prId) ?? { member: m, paths: [] };
    const label = anchorLabel(ev.path, ev.line);
    if (!entry.paths.includes(label)) entry.paths.push(label);
    out.set(m.prId, entry);
  }
  return [...out.values()];
}

/**
 * A criterion's ref. With PRs to name, a button that opens them in a small popover: "Done in" (one per
 * line, each opening the PR), "Code in" (an unmet criterion's code in other PRs, with its files) and
 * "Belongs in …". Without, plain text.
 */
function CriterionRef({
  label,
  doneIn,
  codeIn = [],
  belongs,
}: {
  label: string;
  doneIn: readonly TicketReviewMember[];
  codeIn?: readonly CriterionCodeIn[];
  belongs: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  useClickOutside(rootRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (doneIn.length === 0 && codeIn.length === 0 && belongs == null) return <span className={`shrink-0 font-mono text-meta ${MUTED}`}>{label}</span>;
  return (
    <span ref={rootRef} className="shrink-0" data-criterion-ref>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={doneIn.length > 0 ? 'The pull requests that do this' : codeIn.length > 0 ? 'The pull requests with code for this' : 'Where this belongs'}
        className={`hit rounded-ui font-mono text-meta ${MUTED} underline decoration-dotted underline-offset-2 hover:text-ui-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent`}
      >
        {label}
      </button>
      {open && (
        <FloatingLayer
          anchorRef={rootRef}
          id={panelId}
          role="dialog"
          aria-label={`${label}: pull requests`}
          className="z-[60] w-64 rounded-ui bg-ui-raise p-2 text-meta shadow-lg ring-1 ring-ui-line motion-safe:animate-ui-pop"
        >
          {doneIn.length > 0 && (
            <>
              <p className={`mb-1 ${MUTED}`}>Done in</p>
              <ul className="space-y-0.5">
                {doneIn.map((m) => (
                  <li key={m.prId}>
                    <MemberPrLink member={{ repo: m.repo, number: m.number, label: memberLabel(m) }} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {codeIn.length > 0 && (
            <div className={doneIn.length > 0 ? 'mt-1.5' : ''}>
              <p className={`mb-1 ${MUTED}`}>Code in</p>
              <ul className="space-y-1">
                {codeIn.map(({ member: m, paths }) => (
                  <li key={m.prId} className="min-w-0">
                    <MemberPrLink member={{ repo: m.repo, number: m.number, label: memberLabel(m) }} />
                    {paths.map((p) => (
                      <span key={p} className={`block break-all font-mono ${MUTED}`}>
                        {p}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {belongs != null && (
            <p className={doneIn.length > 0 || codeIn.length > 0 ? 'mt-1.5' : ''}>
              <PrRefText text={belongs} />
            </p>
          )}
        </FloatingLayer>
      )}
    </span>
  );
}

export function MissingRow({
  item,
  review,
  viewedPrId,
  changedPaths,
  onOpenInChanges,
  actions = true,
  selection = null,
}: RowContext & PickerRowProps & { item: TicketReviewItem }): JSX.Element {
  const owner = item.ownerPrId != null ? review.members.find((m) => m.prId === item.ownerPrId) : undefined;
  return (
    <li className={REVIEW_ITEM_CARD}>
      <div className="flex items-start gap-2">
        {selection}
        <span className={`${CHIP} ${TICKET_CRITERION_STATUS_CLASS.not_met}`}>Not done</span>
        {/* The item's own title leads; its 'M1'… ref is internal (item refs, AI Fix) and never shown. */}
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-semibold">{item.title}</span>
      </div>
      {owner != null && (
        <div className={`mt-0.5 text-meta ${MUTED}`}>
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
      {actions && <ItemAction item={item} review={review} viewedPrId={viewedPrId} />}
    </li>
  );
}

export function MissingList({ items, ...ctx }: RowContext & { items: readonly TicketReviewItem[] }): JSX.Element | null {
  const look = useStorySectionLook();
  if (items.length === 0) return null;
  return (
    // `data-story-section`: the story view's section nav reaches it (Ticket/StoryLayout.tsx).
    <div className={`scroll-mt-4 space-y-1.5 focus:outline-none ${look?.section ?? ''}`} data-story-section="missing">
      <div className="flex items-center gap-1">
        <h5 className={look?.heading ?? REVIEW_SUBHEAD}>{`${STORY_MISSING_HEADING} (${items.length})`}</h5>
        <InfoButton title={STORY_MISSING_HEADING}>
          <p>{STORY_MISSING_EXPLAINER}</p>
        </InfoButton>
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <MissingRow key={item.id} item={item} {...ctx} />
        ))}
      </ul>
    </div>
  );
}

export function NotRequestedList({
  items,
  review,
  viewedPrId,
  changedPaths,
  onOpenInChanges,
}: RowContext & { items: readonly TicketNotRequestedItem[] }): JSX.Element | null {
  const look = useStorySectionLook();
  if (items.length === 0) return null;
  return (
    <div className={`scroll-mt-4 space-y-1 focus:outline-none ${look?.section ?? ''}`} data-story-section="not-asked">
      <h5 className={look?.heading ?? REVIEW_SUBHEAD}>{`Not asked for (${items.length})`}</h5>
      <ul className="space-y-1.5">
        {items.map((g, i) => (
          <li key={i} className={REVIEW_ITEM_CARD}>
            <span className={`break-words ${REVIEW_ITEM_TITLE}`}>
              <PrRefText text={g.title} />
            </span>
            {notRequestedPostedLabel(review, i) != null && (
              <span className={`ml-2 text-meta ${MUTED}`}>{notRequestedPostedLabel(review, i)}</span>
            )}
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
  );
}

/** What one SUCCEEDED run found for the ticket — the WHOLE story, every PR's share. */
export function TicketResults({
  review,
  viewedPrId,
  changedPaths = NO_PATHS,
  onOpenInChanges,
  docsItems,
  afterCriteria,
}: {
  review: TicketReview;
  viewedPrId: number | null;
  changedPaths?: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
  /** The story docs check's notes by criterion number (`AC{n}` = array position n); the Story section
   *  passes them only when they were written against THIS list. The PR pane passes nothing. */
  docsItems?: ReadonlyMap<number, StoryDocsCriterionItem>;
  /** Drawn right under the criteria (the story view's design). */
  afterCriteria?: ReactNode;
}): JSX.Element {
  const a = review.assessment;
  const byRef = useMemo(() => itemsByRef(review.items), [review.items]);
  const missing = useMemo(() => missingItems(review.items), [review.items]);
  const summary = useMemo(() => storySummaryProse(a?.summary), [a?.summary]);
  if (a == null) return <p className={`text-meta ${MUTED}`}>No result stored.</p>;
  const ctx = { review, viewedPrId, changedPaths, onOpenInChanges };
  const autoPostFailed = autoPostFailureLine(review.autoPost);
  return (
    <div className="space-y-3">
      {autoPostFailed != null && <p className="text-meta text-ui-warn">{autoPostFailed}</p>}
      {/* Two plain sentences. An older run's stored summary also listed every gap as a bullet: only
          its leading prose is shown (the rows below carry the detail). */}
      {summary != null && <Markdown prRefs>{summary}</Markdown>}
      {viewedPrId != null && <StoryGapsPost review={review} viewedPrId={viewedPrId} />}
      {a.criteria.length > 0 && (
        <ul className="space-y-1.5">
          {a.criteria.map((c, i) => (
            <CriterionRow key={c.ref} c={c} item={byRef.get(c.ref)} docs={docsItems?.get(i + 1)} {...ctx} />
          ))}
        </ul>
      )}
      {afterCriteria}
      <MissingList items={missing} {...ctx} />
      <NotRequestedList items={a.notRequested} {...ctx} />
      <DocReferencesBlock references={a.references} />
      {review.members.some((m) => !m.checkedOut) && (
        <p className={`text-meta ${MUTED}`}>
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

const CARD_CHANGE_CLASS: Record<TicketPrCard['interfaces'][number]['change'], string> = {
  added: 'bg-ui-raise text-ui-success',
  changed: 'bg-ui-raise text-ui-warn',
  removed: 'bg-ui-danger/10 text-ui-danger',
};

/** One member's contribution card, collapsed by default: summary, interfaces, loose ends. With
 *  `row` (under "What each PR adds") the toggle is a full-width row — the PR's number and title — and
 *  the open card spans the whole width under it; in the story rail its Expand lays it over the main
 *  column (RailLayout.tsx `RailWideLeft`). Bare (one PR's own coverage) a small "What this PR adds". */
export function PrCardDisclosure({
  card,
  label,
  row,
}: {
  card: TicketPrCard;
  label?: ReactNode;
  row?: { number: number; title: string | null; repo: string };
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const body = (
    <div className="space-y-3 text-meta">
      <p className="whitespace-pre-wrap break-words text-body text-ui-ink">
        <PrRefText text={card.summary} />
      </p>
      {card.interfaces.length > 0 && (
        <div className="space-y-1.5">
          <h6 className={REVIEW_SUBHEAD}>{`Interfaces (${card.interfaces.length})`}</h6>
          <ul className="space-y-2">
            {card.interfaces.map((i, k) => (
              <li key={k} className="space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span className={`${CHIP} ${CARD_CHANGE_CLASS[i.change]}`}>{TICKET_PR_CARD_CHANGE_LABEL[i.change]}</span>
                  <span className={MUTED}>{TICKET_PR_CARD_KIND_LABEL[i.kind]}</span>
                </div>
                <div className="font-mono text-ui-ink [overflow-wrap:anywhere]">{i.name}</div>
                {i.note != null && i.note !== '' && (
                  <div className={`break-words ${MUTED}`}>
                    <PrRefText text={i.note} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.looseEnds.length > 0 && (
        <div className="space-y-1.5">
          <h6 className={REVIEW_SUBHEAD}>{`Loose ends (${card.looseEnds.length})`}</h6>
          <ul className="list-disc space-y-1 pl-4 text-ui-ink">
            {card.looseEnds.map((l, k) => (
              <li key={k} className="break-words">
                <PrRefText text={l} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
  if (row != null) {
    // Every PR here is on the same ticket: a title that opens with a ticket key ("BMD-1182 Send…")
    // drops it in the row (the full title stays in the tooltip).
    const shortTitle = row.title != null ? row.title.replace(/^\[?[A-Z][A-Z0-9]+-\d+\]?[\s:–—-]*/, '') || row.title : null;
    return (
      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          title={row.title ?? undefined}
          className="hit flex w-full min-w-0 items-center gap-2 rounded-ui px-1.5 py-1 text-left text-body hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:min-h-10"
        >
          <ChevronIcon dir={open ? 'down' : 'right'} size={12} className="shrink-0 text-ui-mute" />
          <span className="shrink-0 font-mono text-meta text-ui-mute">
            <span className="sr-only">{row.repo}</span>#{row.number}
          </span>
          <span className={`min-w-0 flex-1 truncate ${shortTitle != null ? 'text-ui-ink' : MUTED}`}>{shortTitle ?? label}</span>
        </button>
        {open && (
          <RailWideLeft className="mb-2 mt-1 rounded-ui bg-ui-surface p-3">
            <div id={bodyId}>
              <div className="mb-2 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-meta text-ui-mute">{label}</span>
                <RailWideToggle className="-my-0.5 ml-auto" expandTitle="Show over the main column" />
              </div>
              {body}
            </div>
          </RailWideLeft>
        )}
      </div>
    );
  }
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="hit inline-flex items-center gap-1.5 rounded-ui px-1 py-0.5 text-left text-meta font-medium text-ui-mute hover:text-ui-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
        {label != null ? <span className="font-mono">{label}</span> : 'What this PR adds'}
      </button>
      {open && (
        <div id={bodyId} className="ml-5 mt-1">
          {body}
        </div>
      )}
    </div>
  );
}

/** "What this PR adds" for every member that has a card (the Open PRs stack), grouped by repository
 *  (a repository's name once, its PRs under it). Nothing when none do. */
export function MemberCards({ members }: { members: readonly TicketReviewMember[] }): JSX.Element | null {
  const withCards = useMemo(() => membersWithCards(members), [members]);
  const groups = useMemo(() => {
    const byRepo = new Map<string, typeof withCards>();
    for (const w of withCards) {
      const list = byRepo.get(w.member.repo);
      if (list != null) list.push(w);
      else byRepo.set(w.member.repo, [w]);
    }
    return [...byRepo.entries()];
  }, [withCards]);
  if (withCards.length === 0) return null;
  const oneRepo = groups.length === 1;
  return (
    <div className="space-y-1.5" data-testid="story-member-cards">
      <h5 className={REVIEW_SUBHEAD}>What each PR adds</h5>
      <div className="space-y-2.5">
        {groups.map(([repo, list]) => (
          <div key={repo}>
            {!oneRepo && (
              <h6 className="truncate px-1.5 pb-0.5 font-mono text-meta text-ui-mute" title={repo}>
                {repo.includes('/') ? repo.slice(repo.indexOf('/') + 1) : repo}
              </h6>
            )}
            <ul>
              {list.map(({ member, card }) => (
                <li key={member.prId}>
                  <PrCardDisclosure
                    card={card}
                    label={memberLabel(member)}
                    row={{ number: member.number, title: member.title, repo: member.repo }}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

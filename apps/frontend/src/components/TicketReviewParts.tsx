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
import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  STORY_MISSING_EXPLAINER,
  STORY_MISSING_HEADING,
  TICKET_CRITERION_STATUS_LABEL,
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
  deliveredByLabel,
  expectedInLabel,
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
import { CheckIcon, ChevronIcon, WarningIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { Markdown } from './Markdown.js';
import { autoPostFailureLine } from '../lib/autoPost.js';
import { MemberPrLink, PrRefText } from './ReviewPrRefs.js';
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
        className="hit break-all text-left font-mono text-meta text-ui-accent hover:underline"
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
  const done = deliveredByLabel(c, review.members);
  const belongs = expectedInLabel(c.expectedIn, review.members);
  const refProps = { viewedPrId, members: review.members, changedPaths, onOpenInChanges };
  // MET is one compact line: tick, ref, criterion, who delivered it.
  if (c.status === 'met') {
    const line = (
      <>
        <span className="shrink-0 self-center text-ui-success" aria-label="Met">
          <CheckIcon size={12} />
        </span>
        <span className={`shrink-0 font-mono text-meta ${MUTED}`}>{c.ref}</span>
        <span className="min-w-0 break-words">
          {criterionTextOnly(c.text, c.ref)}
          {done != null && (
            <span className={`text-meta ${MUTED}`}>
              {' · '}
              <PrRefText text={done} />
            </span>
          )}
        </span>
      </>
    );
    if (docs == null) return <li className="flex items-baseline gap-2 px-1 text-body">{line}</li>;
    return (
      <li className="flex flex-col px-1 text-body">
        <div className="flex items-baseline gap-2">{line}</div>
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
          <span className={`shrink-0 font-mono text-meta leading-5 ${MUTED}`}>{c.ref}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-semibold">{criterionTextOnly(c.text, c.ref)}</span>
        </span>
      </div>
      {(done != null || belongs != null) && (
        <div className={`mt-0.5 text-meta ${MUTED}`}>
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
      {actions && item != null && <ItemAction item={item} review={review} viewedPrId={viewedPrId} />}
      {docs != null && <StoryDocsCriterionDetail item={docs} />}
    </li>
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
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <h5 className={REVIEW_SUBHEAD}>{`${STORY_MISSING_HEADING} (${items.length})`}</h5>
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
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <h5 className={REVIEW_SUBHEAD}>{`Not asked for (${items.length})`}</h5>
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

/** One member's contribution card, collapsed by default: summary, interfaces, loose ends. */
export function PrCardDisclosure({ card, label }: { card: TicketPrCard; label?: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
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
        {/* Under "What each PR adds" the PR ref IS the label; a bare mount (one PR's own coverage) names the card. */}
        {label != null ? <span className="font-mono">{label}</span> : 'What this PR adds'}
      </button>
      {open && (
        <div id={bodyId} className="ml-5 mt-1 space-y-2 text-meta">
          <p className="whitespace-pre-wrap break-words text-ui-ink">
            <PrRefText text={card.summary} />
          </p>
          {card.interfaces.length > 0 && (
            <div className="space-y-1">
              <h6 className={REVIEW_SUBHEAD}>{`Interfaces (${card.interfaces.length})`}</h6>
              <ul className="space-y-1">
                {card.interfaces.map((i, k) => (
                  <li key={k} className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className={`${CHIP} ${CARD_CHANGE_CLASS[i.change]}`}>{TICKET_PR_CARD_CHANGE_LABEL[i.change]}</span>
                    <span className={MUTED}>{TICKET_PR_CARD_KIND_LABEL[i.kind]}</span>
                    <span className="break-all font-mono text-ui-ink">{i.name}</span>
                    {i.note != null && i.note !== '' && (
                      <span className={`min-w-0 break-words ${MUTED}`}>
                        <PrRefText text={i.note} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {card.looseEnds.length > 0 && (
            <div className="space-y-1">
              <h6 className={REVIEW_SUBHEAD}>{`Loose ends (${card.looseEnds.length})`}</h6>
              <ul className="list-disc space-y-0.5 pl-4 text-ui-ink">
                {card.looseEnds.map((l, k) => (
                  <li key={k} className="break-words">
                    <PrRefText text={l} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "What this PR adds" for every member that has a card (the Open PRs stack). Nothing when none do. */
export function MemberCards({ members }: { members: readonly TicketReviewMember[] }): JSX.Element | null {
  const withCards = useMemo(() => membersWithCards(members), [members]);
  if (withCards.length === 0) return null;
  return (
    <div className="space-y-1">
      <h5 className={REVIEW_SUBHEAD}>What each PR adds</h5>
      <ul className="space-y-0.5">
        {withCards.map(({ member, card }) => (
          <li key={member.prId}>
            <PrCardDisclosure card={card} label={memberLabel(member)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

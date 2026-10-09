// THE TICKET REVIEW'S RESULT PIECES — shared by the PR pane's Story check (TicketCoverage.tsx) and
// the Open PRs ticket stack's Story check panel (Activity/StackStoryCheck.tsx), so both draw one
// criterion, one missing item and one currency pill the same way.
//
// `viewedPrId` is the PR the reader is looking at, or null in the Open PRs stack, where no PR is
// "this one": there a row shows who delivers it and where it belongs, and NO Post button (posting
// stays per PR, in the pane). A posted item still says where it was posted.
//
// "What this PR adds" (`PrCardDisclosure`) is a member's CONTRIBUTION CARD at its current head: a
// model-written description of the PR, collapsed by default, drawn from the review already loaded
// (no request of its own). A member with no card shows nothing.
//
// Rules (unchanged from the pane): every string from Claude renders as PLAIN TEXT, except the run's
// summary, which is markdown through the sanitizing <Markdown>; a PR reference in any of it
// ("api#12") is an in-app button via ReviewPrRefs.tsx. ⚠ Posting follows the post-write copy
// contract: once GitHub answered with a comment id, the button never comes back (a retry
// double-posts).
import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  TICKET_CRITERION_STATUS_LABEL,
  type ClaudeFindingSide,
  type TicketCriterion,
  type TicketEvidence,
  type TicketNotRequestedItem,
  type TicketPrCard,
  type TicketReview,
  type TicketReviewItem,
  type TicketReviewMember,
} from '@pierre-review/shared';
import { ApiError } from '../api/client.js';
import { usePostTicketItem } from '../hooks/useTicketReview.js';
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
  postButtonLabel,
  postTargetOf,
  notRequestedPostedLabel,
  postedLabel,
  TICKET_PR_CARD_CHANGE_LABEL,
  TICKET_PR_CARD_KIND_LABEL,
  type TicketCurrency,
} from '../lib/ticketReview.js';
import { CheckIcon, ChevronIcon, WarningIcon } from './Icons.js';
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
const MUTED = 'text-gray-500 dark:text-gray-400';
const ERROR_TEXT = 'text-red-600 dark:text-red-400';
const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const RUNNING_CLASS = 'bg-sky-500/10 text-sky-700 dark:text-sky-300';
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
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
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

/**
 * The item's action line: Post (and Send to chat, while this PR's Review chat is on screen) in the
 * pane; in the stack only where it was posted, if it was.
 */
function ItemAction({ item, review, viewedPrId }: { item: TicketReviewItem; review: TicketReview; viewedPrId: number | null }): JSX.Element | null {
  if (viewedPrId != null) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <ItemPost item={item} review={review} viewedPrId={viewedPrId} />
        {/* ⚠ The SERVER's rule (`resolveChatPins`): a story item can join this PR's chat only when
            this PR started that ticket review or is one of its members. The ticket's latest review
            may predate this PR joining the ticket — then it offers no pin that would 404. */}
        {(review.originPrId === viewedPrId || review.members.some((m) => m.prId === viewedPrId)) && (
        <SendToChatButton
          prId={viewedPrId}
          reviewId={null}
          pinRef={{ kind: 'story_item', ticketReviewId: review.id, itemId: item.id }}
          label={`${review.ticketKey != null ? `${review.ticketKey} ` : ''}${item.ref} · ${item.title}`}
        />
        )}
      </div>
    );
  }
  const posted = postedLabel(item, review.members, -1);
  if (posted == null) return null;
  return (
    <div className={`mt-1 text-xs ${MUTED}`}>
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
}: RowContext & { c: TicketCriterion; item: TicketReviewItem | undefined }): JSX.Element {
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
      {item != null && <ItemAction item={item} review={review} viewedPrId={viewedPrId} />}
    </li>
  );
}

export function MissingRow({
  item,
  review,
  viewedPrId,
  changedPaths,
  onOpenInChanges,
}: RowContext & { item: TicketReviewItem }): JSX.Element {
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
      <ItemAction item={item} review={review} viewedPrId={viewedPrId} />
    </li>
  );
}

export function MissingList({ items, ...ctx }: RowContext & { items: readonly TicketReviewItem[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h5 className={REVIEW_SUBHEAD}>{`Not done (${items.length})`}</h5>
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
              <span className={`ml-2 text-xs ${MUTED}`}>{notRequestedPostedLabel(review, i)}</span>
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
}: {
  review: TicketReview;
  viewedPrId: number | null;
  changedPaths?: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const a = review.assessment;
  const byRef = useMemo(() => itemsByRef(review.items), [review.items]);
  const missing = useMemo(() => missingItems(review.items), [review.items]);
  if (a == null) return <p className={`text-xs ${MUTED}`}>No result stored.</p>;
  const ctx = { review, viewedPrId, changedPaths, onOpenInChanges };
  const autoPostFailed = autoPostFailureLine(review.autoPost);
  return (
    <div className="space-y-3">
      {autoPostFailed != null && <p className="text-xs text-amber-700 dark:text-amber-300">{autoPostFailed}</p>}
      {a.summary != null && a.summary !== '' && <Markdown prRefs>{a.summary}</Markdown>}
      {a.criteria.length > 0 && (
        <ul className="space-y-1.5">
          {a.criteria.map((c) => (
            <CriterionRow key={c.ref} c={c} item={byRef.get(c.ref)} {...ctx} />
          ))}
        </ul>
      )}
      <MissingList items={missing} {...ctx} />
      <NotRequestedList items={a.notRequested} {...ctx} />
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

const CARD_CHANGE_CLASS: Record<TicketPrCard['interfaces'][number]['change'], string> = {
  added: 'bg-green-500/10 text-green-800 dark:text-green-300',
  changed: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  removed: 'bg-red-500/10 text-red-800 dark:text-red-300',
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
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs font-medium text-gray-600 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:text-gray-50"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
        {/* Under "What each PR adds" the PR ref IS the label; a bare mount (one PR's own coverage) names the card. */}
        {label != null ? <span className="font-mono">{label}</span> : 'What this PR adds'}
      </button>
      {open && (
        <div id={bodyId} className="ml-5 mt-1 space-y-2 text-xs">
          <p className="whitespace-pre-wrap break-words text-gray-800 dark:text-gray-200">
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
                    <span className="break-all font-mono text-gray-900 dark:text-gray-100">{i.name}</span>
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
              <ul className="list-disc space-y-0.5 pl-4 text-gray-800 dark:text-gray-200">
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

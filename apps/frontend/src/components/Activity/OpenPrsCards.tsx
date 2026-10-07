import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { ClaudeReviewPrState, TicketMergedPr, TicketReviewState, TimelinePr, User } from '@pierre-review/shared';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useMaintainersByRepo } from '../../hooks/useMaintainers.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useClaudeReviewStarting, useClaudeReviewStates } from '../../hooks/useClaudeReview.js';
import { useWorkspaceAutoReview } from '../../hooks/useWorkspaceAutoReview.js';
import { reviewWorkInProgress } from '../../lib/claudeReviewColumn.js';
import { useCiReviewStates } from '../../hooks/useCiReview.js';
import { useTicketLinks } from '../../hooks/useTicketLinks.js';
import { useMergedPanelOpen, useTicketMergedPrs } from '../../hooks/useTicketMergedPrs.js';
import { useStartTicketReview, useTicketReviewStarting, useTicketReviewStates } from '../../hooks/useTicketReview.js';
import { useTrackerOn } from '../../hooks/useWorkspaceTracker.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import {
  MERGE_TONE_CHIP,
  dateTime,
  indexUsers,
  mergeVerdict,
  mergeVerdictWarning,
  relativeTime,
  safeExternalUrl,
  sortOpenPrsByActivity,
  userLabel,
} from '../../lib/ui.js';
import {
  effectiveSort,
  pickSort,
  reverseSort,
  sortLabel,
  sortOpenPrs,
  sortOptionsFor,
  type OpenPrsSort,
} from '../../lib/openPrsSort.js';
import { Avatar } from '../CommentCard.js';
import { ArrowIcon, CaretIcon, CheckCircleIcon, CheckIcon, ChevronIcon, MergeIcon, TicketIcon } from '../Icons.js';
import { cardTicketLabel, cardTickets, type CardTicket } from '../../lib/cardTickets.js';
import { TicketStoryModal } from '../TicketStory.js';
import {
  cardTicketPills,
  refusalSentence,
  ticketCoverage,
  ticketCurrency,
  type CoverageTone,
} from '../../lib/ticketReview.js';
import {
  initialsOf,
  mergedByStack,
  mergedPanelKeys,
  prCountLabel,
  stackDomId,
  stackOpenPrs,
  stackRollup,
  stackRollupParts,
  stackIdFor,
  stacksWorthShowing,
  type OpenPrsStack,
  type OpenPrsView,
} from '../../lib/openPrsStacks.js';
import { useOpenPrsView } from '../../store/openPrsView.js';
import { useStackStoryCheck } from '../../store/stackStoryCheck.js';
import { ReviewedAgo } from '../ReviewedAgo.js';
import { StackStoryCheck } from './StackStoryCheck.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { ClaudeReviewPanel } from './ClaudeReviewCell.js';
import { BlastRadiusChip } from './BlastRadiusChip.js';
import { LargePrFlag } from './LargePrFlag.js';
import {
  CARD_CHIP,
  CARD_NEUTRAL_CHIP,
  CARD_TONE_CHIP,
  CardSep,
  CiChip,
  LineDelta,
  PrCardChips,
  PrCardFrame,
  PrCardMeta,
  PrCardTitle,
  filesLabel,
} from './PrCardShell.js';

// THE OPEN PRs CARDS — the Open PRs tab's list (OpenPrsDetail), one card per open PR over
// TimelinePr rows from /api/open-prs; drafts are included and marked. No column headings: the
// order is picked from the header's Sort menu (`OpenPrsSortMenu`, state owned by the caller;
// null = sortOpenPrsByActivity, the order the inline lists use).
//
// ONE CARD, FOUR LAYERS, MOST IMPORTANT FIRST:
//   1. the title (the card's largest, heaviest text) + draft marker.
//   2. the status chips, LEFT-aligned under the title (right-aligned they read as a separate
//      column, which the user found harder to scan) — CI, review standing, threads, merge
//      readiness. Each renders only when it has something true to say (no "no checks", no "—").
//   3. the TICKET ROW (only when the PR names a ticket): each ticket, "BMD-1043 · <its title>",
//      wrapping when there are several. A Jira ticket opens its story in a MODAL (read on the
//      click, `TicketKeyButton`), with "Open in Jira" inside (any ticket with an ident — Jira, GitHub Issues, Linear). Below the chips so status is
//      still the first thing read, above the grey meta line because it says what the PR is FOR.
//      Data: ONE batched `POST /api/ticket-links` (core, free; detection + stored Jira
//      titles), folded by `lib/cardTickets.ts`.
//   4. the meta line: #number · repo · author · opened · updated · size, blast radius, large-PR.
//   5. the Claude Review panel (ClaudeReviewCell.tsx) on the AI surface, accented by outcome —
//      ONLY where agentic AI runs (`me.ai.enabled`: local, free). With it, ONE batched states
//      request covers every listed card (never one per card); without it, no panel and no request.
//
// The frame, title, chips row and meta line are the SHARED PR card shell (PrCardShell.tsx), which the
// Pending board's cards are built on too — change the look there, once, for both lists.
//
// The card is WHOLE-CARD clickable and keyboard-focusable (Enter / Space opens the PR); every
// control inside it stops propagation, so a click there never opens the PR.
//
// GROUPED BY TICKET (the default where the workspace has a tracker — core, free): the same cards, in
// one STACK per ticket (`lib/openPrsStacks.ts` decides membership and order). The stack header
// carries the ticket — key (the same modal), title, status, type, assignee, PR count, a quiet roll-up, and (where
// agentic AI runs) the TICKET REVIEW's coverage pill + Re-check — so a
// card inside a stack drops its own ticket row and keeps only "Also in <other ticket>" when the
// PR names two. Until the ticket answer arrives, and whenever no PR names a ticket, the page is
// the plain list: Jira never blocks the board. Under a stack's open cards, a collapsed
// "Merged (n)" panel lists every MERGED PR linked to the same ticket (any repo, same Jira site),
// from ONE batched `GET /api/ticket-merged-prs` for the whole board; it never makes a stack of
// its own, and the header's "n PRs" stays the open count.
// Between the header and the cards, a collapsed "Story check" panel (StackStoryCheck.tsx) holds the
// ticket review's WHOLE story — read by `latestRunId` only once expanded; the header adds
// "reviewed X ago" from the batched states. The PR pane shows only its own share and jumps here.

// The chip classes and the CI chip are the shared card shell's (PrCardShell.tsx), so the Pending
// board's cards wear the same chips.
const CHIP = CARD_CHIP;
const NEUTRAL_CHIP = CARD_NEUTRAL_CHIP;
const TONE_CHIP = CARD_TONE_CHIP;
const Sep = CardSep;

// ---- the status chips (line 2) ----

function ReviewChip({ pr }: { pr: TimelinePr }): JSX.Element | null {
  if (pr.isChangesRequested) {
    return <span className={`${TONE_CHIP} bg-red-500/10 text-red-700 dark:text-red-400`}>Changes requested</span>;
  }
  if (pr.isApproved) {
    return (
      <span className={`${TONE_CHIP} bg-green-500/10 text-green-700 dark:text-green-400`}>
        <CheckIcon size={11} />
        Approved
      </span>
    );
  }
  return null;
}

/** The thread mix: untouched leads (amber), else what is still open, else all resolved. */
export function threadChipLabel(c: TimelinePr['threadCounts']): { text: string; warn: boolean } | null {
  const total = c.untouched + c.replied_unresolved + c.likely_addressed + c.resolved;
  if (total === 0) return null;
  if (c.untouched > 0) return { text: `${c.untouched} untouched`, warn: true };
  const open = total - c.resolved;
  if (open > 0) return { text: `${open} open thread${open === 1 ? '' : 's'}`, warn: false };
  return { text: `${total} resolved`, warn: false };
}

function ThreadsChip({ pr }: { pr: TimelinePr }): JSX.Element | null {
  const label = threadChipLabel(pr.threadCounts);
  if (label == null) return null;
  return (
    <span
      className={label.warn ? `${TONE_CHIP} bg-amber-500/10 text-amber-700 dark:text-amber-400` : NEUTRAL_CHIP}
      title="Review threads: untouched · replied · likely addressed · resolved"
    >
      <ThreadStateBar counts={pr.threadCounts} compact className="!w-8" />
      {label.text}
    </span>
  );
}

function MergeChip({ pr }: { pr: TimelinePr }): JSX.Element | null {
  const input = { mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft };
  // A draft says "draft" on the title line; only a branch fact (conflicts, behind) survives it.
  const v = pr.isDraft ? mergeVerdictWarning(input) : mergeVerdict(input);
  if (v == null || v.verdict === 'unknown' || v.verdict === 'draft') return null;
  return (
    <span className={`${TONE_CHIP} ${MERGE_TONE_CHIP[v.tone]}`} title={v.detail ?? undefined}>
      {v.label}
    </span>
  );
}

// ---- the sort menu (the tab's header) ----

export function OpenPrsSortMenu({
  sort,
  onChange,
}: {
  sort: OpenPrsSort | null;
  onChange: (sort: OpenPrsSort | null) => void;
}): JSX.Element {
  const claudeOn = useAiCapabilities().enabled;
  const shown = effectiveSort(sort, claudeOn);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
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
  // Focus the chosen row when the menu opens, so arrows / Tab start from it.
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };

  const item = (key: string, label: string, checked: boolean, pick: () => void): JSX.Element => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={() => {
        pick();
        setOpen(false);
      }}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-gray-800 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:text-gray-100 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
    >
      <span className="inline-flex w-3 shrink-0 justify-center">{checked && <CheckIcon size={11} />}</span>
      {label}
    </button>
  );

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-gray-300 py-0.5 pl-2.5 pr-2 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
      >
        <span className="text-gray-500 dark:text-gray-400">Sort:</span>
        <span className="font-medium text-gray-800 dark:text-gray-100">{sortLabel(shown)}</span>
        <CaretIcon dir="down" />
      </button>
      {shown != null && (
        <button
          type="button"
          onClick={() => onChange(reverseSort(shown))}
          aria-label="Reverse the order"
          title="Reverse the order"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
        >
          <ArrowIcon dir={shown.dir === 'asc' ? 'up' : 'down'} size={11} />
        </button>
      )}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Sort open PRs"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-[60] mt-1 w-56 rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {item('default', 'Recent activity', shown == null, () => onChange(null))}
          <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
          {sortOptionsFor(claudeOn).map((o) =>
            item(o.key, o.name, shown?.key === o.key, () => onChange(pickSort(o.key))),
          )}
        </div>
      )}
    </div>
  );
}

// ---- the "Group by ticket / List" toggle (the tab's header; shown only where a tracker is set) ----

export function OpenPrsViewToggle(): JSX.Element {
  const view = useOpenPrsView((s) => s.view);
  const setView = useOpenPrsView((s) => s.setView);
  const option = (v: OpenPrsView, label: string): JSX.Element => (
    <button
      type="button"
      aria-pressed={view === v}
      onClick={() => setView(v)}
      className={`rounded-full px-2.5 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        view === v
          ? 'bg-gray-900 font-medium text-white dark:bg-gray-100 dark:text-gray-900'
          : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-50'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Layout"
      className="inline-flex items-center rounded-full border border-gray-300 p-px dark:border-gray-700"
    >
      {option('grouped', 'Group by ticket')}
      {option('list', 'List')}
    </div>
  );
}

// ---- the list ----

export function OpenPrsCards({
  prs,
  isLoading,
  isError,
  sort,
  grouped = false,
  onOpenPr,
  emptyLabel = (
    <>
      <CheckCircleIcon className="mr-1.5 inline-block align-[-0.15em] decorative-mark text-gray-300 dark:text-gray-600" />
      No open PRs here.
    </>
  ),
}: {
  prs: TimelinePr[];
  isLoading: boolean;
  isError: boolean;
  /** The header's Sort menu choice; null = the default activity order. */
  sort: OpenPrsSort | null;
  /** The reader picked "Group by ticket". Honoured only once tickets are known (see below). */
  grouped?: boolean;
  onOpenPr: (pr: TimelinePr) => void;
  // The zero-row copy — overridden when a client-side narrowing (not the data) emptied the list.
  // ReactNode, not string: the DEFAULT is the all-clear state and leads with a muted tick, while
  // an override ("adjust the repo filter") is plain prose that must NOT wear one.
  emptyLabel?: ReactNode;
}): JSX.Element {
  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const maintainersByRepo = useMaintainersByRepo();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(() => new Map((repos ?? []).map((r) => [r.id, r.fullName])), [repos]);

  // The Claude Review panel: capability-gated, ONE request for every listed PR.
  const claudeOn = useAiCapabilities().enabled;
  const prIds = useMemo(() => prs.map((p) => p.id), [prs]);
  const { data: claudeData } = useClaudeReviewStates(prIds, claudeOn);
  const claudeStates = useMemo(
    () => new Map((claudeData?.states ?? []).map((st) => [st.prId, st])),
    [claudeData],
  );
  // The CI review (its own run): ONE batched request for every listed PR, like the states above.
  const { data: ciData } = useCiReviewStates(prIds, claudeOn);
  const ciStates = useMemo(() => new Map((ciData?.states ?? []).map((st) => [st.prId, st])), [ciData]);
  // The ticket row: wherever THIS workspace has a tracker (core, free — apiVersion 23), ONE request
  // for every listed PR.
  const ticketsOn = useTrackerOn(useFilters((s) => s.workspaceId));
  const { data: ticketData } = useTicketLinks(prIds, ticketsOn);
  const detectedTickets = useMemo(
    () => new Map((ticketData?.prs ?? []).map((t) => [t.prId, t])),
    [ticketData],
  );
  // The TICKET review's reading of every listed ticket: ONE batched request (never one per stack),
  // only where agentic AI runs AND the tracker does. It feeds the stack headers and the card pills.
  const ticketReviewOn = claudeOn && ticketsOn;
  const ticketIdents = useMemo(
    () => (ticketData?.prs ?? []).flatMap((p) => cardTickets(p).map((t) => t.ident)),
    [ticketData],
  );
  const { data: ticketStatesData } = useTicketReviewStates(ticketIdents, ticketReviewOn);
  const ticketStates = useMemo(
    () => new Map((ticketStatesData?.states ?? []).map((st) => [st.ident, st])),
    [ticketStatesData],
  );
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const openAiFix = useFilters((s) => s.openAiFix);
  const metaOf = (pr: TimelinePr): TabMeta => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      repoFullName: repoNameById.get(pr.repoId) ?? '',
      authorLogin: u?.githubLogin ?? null,
      authorDisplayName: u?.displayName ?? null,
      authorAvatarUrl: u?.avatarUrl ?? null,
    };
  };

  const shownSort = effectiveSort(sort, claudeOn);
  const rows = useMemo(() => {
    if (shownSort == null) {
      return sortOpenPrsByActivity(prs, (pr) => {
        const set = maintainersByRepo.get(pr.repoId);
        return pr.authorId != null && set != null && set.has(pr.authorId);
      });
    }
    return sortOpenPrs(prs, shownSort, { usersById, repoNameById, claudeStates });
  }, [prs, shownSort, maintainersByRepo, usersById, repoNameById, claudeStates]);

  // GROUPED only once the ticket answer is HERE: before it, the plain list (no skeleton, no wait
  // on Jira); after it, the list again if no PR names a ticket (a lone "No ticket" header says
  // nothing). A failed ticket request is the list too. Folded ABOVE the early returns because the
  // merged panel's ONE batched request (below) reads its keys.
  const stacked = useMemo(
    () =>
      grouped && ticketsOn && ticketData != null
        ? stackOpenPrs(rows, (pr) => cardTickets(detectedTickets.get(pr.id)))
        : null,
    [grouped, ticketsOn, ticketData, rows, detectedTickets],
  );
  const showStacks = stacked != null && stacksWorthShowing(stacked);
  // Each stack's "Merged (n)" panel: ONE request for every stack on the board, only while the
  // stacks are on screen.
  const workspaceId = useFilters((s) => s.workspaceId);
  const mergedKeys = useMemo(() => (showStacks && stacked != null ? mergedPanelKeys(stacked.stacks) : []), [showStacks, stacked]);
  const { data: mergedData } = useTicketMergedPrs(workspaceId, mergedKeys, ticketsOn && showStacks);
  const mergedStacks = useMemo(
    () => (stacked != null ? mergedByStack(stacked.stacks, mergedData) : new Map<string, TicketMergedPr[]>()),
    [stacked, mergedData],
  );
  // "See the whole story in Open PRs" from a PR pane: once that ticket's stack is on the page,
  // open its Story check panel and scroll to it (store/stackStoryCheck.ts). The store opens the
  // panel; the jump helper expanded the stack before switching tabs.
  const storyTarget = useStackStoryCheck((s) => s.target);
  const takeStoryTarget = useStackStoryCheck((s) => s.takeTarget);
  useEffect(() => {
    if (storyTarget == null || !showStacks || stacked == null) return;
    const hit = takeStoryTarget(stacked.stacks.map((st) => st.id));
    if (hit == null) return;
    useOpenPrsView.getState().expand(hit);
    requestAnimationFrame(() => {
      document.getElementById(stackDomId(hit))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [storyTarget, showStacks, stacked, takeStoryTarget]);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const openMerged = (m: TicketMergedPr): void =>
    openPrDetailTab(
      {
        id: m.prId,
        number: m.number,
        title: m.title,
        repoFullName: m.repoFullName,
        authorLogin: m.authorLogin,
        authorDisplayName: m.authorDisplayName,
        authorAvatarUrl: m.authorAvatarUrl,
      },
      { fromActivity: true },
    );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-900/40" />
        ))}
      </div>
    );
  }
  if (isError) {
    return <div className="text-sm text-red-500">Couldn’t load the open PRs.</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {emptyLabel}
      </div>
    );
  }

  const ticketsOf = (pr: TimelinePr): CardTicket[] => cardTickets(detectedTickets.get(pr.id));

  const renderCard = (
    pr: TimelinePr,
    opts: { inStack?: { alsoIn: CardTicket[]; key: string | null }; keyPrefix?: string } = {},
  ) => (
    <OpenPrCard
      key={`${opts.keyPrefix ?? ''}${pr.id}`}
      pr={pr}
      author={pr.authorId != null ? usersById.get(pr.authorId) : undefined}
      repoName={repoNameById.get(pr.repoId) ?? `repo ${pr.repoId}`}
      onOpen={() => onOpenPr(pr)}
      tickets={opts.inStack == null ? ticketsOf(pr) : []}
      alsoIn={opts.inStack?.alsoIn ?? []}
      headingLevel={opts.inStack != null ? 4 : 3}
      working={
        claudeOn ? (
          <ClaudeWorkChip
            prId={pr.id}
            state={claudeStates.get(pr.id)}
            ciRunning={ciStates.get(pr.id)?.status === 'running'}
            ticketRunning={
              ticketReviewOn &&
              ticketsOf(pr).some((t) => t.ident != null && ticketStates.get(t.ident)?.status === 'running')
            }
          />
        ) : null
      }
      claude={
        claudeOn ? (
          <ClaudeReviewPanel
            prId={pr.id}
            state={claudeStates.get(pr.id)}
            ciState={ciStates.get(pr.id)}
            onOpenReview={() => openClaudeReview(metaOf(pr), { fromActivity: true })}
            onOpenFix={() => openAiFix(metaOf(pr))}
            // The ticket review's reading of this PR's tickets — not the stack's own (its header
            // says that once).
            ticketPills={
              ticketReviewOn ? cardTicketPills(ticketsOf(pr), ticketStates, opts.inStack?.key ?? null) : []
            }
          />
        ) : null
      }
    />
  );

  if (showStacks && stacked != null) {
    return (
      <div className="space-y-5">
        {stacked.stacks.map((stack) => (
          <TicketStack
            key={stack.id}
            stack={stack}
            merged={mergedStacks.get(stack.id) ?? []}
            onOpenMerged={openMerged}
            review={
              ticketReviewOn && stack.ticket?.ident != null && stack.rows[0] != null
                ? { ident: stack.ticket.ident, state: ticketStates.get(stack.ticket.ident), prId: stack.rows[0].pr.id }
                : null
            }
          >
            {stack.rows.map((r) =>
              renderCard(r.pr, {
                inStack: { alsoIn: r.alsoIn, key: stack.ticket?.key ?? null },
                keyPrefix: `${stack.id}:`,
              }),
            )}
          </TicketStack>
        ))}
      </div>
    );
  }

  return (
    <ul aria-label="Open pull requests" className="space-y-2">
      {rows.map((pr) => renderCard(pr))}
    </ul>
  );
}

// ---- a ticket key that opens the ticket's story in a modal ----

/**
 * A Jira ticket's key (and title): a click opens its STORY in a modal (TicketStory.tsx) instead of
 * leaving for Jira — "Open in Jira" is inside it. The modal is MOUNTED ONLY WHILE OPEN, so the
 * stored row is read on the click, never on the card's mount. ⚠ The modal is portalled but its
 * React events still bubble to the card / stack header (which open the PR / toggle), so the
 * wrapper stops them.
 */
function TicketKeyButton({
  ticket,
  prId,
  className,
  children,
}: {
  ticket: CardTicket;
  prId: number;
  className: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Show ${cardTicketLabel(ticket)}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`${className} rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
      >
        {children}
      </button>
      {open && (
        <span
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="contents"
        >
          <TicketStoryModal ticket={ticket} prId={prId} onClose={close} />
        </span>
      )}
    </>
  );
}

// ---- one ticket stack ----

const STATUS_PILL: Record<'new' | 'indeterminate' | 'done', string> = {
  new: 'bg-gray-500/10 text-gray-700 dark:text-gray-300',
  indeterminate: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  done: 'bg-green-500/15 text-green-700 dark:text-green-400',
};
const STATUS_WORD: Record<'new' | 'indeterminate' | 'done', string> = {
  new: 'To do',
  indeterminate: 'In progress',
  done: 'Done',
};
/** Move to another stack on the page (opening it if collapsed) — the "Also in" link. */
function jumpToStack(stackId: string): void {
  useOpenPrsView.getState().expand(stackId);
  requestAnimationFrame(() => {
    const el = document.getElementById(stackDomId(stackId));
    if (el == null) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.querySelector<HTMLElement>('[data-stack-toggle]')?.focus({ preventScroll: true });
  });
}

const COVERAGE_TONE: Record<CoverageTone, string> = {
  ok: 'bg-green-500/15 text-green-700 dark:text-green-400',
  partial: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  bad: 'bg-red-500/10 text-red-700 dark:text-red-400',
  muted: 'bg-gray-500/10 text-gray-700 dark:text-gray-300',
};

/**
 * The stack header's TICKET REVIEW reading: one pill ("4 of 6 met", amber marker when something
 * moved since) and Check / Re-check. The start shares its mutation key with the PR pane's block.
 */
function StackCoverage({
  ident,
  state,
  prId,
}: {
  ident: string;
  state: TicketReviewState | undefined;
  prId: number;
}): JSX.Element | null {
  const ready = useAiCapabilities().ready;
  const start = useStartTicketReview(ident);
  const starting = useTicketReviewStarting(ident);
  const cov = ticketCoverage(state);
  const currency = state != null ? ticketCurrency(state) : null;
  const running = state?.status === 'running';
  const refused = start.data?.runs.find((r) => r.ident === ident)?.refused ?? null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {cov != null && (
        <span className={`${CHIP} border-transparent ${COVERAGE_TONE[cov.tone]}`} title={cov.title}>
          {cov.running && <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />}
          {cov.label}
        </span>
      )}
      {cov != null && cov.stale && currency != null && (
        <span className="text-[11px] text-amber-800 dark:text-amber-300" title={currency.title}>
          {currency.label}
        </span>
      )}
      {state?.checkedAt != null && <ReviewedAgo at={state.checkedAt} className="text-[11px]" />}
      {ready && !running && (
        <button
          type="button"
          disabled={starting}
          onClick={() => start.mutate({ prId, ident })}
          title="Check this ticket against all its PRs"
          className="whitespace-nowrap rounded border border-ai-border bg-white/70 px-2 py-0.5 text-[11px] font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:opacity-60 dark:bg-gray-900/50"
        >
          {starting ? 'Starting…' : cov == null ? 'Check story' : 'Re-check'}
        </button>
      )}
      {refused != null && (
        <span className="text-xs text-red-700 dark:text-red-400">{refusalSentence(refused)}</span>
      )}
      {start.isError && <span className="text-xs text-red-700 dark:text-red-400">Could not start the check.</span>}
    </span>
  );
}

function TicketStack({
  stack,
  review,
  merged,
  onOpenMerged,
  children,
}: {
  stack: OpenPrsStack;
  /** Every merged PR linked to this ticket (the "Merged (n)" panel); [] = no panel. */
  merged: readonly TicketMergedPr[];
  onOpenMerged: (pr: TicketMergedPr) => void;
  // The ticket review's reading + who starts it (any PR on the ticket); null = not offered here.
  review: { ident: string; state: TicketReviewState | undefined; prId: number } | null;
  children: ReactNode;
}): JSX.Element {
  const collapsed = useOpenPrsView((s) => s.collapsed.includes(stack.id));
  const toggle = useOpenPrsView((s) => s.toggleCollapsed);
  const headingId = useId();
  const listId = useId();
  const t = stack.ticket;
  const cat = t?.statusCategory ?? null;
  const href = t != null ? safeExternalUrl(t.url) : null;
  const rollup = stackRollupParts(stackRollup(stack.rows));
  const name = t != null ? t.key : 'No ticket';
  // Any PR on the ticket reads its stored row; only a Jira ticket (it has an ident) has one.
  const storyPrId = t?.ident != null ? (stack.rows[0]?.pr.id ?? null) : null;

  // A click on the header's empty space toggles too (the chevron button is the keyboard route).
  const onHeaderClick = (e: MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('a,button')) return;
    toggle(stack.id);
  };

  return (
    <section
      id={stackDomId(stack.id)}
      aria-labelledby={headingId}
      className={`scroll-mt-4 rounded-xl border bg-gray-50 dark:bg-gray-900/70 ${
        t == null ? 'border-dashed border-gray-300 dark:border-gray-700' : 'border-gray-200 dark:border-gray-800'
      }`}
    >
      <div onClick={onHeaderClick} className="flex cursor-pointer flex-wrap items-start gap-x-2 gap-y-1.5 px-3 py-3">
        <button
          type="button"
          data-stack-toggle
          aria-expanded={!collapsed}
          aria-controls={listId}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
          onClick={() => toggle(stack.id)}
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        >
          <ChevronIcon dir={collapsed ? 'right' : 'down'} size={12} />
        </button>
        <div className="min-w-0 flex-1 basis-[16rem]">
          <h3 id={headingId} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {t == null ? (
              <span className="text-base font-semibold text-gray-700 dark:text-gray-200">No ticket</span>
            ) : (
              <>
                {storyPrId != null ? (
                  <TicketKeyButton
                    ticket={t}
                    prId={storyPrId}
                    className="inline-flex shrink-0 items-center gap-1 font-mono text-[13px] font-semibold text-sky-700 hover:underline dark:text-sky-300"
                  >
                    <TicketIcon size={13} className="shrink-0" />
                    {t.key}
                    <span className="sr-only">:</span>
                  </TicketKeyButton>
                ) : href != null ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={`Open ${cardTicketLabel(t)}`}
                    className="inline-flex shrink-0 items-center gap-1 font-mono text-[13px] font-semibold text-sky-700 hover:underline dark:text-sky-300"
                  >
                    <TicketIcon size={13} className="shrink-0" />
                    {t.key}
                    <span className="sr-only">:</span>
                  </a>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[13px] font-semibold text-gray-700 dark:text-gray-200">
                    <TicketIcon size={13} className="shrink-0" />
                    {t.key}
                    <span className="sr-only">:</span>
                  </span>
                )}
                {t.title != null && (
                  <span className="min-w-0 text-base font-semibold leading-snug text-gray-900 dark:text-gray-50">
                    {t.title}
                  </span>
                )}
              </>
            )}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
            {t != null && cat != null && (
              <span className={`${CHIP} border-transparent ${STATUS_PILL[cat]}`}>{t.status ?? STATUS_WORD[cat]}</span>
            )}
            {t != null && cat == null && t.status != null && <span className={NEUTRAL_CHIP}>{t.status}</span>}
            {t?.issueType != null && <span className="text-[11px] text-gray-500 dark:text-gray-400">{t.issueType}</span>}
            {t?.assignee != null && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-100"
                >
                  {initialsOf(t.assignee.name)}
                </span>
                <span>{t.assignee.name}</span>
              </span>
            )}
            {t != null && t.assignee == null && t.status != null && (
              <span className="text-gray-500 dark:text-gray-400">Unassigned</span>
            )}
          </div>
        </div>
        <div className="ml-7 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 sm:ml-0 sm:mt-0.5">
          {review != null && <StackCoverage ident={review.ident} state={review.state} prId={review.prId} />}
          {rollup.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-x-1.5 text-xs">
              {rollup.map((p, i) => (
                <span key={p.text} className="inline-flex items-center gap-1.5">
                  {i > 0 && <Sep />}
                  <span className={p.tone === 'bad' ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400'}>
                    {p.text}
                  </span>
                </span>
              ))}
            </span>
          )}
          <span className="whitespace-nowrap rounded-full bg-white px-2 py-px text-[11px] font-medium text-gray-600 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700">
            {prCountLabel(stack.rows.length)}
          </span>
        </div>
      </div>
      {t != null && review?.state != null && !collapsed && (
        <StackStoryCheck stackId={stack.id} ticket={t} state={review.state} storyPrId={review.prId} />
      )}
      <ul
        id={listId}
        aria-label={t != null ? `Pull requests for ${t.key}` : 'Pull requests with no ticket'}
        hidden={collapsed}
        className="space-y-2 px-3 pb-3"
      >
        {children}
      </ul>
      {merged.length > 0 && !collapsed && <MergedPanel stackId={stack.id} prs={merged} onOpen={onOpenMerged} />}
    </section>
  );
}

// ---- a stack's "Merged (n)" panel ----

/**
 * Under a stack's open PRs: every MERGED PR linked to the same ticket, COLLAPSED by default (the
 * open state is per session, store in hooks/useTicketMergedPrs.ts). A compact row per PR — title,
 * repo#number, author, merged date — and a click opens it in Limn like an open card.
 */
function MergedPanel({
  stackId,
  prs,
  onOpen,
}: {
  stackId: string;
  prs: readonly TicketMergedPr[];
  onOpen: (pr: TicketMergedPr) => void;
}): JSX.Element {
  const open = useMergedPanelOpen((s) => s.open.has(stackId));
  const toggle = useMergedPanelOpen((s) => s.toggle);
  const listId = useId();
  return (
    <div className="px-3 pb-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => toggle(stackId)}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-gray-600 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:text-gray-50"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
        Merged ({prs.length})
      </button>
      <ul id={listId} hidden={!open} aria-label="Merged pull requests" className="mt-1.5 space-y-1">
        {prs.map((m) => (
          <li key={m.prId}>
            <button
              type="button"
              onClick={() => onOpen(m)}
              className="block w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-left transition-colors hover:border-gray-300 hover:bg-gray-50/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-gray-700 dark:hover:bg-gray-900"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <MergeIcon size={13} className="shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
                <span className="min-w-0 truncate text-[13px] font-medium text-gray-800 dark:text-gray-100" title={m.title}>
                  {m.title}
                </span>
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-[19px] text-[11px] text-gray-500 dark:text-gray-400">
                <span className="max-w-[18rem] truncate font-mono" title={`${m.repoFullName}#${m.number}`}>
                  {m.repoFullName}#{m.number}
                </span>
                {m.authorLogin != null && (
                  <>
                    <Sep />
                    <span className="truncate text-gray-600 dark:text-gray-300">{m.authorDisplayName ?? m.authorLogin}</span>
                  </>
                )}
                <Sep />
                <span title={`Merged ${dateTime(m.mergedAt)}`}>merged {relativeTime(m.mergedAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Claude work in progress on one PR (the card header's chip) ----

/**
 * "Reviewing · Checking CI" with a pulsing dot, in the card's HEADER, whenever ANY Claude work is in
 * flight for the PR: the code review (queued or running, the auto lane included), the ticket
 * review, the CI review, AI Fix. Renders nothing otherwise. Reads the list's batched answers only.
 */
function ClaudeWorkChip({
  prId,
  state,
  ciRunning,
  ticketRunning,
}: {
  prId: number;
  state: ClaudeReviewPrState | undefined;
  ciRunning: boolean;
  ticketRunning: boolean;
}): JSX.Element | null {
  const starting = useClaudeReviewStarting(prId);
  const work = reviewWorkInProgress({ review: state, starting, ciRunning, ticketRunning });
  if (work.length === 0) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-ai-signal/10 px-1.5 py-px text-[11px] font-medium text-ai-signal"
      title="Claude is working on this PR"
    >
      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai-signal-fill" />
      {work.join(' · ')}
    </span>
  );
}

// ---- today's auto reviews against the cap (the tab header) ----

/** "3h 12m" / "12m" until `iso`; "under a minute" at the end. */
export function resetsInLabel(iso: string, nowMs: number): string {
  const mins = Math.ceil((Date.parse(iso) - nowMs) / 60_000);
  if (!Number.isFinite(mins) || mins <= 1) return 'under a minute';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * "7 of 20 auto reviews today · resets in 3h 12m" — this workspace's auto CODE reviews against its
 * daily cap (a calendar UTC day). Shown only while auto review is on (the GET sends `usage` only
 * then) and agentic AI runs here. Re-reads the count once a minute while mounted.
 */
export function AutoReviewUsageLine(): JSX.Element | null {
  const aiOn = useAiCapabilities().enabled;
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, refetch } = useWorkspaceAutoReview(aiOn, workspaceId);
  const [now, setNow] = useState(() => Date.now());
  const usage = data?.usage ?? null;
  const live = usage != null;
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => {
      setNow(Date.now());
      void refetch();
    }, 60_000);
    return () => window.clearInterval(t);
  }, [live, refetch]);
  if (usage == null) return null;
  const full = usage.used >= usage.cap;
  return (
    <span
      className={`text-[11px] ${full ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'}`}
      title="Auto code reviews started today in this Workspace (the day is counted in UTC)"
    >
      {usage.used} of {usage.cap} auto reviews today · resets in {resetsInLabel(usage.resetsAt, now)}
    </span>
  );
}

function OpenPrCard({
  pr,
  author,
  repoName,
  onOpen,
  tickets,
  alsoIn,
  headingLevel,
  working,
  claude,
}: {
  pr: TimelinePr;
  author: User | undefined;
  repoName: string;
  onOpen: () => void;
  /** The ticket row (List view). [] inside a stack — its header names the ticket. */
  tickets: CardTicket[];
  /** Inside a stack: the PR's OTHER tickets, each a stack of its own. */
  alsoIn: CardTicket[];
  headingLevel: 3 | 4;
  /** The header's "Claude is working on this" chip (ClaudeWorkChip); null where AI is off. */
  working?: ReactNode;
  claude: ReactNode;
}): JSX.Element {
  const titleId = useId();
  return (
    <PrCardFrame labelledBy={titleId} onOpen={onOpen} nested={headingLevel === 4}>
      {/* 1 — the title. */}
      <PrCardTitle
        id={titleId}
        level={headingLevel}
        end={working}
        after={
          pr.isDraft ? (
            <span className="shrink-0 rounded border border-gray-300 px-1.5 text-[11px] font-medium text-gray-600 dark:border-gray-600 dark:text-gray-300">
              Draft
            </span>
          ) : null
        }
      >
        {pr.title}
      </PrCardTitle>

      {/* 2 — the PR's status chips, left-aligned under the title so they read with it. */}
      <PrCardChips>
        <CiChip ci={pr.ciStatus} />
        <ReviewChip pr={pr} />
        <ThreadsChip pr={pr} />
        <MergeChip pr={pr} />
      </PrCardChips>

      {/* 3 — the ticket row: absent when the PR names no ticket (never an empty row). */}
      {tickets.length > 0 && (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <TicketIcon size={13} className="shrink-0 text-sky-700 dark:text-sky-300" />
          {tickets.map((t) => {
            const href = safeExternalUrl(t.url);
            const label = cardTicketLabel(t);
            const body = (
              <>
                <span className="shrink-0 whitespace-nowrap font-mono font-medium">{t.key}</span>
                {t.title != null && (
                  <>
                    <span aria-hidden className="decorative-mark shrink-0 text-gray-400 dark:text-gray-500">·</span>
                    <span className="min-w-0 truncate">{t.title}</span>
                  </>
                )}
              </>
            );
            return t.ident != null ? (
              <TicketKeyButton
                key={t.key}
                ticket={t}
                prId={pr.id}
                className="inline-flex min-w-0 max-w-full items-center gap-1 text-sky-700 hover:underline dark:text-sky-300 sm:max-w-[32rem]"
              >
                {body}
              </TicketKeyButton>
            ) : href != null ? (
              <a
                key={t.key}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                title={`Open ${label}`}
                className="inline-flex min-w-0 max-w-full items-center gap-1 text-sky-700 hover:underline dark:text-sky-300 sm:max-w-[32rem]"
              >
                {body}
              </a>
            ) : (
              <span
                key={t.key}
                title={label}
                className="inline-flex min-w-0 max-w-full items-center gap-1 text-gray-700 dark:text-gray-200 sm:max-w-[32rem]"
              >
                {body}
              </span>
            );
          })}
        </div>
      )}

      {/* 3b — inside a stack: the PR's other tickets, as jumps to their own stacks. */}
      {alsoIn.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
          <TicketIcon size={13} className="shrink-0 text-sky-700 dark:text-sky-300" />
          <span>Also in</span>
          {alsoIn.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                jumpToStack(stackIdFor(t.key));
              }}
              title={`Go to ${cardTicketLabel(t)}`}
              className="rounded font-mono font-medium text-sky-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-sky-300"
            >
              {t.key}
            </button>
          ))}
        </div>
      )}

      {/* 4 — the meta line. */}
      <PrCardMeta
        parts={[
          <span className="font-mono">#{pr.number}</span>,
          <span className="max-w-[18rem] truncate" title={repoName}>
            {repoName}
          </span>,
          <span className="inline-flex min-w-0 items-center gap-1 text-gray-600 dark:text-gray-300">
            <Avatar user={author} size={14} />
            <span className="truncate">{userLabel(author, pr.authorId)}</span>
          </span>,
          <span title={`Opened ${dateTime(pr.openedAt)}`}>opened {relativeTime(pr.openedAt)}</span>,
          pr.updatedAt !== pr.openedAt && (
            <span title={`Updated ${dateTime(pr.updatedAt)}`}>updated {relativeTime(pr.updatedAt)}</span>
          ),
          <span>{filesLabel(pr.changedFiles)}</span>,
        ]}
        trailing={
          <>
            <LineDelta additions={pr.additions} deletions={pr.deletions} />
            <LargePrFlag pr={pr} />
            <BlastRadiusChip pr={pr} />
          </>
        }
      />

      {/* 5 — Claude Review (only where agentic AI runs). */}
      {claude}
    </PrCardFrame>
  );
}

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { ClaudeReviewPrState, TicketMergedPr, TicketReviewState, TimelinePr, User } from '@pierre-review/shared';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useMaintainersByRepo } from '../../hooks/useMaintainers.js';
import { aiReadyFor, useAiCapabilities, useAiProviderName } from '../../hooks/useAiCapabilities.js';
import { useClaudeReviewStarting, useClaudeReviewStates } from '../../hooks/useClaudeReview.js';
import { useRunAutoReviewSweep, useWorkspaceAutoReview } from '../../hooks/useWorkspaceAutoReview.js';
import { autoSweepResultLine } from '../../lib/claudeAutoReview.js';
import { AiRunGate } from '../AiSetup.js';
import { reviewWorkInProgress } from '../../lib/claudeReviewColumn.js';
import { useCiReviewStates } from '../../hooks/useCiReview.js';
import { useOpenPrsTicketGate } from '../../hooks/useOpenPrsTicketGate.js';
import { useMergedPanelOpen, useTicketMergedPrs } from '../../hooks/useTicketMergedPrs.js';
import { useStartTicketReview, useTicketReviewStarting, useTicketReviewStates } from '../../hooks/useTicketReview.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useFilters } from '../../store/filters.js';
import { useOpenStory } from '../../lib/ticketTab.js';
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
import { CopyButton } from '../CopyButton.js';
import { githubPrUrl } from '../../lib/prLink.js';
import { ArrowIcon, CaretIcon, CheckCircleIcon, CheckIcon, ChevronIcon, LinkIcon, MergeIcon, TicketIcon } from '../Icons.js';
import { TrackerLinkOut } from '../TrackerLinkOut.js';
import { cardTicketLabel, cardTickets, type CardTicket } from '../../lib/cardTickets.js';
import {
  cardTicketPills,
  refusalSentence,
  ticketCoverage,
  prLabelOf,
  ticketCurrency,
  ticketWaitWords,
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
  storyStack,
  type OpenPrsStack,
  type OpenPrsView,
  type StoryStackInput,
} from '../../lib/openPrsStacks.js';
import { useOpenPrsView } from '../../store/openPrsView.js';
import {
  limitFor,
  limitToInclude,
  nextLimit,
  openPrsWindowKey,
  settleMemo,
  stackRowsWithin,
  type OpenPrsWindowMemo,
  type OpenPrsWindowScope,
} from '../../lib/openPrsWindow.js';
import { ReviewedAgo } from '../ReviewedAgo.js';
import { TicketStorySection } from './TicketStorySection.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { ClaudeReviewPanel, TicketPillsRow } from './ClaudeReviewCell.js';
import { BlastRadiusChip } from './BlastRadiusChip.js';
import { LargePrFlag } from './LargePrFlag.js';
import { TicketStatusPicker } from '../Ticket/TicketStatusPicker.js';
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
//      wrapping when there are several. A ticket with an ident (Jira, GitHub Issues, Linear) opens
//      its STORY VIEW in a tab (`TicketKeyButton` → `useOpenStory`); no modal. Below the chips so status is
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
// DRAWN A PAGE AT A TIME where the caller passes `windowScope` (Open PRs): ten cards, then ten more
// when the reader nears the bottom or presses Show more (`ShowMoreRow`, lib/openPrsWindow.ts). Only
// the drawing is windowed — sorting, grouping and every batched request still cover the whole list.
//
// GROUPED BY TICKET (the default where the workspace has a tracker — core, free): the same cards, in
// one STACK per ticket (`lib/openPrsStacks.ts` decides membership and order). A stack NEVER collapses:
// its PR list is always shown. The stack header carries the ticket — key AND title as ONE button that
// opens the ticket's STORY VIEW tab (`TicketKeyButton`; a ticket with no ident keeps the tracker link
// on its key and a plain title), status, type, assignee, PR count, a quiet roll-up, and (where
// agentic AI runs) the TICKET REVIEW's coverage pill + Re-check — so a
// card inside a stack drops its own ticket row and keeps only "Also in <other ticket>" when the
// PR names two. Until the ticket answer arrives, and whenever no PR names a ticket, the page is
// the plain list: Jira never blocks the board. Under a stack's open cards, a collapsed
// "Merged (n)" panel lists every MERGED PR linked to the same ticket (any repo, same Jira site),
// from ONE batched `GET /api/ticket-merged-prs` for the whole board; it never makes a stack of
// its own, and the header's "n PRs" stays the open count.
// The board draws NO Story section: the whole story (TicketStorySection.tsx — the ticket review's
// result, else the sprint brief, the ticket as written, the docs check and the design) is in the story
// view, one click on the header away. ⚠ So nothing on the board reads a brief, a design or a docs check.
// The header adds "reviewed X ago" from the batched states. The PR pane shows only its own share and
// links to the story view.
//
// ONE TICKET (`story`): the STORY VIEW (Ticket/TicketTabView.tsx) renders this same component for one
// ticket — exactly ONE stack, every PR handed in as its rows (detection is not asked which ticket they
// belong to), drawn even with NO pull request, its key and title plain text, its Story section ALWAYS
// OPEN (heading row = the story's actions), and its "Merged (n)" panel fed from the view's own read.
// Never a copy of the stack: change the look here, once.

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
  prs: livePrs,
  isLoading,
  answered,
  isError,
  sort,
  grouped = false,
  variant = 'open',
  onOpenPr,
  emptyLabel = (
    <>
      <CheckCircleIcon className="mr-1.5 inline-block align-[-0.15em] decorative-mark text-gray-300 dark:text-gray-600" />
      No open PRs here.
    </>
  ),
  story,
  windowScope,
}: {
  prs: TimelinePr[];
  isLoading: boolean;
  /** The PR query has answered (its data is here); absent = `!isLoading` (a list handed in whole). */
  answered?: boolean;
  isError: boolean;
  /** The header's Sort menu choice; null = the default activity order. */
  sort: OpenPrsSort | null;
  /** The reader picked "Group by ticket". Honoured only where the workspace has a tracker, once
   *  its tickets are known (see below). */
  grouped?: boolean;
  /** 'merged' = Reports → "Merged so far": the same cards and stacks over MERGED PRs. It drops
   *  what means nothing once a PR has landed — the CI and merge-readiness chips, the stack
   *  roll-up, the Claude Review panel and the CI review (and their batched requests), and the
   *  stack's own "Merged (n)" panel (the stack IS the merged work) — and the default order is
   *  newest merge first. It KEEPS the ticket review: the card's coverage pills, the stack's
   *  coverage pill and its Story check (the criteria met, the story, "What each PR adds"), and,
   *  for a ticket never reviewed, the story alone. */
  variant?: 'open' | 'merged';
  onOpenPr: (pr: TimelinePr) => void;
  // The zero-row copy — overridden when a client-side narrowing (not the data) emptied the list.
  // ReactNode, not string: the DEFAULT is the all-clear state and leads with a muted tick, while
  // an override ("adjust the repo filter") is plain prose that must NOT wear one.
  emptyLabel?: ReactNode;
  /** The STORY VIEW: one ticket's stack, drawn even with no PR (see the header). */
  story?: StoryStackInput;
  /** Draw the list a page at a time (lib/openPrsWindow.ts) — the list's place from OUTSIDE this
   *  component (workspace + repo filter); the sort and the layout are added here, and a change to
   *  any of them resets the window to one page. Absent = draw every card. */
  windowScope?: OpenPrsWindowScope;
}): JSX.Element {
  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const maintainersByRepo = useMaintainersByRepo();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(() => new Map((repos ?? []).map((r) => [r.id, r.fullName])), [repos]);

  // The Claude Review panel: capability-gated, ONE request for every listed PR.
  const merged = variant === 'merged';
  const aiOn = useAiCapabilities().enabled;
  const claudeOn = aiOn && !merged;
  // The TICKETS: where THIS workspace has a tracker (core, free — apiVersion 23), ONE request for
  // every listed PR. The first paint WAITS for them, and what is painted is the PRs and their
  // tickets taken together, so the page never redraws into ticket stacks under the reader
  // (hooks/useOpenPrsTicketGate.ts).
  const workspaceId = useFilters((s) => s.workspaceId);
  const ticketGate = useOpenPrsTicketGate(livePrs, workspaceId, isLoading, answered ?? !isLoading);
  const { prs, ticketData, ticketsOn } = ticketGate;
  const prIds = useMemo(() => prs.map((p) => p.id), [prs]);
  const { data: claudeData } = useClaudeReviewStates(prIds, claudeOn);
  const claudeStates = useMemo(
    () => new Map((claudeData?.states ?? []).map((st) => [st.prId, st])),
    [claudeData],
  );
  // TEAM CLAIMS: PRs whose auto review was skipped because a teammate's Limn holds the head.
  const teamClaimSkips = useMemo(
    () => new Map((claudeData?.teamClaimSkips ?? []).map((sk) => [sk.prId, sk])),
    [claudeData],
  );
  // The CI review (its own run): ONE batched request for every listed PR, like the states above.
  const { data: ciData } = useCiReviewStates(prIds, claudeOn);
  const ciStates = useMemo(() => new Map((ciData?.states ?? []).map((st) => [st.prId, st])), [ciData]);
  const detectedTickets = useMemo(
    () => new Map((ticketData?.prs ?? []).map((t) => [t.prId, t])),
    [ticketData],
  );
  // The TICKET review's reading of every listed ticket: ONE batched request (never one per stack),
  // only where agentic AI runs AND the tracker does. It feeds the stack headers and the card pills.
  // Merged so far reads it too: the story, the criteria met and each PR's contribution are what a
  // reader wants to know about LANDED work (the code review and CI panels are not).
  const ticketReviewOn = aiOn && ticketsOn;
  const ticketIdents = useMemo(
    () => [
      ...(story != null ? [story.ticket.ident] : []),
      ...(ticketData?.prs ?? []).flatMap((p) => cardTickets(p).map((t) => t.ident)),
    ],
    [ticketData, story],
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
    if (shownSort == null && merged) {
      return [...prs].sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? '') || b.id - a.id);
    }
    if (shownSort == null) {
      return sortOpenPrsByActivity(prs, (pr) => {
        const set = maintainersByRepo.get(pr.repoId);
        return pr.authorId != null && set != null && set.has(pr.authorId);
      });
    }
    return sortOpenPrs(prs, shownSort, { usersById, repoNameById, claudeStates });
  }, [prs, merged, shownSort, maintainersByRepo, usersById, repoNameById, claudeStates]);

  // GROUPED only with the ticket answer in hand (the first paint waits for it, above); the list if
  // no PR names a ticket (a lone "No ticket" header says nothing), and the list when the ticket
  // answer failed or was too slow for the first paint — until the reader asks for the groups.
  // Folded ABOVE the early returns because the merged panel's ONE batched request (below) reads its
  // keys.
  const wantsStacks = grouped && ticketsOn;
  const stacked = useMemo(
    () =>
      story != null
        ? storyStack(story, rows, (pr) => cardTickets(detectedTickets.get(pr.id)))
        : wantsStacks && !ticketGate.heldList && ticketData != null
        ? stackOpenPrs(
            rows,
            (pr) => cardTickets(detectedTickets.get(pr.id)),
            // Merged so far orders stacks by the MERGE, newest first — a merged PR's `updatedAt`
            // moves with any later comment, label or branch deletion.
            merged ? (pr) => pr.mergedAt ?? pr.updatedAt : undefined,
          )
        : null,
    [story, wantsStacks, ticketGate.heldList, ticketData, rows, detectedTickets, merged],
  );
  const showStacks = stacked != null && (story != null || stacksWorthShowing(stacked));
  // Each stack's "Merged (n)" panel: ONE request for every stack on the board, only while the
  // stacks are on screen.
  const mergedKeys = useMemo(() => (showStacks && stacked != null ? mergedPanelKeys(stacked.stacks) : []), [showStacks, stacked]);
  const { data: mergedData } = useTicketMergedPrs(workspaceId, mergedKeys, ticketsOn && showStacks && !merged && story == null);
  const mergedStacks = useMemo(
    () =>
      story != null && stacked != null
        ? new Map(stacked.stacks.map((st) => [st.id, [...story.merged]] as const))
        : stacked != null
          ? mergedByStack(stacked.stacks, mergedData)
          : new Map<string, TicketMergedPr[]>(),
    [story, stacked, mergedData],
  );
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

  // THE WINDOW (lib/openPrsWindow.ts): only the first page of cards is drawn, the next page each
  // time the reader nears the bottom. Paging is over `rows` / the stacks — already sorted and
  // filtered — so every count stays the full population. Never in the story view (one stack).
  const windowed = windowScope != null && story == null;
  const fullKey = windowed ? openPrsWindowKey(windowScope, shownSort, showStacks) : null;
  const win = useOpenPrsWindow(fullKey);
  const stackSizes = useMemo(
    () => (showStacks && stacked != null ? stacked.stacks.map((st) => st.rows.length) : []),
    [showStacks, stacked],
  );
  const totalCards = showStacks ? stackSizes.reduce((n, s) => n + s, 0) : rows.length;
  // Cards drawn per stack: small stacks whole, a big one (the "No ticket" stack) cut at the limit.
  const stackRows = useMemo(
    () => (!windowed ? stackSizes : stackRowsWithin(stackSizes, win.limit)),
    [windowed, stackSizes, win.limit],
  );
  const stackCount = stackRows.length;
  const drawnCards = !windowed
    ? totalCards
    : showStacks
      ? stackRows.reduce((n, s) => n + s, 0)
      : Math.min(win.limit, rows.length);
  // Grow from what is DRAWN (a whole small stack can run past the limit), so every press or scroll
  // draws new cards.
  const showMore = (): void => win.setLimit(nextLimit(Math.max(win.limit, drawnCards), totalCards));
  // An "Also in" jump to a stack beyond the window grows the window to include it first.
  const revealStack = (stackId: string): void => {
    if (!windowed || stacked == null) return;
    const i = stacked.stacks.findIndex((st) => st.id === stackId);
    if (i >= stackCount) win.setLimit(limitToInclude(i, win.limit, stackSizes));
  };
  // The "n of m" beside Show more counts distinct PRs (a PR in two stacks is one PR), like the header.
  const moreLabel = useMemo(() => {
    if (!windowed || drawnCards >= totalCards) return null;
    if (!showStacks || stacked == null) return { shown: drawnCards, total: rows.length };
    const shownIds = new Set(
      stacked.stacks.slice(0, stackCount).flatMap((st, i) => st.rows.slice(0, stackRows[i]).map((r) => r.pr.id)),
    );
    const allIds = new Set(stacked.stacks.flatMap((st) => st.rows.map((r) => r.pr.id)));
    return { shown: shownIds.size, total: allIds.size };
  }, [windowed, drawnCards, totalCards, showStacks, stacked, stackCount, stackRows, rows.length]);
  const listRef = useRef<HTMLDivElement>(null);

  if (isLoading || ticketGate.waiting) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label={merged ? 'Loading merged pull requests' : 'Loading open pull requests'}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-900/40" />
        ))}
      </div>
    );
  }
  if (isError) {
    return <div className="text-sm text-red-500">{merged ? 'Couldn’t load the merged PRs.' : 'Couldn’t load the open PRs.'}</div>;
  }
  if (rows.length === 0 && story == null) {
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
      onJumpToStack={(stackId) => {
        revealStack(stackId);
        jumpToStack(stackId);
      }}
      headingLevel={opts.inStack != null ? 4 : 3}
      variant={variant}
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
        merged ? (
          ticketReviewOn ? (
            <TicketPillsRow ticketPills={cardTicketPills(ticketsOf(pr), ticketStates, opts.inStack?.key ?? null)} />
          ) : null
        ) : claudeOn ? (
          <ClaudeReviewPanel
            prId={pr.id}
            state={claudeStates.get(pr.id)}
            ciState={ciStates.get(pr.id)}
            teamClaimSkip={teamClaimSkips.get(pr.id) ?? null}
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

  // Under the drawn cards while more remain: the scroll trigger and its keyboard fallback.
  const more =
    moreLabel != null ? (
      <ShowMoreRow
        shown={moreLabel.shown}
        total={moreLabel.total}
        drawnCards={drawnCards}
        onMore={showMore}
        listRef={listRef}
      />
    ) : null;

  if (showStacks && stacked != null) {
    return (
      <div ref={listRef} className="space-y-5">
        {stacked.stacks.slice(0, stackCount).map((stack, stackIndex) => (
          <TicketStack
            key={stack.id}
            stack={stack}
            merged={merged ? [] : (mergedStacks.get(stack.id) ?? [])}
            onOpenMerged={openMerged}
            showRollup={!merged}
            single={story != null}
            review={
              // Who starts the check: any PR on the ticket (the story view's merged ones count too).
              (ticketReviewOn || merged) && stack.ticket?.ident != null && (stack.rows[0]?.pr.id ?? story?.merged[0]?.prId) != null
                ? {
                    ident: stack.ticket.ident,
                    state: ticketReviewOn ? ticketStates.get(stack.ticket.ident) : undefined,
                    prId: (stack.rows[0]?.pr.id ?? story?.merged[0]?.prId) as number,
                    canCheck: ticketReviewOn,
                  }
                : null
            }
            storyState={stack.ticket?.ident != null && ticketReviewOn ? ticketStates.get(stack.ticket.ident) : undefined}
          >
            {stack.rows.slice(0, stackRows[stackIndex]).map((r) =>
              renderCard(r.pr, {
                inStack: { alsoIn: r.alsoIn, key: stack.ticket?.key ?? null },
                keyPrefix: `${stack.id}:`,
              }),
            )}
          </TicketStack>
        ))}
        {more}
      </div>
    );
  }

  // The first paint fell back to the list and the tickets have since arrived: grouping is the
  // reader's call now, never a redraw that happens to them.
  const offerGroups = wantsStacks && ticketGate.heldList && ticketData != null;
  return (
    <>
      {offerGroups && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <TicketIcon size={13} className="shrink-0 text-sky-700 dark:text-sky-300" />
          <span>Tickets loaded.</span>
          <button
            type="button"
            onClick={ticketGate.release}
            className="rounded border border-gray-300 px-1.5 py-0.5 font-medium hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
          >
            Group by ticket
          </button>
        </div>
      )}
      <div ref={listRef}>
        <ul aria-label={merged ? 'Merged pull requests' : 'Open pull requests'} className="space-y-2">
          {(windowed ? rows.slice(0, drawnCards) : rows).map((pr) => renderCard(pr))}
        </ul>
        {more}
      </div>
    </>
  );
}

// ---- a ticket key that opens the ticket's story tab ----

/**
 * A ticket's key and title, as ONE button: a click opens its STORY VIEW in a tab (`useOpenStory` —
 * the same standalone view This Sprint, search and the PR pane open). The ticket's text is in that
 * view's Story section, so there is no modal. ⚠ The card beneath it opens the PR on click, so the
 * button stops the event.
 */
function TicketKeyButton({
  ticket,
  className,
  children,
}: {
  ticket: CardTicket & { ident: string };
  className: string;
  children: ReactNode;
}): JSX.Element {
  const openStory = useOpenStory();
  return (
    <button
      type="button"
      title={`Open the ${ticket.key} story`}
      onClick={(e) => {
        e.stopPropagation();
        openStory({ ident: ticket.ident, key: ticket.key, title: ticket.title ?? null });
      }}
      className={`${className} rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
    >
      {children}
    </button>
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
  done: 'Complete',
};
/** Move to another stack on the page — the "Also in" link. */
function jumpToStack(stackId: string, tries = 2): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(stackDomId(stackId));
    // A stack the window has just grown to draw may land a frame later.
    if (el == null) {
      if (tries > 0) jumpToStack(stackId, tries - 1);
      return;
    }
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  });
}

// ---- the window: draw a page of cards at a time (lib/openPrsWindow.ts) ----

// How far the reader had opened the list, kept for the session so that coming back from a PR tab
// (Activity unmounts while one is open) finds the same cards drawn. ONE memo: a different list
// identity replaces it, so the window starts at one page again.
let windowMemo: OpenPrsWindowMemo | null = null;

/** The window for a list identity (`key`; null = not windowed, everything drawn). */
function useOpenPrsWindow(key: string | null): { limit: number; setLimit: (limit: number) => void } {
  const [memo, setMemo] = useState<OpenPrsWindowMemo | null>(() => windowMemo);
  const limit = key == null ? Number.POSITIVE_INFINITY : limitFor(memo, key);
  // A new identity (workspace, repo filter, sort, layout) starts at one page and FORGETS the old
  // one — going back to a previous sort does not restore its window.
  useEffect(() => {
    if (key == null) return;
    const next = settleMemo(memo, key);
    if (next === memo) return;
    windowMemo = next;
    setMemo(next);
  }, [key, memo]);
  const setLimit = useCallback(
    (next: number): void => {
      if (key == null) return;
      const m = { key, limit: next };
      windowMemo = m;
      setMemo(m);
    },
    [key],
  );
  return { limit, setLimit };
}

/** The nearest scrolling ancestor, so the trigger's margin is measured against what scrolls. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p != null && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return null;
}

/**
 * Under the drawn cards while more remain: "10 of 739" and a Show more button. The row is also the
 * scroll trigger — when it comes within 600px of the visible area the next page is drawn. The
 * observer is rebuilt after every page, so a tall screen keeps filling until the row is out of
 * reach. Pressing the button (the keyboard path) moves focus to the first new card.
 */
function ShowMoreRow({
  shown,
  total,
  drawnCards,
  onMore,
  listRef,
}: {
  shown: number;
  total: number;
  drawnCards: number;
  onMore: () => void;
  listRef: RefObject<HTMLDivElement>;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (el == null || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMoreRef.current();
      },
      { root: scrollParentOf(el), rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [drawnCards]);
  // After a button press: focus the first card the press drew.
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = focusFrom.current;
    if (from == null || drawnCards <= from) return;
    focusFrom.current = null;
    listRef.current?.querySelectorAll<HTMLElement>('li[aria-labelledby]')[from]?.focus();
  }, [drawnCards, listRef]);
  return (
    <div
      ref={ref}
      data-testid="open-prs-more"
      className="mt-3 flex items-center justify-center gap-3 text-xs text-gray-600 dark:text-gray-300"
    >
      <span className="tabular-nums">
        {shown} of {total} PRs
      </span>
      <button
        type="button"
        onClick={() => {
          focusFrom.current = drawnCards;
          onMore();
        }}
        className="rounded border border-gray-300 px-2 py-0.5 font-medium hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:hover:border-gray-500"
      >
        Show more
      </button>
    </div>
  );
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
  const ready = aiReadyFor(useAiCapabilities(), 'ticket_review');
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

/** The ticket's status (the story view's Jira status picker), type and assignee — a header's left facts. */
function TicketPeopleAndStatus({
  t,
  cat,
  single,
}: {
  t: NonNullable<OpenPrsStack['ticket']>;
  cat: 'new' | 'indeterminate' | 'done' | null;
  single: boolean;
}): JSX.Element {
  return (
    <>
      {single && t.ident != null && t.provider === 'jira' && (cat != null || t.status != null) ? (
        // The story view's Jira ticket: the chip is the status picker (the one tracker write).
        <TicketStatusPicker
          ident={t.ident}
          status={t.status ?? STATUS_WORD[cat ?? 'new']}
          chipClassName={cat != null ? `${CHIP} border-transparent ${STATUS_PILL[cat]}` : NEUTRAL_CHIP}
        />
      ) : (
        <>
          {cat != null && <span className={`${CHIP} border-transparent ${STATUS_PILL[cat]}`}>{t.status ?? STATUS_WORD[cat]}</span>}
          {cat == null && t.status != null && <span className={NEUTRAL_CHIP}>{t.status}</span>}
        </>
      )}
      {t.issueType != null && <span className="text-[11px] text-gray-500 dark:text-gray-400">{t.issueType}</span>}
      {t.assignee != null && (
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
      {t.assignee == null && t.status != null && <span className="text-gray-500 dark:text-gray-400">Unassigned</span>}
    </>
  );
}

/**
 * THE STORY VIEW'S HEADER (one ticket, `single`). Two rows, never squeezed side by side:
 *   1. the key and the link out to the tracker (small), then the TITLE on the full width;
 *   2. one meta row that wraps as whole groups — status, type and assignee; the facts as chips of one
 *      kind ("3 of 10 met", "1 failing CI", "2 PRs"); and, pushed right, the ticket review's currency
 *      as one quiet line ("2 PRs changed since · reviewed 52 mins ago") with Re-check beside it.
 * The currency is said HERE only: the Story section below does not repeat it.
 */
function StoryViewHeader({
  headingId,
  t,
  cat,
  rollup,
  prCount,
  review,
  prs,
}: {
  headingId: string;
  t: NonNullable<OpenPrsStack['ticket']>;
  cat: 'new' | 'indeterminate' | 'done' | null;
  rollup: readonly { text: string; tone: 'bad' | 'good' }[];
  prCount: number;
  review: { ident: string; state: TicketReviewState | undefined; prId: number; canCheck?: boolean } | null;
  /** Every PR the view knows (open and merged): one changed PR is named in the currency line. */
  prs: ReadonlyArray<{ prId: number; repoId: number | null; repoFullName: string | null; number: number }>;
}): JSX.Element {
  const { data: repos } = useRepos();
  const labelOf = useMemo(() => {
    const repoName = new Map((repos ?? []).map((r) => [r.id, r.fullName]));
    return prLabelOf(
      prs.map((p) => ({ prId: p.prId, number: p.number, repo: p.repoFullName ?? (p.repoId != null ? repoName.get(p.repoId) : null) })),
    );
  }, [prs, repos]);
  const checked = review != null && review.canCheck !== false;
  const cov = checked ? ticketCoverage(review.state) : null;
  return (
    <header className="space-y-2 px-4 pb-3 pt-3.5" data-testid="story-header">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        <span className="inline-flex items-center gap-1 font-mono text-[13px] font-semibold text-gray-700 dark:text-gray-200">
          <TicketIcon size={13} className="shrink-0" />
          {t.key}
        </span>
        <TrackerLinkOut url={t.url} provider={t.provider} />
      </div>
      <h3 id={headingId} className="break-words text-lg font-semibold leading-snug text-gray-900 dark:text-gray-50">
        <span className="sr-only">{t.key}: </span>
        {t.title ?? t.key}
      </h3>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
          <TicketPeopleAndStatus t={t} cat={cat} single />
        </div>
        <ul aria-label="Facts" className="flex flex-wrap items-center gap-1.5">
          {cov != null && (
            <li className={`${CHIP} border-transparent ${COVERAGE_TONE[cov.tone]}`} title={cov.title}>
              {cov.running && <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />}
              {cov.label}
            </li>
          )}
          {rollup.map((p) => (
            <li key={p.text} className={`${CHIP} border-transparent ${p.tone === 'bad' ? COVERAGE_TONE.bad : COVERAGE_TONE.ok}`}>
              {p.text}
            </li>
          ))}
          {prCount > 0 && <li className={NEUTRAL_CHIP}>{prCountLabel(prCount)}</li>}
        </ul>
        {checked && <StoryCurrencyLine ident={review.ident} state={review.state} prId={review.prId} labelOf={labelOf} />}
      </div>
    </header>
  );
}

/** The story header's quiet currency line and Re-check (or Check story): the ticket review's state. */
function StoryCurrencyLine({
  ident,
  state,
  prId,
  labelOf,
}: {
  ident: string;
  state: TicketReviewState | undefined;
  prId: number;
  labelOf: (prId: number) => string | null;
}): JSX.Element | null {
  const ready = aiReadyFor(useAiCapabilities(), 'ticket_review');
  const start = useStartTicketReview(ident);
  const starting = useTicketReviewStarting(ident);
  const cov = ticketCoverage(state);
  const currency = state != null ? ticketCurrency(state, labelOf) : null;
  const running = state?.status === 'running';
  const refused = start.data?.runs.find((r) => r.ident === ident)?.refused ?? null;
  const stale =cov != null && cov.stale && currency != null;
  const why = stale ? ticketWaitWords(state?.waiting) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:ml-auto">
      {(stale || state?.checkedAt != null) && (
        <span className="text-xs text-gray-600 dark:text-gray-300">
          {stale && (
            <span className="text-amber-800 dark:text-amber-300" title={currency.title}>
              {currency.label}
            </span>
          )}
          {why != null && (
            <>
              <span aria-hidden className="decorative-mark text-gray-400 dark:text-gray-500">
                {' · '}
              </span>
              <span title={why.title}>{why.label}</span>
            </>
          )}
          {stale && state?.checkedAt != null && (
            <span aria-hidden className="decorative-mark text-gray-400 dark:text-gray-500">
              {' · '}
            </span>
          )}
          {state?.checkedAt != null && <ReviewedAgo at={state.checkedAt} className="text-xs" />}
        </span>
      )}
      {ready && !running && (
        <button
          type="button"
          disabled={starting}
          onClick={() => start.mutate({ prId, ident })}
          title="Check this ticket against all its PRs"
          className="whitespace-nowrap rounded border border-ai-border bg-white/70 px-2 py-0.5 text-xs font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:opacity-60 dark:bg-gray-900/50"
        >
          {starting ? 'Starting…' : cov == null ? 'Check story' : 'Re-check'}
        </button>
      )}
      {refused != null && <span className="text-xs text-red-700 dark:text-red-400">{refusalSentence(refused)}</span>}
      {start.isError && <span className="text-xs text-red-700 dark:text-red-400">Could not start the check.</span>}
    </div>
  );
}

function TicketStack({
  stack,
  review,
  storyState,
  merged,
  onOpenMerged,
  showRollup = true,
  single = false,
  children,
}: {
  stack: OpenPrsStack;
  /** The ticket review's state for the Story section (undefined = none / no AI here). */
  storyState: TicketReviewState | undefined;
  /** The story view's ONE stack: plain key and title, and the Story section (always open). */
  single?: boolean;
  /** false on Reports → "Merged so far": failing CI / ready to merge say nothing about landed work. */
  showRollup?: boolean;
  /** Every merged PR linked to this ticket (the "Merged (n)" panel); [] = no panel. */
  merged: readonly TicketMergedPr[];
  onOpenMerged: (pr: TicketMergedPr) => void;
  // The ticket review's reading + who starts it (any PR on the ticket); null = not offered here.
  // `canCheck: false` = show what is stored, never offer Check (no AI here).
  review: { ident: string; state: TicketReviewState | undefined; prId: number; canCheck?: boolean } | null;
  children: ReactNode;
}): JSX.Element {
  const headingId = useId();
  const t = stack.ticket;
  const cat = t?.statusCategory ?? null;
  const href = t != null ? safeExternalUrl(t.url) : null;
  const rollup = showRollup ? stackRollupParts(stackRollup(stack.rows)) : [];
  // Any PR on the ticket reads its stored row; only a Jira ticket (it has an ident) has one.
  const storyPrId = t?.ident != null ? (stack.rows[0]?.pr.id ?? merged[0]?.prId ?? null) : null;
  const knownPrs = useMemo(
    () => [
      ...stack.rows.map((r) => ({ prId: r.pr.id, repoId: r.pr.repoId, repoFullName: null, number: r.pr.number })),
      ...merged.map((m) => ({ prId: m.prId, repoId: m.repoId, repoFullName: m.repoFullName, number: m.number })),
    ],
    [stack.rows, merged],
  );

  return (
    <section
      id={stackDomId(stack.id)}
      aria-labelledby={headingId}
      tabIndex={-1}
      className={`scroll-mt-4 rounded-xl focus:outline-none border bg-gray-50 dark:bg-gray-900/70 ${
        t == null ? 'border-dashed border-gray-300 dark:border-gray-700' : 'border-gray-200 dark:border-gray-800'
      }`}
    >
      {single && t != null ? (
        <StoryViewHeader headingId={headingId} t={t} cat={cat} rollup={rollup} prCount={stack.rows.length} review={review} prs={knownPrs} />
      ) : (
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5 px-3 py-3">
        <div className="min-w-0 flex-1 basis-[16rem]">
          <h3 id={headingId} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {t == null ? (
              <span className="text-base font-semibold text-gray-700 dark:text-gray-200">No ticket</span>
            ) : !single && t.ident != null ? (
              // On the board the key AND title are ONE button: it opens the ticket's story view.
              <TicketKeyButton
                ticket={{ ...t, ident: t.ident }}
                className="group inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
              >
                <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[13px] font-semibold text-sky-700 group-hover:underline dark:text-sky-300">
                  <TicketIcon size={13} className="shrink-0" />
                  {t.key}
                  <span className="sr-only">:</span>
                </span>
                {t.title != null && (
                  <span className="min-w-0 text-base font-semibold leading-snug text-gray-900 group-hover:underline dark:text-gray-50">
                    {t.title}
                  </span>
                )}
              </TicketKeyButton>
            ) : (
              <>
                {/* In the standalone story view the key is plain text (this IS its story); on the board
                    a ticket with no ident links its key to the tracker. */}
                {!single && href != null ? (
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
            {t != null && <TicketPeopleAndStatus t={t} cat={cat} single={false} />}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 sm:mt-0.5">
          {/* The story view's key is plain text (this IS its story), so the way to the ticket itself
              is this link out; on the board the key links there already. */}
          {single && t != null && <TrackerLinkOut url={t.url} provider={t.provider} />}
          {review != null && review.canCheck !== false && (
            <StackCoverage ident={review.ident} state={review.state} prId={review.prId} />
          )}
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
          {(!single || stack.rows.length > 0) && (
            <span className="whitespace-nowrap rounded-full bg-white px-2 py-px text-[11px] font-medium text-gray-600 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700">
              {prCountLabel(stack.rows.length)}
            </span>
          )}
        </div>
      </div>
      )}
      {/* The Story section is the story view's alone: on the board it would start every story read
          per stack on mount. */}
      {single && t?.ident != null && (
        <TicketStorySection
          key={t.ident}
          ticket={{ ...t, ident: t.ident }}
          state={storyState}
          storyPrId={storyPrId}
          prCount={stack.rows.length + merged.length}
        />
      )}
      <ul
        aria-label={t != null ? `Pull requests for ${t.key}` : 'Pull requests with no ticket'}
        className="space-y-2 px-3 pb-3"
      >
        {children}
      </ul>
      {merged.length > 0 && <MergedPanel stackId={stack.id} prs={merged} onOpen={onOpenMerged} />}
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
  const aiName = useAiProviderName();
  const work = reviewWorkInProgress({ review: state, starting, ciRunning, ticketRunning });
  if (work.length === 0) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-ai-signal/10 px-1.5 py-px text-[11px] font-medium text-ai-signal"
      title={`${aiName} is working on this PR`}
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

/**
 * "Run auto reviews now" — ONE auto-review sweep of this workspace now (POST …/auto-review/sweep):
 * every open PR auto review covers that is due, failed auto runs at the current head (whatever the
 * retry wait), and new commits or comments not yet reviewed. Queued as auto runs on the default
 * provider, under the daily cap. Shown only while auto review is on here and AI runs here; behind
 * the AI gate (an over-budget press takes two presses). One plain line answers the press.
 */
export function RunAutoReviewsButton(): JSX.Element | null {
  const aiOn = useAiCapabilities().enabled;
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data } = useWorkspaceAutoReview(aiOn, workspaceId);
  const sweep = useRunAutoReviewSweep(workspaceId);
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    if (line == null) return;
    const t = window.setTimeout(() => setLine(null), 15_000);
    return () => window.clearTimeout(t);
  }, [line]);
  // A workspace switch forgets the last answer.
  useEffect(() => setLine(null), [workspaceId]);
  if (!aiOn || workspaceId == null || data?.workspaceId !== workspaceId || !data.autoReview.enabled) return null;
  const run = (): void => {
    setLine(null);
    sweep.mutate(
      {},
      {
        onSuccess: (res) => setLine(autoSweepResultLine(res)),
        onError: (err) => setLine((err as Error)?.message ?? 'Could not run auto reviews.'),
      },
    );
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <AiRunGate kind="review" meter={false}>
        <button
          type="button"
          onClick={run}
          disabled={sweep.isPending}
          title="Review every PR that is due now: new PRs, new commits or comments, and failed auto reviews. The daily limit still applies."
          className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          {sweep.isPending ? 'Checking…' : 'Run auto reviews now'}
        </button>
      </AiRunGate>
      {line != null && (
        <span role="status" className="text-[11px] text-gray-600 dark:text-gray-300">
          {line}
        </span>
      )}
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
  onJumpToStack = jumpToStack,
  headingLevel,
  variant = 'open',
  working,
  claude,
}: {
  pr: TimelinePr;
  /** 'merged': a "Merged" chip in place of CI + merge readiness, and "merged X ago" in the meta. */
  variant?: 'open' | 'merged';
  author: User | undefined;
  repoName: string;
  onOpen: () => void;
  /** The ticket row (List view). [] inside a stack — its header names the ticket. */
  tickets: CardTicket[];
  /** Inside a stack: the PR's OTHER tickets, each a stack of its own. */
  alsoIn: CardTicket[];
  /** "Also in" → that ticket's stack (the list grows to draw it first). */
  onJumpToStack?: (stackId: string) => void;
  headingLevel: 3 | 4;
  /** The header's "Claude is working on this" chip (ClaudeWorkChip); null where AI is off. */
  working?: ReactNode;
  claude: ReactNode;
}): JSX.Element {
  const titleId = useId();
  const prUrl = githubPrUrl(repoName, pr.number);
  return (
    <PrCardFrame labelledBy={titleId} onOpen={onOpen} nested={headingLevel === 4}>
      {/* 1 — the title. */}
      <PrCardTitle
        id={titleId}
        level={headingLevel}
        end={
          working != null || prUrl != null ? (
            <>
              {working}
              {prUrl != null && (
                <CopyButton text={prUrl} what="PR link" title="Copy the GitHub link to this PR" icon={<LinkIcon />} />
              )}
            </>
          ) : null
        }
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
        {variant === 'merged' ? (
          <span className={NEUTRAL_CHIP}>
            <MergeIcon size={11} />
            Merged
          </span>
        ) : (
          <CiChip ci={pr.ciStatus} />
        )}
        <ReviewChip pr={pr} />
        <ThreadsChip pr={pr} />
        {variant !== 'merged' && <MergeChip pr={pr} />}
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
                ticket={{ ...t, ident: t.ident }}
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
                onJumpToStack(stackIdFor(t.key));
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
          variant === 'merged' && pr.mergedAt != null ? (
            <span title={`Merged ${dateTime(pr.mergedAt)}`}>merged {relativeTime(pr.mergedAt)}</span>
          ) : (
            pr.updatedAt !== pr.openedAt && (
              <span title={`Updated ${dateTime(pr.updatedAt)}`}>updated {relativeTime(pr.updatedAt)}</span>
            )
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

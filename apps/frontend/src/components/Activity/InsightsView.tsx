import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AutomatedReviewerKind,
  BotOnlyReviewCard,
  CiStatus,
  InsightCard,
  InsightPrRef,
  InsightSeverity,
  ReviewerRoutingCard,
  StalledReviewCard,
  UntouchedThreadCard,
  User,
} from '@pierre-review/shared';
import { useTeamInsights } from '../../hooks/useTeamInsights.js';
import { usePr, useThread } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useRequestReviewers } from '../../hooks/usePrWrites.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { automatedReviewerMeta, CI_META, indexUsers } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { Markdown } from '../Markdown.js';
import { AiSummary } from '../AiSummary.js';
import { ThreadCard } from '../ThreadView/index.js';
import { BotRoiPanel } from './BotRoiPanel.js';
import { RetroView } from './RetroView.js';
import { SprintReportCard } from './SprintReportCard.js';
import { PresetPromptPanel } from './PresetPromptPanel.js';
import { TeamMetricsPanel } from './TeamMetricsPanel.js';
import { TeamComparisonPanel } from './TeamComparisonPanel.js';
import { TrackUsage } from './TrackUsage.js';

// Left-accent + label per severity — the same visual grammar as the Feed's cards.
const SEV: Record<InsightSeverity, { border: string; dot: string }> = {
  high: { border: 'border-l-red-400 dark:border-l-red-500', dot: 'bg-red-500' },
  warn: { border: 'border-l-amber-400 dark:border-l-amber-500', dot: 'bg-amber-500' },
  info: { border: 'border-l-sky-400 dark:border-l-sky-500', dot: 'bg-sky-500' },
};

const KIND_LABEL: Record<InsightCard['kind'], string> = {
  bot_signal: 'Review-bot signal',
  bot_only_review: 'Only a bot reviewed',
  stalled_review: 'Stalled review',
  untouched_thread: 'Untouched thread',
  reviewer_load: 'Review load',
  reviewer_routing: 'Needs a reviewer',
};

// The insight-card kinds that belong to the Bots sub-tab (everything else is Overview).
const BOT_CARD_KINDS = new Set<InsightCard['kind']>(['bot_signal', 'bot_only_review']);

type InsightsSubTab = 'overview' | 'bots' | 'sprint' | 'retro' | 'compare';
const SUB_TABS: { key: InsightsSubTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'bots', label: 'Bots' },
  { key: 'sprint', label: 'Sprint' },
  { key: 'retro', label: 'Retro' },
];
// The cross-team "Compare" sub-tab is only meaningful (and only shown) in All-Teams scope.
const COMPARE_TAB: { key: InsightsSubTab; label: string } = { key: 'compare', label: 'Compare teams' };

function ageLabel(hours: number): string {
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function metaFor(
  card: { prId: number; prNumber: number; prTitle: string; repoFullName: string; authorId?: number | null },
  usersById: Map<number, User>,
): PinnedPr {
  const author = card.authorId != null ? usersById.get(card.authorId) : undefined;
  return {
    id: card.prId,
    number: card.prNumber,
    title: card.prTitle,
    repoFullName: card.repoFullName,
    authorLogin: author?.githubLogin ?? null,
    authorDisplayName: author?.displayName ?? null,
    authorAvatarUrl: author?.avatarUrl ?? null,
  };
}

function UserChip({
  id,
  usersById,
}: {
  id: number;
  usersById: Map<number, User>;
}): JSX.Element {
  const u = usersById.get(id);
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px]">
      <Avatar user={u} size={13} />
      <UserName user={u} fallbackId={id} />
    </span>
  );
}

// A small vendor pill for an automated reviewer — the same 🤖 chip grammar the bot-signal
// card + provenance badges use (color from automatedReviewerMeta). Rendered on an untouched
// thread whose original commenter is a classified review bot.
function BotVendorPill({ kind }: { kind: AutomatedReviewerKind }): JSX.Element {
  const meta = automatedReviewerMeta(kind);
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium"
      style={{ color: meta.color, background: `${meta.color}1a` }}
      title="This thread was opened by an automated reviewer"
    >
      🤖 {meta.label}
    </span>
  );
}

// At-a-glance CI dot + files-changed count + a green/red LOC delta — mirrors the
// PR-detail size label (ChangesTab / PrDetail), so the card carries the same signal
// the open-PR list does without a second fetch.
function PrMetaRow({ pr }: { pr: InsightPrRef }): JSX.Element {
  const ci = pr.ciStatus ? CI_META[pr.ciStatus] : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
      <span className="inline-flex items-center gap-1" title={ci?.label ?? 'no checks'}>
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={ci ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
          aria-hidden
        />
        {ci?.label ?? 'no checks'}
      </span>
      <span>
        {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
      </span>
      <span className="font-mono">
        <span className="text-green-600 dark:text-green-400">+{pr.additions}</span>{' '}
        <span className="text-red-500 dark:text-red-400">−{pr.deletions}</span>
      </span>
    </div>
  );
}

// Collapsible PR summary: the plain description (markdown) + the Pro AI summary with
// its own inline Generate/Regenerate action (AiSummary self-gates on the prSummary
// capability + shares the ['ai-fix-summary', prId] cache with the Overview/AI tabs).
// Lazy: the PR detail is fetched only when expanded.
function InsightPrSummary({ prId }: { prId: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        {open ? '▾' : '▸'} PR summary
      </button>
      {open && <InsightPrSummaryBody prId={prId} />}
    </div>
  );
}

function InsightPrSummaryBody({ prId }: { prId: number }): JSX.Element {
  const { data: pr, isLoading } = usePr(prId);
  if (isLoading)
    return <div className="mt-1 text-[11px] text-gray-400">Loading…</div>;
  if (!pr)
    return <div className="mt-1 text-[11px] text-gray-400">Couldn’t load this PR.</div>;
  const hasBody = pr.body != null && pr.body.trim() !== '';
  return (
    <div className="mt-1 space-y-2 rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-900/40">
      {hasBody ? (
        <div className="max-h-64 overflow-auto text-sm">
          <Markdown>{pr.body as string}</Markdown>
        </div>
      ) : (
        <div className="text-[11px] italic text-gray-400">No PR description.</div>
      )}
      <AiSummary pr={pr} />
    </div>
  );
}

// The untouched review thread rendered in full, exactly as the Feed does it — code
// anchor, every reply, and the inline Reply + Resolve controls (ThreadCard). Fetched
// on demand by thread id; comment authors resolve from the global roster.
function InsightThread({ card }: { card: UntouchedThreadCard }): JSX.Element {
  const { data: thread, isLoading } = useThread(card.threadId);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const prUrl = `https://github.com/${card.repoFullName}/pull/${card.prNumber}`;
  if (isLoading)
    return <div className="px-1 py-2 text-xs text-gray-400">Loading conversation…</div>;
  if (!thread)
    return (
      <div className="px-1 py-2 text-xs text-gray-400">Couldn’t load this conversation.</div>
    );
  return (
    <ThreadCard thread={thread} usersById={usersById} prUrl={prUrl} repoId={card.repoId} />
  );
}

// Suggested reviewers + their rationale + a single "Assign" button that requests them
// on the PR (server-gated on write access; drops the author + bots). Once requested,
// ['team-insights'] is invalidated → the card leaves the board on the next refresh.
function RoutingReviewers({
  card,
  usersById,
}: {
  card: ReviewerRoutingCard;
  usersById: Map<number, User>;
}): JSX.Element {
  const request = useRequestReviewers(card.prId);
  const ids = card.suggestedReviewers.map((s) => s.userId);
  const done = request.isSuccess;
  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-gray-500">
        <span className="font-medium">Suggested reviewers</span>
        <button
          type="button"
          onClick={() => request.mutate({ userIds: ids })}
          disabled={request.isPending || done || ids.length === 0}
          className="rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/20"
          title="Request these reviewers on GitHub"
        >
          {done
            ? '✓ Requested'
            : request.isPending
              ? 'Assigning…'
              : `Assign${ids.length > 1 ? ' all' : ''}`}
        </button>
      </div>
      <ul className="space-y-1">
        {card.suggestedReviewers.map((s) => (
          <li key={s.userId} className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
            <UserChip id={s.userId} usersById={usersById} />
            <span className="text-gray-400">{s.reason}</span>
          </li>
        ))}
      </ul>
      {request.isError && (
        <div className="text-[11px] text-red-500">
          {(request.error as Error)?.message ?? 'Couldn’t request reviewers.'}
        </div>
      )}
    </div>
  );
}

function CardShell({
  card,
  right,
  onActivate,
  children,
  innerRef,
  flash = false,
}: {
  card: InsightCard;
  right?: React.ReactNode;
  onActivate?: () => void;
  children: React.ReactNode;
  // Registers this card's <li> by card.id so the back-from-a-click flash can scroll to it
  // (parity with the Feed's rows).
  innerRef?: (el: HTMLLIElement | null) => void;
  flash?: boolean;
}): JSX.Element {
  const sev = SEV[card.severity];
  // The whole card is clickable to open "the event in question" (like a Feed card).
  // Inner links/buttons/inputs + the inline thread (data-noactivate) win the click.
  const onClick = onActivate
    ? (e: React.MouseEvent): void => {
        if ((e.target as HTMLElement).closest('a,button,textarea,input,[data-noactivate]')) return;
        onActivate();
      }
    : undefined;
  return (
    <li
      ref={innerRef}
      onClick={onClick}
      className={`rounded-lg border border-l-4 border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900/40 ${sev.border}${
        flash ? ' ring-2 ring-sky-400/70' : ''
      }${onActivate ? ' cursor-pointer hover:bg-gray-50/70 dark:hover:bg-gray-900/60' : ''}`}
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${sev.dot}`} aria-hidden />
        <span className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {KIND_LABEL[card.kind]}
        </span>
        <span className="ml-auto text-gray-400">{right}</span>
      </div>
      {children}
    </li>
  );
}

function PrLine({
  card,
  onOpen,
}: {
  card: StalledReviewCard | UntouchedThreadCard | ReviewerRoutingCard;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 truncate text-left font-medium text-gray-800 hover:underline dark:text-gray-100"
        title="Open this PR on its Overview tab"
      >
        <span className="text-gray-400">
          {card.repoFullName} #{card.prNumber}
        </span>{' '}
        {card.prTitle}
      </button>
      <a
        href={card.githubUrl}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        title="Open on GitHub"
      >
        ↗
      </a>
    </div>
  );
}

// "Only a bot reviewed this" governance risk (WS7): an aggregate list of PRs merged (or
// open-and-mergeable) whose ONLY review came from an automated reviewer — no human ever
// looked. A rubber-stamping-fatigue caution; each PR opens its detail tab. Deterministic.
function BotOnlyReviewCardView({
  card,
  innerRef,
  flash,
  onOpen,
}: {
  card: BotOnlyReviewCard;
  innerRef: (el: HTMLLIElement | null) => void;
  flash: boolean;
  onOpen: (meta: PinnedPr, returnItemId?: string) => void;
}): JSX.Element {
  return (
    <CardShell
      card={card}
      innerRef={innerRef}
      flash={flash}
      right={`${card.prs.length} PR${card.prs.length === 1 ? '' : 's'}`}
    >
      <div className="text-sm text-gray-800 dark:text-gray-100">
        🤖 Only a bot reviewed{' '}
        <span className="font-semibold tabular-nums">{card.prs.length}</span> PR
        {card.prs.length === 1 ? '' : 's'} — no human review
      </div>
      <ul className="mt-1.5 space-y-1">
        {card.prs.map((p) => (
          <li key={p.prId} className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
            <button
              type="button"
              onClick={() =>
                onOpen(
                  {
                    id: p.prId,
                    number: p.number,
                    title: p.title,
                    repoFullName: p.repoFullName,
                    authorLogin: null,
                    authorDisplayName: null,
                    authorAvatarUrl: null,
                  },
                  card.id,
                )
              }
              className="min-w-0 truncate text-left text-gray-600 hover:underline dark:text-gray-300"
              title="Open this PR on its Overview tab"
            >
              <span className="text-gray-400">
                {p.repoFullName} #{p.number}
              </span>{' '}
              {p.title}
            </button>
            <span className="shrink-0 rounded bg-gray-500/10 px-1 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
              {p.state}
            </span>
            <span
              className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
              style={{ background: '#f59e0b1a' }}
              title="The only review on this PR"
            >
              {p.botLabel}
            </span>
            <a
              href={p.githubUrl}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              title="Open on GitHub"
            >
              ↗
            </a>
          </li>
        ))}
      </ul>
      <div className="mt-2 text-[11px] text-gray-400">
        A trust/safety hook — deterministic (no AI). Consider a human pass before these ship.
      </div>
    </CardShell>
  );
}

export function InsightsView({
  initialSubTab,
}: {
  initialSubTab?: InsightsSubTab;
} = {}): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const selectThread = useFilters((s) => s.selectThread);
  const openMetricsDetail = useFilters((s) => s.openMetricsDetail);
  const openBotPrsDetail = useFilters((s) => s.openBotPrsDetail);
  // The team-scope selector narrows the WHOLE panel: this one fetch feeds both the Overview
  // TeamMetricsPanel metrics AND every insight card (incl. the bot cards), so scoping it
  // scopes Overview + the Bots-tab cards. scope is in the query key → a scope change refetches.
  const teamScope = useFilters((s) => s.teamScope);
  const scope = scopeToParam(teamScope);
  const { data, isLoading, isError } = useTeamInsights(true, scope);
  const usersById = useMemo(() => indexUsers(data?.users), [data?.users]);

  // Internal sub-tab bar (Overview | Bots | Retro). The header (Insights + Pro + sprint
  // caption + Track usage) sits ABOVE it and is shared across sub-tabs. A deep-linked
  // initialSubTab (e.g. the legacy 'retro' rail value → the Retro sub-tab) is honoured,
  // including a later change to it.
  const [subTab, setSubTab] = useState<InsightsSubTab>(initialSubTab ?? 'overview');
  useEffect(() => {
    if (initialSubTab) setSubTab(initialSubTab);
  }, [initialSubTab]);

  // The Compare tab exists only in All-Teams scope. Show it there; if the scope leaves 'teams'
  // while it's active, fall back to Overview so the tab strip never strands on a hidden tab.
  const isAllTeams = teamScope === 'teams';
  const subTabs = useMemo(
    () => (isAllTeams ? [...SUB_TABS, COMPARE_TAB] : SUB_TABS),
    [isAllTeams],
  );
  useEffect(() => {
    if (subTab === 'compare' && !isAllTeams) setSubTab('overview');
  }, [subTab, isAllTeams]);

  // Back-from-a-click flash — EXACT parity with the Feed (FeedView): a real browser Back
  // (navigateBack) sets a one-shot activityFlashItemId (the returnItemId we stamped when
  // opening the PR = the card's id); on return we scroll that card into view and flash it,
  // so returning from a PR tab lands you back on the card you clicked instead of scroll-top.
  const flashTarget = usePinnedTabs((s) => s.activityFlashItemId);
  const clearFlash = usePinnedTabs((s) => s.clearActivityFlashItem);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (flashTarget == null) return;
    const id = flashTarget;
    const raf = requestAnimationFrame(() => {
      const el = rowRefs.current.get(id);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setFlashId(id);
        window.setTimeout(() => setFlashId((c) => (c === id ? null : c)), 1800);
      }
      clearFlash();
    });
    return () => cancelAnimationFrame(raf);
  }, [flashTarget, clearFlash]);
  const setCardRef = (id: string, el: HTMLLIElement | null): void => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  };

  // ---- AI summaries: each card owns its OWN delta-gated regenerate (no unified Refresh) ----
  const { teamInsights } = useProCapabilities();
  const [showUsage, setShowUsage] = useState(false);

  // Match the Feed's interaction model: the PR title opens the PR detail on its Overview
  // tab; the card body opens "the event in question". For a thread that event is the thread
  // itself — the PR detail opens on its Threads tab, deep-linked to the thread in context.
  const open = (meta: PinnedPr, returnItemId?: string): void =>
    openPrDetailTab(meta, { fromActivity: true, returnItemId });
  const openThread = (card: UntouchedThreadCard): void => {
    openPrDetailTab(metaFor(card, usersById), { fromActivity: true, returnItemId: card.id });
    selectThread(card.prId, card.threadId);
  };

  const cards = data?.cards ?? [];
  // Partition by kind: the Bots sub-tab owns bot_signal + bot_only_review; Overview owns
  // the rest (stalled_review / untouched_thread / reviewer_load / reviewer_routing).
  const nonBotCards = cards.filter((c) => !BOT_CARD_KINDS.has(c.kind));
  const botCards = cards.filter((c) => BOT_CARD_KINDS.has(c.kind));

  // The shared card-rendering switch — the same JSX for a card wherever it appears. A card
  // that isn't in the active sub-tab simply isn't in the DOM (and its ref is dropped), which
  // the flash effect already tolerates (it guards on the ref existing).
  const renderCard = (card: InsightCard): JSX.Element | null => {
    switch (card.kind) {
      case 'stalled_review':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            right={`waiting ${ageLabel(card.ageHours)}`}
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
              <span>waiting on</span>
              {card.requestedReviewerIds.length > 0 ? (
                card.requestedReviewerIds.map((id) => (
                  <UserChip key={id} id={id} usersById={usersById} />
                ))
              ) : (
                <span className="italic">no reviewer requested</span>
              )}
            </div>
            <InsightPrSummary prId={card.prId} />
          </CardShell>
        );
      case 'untouched_thread':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            right={`${ageLabel(card.ageHours)} old`}
          >
            {/* Only this header chrome navigates (→ the thread on the PR's Threads tab).
                The embedded conversation + PR summary below are for reading/replying
                in place, NOT a click target — so the thread never feels clickable. */}
            <div
              className="-m-1 cursor-pointer rounded p-1 hover:bg-gray-50/70 dark:hover:bg-gray-900/60"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a,button')) return;
                openThread(card);
              }}
            >
              <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
              <PrMetaRow pr={card} />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
                <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-mono">
                  {card.path}
                </span>
                <span>· no reply since</span>
                {card.originalCommenterId != null && (
                  <UserChip id={card.originalCommenterId} usersById={usersById} />
                )}
                {card.botKind != null && <BotVendorPill kind={card.botKind} />}
              </div>
            </div>
            <div className="mt-2">
              <InsightThread card={card} />
            </div>
            <InsightPrSummary prId={card.prId} />
          </CardShell>
        );
      case 'reviewer_routing':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            right="unassigned"
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} />
            {card.topPaths.length > 0 && (
              <div className="mt-1 truncate text-[11px] text-gray-400">
                touches{' '}
                <span className="font-mono">{card.topPaths.slice(0, 3).join(', ')}</span>
              </div>
            )}
            <RoutingReviewers card={card} usersById={usersById} />
            <InsightPrSummary prId={card.prId} />
          </CardShell>
        );
      case 'reviewer_load':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            right={`${card.reviewsThisSprint} review${
              card.reviewsThisSprint === 1 ? '' : 's'
            } this sprint`}
          >
            <div className="flex items-center gap-2 text-sm">
              <UserChip id={card.reviewerId} usersById={usersById} />
              <span className="font-semibold text-gray-800 dark:text-gray-100">
                {card.pendingCount} pending review{card.pendingCount === 1 ? '' : 's'}
              </span>
            </div>
            {card.pendingPrs.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {card.pendingPrs.map((p) => (
                  <li key={p.prId} className="truncate text-[11px]">
                    <button
                      type="button"
                      onClick={() =>
                        open(
                          {
                            id: p.prId,
                            number: p.prNumber,
                            title: p.prTitle,
                            repoFullName: p.repoFullName,
                            authorLogin: null,
                            authorDisplayName: null,
                            authorAvatarUrl: null,
                          },
                          card.id,
                        )
                      }
                      className="text-left text-gray-500 hover:underline dark:text-gray-400"
                    >
                      <span className="text-gray-400">
                        {p.repoFullName} #{p.prNumber}
                      </span>{' '}
                      {p.prTitle}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardShell>
        );
      case 'bot_signal':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            right={card.actedOnPct != null ? `${card.actedOnPct}% acted on` : undefined}
          >
            <div className="text-sm text-gray-800 dark:text-gray-100">
              <span className="font-semibold tabular-nums">{card.totalThreads}</span>{' '}
              review-bot thread{card.totalThreads === 1 ? '' : 's'} this sprint ·{' '}
              <span className="tabular-nums">{card.totalUntouched}</span> untouched
              {card.oldestUntouchedDays != null && card.totalUntouched > 0 && (
                <>
                  , oldest{' '}
                  <span className="tabular-nums">{card.oldestUntouchedDays}</span>d
                </>
              )}
            </div>
            <ul className="mt-2 space-y-1">
              {card.vendors.map((v) => {
                // v.kind is AutomatedReviewerKind (vendor / in_house / pierre) — the
                // kind-in-hand lookup handles all three.
                const meta = automatedReviewerMeta(v.kind);
                const pct = v.threads > 0 ? Math.round((v.actedOn / v.threads) * 100) : 0;
                return (
                  <li key={v.kind} className="flex flex-wrap items-center gap-x-2 text-[11px]">
                    {/* Click a vendor → its Bot-PRs tab (the drill-down of every PR this
                        automated reviewer touched in the window). */}
                    <button
                      type="button"
                      onClick={() => openBotPrsDetail(v.kind)}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:underline"
                      style={{ color: meta.color, background: `${meta.color}1a` }}
                      title="View this bot's PRs"
                    >
                      🤖 {meta.label}
                    </button>
                    <span className="tabular-nums text-gray-500">
                      {v.threads} thread{v.threads === 1 ? '' : 's'}
                    </span>
                    <span className="text-gray-400">·</span>
                    <span className="tabular-nums text-gray-500">{pct}% acted on</span>
                    {v.untouched > 0 && (
                      <span className="tabular-nums text-amber-600 dark:text-amber-400">
                        · {v.untouched} untouched
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="mt-2 text-[11px] text-gray-400">
              “Acted on” = a later commit touched the flagged file (approximate).
              Deterministic across every repo + bot — no AI.
            </div>
          </CardShell>
        );
      case 'bot_only_review':
        return (
          <BotOnlyReviewCardView
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            onOpen={open}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-3" data-testid="insights-view">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Insights
        </h2>
        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        {data?.sprint && (
          <span className="text-[11px] text-gray-400">
            {/* Cadence-aware (matches the Flow-metrics caption below); default 14d when the
                metrics window isn't available. */}
            sprint: last {data.metrics?.sprintDays ?? 14}d · {cards.length} item
            {cards.length === 1 ? '' : 's'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowUsage((s) => !s)}
            className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
              showUsage
                ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950/30 dark:text-violet-300'
                : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500'
            }`}
            title="Show your month-to-date AI usage (in credits)"
          >
            {showUsage ? '▾' : '▸'} Track usage
          </button>
        </div>
      </div>

      {showUsage && <TrackUsage />}

      {/* Internal sub-tab bar — Overview / Bots / Retro (styled like the Flow-metrics
          drill-down bar). Retro is the retrospective narrative, now nested here. */}
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
        {subTabs.map(({ key, label }) => {
          const on = key === subTab;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setSubTab(key)}
              className={`-mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                on
                  ? 'border-gray-300 bg-white text-violet-600 dark:border-gray-700 dark:bg-gray-950 dark:text-violet-300'
                  : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {subTab === 'overview' ? (
        <div className="space-y-3">
          {data?.metrics && (
            <TeamMetricsPanel metrics={data.metrics} onOpenMetric={openMetricsDetail} />
          )}

          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-20 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40"
                />
              ))}
            </div>
          ) : isError ? (
            <div className="text-sm text-red-500">Couldn’t load insights.</div>
          ) : nonBotCards.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
              Nothing needs attention across your watched repos right now. 🎉
              <div className="mt-1 text-[11px]">
                Stalled reviews, untouched threads, reviewer load and un-assigned PRs will
                surface here.
              </div>
            </div>
          ) : (
            <ul className="space-y-2">{nonBotCards.map((card) => renderCard(card))}</ul>
          )}
        </div>
      ) : subTab === 'bots' ? (
        <div className="space-y-3">
          {/* Review-bot ROI / utilisation — a Pro drill-down atop the (core) bot cards.
              The analytics route is core+deterministic; the panel is UI-gated on teamInsights.
              It carries its own empty state, so the Bots tab never shows the generic
              "nothing needs attention" block. */}
          {teamInsights && <BotRoiPanel />}
          {isError ? (
            <div className="text-sm text-red-500">Couldn’t load insights.</div>
          ) : botCards.length > 0 ? (
            <ul className="space-y-2">{botCards.map((card) => renderCard(card))}</ul>
          ) : null}
        </div>
      ) : subTab === 'sprint' ? (
        // The AI sprint digest (state of play), full width, followed by the one-click
        // preset-prompt answer surface. Both are per-team (teamScope) + gated on activityDigest.
        <div className="space-y-3">
          <SprintReportCard />
          <PresetPromptPanel />
        </div>
      ) : subTab === 'compare' ? (
        // Cross-team comparison — only reachable in All-Teams scope (the tab is hidden otherwise).
        <TeamComparisonPanel />
      ) : (
        <RetroView />
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import type {
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
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useRequestReviewers } from '../../hooks/usePrWrites.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import {
  useRepoDigests,
  useRefreshRepoDigests,
  digestProgressProps,
} from '../../hooks/useRepoDigest.js';
import { useSprintReport, useRefreshSprintReport } from '../../hooks/useSprintReport.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { useFilters } from '../../store/filters.js';
import { CI_META, indexUsers } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { Markdown } from '../Markdown.js';
import { AiSummary } from '../AiSummary.js';
import { ThreadCard } from '../ThreadView/index.js';
import { SprintReportCard } from './SprintReportCard.js';
import { TeamMetricsPanel } from './TeamMetricsPanel.js';
import { TrackUsage } from './TrackUsage.js';
import { RegenProgressBar } from './RegenProgressBar.js';

// Left-accent + label per severity — the same visual grammar as the Feed's cards.
const SEV: Record<InsightSeverity, { border: string; dot: string }> = {
  high: { border: 'border-l-red-400 dark:border-l-red-500', dot: 'bg-red-500' },
  warn: { border: 'border-l-amber-400 dark:border-l-amber-500', dot: 'bg-amber-500' },
  info: { border: 'border-l-sky-400 dark:border-l-sky-500', dot: 'bg-sky-500' },
};

const KIND_LABEL: Record<InsightCard['kind'], string> = {
  stalled_review: 'Stalled review',
  untouched_thread: 'Untouched thread',
  reviewer_load: 'Review load',
  reviewer_routing: 'Needs a reviewer',
};

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
// its own inline Generate/Regenerate action (AiSummary self-gates on the aiAnalysis
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
          onClick={() => request.mutate(ids)}
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
}: {
  card: InsightCard;
  right?: React.ReactNode;
  onActivate?: () => void;
  children: React.ReactNode;
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
      onClick={onClick}
      className={`rounded-lg border border-l-4 border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900/40 ${sev.border}${
        onActivate ? ' cursor-pointer hover:bg-gray-50/70 dark:hover:bg-gray-900/60' : ''
      }`}
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

export function InsightsView(): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const showThreadInChanges = useFilters((s) => s.showThreadInChanges);
  const openMetricsDetail = useFilters((s) => s.openMetricsDetail);
  const { data, isLoading, isError, refetch, isFetching } = useTeamInsights(true);
  const usersById = useMemo(() => indexUsers(data?.users), [data?.users]);

  // ---- Unified summaries (Req: one Refresh drives Insights + sprint report + digests) ----
  const { activityDigest } = useProCapabilities();
  const { data: repos } = useRepos();
  const storeRepoIds = useFilters((s) => s.repoIds);
  // The digest set = watched repos ∩ the FilterBar-visible selection (null = all visible).
  const watchedVisibleIds = useMemo(
    () =>
      (repos ?? [])
        .filter((r) => r.inboxWatch && (storeRepoIds == null || storeRepoIds.includes(r.id)))
        .map((r) => r.id),
    [repos, storeRepoIds],
  );
  const digestsQuery = useRepoDigests(
    watchedVisibleIds,
    activityDigest && watchedVisibleIds.length > 0,
  );
  const refreshDigests = useRefreshRepoDigests();
  const refreshSprint = useRefreshSprintReport();
  const sprintQuery = useSprintReport(activityDigest);
  const [showUsage, setShowUsage] = useState(false);

  // The diff check is unchanged (the payload-hash cache still prevents re-summarising
  // unchanged content); we just surface staleness so the user knows a Refresh is worth it.
  const anyDigestStale = (digestsQuery.data?.digests ?? []).some((d) => d.stale);
  const contentMoved = anyDigestStale || (sprintQuery.data?.report?.stale ?? false);
  const refreshingAll = isFetching || refreshDigests.isPending || refreshSprint.isPending;
  // ONE control regenerates everything (unchanged content stays free via the payload-hash).
  const refreshAll = (): void => {
    void refetch();
    if (activityDigest) {
      refreshSprint.mutate();
      if (watchedVisibleIds.length > 0) refreshDigests.mutate(watchedVisibleIds);
    }
  };

  // Match the Feed's interaction model: the PR title opens the PR detail on its Overview
  // tab; the card body opens "the event in question". For a thread that event is the
  // thread itself — deep-linked into the Changes tab, where it renders inline in context.
  const open = (meta: PinnedPr, returnItemId?: string): void =>
    openPrDetailTab(meta, { fromActivity: true, returnItemId });
  const openThreadInChanges = (card: UntouchedThreadCard): void => {
    openPrDetailTab(metaFor(card, usersById), { fromActivity: true, returnItemId: card.id });
    showThreadInChanges(card.prId, card.threadId);
  };

  const cards = data?.cards ?? [];

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
            sprint: last 2 weeks · {cards.length} item{cards.length === 1 ? '' : 's'}
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
          {/* ONE Refresh for ALL summaries — Insights cards + sprint report + repo digests.
              The diff check still skips unchanged content, so a re-run is cheap. */}
          <button
            type="button"
            onClick={refreshAll}
            disabled={refreshingAll}
            className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
            title="Refresh every summary — Insights, sprint report and repo summaries (unchanged content is free)"
          >
            <span aria-hidden className={refreshingAll ? 'animate-spin' : ''}>
              ↻
            </span>{' '}
            Refresh
          </button>
        </div>
      </div>

      {/* Content-moved notice: when a summary is stale (underlying data changed since it
          was written), prompt the user to Refresh — the summaries won't auto-regenerate. */}
      {contentMoved && (
        <button
          type="button"
          onClick={refreshAll}
          disabled={refreshingAll}
          className="flex w-full items-center gap-2 rounded-lg border border-amber-300 bg-amber-50/60 px-3 py-1.5 text-left text-[12px] text-amber-800 hover:bg-amber-100/60 disabled:opacity-60 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <span aria-hidden>⟳</span>
          Repo content has moved on since these summaries were written — Refresh to update them.
        </button>
      )}

      {showUsage && <TrackUsage />}

      {data?.metrics && (
        <TeamMetricsPanel metrics={data.metrics} onOpenMetric={openMetricsDetail} />
      )}

      {/* Repo digests are nested INSIDE the sprint report card (collapsed by default) to
          keep the Insights tab compact — pass the digest data down. */}
      <SprintReportCard
        showRefresh={false}
        digests={digestsQuery.data?.digests ?? []}
        digestsLoading={digestsQuery.isLoading}
        anyWatched={watchedVisibleIds.length > 0}
        refreshingRepoIds={refreshDigests.refreshingRepoIds}
        regenerating={refreshSprint.isPending}
      />
      <RegenProgressBar
        active={refreshDigests.isPending && (refreshDigests.progress?.total ?? 0) > 0}
        label="Regenerating summaries"
        {...digestProgressProps(refreshDigests.progress)}
      />

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
      ) : cards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Nothing needs attention across your watched repos right now. 🎉
          <div className="mt-1 text-[11px]">
            Stalled reviews, untouched threads, reviewer load and un-assigned PRs will
            surface here.
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {cards.map((card) => {
            switch (card.kind) {
              case 'stalled_review':
                return (
                  <CardShell
                    key={card.id}
                    card={card}
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
                  <CardShell key={card.id} card={card} right={`${ageLabel(card.ageHours)} old`}>
                    {/* Only this header chrome navigates (→ the thread in the Changes tab).
                        The embedded conversation + PR summary below are for reading/replying
                        in place, NOT a click target — so the thread never feels clickable. */}
                    <div
                      className="-m-1 cursor-pointer rounded p-1 hover:bg-gray-50/70 dark:hover:bg-gray-900/60"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('a,button')) return;
                        openThreadInChanges(card);
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
              default:
                return null;
            }
          })}
        </ul>
      )}
    </div>
  );
}

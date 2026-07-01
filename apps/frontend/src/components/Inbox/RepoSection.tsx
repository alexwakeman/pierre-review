import { useMemo, useState } from 'react';
import type {
  ClaudeReviewSummary,
  ClaudeReviewVerdict,
  InboxRepo,
  InboxRepoStats,
  TimelinePr,
  User,
} from '@pierre-review/shared';
import { useUsers } from '../../hooks/useTimeline.js';
import { useRepoClaudeReviews } from '../../hooks/useRepoClaudeReviews.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import {
  CI_META,
  DERIVED_STATE_META,
  indexUsers,
  PR_STATE_META,
  REASON_META,
  relativeTime,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { MaintainerShield } from '../MaintainerShield.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { DigestBanner } from './DigestBanner.js';

const VERDICT_COLOR: Record<ClaudeReviewVerdict, string> = {
  APPROVE: '#22c55e',
  REQUEST_CHANGES: '#ef4444',
  COMMENT: '#9ca3af',
};

const VERDICT_LABEL: Record<ClaudeReviewVerdict, string> = {
  APPROVE: 'APPROVE',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
  COMMENT: 'COMMENT',
};

// Muted zebra hues by repo rank parity (mirrors the timeline's tl-repo-tint-N idea:
// blue / violet), applied as a faint left accent + card wash so adjacent repo cards
// in the all-repos feed read apart.
const TINTS = [
  { border: '#3b82f6', wash: 'rgb(59 130 246 / 0.05)' }, // blue
  { border: '#8957e5', wash: 'rgb(137 87 229 / 0.05)' }, // violet
] as const;

function groupByAuthor(
  prs: TimelinePr[],
): { authorId: number | null; prs: TimelinePr[] }[] {
  const map = new Map<number | null, TimelinePr[]>();
  for (const pr of prs) {
    const arr = map.get(pr.authorId) ?? [];
    arr.push(pr);
    map.set(pr.authorId, arr);
  }
  return [...map.entries()]
    .map(([authorId, prs]) => ({ authorId, prs }))
    .sort((a, b) => b.prs.length - a.prs.length);
}

function prNeedsAttention(pr: TimelinePr): boolean {
  return (
    REASON_META[pr.reasonTag].myTurn ||
    pr.isStalled ||
    pr.isChangesRequested ||
    pr.threadCounts.untouched > 0
  );
}

function pinnedMetaOf(
  pr: TimelinePr,
  repoFullName: string,
  usersById: Map<number, User>,
): PinnedPr {
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    repoFullName,
    authorLogin: author?.githubLogin ?? null,
    authorDisplayName: author?.displayName ?? null,
    authorAvatarUrl: author?.avatarUrl ?? null,
  };
}

// The `🧵 a·b·c·d` glyph — review-thread counts (untouched·replied·likely·resolved),
// each tinted by DERIVED_STATE_META. Zero-total → nothing.
function ThreadGlyph({ pr }: { pr: TimelinePr }): JSX.Element | null {
  const c = pr.threadCounts;
  if (c.untouched + c.replied_unresolved + c.likely_addressed + c.resolved === 0) {
    return null;
  }
  const parts: [keyof typeof c, string][] = [
    ['untouched', DERIVED_STATE_META.untouched.color],
    ['replied_unresolved', DERIVED_STATE_META.replied_unresolved.color],
    ['likely_addressed', DERIVED_STATE_META.likely_addressed.color],
    ['resolved', DERIVED_STATE_META.resolved.color],
  ];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 tabular-nums"
      title="Threads: untouched · replied · likely addressed · resolved"
    >
      <span aria-hidden="true" className="text-gray-400">
        🧵
      </span>
      {parts.map(([k, color], i) => (
        <span key={k}>
          <span style={{ color }}>{c[k]}</span>
          {i < parts.length - 1 && <span className="text-gray-300 dark:text-gray-600">·</span>}
        </span>
      ))}
    </span>
  );
}

function PrStateDot({ pr }: { pr: TimelinePr }): JSX.Element {
  const meta = PR_STATE_META[pr.state];
  // Draft → hollow ring; open/merged/closed → filled. Mirrors the timeline's ●/◐.
  return (
    <span
      aria-hidden="true"
      title={pr.isDraft ? 'Draft' : meta.label}
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={
        pr.isDraft
          ? { border: `2px solid ${meta.color}` }
          : { background: meta.color }
      }
    />
  );
}

function CiDot({ pr }: { pr: TimelinePr }): JSX.Element | null {
  const meta = CI_META[pr.ciStatus];
  if (!meta) return null;
  return (
    <span
      aria-hidden="true"
      title={meta.label}
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: meta.color }}
    />
  );
}

function PrRow({
  pr,
  runs,
  onOpen,
  onOpenClaude,
}: {
  pr: TimelinePr;
  runs: ClaudeReviewSummary[];
  onOpen: () => void;
  onOpenClaude: () => void;
}): JSX.Element {
  const latest = runs[0];
  const verdict = latest?.userVerdict ?? latest?.verdict ?? null;
  const reason = REASON_META[pr.reasonTag];
  const attention = prNeedsAttention(pr);
  return (
    <div
      className="group flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-800/60"
      style={
        attention
          ? { boxShadow: `inset 2px 0 0 ${reason.myTurn ? reason.color : '#f59e0b'}` }
          : undefined
      }
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={`Open #${pr.number} — ${pr.title}`}
      >
        <PrStateDot pr={pr} />
        {pr.newSinceLastViewed != null && (
          <span
            aria-hidden="true"
            title="New activity since you last looked"
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
          />
        )}
        <span className="shrink-0 font-mono text-gray-400">#{pr.number}</span>
        <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
          {pr.title}
        </span>
      </button>

      {pr.isApproved && (
        <span
          className="shrink-0 font-medium text-green-600 dark:text-green-400"
          title="Approved"
        >
          ✓
        </span>
      )}
      {pr.isChangesRequested && (
        <span
          className="shrink-0 font-medium text-red-600 dark:text-red-400"
          title="Changes requested"
        >
          ⚠
        </span>
      )}
      <CiDot pr={pr} />
      {pr.isStalled && (
        <span aria-hidden="true" className="shrink-0 text-amber-500" title="Stalled">
          ⏱
        </span>
      )}
      <ThreadGlyph pr={pr} />
      {runs.length > 0 && (
        <button
          type="button"
          onClick={onOpenClaude}
          className="flex shrink-0 items-center gap-0.5 rounded px-1 font-medium tabular-nums hover:underline"
          style={{ color: verdict ? VERDICT_COLOR[verdict] : '#8957e5' }}
          title={`${runs.length} prior Claude review${runs.length === 1 ? '' : 's'}${
            verdict ? ` · latest ${VERDICT_LABEL[verdict]}` : ''
          } — open`}
        >
          <span aria-hidden="true">⚡</span>
          {runs.length}
        </button>
      )}
      <button
        type="button"
        onClick={onOpen}
        aria-hidden="true"
        tabIndex={-1}
        className="shrink-0 text-gray-300 group-hover:text-gray-500 dark:text-gray-600"
        title="Open"
      >
        ▸
      </button>
    </div>
  );
}

function AuthorGroup({
  authorId,
  prs,
  repo,
  usersById,
  runsByPr,
  expanded,
  onToggle,
  onOpenPr,
  onOpenClaude,
}: {
  authorId: number | null;
  prs: TimelinePr[];
  repo: InboxRepo;
  usersById: Map<number, User>;
  runsByPr: Map<number, ClaudeReviewSummary[]>;
  expanded: boolean;
  onToggle: () => void;
  onOpenPr: (pr: TimelinePr) => void;
  onOpenClaude: (pr: TimelinePr) => void;
}): JSX.Element {
  const user = authorId != null ? usersById.get(authorId) : undefined;
  const stalled = prs.filter((p) => p.isStalled).length;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-800/40"
      >
        <span aria-hidden="true" className="w-3 shrink-0 text-gray-400">
          {expanded ? '▾' : '▸'}
        </span>
        <Avatar user={user} size={18} />
        <span className="font-medium text-gray-700 dark:text-gray-200">
          <UserName user={user} fallbackId={authorId} repoId={repo.repoId} />
        </span>
        <span className="text-gray-400">
          {prs.length} PR{prs.length === 1 ? '' : 's'}
        </span>
        {stalled > 0 && (
          <span className="text-amber-500" title={`${stalled} stalled`}>
            · {stalled} ⏱
          </span>
        )}
      </button>
      {expanded && (
        <div className="ml-3 border-l border-gray-100 pl-1 dark:border-gray-800">
          {prs.map((pr) => (
            <PrRow
              key={pr.id}
              pr={pr}
              runs={runsByPr.get(pr.id) ?? []}
              onOpen={() => onOpenPr(pr)}
              onOpenClaude={() => onOpenClaude(pr)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// The one-line repo stat summary (open / draft / merged-7d / stalled / TTFR / oldest
// unreviewed). Extracted so both the all-repos RepoSection and the single-repo
// RepoFeedHeader render the identical block from one source.
export function RepoStatsLine({ stats: s }: { stats: InboxRepoStats }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
      <span>
        <span className="font-semibold text-gray-700 dark:text-gray-200 tabular-nums">
          {s.openPrs}
        </span>{' '}
        open
      </span>
      <span>
        <span className="tabular-nums">{s.draftPrs}</span> draft
      </span>
      <span>
        <span className="tabular-nums">{s.mergedLast7d}</span> merged 7d
      </span>
      {s.stalledPrs > 0 && (
        <span className="text-amber-500">
          <span className="tabular-nums">{s.stalledPrs}</span> stalled ⏱
        </span>
      )}
      {s.medianHoursToFirstReview != null && (
        <span title="Median hours to first review">
          TTFR{' '}
          <span className="tabular-nums">
            {s.medianHoursToFirstReview < 1
              ? `${Math.round(s.medianHoursToFirstReview * 60)}m`
              : `${Math.round(s.medianHoursToFirstReview)}h`}
          </span>
        </span>
      )}
      {s.oldestUnreviewed != null && (
        <a
          href={s.oldestUnreviewed.githubUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="hover:underline"
          title={s.oldestUnreviewed.title}
        >
          oldest unreviewed #{s.oldestUnreviewed.number} ·{' '}
          {relativeTime(s.oldestUnreviewed.openedAt)}
        </a>
      )}
    </div>
  );
}

// One repo's Inbox panel at two densities: a collapsible CARD in the all-repos feed
// ('feed'), or the always-expanded single-repo console ('console'). The body follows
// the strict narrative order: Digest (Pro) → Stats → Thread State → PRs-by-author →
// Claude Reviews. Glyph vocabulary is 100% reused from lib/ui.ts.
export function RepoSection({
  repo,
  density,
  tintIndex,
  claudeEnabled,
  expanded = true,
  onToggleExpand,
}: {
  repo: InboxRepo;
  density: 'feed' | 'console';
  tintIndex: number;
  claudeEnabled: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}): JSX.Element {
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const inboxThreadFilter = useFilters((s) => s.inboxThreadFilter);
  const setInboxThreadFilter = useFilters((s) => s.setInboxThreadFilter);
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  const isOpen = density === 'console' || expanded;
  const tint = TINTS[tintIndex % TINTS.length] ?? TINTS[0];

  // Claude run history per repo (lazy: only when this section is open + enabled).
  const { data: repoReviews } = useRepoClaudeReviews(repo.repoId, claudeEnabled && isOpen);
  const runsByPr = useMemo(() => {
    const m = new Map<number, ClaudeReviewSummary[]>();
    for (const p of repoReviews?.prs ?? []) m.set(p.prId, p.runs);
    return m;
  }, [repoReviews]);

  // Author-group collapse state (default: first group expanded). A thread-state
  // filter force-expands every group with a match.
  const [expandedAuthors, setExpandedAuthors] = useState<Record<string, boolean>>({});
  const filterActive = inboxThreadFilter != null;

  const groups = useMemo(() => {
    const all = groupByAuthor(repo.prs);
    if (!filterActive) return all;
    return all
      .map((g) => ({
        ...g,
        prs: g.prs.filter((p) => p.threadCounts[inboxThreadFilter] > 0),
      }))
      .filter((g) => g.prs.length > 0);
  }, [repo.prs, filterActive, inboxThreadFilter]);

  const openPr = (pr: TimelinePr): void => {
    // Open a full-screen PR-detail tab; `fromInbox` arms the Back-to-Inbox history entry.
    openPrDetailTab(pinnedMetaOf(pr, repo.repoFullName, usersById), { fromInbox: true });
  };
  const openClaude = (pr: TimelinePr): void => {
    openPrDetailTab(pinnedMetaOf(pr, repo.repoFullName, usersById), { fromInbox: true });
    openClaudeReview(pr.id); // requests the PR's Claude Review tab (claudeTabFocus)
  };

  const s = repo.stats;
  const maintainerCount = repo.maintainerIds.length;

  const Header = (
    <div className="flex items-center gap-2">
      {density === 'feed' && (
        <span aria-hidden="true" className="w-3 shrink-0 text-gray-400">
          {expanded ? '▾' : '▸'}
        </span>
      )}
      <span
        className={`min-w-0 truncate font-semibold text-gray-800 dark:text-gray-100 ${
          density === 'console' ? 'text-base' : 'text-sm'
        }`}
      >
        {repo.repoFullName}
      </span>
      {maintainerCount > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-[11px] text-gray-400"
          title={`${maintainerCount} maintainer${maintainerCount === 1 ? '' : 's'} (have merged here)`}
        >
          <MaintainerShield />
          {maintainerCount}
        </span>
      )}
      {repo.hasUnread && (
        <span
          aria-hidden="true"
          title="New activity since you last looked"
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
        />
      )}
      {repo.attentionCount > 0 && (
        <span
          className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
          title="PRs needing attention (your turn · stalled · untouched threads)"
        >
          ⚠ {repo.attentionCount}
        </span>
      )}
      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-gray-400">
        {s.openPrs > 0 ? `[${s.openPrs}]` : '[—]'}
      </span>
    </div>
  );

  return (
    <section
      className={
        density === 'feed'
          ? 'overflow-hidden rounded-lg border'
          : 'rounded-lg'
      }
      style={
        density === 'feed'
          ? { borderColor: tint.border + '40', background: tint.wash }
          : undefined
      }
    >
      {density === 'feed' ? (
        <button
          type="button"
          onClick={onToggleExpand}
          className="w-full px-3 py-2 text-left"
        >
          {Header}
        </button>
      ) : (
        <div className="px-1 py-1">{Header}</div>
      )}

      {isOpen && (
        <div className="space-y-3 px-3 pb-3 pt-1">
          {/* 1) Digest (Pro only; renders nothing in OSS mode) */}
          <DigestBanner repoId={repo.repoId} />

          {/* 2) Stats */}
          <RepoStatsLine stats={s} />

          {/* 3) Thread state — clickable segments soft-filter the author list */}
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Thread state
            </div>
            <ThreadStateBar
              counts={repo.threadTotals}
              activeState={inboxThreadFilter}
              onSegmentClick={setInboxThreadFilter}
            />
            {filterActive && (
              <button
                type="button"
                onClick={() => setInboxThreadFilter(null)}
                className="mt-1 text-[10px] text-gray-400 hover:underline"
              >
                Showing only PRs with {DERIVED_STATE_META[inboxThreadFilter].label.toLowerCase()}{' '}
                threads — clear filter
              </button>
            )}
          </div>

          {/* 4) PRs by author */}
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              PRs by author
            </div>
            {groups.length === 0 ? (
              <div className="px-1 py-2 text-xs text-gray-400">
                {filterActive ? 'No PRs match this thread-state filter.' : 'No open PRs.'}
              </div>
            ) : (
              <div className="space-y-0.5">
                {groups.map((g, i) => {
                  const key = g.authorId == null ? 'null' : String(g.authorId);
                  const isExpanded = filterActive
                    ? true
                    : (expandedAuthors[key] ?? i === 0);
                  return (
                    <AuthorGroup
                      key={key}
                      authorId={g.authorId}
                      prs={g.prs}
                      repo={repo}
                      usersById={usersById}
                      runsByPr={runsByPr}
                      expanded={isExpanded}
                      onToggle={() =>
                        setExpandedAuthors((prev) => ({ ...prev, [key]: !isExpanded }))
                      }
                      onOpenPr={openPr}
                      onOpenClaude={openClaude}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* 5) Claude reviews (this repo) */}
          {claudeEnabled && (repoReviews?.prs.length ?? 0) > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                <span>Claude reviews · this repo</span>
                <span className="ml-auto font-normal normal-case">
                  {(repoReviews?.prs ?? []).reduce((n, p) => n + p.runs.length, 0)} runs /{' '}
                  {repoReviews?.prs.length} PRs
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(repoReviews?.prs ?? []).map((p) => {
                  const latest = p.runs[0];
                  const verdict = latest?.userVerdict ?? latest?.verdict ?? null;
                  return (
                    <button
                      key={p.prId}
                      type="button"
                      onClick={() => {
                        openPrDetailTab(
                          {
                            id: p.prId,
                            number: p.prNumber,
                            title: p.prTitle,
                            repoFullName: repo.repoFullName,
                            authorLogin:
                              (p.authorId != null
                                ? usersById.get(p.authorId)?.githubLogin
                                : null) ?? null,
                            authorDisplayName:
                              (p.authorId != null
                                ? usersById.get(p.authorId)?.displayName
                                : null) ?? null,
                            authorAvatarUrl:
                              (p.authorId != null
                                ? usersById.get(p.authorId)?.avatarUrl
                                : null) ?? null,
                          },
                          { fromInbox: true },
                        );
                        openClaudeReview(p.prId);
                      }}
                      className="flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
                      title={`${p.prTitle} — ${p.runs.length} run${p.runs.length === 1 ? '' : 's'}, open`}
                    >
                      <span className="font-mono text-gray-400">#{p.prNumber}</span>
                      {verdict && (
                        <span
                          className="font-medium"
                          style={{ color: VERDICT_COLOR[verdict] }}
                        >
                          {VERDICT_LABEL[verdict]}
                        </span>
                      )}
                      {latest?.finishedAt != null && (
                        <span className="text-gray-400">
                          {relativeTime(latest.finishedAt)}
                        </span>
                      )}
                      <span aria-hidden="true" className="text-gray-300 dark:text-gray-600">
                        ▸
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

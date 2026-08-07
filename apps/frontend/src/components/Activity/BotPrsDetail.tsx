import { useEffect, useMemo, useState } from 'react';
import type {
  BotVendorAnalytics,
  BotVendorComment,
  BotVendorPr,
  BotWindowKind,
  User,
} from '@pierre-review/shared';
import { useBotAnalytics } from '../../hooks/useBotTriage.js';
import { useBotVendorComments, useBotVendorPrs } from '../../hooks/useBotVendorPrs.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import {
  commentFacetCounts,
  selectComments,
  SEVERITY_PILLS,
  type CommentSort,
  type SeverityPillKey,
} from '../../lib/botComments.js';
import {
  CI_META,
  DERIVED_STATE_META,
  indexUsers,
  ML_SEVERITY_META,
  relativeTime,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { Markdown } from '../Markdown.js';
import { MlSeverityBadge } from '../MlSeverityBadge.js';
import { UserName } from '../UserName.js';

// The BOT DRILL-DOWN — a persistent, singleton tab opened by clicking an automated-reviewer row in
// the Bot-ROI panel. One sub-tab per detected bot, under a COMMENTS | PRs toggle: Comments (the
// default) is everything that reviewer actually said in the window, severity-badged and filterable;
// PRs is the same reviewer's attention seen per pull request (thread volume, acted-on %,
// still-untouched, and whether ONLY bots reviewed it). Bot sub-tabs come from the CORE analytics
// read (useBotAnalytics); BOTH lists are lazy, fetched only while their own view is open, so
// opening the tab costs exactly one list request. Clicking any row opens that PR's detail tab.
//
// ⚠ IT REPRODUCES ONE ROW OF THE PANEL IT WAS OPENED FROM, so it takes the identical
// workspace + repo narrowing: the header label and each row's `botOnly` badge must not be able to
// contradict the ROI table behind them.
//
// The Comments view's filtering and sorting are PURE and live in lib/botComments.ts (tested in
// test/botComments.test.ts) — this file only owns the controls and the windowing.

// The window picker options — kept in lockstep with BotRoiPanel's WINDOWS (same store field).
const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

// Stable empty reference so the default-vendor effect below doesn't loop every render.
const NO_VENDORS: BotVendorAnalytics[] = [];

// The Comments sub-view renders FULL markdown bodies, so the list is windowed client-side
// (3000 rows of react-markdown in one paint is a stall): first page, then "Show more" steps.
const COMMENTS_PAGE = 50;
const COMMENTS_PAGE_STEP = 150;

const TARGET_KIND_LABEL: Record<BotVendorComment['targetKind'], string> = {
  review_comment: 'inline comment',
  pr_comment: 'PR comment',
  review: 'review summary',
};

// Pill chrome for the severity filter row. The four severities reuse the ONE severity palette
// (ML_SEVERITY_META) so a pill and the badge it selects are the same colour; `praise` is not a
// severity and gets its own green, deliberately outside that scale — it is the model saying "this
// is not a finding at all", and lending it a severity hue would read as a fifth rank.
const PILL_META: Record<SeverityPillKey, { label: string; color: string; description: string }> = {
  ...ML_SEVERITY_META,
  praise: {
    label: 'Praise',
    color: '#16a34a',
    description:
      'Not a finding — the bot acknowledging a fix, confirming a resolution, withdrawing a concern or saying thanks. Excluded from every severity share.',
  },
};

// Stable empty selection, so the derived "filters aren't shown ⇒ nothing is filtered" branch
// doesn't hand a fresh Set to the memo on every render.
const NO_PILLS: ReadonlySet<SeverityPillKey> = new Set<SeverityPillKey>();

// One row of the Comments sub-view. The severity badge reads the label shipped INLINE on the
// row — this list must never mount the per-PR label index per row (the per-card-query failure
// the feed's unbadged comment cards exist to avoid).
function CommentRow({
  c,
  showSeverity,
  onOpen,
}: {
  c: BotVendorComment;
  showSeverity: boolean;
  onOpen: (c: BotVendorComment) => void;
}): JSX.Element {
  const state = c.derivedState ? DERIVED_STATE_META[c.derivedState] : null;
  return (
    <tr className="border-t border-gray-100 align-top dark:border-gray-800/60">
      {showSeverity && (
        <td className="py-2 pr-3">
          {c.mlLabel ? (
            <MlSeverityBadge label={c.mlLabel} />
          ) : (
            <span className="text-[11px] text-gray-300 dark:text-gray-600" title="Not scored yet">
              —
            </span>
          )}
        </td>
      )}
      <td className="max-w-2xl py-2 pr-3">
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-400">
          <span className="uppercase tracking-wide">{TARGET_KIND_LABEL[c.targetKind]}</span>
          {c.path && <span className="truncate font-mono">{c.path}</span>}
          {state && (
            <span
              className="rounded px-1 py-px font-medium"
              style={{ color: state.color, background: `${state.color}1a` }}
              title={state.description}
            >
              {state.label}
            </span>
          )}
        </div>
        {/* Full markdown — comment/review bodies are always persisted (lean storage keeps them). */}
        <div className="text-xs">
          <Markdown>{c.body ?? ''}</Markdown>
        </div>
      </td>
      <td className="py-2 pr-3">
        <button
          type="button"
          onClick={() => onOpen(c)}
          className="block max-w-56 text-left hover:underline"
          title={`${c.repoFullName} #${c.prNumber} — ${c.prTitle}`}
        >
          <span className="block truncate font-mono text-[11px] text-gray-400">
            {c.repoFullName} #{c.prNumber}
          </span>
          <span className="block truncate text-[11px] text-gray-700 dark:text-gray-200">
            {c.prTitle}
          </span>
        </button>
      </td>
      <td className="whitespace-nowrap py-2 text-[11px] text-gray-500 dark:text-gray-400">
        {relativeTime(c.createdAt)}
      </td>
    </tr>
  );
}

function CiCell({ ci }: { ci: BotVendorPr['ciStatus'] }): JSX.Element {
  const meta = ci ? CI_META[ci] : null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={meta ? { background: meta.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
        aria-hidden
      />
      {meta?.label ?? 'no checks'}
    </span>
  );
}

function DiffCell({ pr }: { pr: BotVendorPr }): JSX.Element {
  return (
    <span className="whitespace-nowrap text-[11px]">
      <span className="text-gray-400">{pr.changedFiles}f</span>{' '}
      <span className="font-mono text-green-600 dark:text-green-400">+{pr.additions}</span>{' '}
      <span className="font-mono text-red-500 dark:text-red-400">−{pr.deletions}</span>
    </span>
  );
}

function AuthorCell({
  id,
  usersById,
}: {
  id: number | null;
  usersById: Map<number, User>;
}): JSX.Element {
  const u = id != null ? usersById.get(id) : undefined;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
      <Avatar user={u} size={14} />
      <UserName user={u} fallbackId={id ?? 0} />
    </span>
  );
}

// Bot threads on this PR, with still-untouched surfaced in amber.
function ThreadsCell({ pr }: { pr: BotVendorPr }): JSX.Element {
  return (
    <span className="whitespace-nowrap text-[11px] tabular-nums">
      <span className="text-gray-700 dark:text-gray-200">{pr.botThreads}</span>
      {pr.botUntouched > 0 && (
        <span
          className="ml-1 text-amber-600 dark:text-amber-400"
          title={`${pr.botUntouched} still untouched — no reply, no follow-up commit`}
        >
          {pr.botUntouched} untouched
        </span>
      )}
    </span>
  );
}

// Acted-on count + its share of this vendor's threads on the PR ("acted on" ≈ resolved /
// likely_addressed / human follow-up — approximate, same heuristic as the ROI panel).
function ActedOnCell({ pr }: { pr: BotVendorPr }): JSX.Element {
  const pct = pr.botThreads > 0 ? Math.round((pr.botActedOn / pr.botThreads) * 100) : null;
  return (
    <span className="whitespace-nowrap text-[11px] tabular-nums">
      <span className="text-gray-700 dark:text-gray-200">{pr.botActedOn}</span>
      {pct != null && <span className="ml-1 text-gray-400">{pct}%</span>}
    </span>
  );
}

function Row({
  pr,
  usersById,
  onOpen,
}: {
  pr: BotVendorPr;
  usersById: Map<number, User>;
  onOpen: (pr: BotVendorPr) => void;
}): JSX.Element {
  return (
    <tr className="border-t border-gray-100 align-top hover:bg-gray-50/70 dark:border-gray-800/60 dark:hover:bg-gray-900/40">
      <td className="py-1.5 pr-3">
        {/* Two lines per PR: the repo/number pointer, then the title. */}
        <button
          type="button"
          onClick={() => onOpen(pr)}
          className="block max-w-md text-left hover:underline"
          title={`${pr.repoFullName} #${pr.prNumber} — ${pr.prTitle}`}
        >
          <span className="block truncate font-mono text-[11px] text-gray-400">
            {pr.repoFullName} #{pr.prNumber}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
              {pr.prTitle}
            </span>
            {pr.botOnly && (
              <span
                className="shrink-0 rounded bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300"
                title="Only bots touched this PR — no human review or comment"
              >
                bot-only
              </span>
            )}
          </span>
        </button>
      </td>
      <td className="py-1.5 pr-3">
        <ThreadsCell pr={pr} />
      </td>
      <td className="py-1.5 pr-3">
        <ActedOnCell pr={pr} />
      </td>
      <td className="py-1.5 pr-3">
        <CiCell ci={pr.ciStatus} />
      </td>
      <td className="py-1.5 pr-3">
        <DiffCell pr={pr} />
      </td>
      <td className="py-1.5 pr-3">
        <AuthorCell id={pr.authorId} usersById={usersById} />
      </td>
      <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
        {pr.lastBotActivityAt ? relativeTime(pr.lastBotActivityAt) : '—'}
      </td>
    </tr>
  );
}

function Table({
  rows,
  usersById,
  onOpen,
}: {
  rows: BotVendorPr[];
  usersById: Map<number, User>;
  onOpen: (pr: BotVendorPr) => void;
}): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            <th className="pb-1 pr-3 font-semibold">Pull request</th>
            <th className="pb-1 pr-3 font-semibold">Bot threads</th>
            <th className="pb-1 pr-3 font-semibold">Acted on</th>
            <th className="pb-1 pr-3 font-semibold">CI</th>
            <th className="pb-1 pr-3 font-semibold">Diff</th>
            <th className="pb-1 pr-3 font-semibold">Author</th>
            <th className="pb-1 pr-3 font-semibold">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((pr) => (
            <Row key={pr.prId} pr={pr} usersById={usersById} onOpen={onOpen} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BotPrsDetail(): JSX.Element {
  const botPrsFocusKey = useFilters((s) => s.botPrsFocusKey);
  const consumeBotPrsFocus = useFilters((s) => s.consumeBotPrsFocus);
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const workspaceId = useFilters((s) => s.workspaceId);
  // The repo the drill-down was opened from (per-repo Bots tab) — narrows the whole tab's DATA to
  // that repo; null (the cross-repo Bots rail) measures the whole workspace. Read (not consumed)
  // so it persists for the tab's lifetime; only reset when the next drill-down opens.
  const focusRepoId = useFilters((s) => s.botPrsFocusRepoId);
  const repoScope = useMemo(() => (focusRepoId != null ? [focusRepoId] : null), [focusRepoId]);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  // The ACTIVE WORKSPACE's per-bot colour resolver (brand-aware) — so each in-house reviewer's tab
  // gets its own distinct hue instead of all sharing the neutral gray. Identity is a per-workspace
  // fact, so the colour map is fetched at the same workspace as everything else on this tab.
  const botColor = useBotColors(workspaceId);

  // Bot sub-tabs come from the CORE analytics read (the same query the Bot-ROI panel uses, at the
  // same workspace + repo narrowing, so switching to this tab is usually instant off the cache).
  const analytics = useBotAnalytics(workspaceId, window, true, repoScope);
  const vendors = analytics.data?.vendors ?? NO_VENDORS;

  // The active reviewer sub-tab, identified by its analytics-row KEY (`u<userId>` | 'pierre').
  // Seeded from the focus signal (the clicked ROI row); defaults to the first (most-threads)
  // reviewer once analytics load / when the current pick drops out of the window.
  const [active, setActive] = useState<string | null>(botPrsFocusKey);
  // A clicked ROI row (even while the tab is already open) re-jumps to that reviewer's sub-tab.
  useEffect(() => {
    if (botPrsFocusKey) {
      setActive(botPrsFocusKey);
      consumeBotPrsFocus();
    }
  }, [botPrsFocusKey, consumeBotPrsFocus]);
  // Default (or re-default) to the first reviewer when nothing valid is selected — e.g. the
  // initial load, or a window change that dropped the previously-active reviewer.
  useEffect(() => {
    if (vendors.length === 0) return;
    setActive((cur) =>
      cur != null && vendors.some((v) => v.key === cur) ? cur : (vendors[0] as BotVendorAnalytics).key,
    );
  }, [vendors]);

  // Comments | PRs sub-view — state LOCAL to the tab (window/scope stay shared with the panel).
  // COMMENTS IS THE DEFAULT: what a review bot actually said is the question this drill-down is
  // opened to answer; the per-PR shape is the secondary cut.
  // The visible view is DERIVED for the 'pierre' sentinel and never written back: its verbatim
  // reviews are posted with the human's token, so there are no per-comment rows to list — the
  // scalar keeps the user's choice for the sub-tabs that do render it (a corrective set would
  // permanently forget it).
  const [view, setView] = useState<'prs' | 'comments'>('comments');
  const effectiveView: 'prs' | 'comments' = active === 'pierre' ? 'prs' : view;
  const mlEnabled = useMlSeverityEnabled();
  const [commentSort, setCommentSort] = useState<CommentSort>('newest');
  // Severity/praise pills (empty = no narrowing) and the vendor-disagreement toggle. They AND.
  const [severityPills, setSeverityPills] = useState<ReadonlySet<SeverityPillKey>>(NO_PILLS);
  const [disagreesOnly, setDisagreesOnly] = useState(false);
  const [visibleComments, setVisibleComments] = useState(COMMENTS_PAGE);
  const togglePill = (k: SeverityPillKey): void =>
    setSeverityPills((cur) => {
      const next = new Set(cur);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  const clearCommentFilters = (): void => {
    setSeverityPills(NO_PILLS);
    setDisagreesOnly(false);
  };

  // BOTH lists are lazy, each gated on its own view being the visible one. Comments now opens by
  // default, so making the PR list lazy too is what keeps opening this tab at one list request
  // rather than two — and the PR list is the heavier read of the pair.
  const prs = useBotVendorPrs(workspaceId, active, window, effectiveView === 'prs', repoScope);
  const rows = prs.data?.prs ?? [];
  const comments = useBotVendorComments(
    workspaceId,
    active,
    window,
    effectiveView === 'comments',
    repoScope,
  );
  const fetchedComments = useMemo(() => comments.data?.comments ?? [], [comments.data]);

  // Facet counts over the FULL fetched list — pre-filter, so a pill's badge never drops to 0
  // because another pill is pressed (ThreadList's state-pill rule).
  const facets = useMemo(() => commentFacetCounts(fetchedComments), [fetchedComments]);
  // The filter row hides itself when nothing in the list is labelled — with no scoring service (or
  // an un-enriched install) a permanent row of zero-count pills advertises a filter that can only
  // ever return nothing. The active selection is then DERIVED to empty rather than cleared: a
  // scalar that survives a sub-tab with no labels is the user's choice, and a corrective set would
  // forget it (the derived-sub-tab rule).
  const showCommentFilters = mlEnabled && facets.labelled > 0;
  const activePills = showCommentFilters ? severityPills : NO_PILLS;
  const activeDisagrees = showCommentFilters && disagreesOnly;
  // Severity is only offerable where severities exist; the two DATE orders always are.
  const effectiveSort: CommentSort = !mlEnabled && commentSort === 'severity' ? 'newest' : commentSort;

  // Re-window the markdown-heavy list whenever what it shows changes shape — including on a filter
  // change, which can pull a row from position 3000 into view. workspaceId and repoScope are
  // deliberately in the deps: both re-key the comments query WITHOUT remounting this singleton tab
  // (openBotPrsDetail re-seeds the repo focus in place, and the header WorkspaceSelector can switch
  // workspace while the tab is open) — an enlarged 'Show more' window surviving that switch would
  // mount hundreds of markdown bodies in the new scope's first paint, exactly the stall the
  // windowing exists to prevent.
  useEffect(() => {
    setVisibleComments(COMMENTS_PAGE);
  }, [active, effectiveSort, activePills, activeDisagrees, window, workspaceId, repoScope]);

  const commentRows = useMemo(
    () =>
      selectComments(
        fetchedComments,
        { severities: activePills, disagreesOnly: activeDisagrees },
        effectiveSort,
      ),
    [fetchedComments, activePills, activeDisagrees, effectiveSort],
  );
  const commentsFiltered = commentRows.length !== fetchedComments.length;

  // The selected reviewer's label for the header. Either list answers it, but with both lazy the
  // ANALYTICS row is the fallback that is always loaded — otherwise the caption would read
  // "an automated reviewer" for as long as the open view's own request is in flight.
  const activeLabel =
    prs.data?.label ??
    comments.data?.label ??
    vendors.find((v) => v.key === active)?.label ??
    null;
  const botOnlyPrs = analytics.data?.totals.botOnlyPrs ?? 0;

  const openPr = (pr: BotVendorPr): void => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    const meta: PinnedPr = {
      id: pr.prId,
      number: pr.prNumber,
      title: pr.prTitle,
      repoFullName: pr.repoFullName,
      authorLogin: u?.githubLogin ?? null,
      authorDisplayName: u?.displayName ?? null,
      authorAvatarUrl: u?.avatarUrl ?? null,
    };
    openPrDetailTab(meta);
  };
  const openPrFromComment = (c: BotVendorComment): void => {
    const u = c.prAuthorId != null ? usersById.get(c.prAuthorId) : undefined;
    const meta: PinnedPr = {
      id: c.prId,
      number: c.prNumber,
      title: c.prTitle,
      repoFullName: c.repoFullName,
      authorLogin: u?.githubLogin ?? null,
      authorDisplayName: u?.displayName ?? null,
      authorAvatarUrl: u?.avatarUrl ?? null,
    };
    openPrDetailTab(meta);
  };

  const isFetching = analytics.isFetching || prs.isFetching || comments.isFetching;
  const refresh = (): void => {
    void analytics.refetch();
    // Only the OPEN view's list — `refetch` ignores `enabled`, so refetching both would spend a
    // search-tier request on a list nothing renders (and undo half of making them lazy).
    if (effectiveView === 'comments') void comments.refetch();
    else void prs.refetch();
  };

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          Bot Drill-Down
        </h2>
        <span className="text-[11px] text-gray-400">
          {effectiveView === 'comments'
            ? `What ${activeLabel ?? 'an automated reviewer'} said in the window`
            : `PRs ${activeLabel ?? 'an automated reviewer'} touched · most-recent activity first`}
          {botOnlyPrs > 0 && (
            <>
              {' · '}
              <span className="text-amber-600 dark:text-amber-400">
                {botOnlyPrs} bot-only open
              </span>
            </>
          )}
        </span>
        {/* Window picker (shared with the Bot-ROI panel via botAnalyticsWindow). */}
        <div className="ml-auto inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
          {WINDOWS.map((wOpt) => (
            <button
              key={wOpt.key}
              type="button"
              onClick={() => setWindow(wOpt.key)}
              className={`px-2 py-0.5 text-[11px] font-medium ${
                window === wOpt.key
                  ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {wOpt.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={isFetching}
          className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          <span aria-hidden className={isFetching ? 'animate-spin' : ''}>
            ↻
          </span>{' '}
          Refresh
        </button>
      </div>

      {analytics.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
          ))}
        </div>
      ) : analytics.isError ? (
        <div className="text-sm text-red-500">Couldn’t load bot analytics.</div>
      ) : vendors.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          No automated-reviewer activity in this window.
          <div className="mt-1 text-[11px]">
            When review bots (CodeRabbit, Copilot, in-house AI…) comment on your PRs, the PRs
            they touched land here.
          </div>
        </div>
      ) : (
        <>
          {/* Sub-tab bar — one per detected vendor. */}
          <div role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
            {vendors.map((v) => {
              const on = v.key === active;
              const color = botColor({ login: v.login, kind: v.kind });
              return (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setActive(v.key)}
                  className={`-mb-px flex items-center gap-1 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                    on
                      ? 'border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950'
                      : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
                  }`}
                  style={on ? { color } : undefined}
                >
                  <span aria-hidden>🤖</span>
                  {v.label}
                  <span className="ml-1 text-gray-400">{v.threads}</span>
                </button>
              );
            })}
          </div>

          {/* Comments | PRs sub-view toggle — Comments first, and the view this tab opens on.
              Comments is DISABLED for the 'pierre' sentinel (verbatim reviews are posted with the
              human's token — no per-comment rows), which is the one case that lands on PRs. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
              {(
                [
                  { key: 'comments', label: 'Comments' },
                  { key: 'prs', label: 'PRs' },
                ] as const
              ).map((t) => {
                const disabled = t.key === 'comments' && active === 'pierre';
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setView(t.key)}
                    disabled={disabled}
                    title={
                      disabled
                        ? 'Pierre’s verbatim reviews are posted with the human’s token — there are no per-comment rows to list.'
                        : t.key === 'comments'
                          ? 'Everything this bot said in the window — inline comments, PR comments and review summaries'
                          : 'The PRs this bot touched in the window'
                    }
                    className={`px-2 py-0.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                      effectiveView === t.key
                        ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                        : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            {/* Sort. Both DATE orders are always offered; Severity only where severities exist
                to sort by (no scoring service ⇒ the option would sort by nothing). */}
            {effectiveView === 'comments' && (
              <div className="ml-auto inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
                {(
                  [
                    { key: 'newest', label: 'Newest', title: 'Most recent first' },
                    { key: 'oldest', label: 'Oldest', title: 'Earliest first' },
                    {
                      key: 'severity',
                      label: 'Severity',
                      title:
                        'Worst predicted severity first — summaries and unscored comments sink to the bottom',
                    },
                  ] as const
                )
                  .filter((s) => s.key !== 'severity' || mlEnabled)
                  .map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setCommentSort(s.key)}
                      title={s.title}
                      className={`px-2 py-0.5 text-[11px] font-medium ${
                        effectiveSort === s.key
                          ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                          : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Severity/praise pills + the vendor-disagreement toggle. They AND together, and their
              badges count the FULL fetched list so pressing one never zeroes the others. Hidden
              entirely when nothing in the list is labelled — a row of dead pills on an
              un-enriched (or OSS) install advertises a filter that can only return nothing. */}
          {effectiveView === 'comments' && showCommentFilters && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Severity
              </span>
              {SEVERITY_PILLS.map((k) => {
                const meta = PILL_META[k];
                const on = activePills.has(k);
                const count = facets.counts[k];
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => togglePill(k)}
                    aria-pressed={on}
                    disabled={count === 0 && !on}
                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                      on
                        ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/30 dark:text-sky-300'
                        : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
                    }`}
                    title={meta.description}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: meta.color }}
                    />
                    {meta.label}
                    {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setDisagreesOnly((v) => !v)}
                aria-pressed={activeDisagrees}
                disabled={facets.disagreements === 0 && !activeDisagrees}
                className={`ml-1 flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                  activeDisagrees
                    ? 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/30 dark:text-amber-300'
                    : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
                }`}
                title="Only comments where the bot's OWN declared severity badge differs from Limn's. This is a SEVERITY disagreement and nothing else: vendors declare no machine-readable category, so category disagreement is not derivable and is never claimed here."
              >
                <span aria-hidden="true">⚖</span>
                Bot disagrees
                {facets.disagreements > 0 && (
                  <span className="tabular-nums opacity-70">{facets.disagreements}</span>
                )}
              </button>
              {(activePills.size > 0 || activeDisagrees) && (
                <button
                  type="button"
                  onClick={clearCommentFilters}
                  className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 underline-offset-2 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          {effectiveView === 'comments' ? (
            comments.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-8 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
                ))}
              </div>
            ) : comments.isError ? (
              <div className="text-sm text-red-500">Couldn’t load the comment list.</div>
            ) : commentRows.length === 0 ? (
              // Two different empty states: nothing was said, versus nothing survived the pills.
              // The second must offer the way out, or the filter reads as a broken list.
              <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
                {commentsFiltered ? (
                  <>
                    None of this bot’s {fetchedComments.length.toLocaleString()} comments match
                    these filters.
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={clearCommentFilters}
                        className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-500"
                      >
                        Clear filters
                      </button>
                    </div>
                  </>
                ) : (
                  'No comments from this bot in the window.'
                )}
              </div>
            ) : (
              <>
                {comments.data?.truncated && (
                  <div className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    This bot said more in the window than one read covers — showing the most
                    recent {fetchedComments.length.toLocaleString()}.
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] border-collapse text-sm">
                    <thead>
                      <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        {mlEnabled && <th className="pb-1 pr-3 font-semibold">Severity</th>}
                        <th className="pb-1 pr-3 font-semibold">Comment</th>
                        <th className="pb-1 pr-3 font-semibold">Pull request</th>
                        <th className="pb-1 font-semibold">Posted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {commentRows.slice(0, visibleComments).map((c) => (
                        <CommentRow
                          key={`${c.targetKind}:${c.targetId}`}
                          c={c}
                          showSeverity={mlEnabled}
                          onOpen={openPrFromComment}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                {commentRows.length > visibleComments && (
                  <button
                    type="button"
                    onClick={() => setVisibleComments((n) => n + COMMENTS_PAGE_STEP)}
                    className="w-full rounded border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-500"
                  >
                    Show more ({(commentRows.length - visibleComments).toLocaleString()} remaining)
                  </button>
                )}
                {/* Filtered-of-fetched, never a bare count: with pills on, "50 comments" would
                    read as the bot's whole output for the window. */}
                <div className="text-[11px] text-gray-400">
                  {commentsFiltered
                    ? `${commentRows.length.toLocaleString()} of ${fetchedComments.length.toLocaleString()} comments match`
                    : `${fetchedComments.length.toLocaleString()} comments`}
                </div>
              </>
            )
          ) : prs.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-8 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
              ))}
            </div>
          ) : prs.isError ? (
            <div className="text-sm text-red-500">Couldn’t load the PR list.</div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
              No PRs for this bot in the window.
            </div>
          ) : (
            <Table rows={rows} usersById={usersById} onOpen={openPr} />
          )}
        </>
      )}
    </div>
  );
}

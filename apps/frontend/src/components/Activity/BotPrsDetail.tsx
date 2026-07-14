import { useEffect, useMemo, useState } from 'react';
import type {
  AutomatedReviewerKind,
  BotVendorAnalytics,
  BotVendorPr,
  BotWindowKind,
  User,
} from '@pierre-review/shared';
import { useBotAnalytics } from '../../hooks/useBotTriage.js';
import { useBotVendorPrs } from '../../hooks/useBotVendorPrs.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { CI_META, automatedReviewerMeta, indexUsers, relativeTime } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';

// The bot-vendor PR DRILL-DOWN — a persistent, singleton tab opened by clicking an
// automated-reviewer row in the Bot-ROI panel. One sub-tab per detected vendor, each listing
// the PRs that reviewer touched in the window (thread volume, acted-on %, still-untouched,
// and whether ONLY bots reviewed the PR) so a lead can see WHERE a bot's attention lands.
// Vendor sub-tabs come from the CORE analytics read (useBotAnalytics); the per-vendor PR
// list is a lazy read (useBotVendorPrs). Clicking any PR opens its detail tab.

// The window picker options — kept in lockstep with BotRoiPanel's WINDOWS (same store field).
const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

// Stable empty reference so the default-vendor effect below doesn't loop every render.
const NO_VENDORS: BotVendorAnalytics[] = [];

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
  const botPrsFocus = useFilters((s) => s.botPrsFocus);
  const consumeBotPrsFocus = useFilters((s) => s.consumeBotPrsFocus);
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);

  // Vendor sub-tabs come from the CORE analytics read (the same query the Bot-ROI panel uses,
  // so switching to this tab is usually instant off the cache).
  const analytics = useBotAnalytics(window, true, scope);
  const vendors = analytics.data?.vendors ?? NO_VENDORS;

  // The active vendor sub-tab. Seeded from the focus signal (the clicked ROI row); defaults to
  // the first (most-threads) vendor once analytics load / when the current pick drops out of
  // the window.
  const [active, setActive] = useState<AutomatedReviewerKind | null>(botPrsFocus);
  // A clicked ROI row (even while the tab is already open) re-jumps to that vendor's sub-tab.
  useEffect(() => {
    if (botPrsFocus) {
      setActive(botPrsFocus);
      consumeBotPrsFocus();
    }
  }, [botPrsFocus, consumeBotPrsFocus]);
  // Default (or re-default) to the first vendor when nothing valid is selected — e.g. the
  // initial load, or a window change that dropped the previously-active vendor.
  useEffect(() => {
    if (vendors.length === 0) return;
    setActive((cur) =>
      cur != null && vendors.some((v) => v.kind === cur) ? cur : (vendors[0] as BotVendorAnalytics).kind,
    );
  }, [vendors]);

  const prs = useBotVendorPrs(active, window, true, scope);
  const rows = prs.data?.prs ?? [];
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

  const isFetching = analytics.isFetching || prs.isFetching;
  const refresh = (): void => {
    void analytics.refetch();
    void prs.refetch();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Bot PRs</h2>
        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        <span className="text-[11px] text-gray-400">
          PRs an automated reviewer touched · most-recent activity first
          {botOnlyPrs > 0 && (
            <>
              {' · '}
              <span className="text-amber-600 dark:text-amber-400">
                {botOnlyPrs} bot-only
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
              const on = v.kind === active;
              const meta = automatedReviewerMeta(v.kind);
              return (
                <button
                  key={v.kind}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setActive(v.kind)}
                  className={`-mb-px flex items-center gap-1 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                    on
                      ? 'border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950'
                      : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
                  }`}
                  style={on ? { color: meta.color } : undefined}
                >
                  <span aria-hidden>🤖</span>
                  {v.label}
                  <span className="ml-1 text-gray-400">{v.threads}</span>
                </button>
              );
            })}
          </div>

          {prs.isLoading ? (
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

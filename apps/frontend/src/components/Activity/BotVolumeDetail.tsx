import { useCallback, useMemo, useState } from 'react';
import type { BotVolumePrRow, BotVolumePrSort, BotWindowKind } from '@pierre-review/shared';
import { useAutoLoadSentinel } from '../../hooks/useAutoLoadSentinel.js';
import { useBotVolumePrs } from '../../hooks/useBotVolume.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { botNarrowLabel } from '../../lib/severityAgreement.js';
import {
  VOLUME_SORTS,
  baselineCaption,
  formatLoc,
  formatRatio,
  ratioDetail,
  ratioTone,
} from '../../lib/botVolume.js';

// BOT COMMENTS PER MERGED PR — the drill-down behind the ROI table's "Comments/PR" column. Click a
// bot's cell and this is the merged PRs that average was folded from, biggest first.
//
// ⚠ THE POPULATION IS PRs **MERGED** IN THE WINDOW, and every caption on this screen says so. Open
// PRs are excluded: measured on this corpus one repo holds 686 merged vs 997 opened over the same
// 180 days, so a caption that only says "PRs" is wrong by ~45%.
//
// ⚠ EVERY NUMBER HERE IS THE SERVER'S. `botComments`, `expected`, `ratio` and both totals come
// from the same single scan the column was folded from, which is what makes the list and the cell
// that opened it agree BY CONSTRUCTION. Nothing on this screen re-derives a count from the loaded
// rows — `items.length` is only ever reported as "showing N of M".
//
// THE TAB IS A SINGLETON THAT IS RE-SEEDED IN PLACE, NEVER REMOUNTED (`BOT_VOLUME_TAB_KEY`) —
// clicking a second bot's cell swaps the seed under a live component.

// The window picker options — kept in lockstep with BotRoiPanel's and BotFlaggingDetail's WINDOWS,
// since all three write the SAME store field (`botAnalyticsWindow`). This page reproduces a number
// off the panel behind it, so the two must not be able to be measuring different windows.
const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

function Skeleton(): JSX.Element {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
      ))}
    </div>
  );
}

function Row({
  row,
  onOpenPr,
}: {
  row: BotVolumePrRow;
  onOpenPr: (row: BotVolumePrRow) => void;
}): JSX.Element {
  // ⚠ A DATA-DERIVED URL NEVER GOES STRAIGHT INTO `href` — React renders `javascript:` URLs (it
  // only console-warns). `prUrl` is built server-side today, but the rule is about the channel,
  // not about who happens to be writing it this week.
  const href = safeExternalUrl(row.prUrl);
  const detail = ratioDetail(row);
  return (
    <tr className="border-b border-gray-100 last:border-0 dark:border-gray-800/60">
      <td className="px-2 py-1.5">
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="font-mono text-[10px] text-gray-400">{row.repoFullName}</span>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] text-gray-500 hover:underline dark:text-gray-400"
              title="Open on GitHub"
            >
              #{row.prNumber}
            </a>
          ) : (
            <span className="font-mono text-[10px] text-gray-500">#{row.prNumber}</span>
          )}
          <button
            type="button"
            onClick={() => onOpenPr(row)}
            title="Open this PR"
            className="max-w-[46rem] truncate text-left text-gray-700 hover:underline dark:text-gray-200"
          >
            {row.prTitle}
          </button>
        </div>
        {/* Who said what. Rendered only when more than one bot commented — with a single bot the
            breakdown restates the count in the next column, and under a bot narrowing it always
            would. Sums to `botComments` by construction (server-folded), so it is never a
            second tally. */}
        {row.byBot.length > 1 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {row.byBot.map((b) => (
              <span
                key={b.key}
                className="rounded bg-gray-100 px-1 py-px text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
              >
                {b.label} <span className="tabular-nums">{b.comments}</span>
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-gray-700 dark:text-gray-200">
        {row.botComments.toLocaleString()}
      </td>
      {/* LOC and files are DASHED when the size was never observed — never 0. Under lean storage
          an unhydrated PR is indistinguishable from a genuinely empty one, so the server sends
          null rather than fabricating a zero (which would also drop the PR into the smallest size
          bucket and manufacture a spectacular ratio). */}
      <td
        className="px-2 py-1.5 text-right tabular-nums text-gray-500"
        title={
          row.loc == null
            ? 'This PR’s size was never observed — under lean storage that is indistinguishable from an empty PR, so it is left blank rather than shown as 0.'
            : `+${row.additions.toLocaleString()} / −${row.deletions.toLocaleString()}`
        }
      >
        {formatLoc(row.loc)}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
        {row.changedFiles == null ? '—' : row.changedFiles.toLocaleString()}
      </td>
      {/* ⚠ `expected` AND `baselinePrs` RIDE BESIDE THE MULTIPLIER, not behind the tooltip. A
          near-zero expectation inflates the ratio without inflating the finding (measured: 42.9×
          off 3 comments against an expectation of 0.07), and only the surrounding numbers tell
          that apart from a PR that was genuinely torn apart. */}
      <td className="px-2 py-1.5 text-right" title={baselineCaption(row.baseline, row.baselinePrs)}>
        <span className={`font-medium tabular-nums ${ratioTone(row.ratio)}`}>
          {formatRatio(row.ratio, row.baseline)}
        </span>
        {detail && (
          <div className="text-[10px] tabular-nums text-gray-400">
            {detail}
            {row.baseline === 'repo' && ' · repo avg, not size-matched'}
            {row.baseline === 'low_expectation' && ' · too few expected to compare'}
          </div>
        )}
      </td>
    </tr>
  );
}

export function BotVolumeDetail(): JSX.Element {
  // The cell this tab was opened on. READ, NEVER CONSUMED — it has to survive the tab's whole
  // lifetime (the header, the query and the tab chip all read it). The next open overwrites it.
  const seed = useFilters((s) => s.botVolumeSeed);
  const workspaceId = useFilters((s) => s.workspaceId);
  // The window is the SHARED transient store field, written by this picker and by the Bots rail's.
  // Never a local copy — see WINDOWS above.
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  // The repo the COLUMN was measured at (per-repo Bots tab); null on the cross-repo Bots rail.
  const seedRepoId = seed?.repoId ?? null;
  const repoScope = useMemo(() => (seedRepoId != null ? [seedRepoId] : null), [seedRepoId]);
  const bots = seed?.bots ?? null;
  const setBots = useFilters((s) => s.setBotVolumeBots);

  // ⚠ THE SORT IS LOCAL AND IS DELIBERATELY *NOT* RESET when the seed / window / scope changes,
  // which is the opposite of what the flagging drill-down does with its refinements. The reason is
  // the difference between a filter and an ordering: a stale FILTER can empty the list and read as
  // a broken screen (which is why that tab clears them), whereas an ordering can only ever
  // re-arrange the same rows. Someone who switched to "most vs expected" asked a question about
  // ranking, and widening the window is them asking it over more data — clearing it there would
  // silently answer a different question.
  const [sort, setSort] = useState<BotVolumePrSort>('comments');

  const { data: repos } = useRepos();
  const repoName = useMemo(() => {
    if (seedRepoId == null) return null;
    return (repos ?? []).find((r) => r.id === seedRepoId)?.fullName ?? `repo ${seedRepoId}`;
  }, [repos, seedRepoId]);

  const { items, total, filteredTotal, truncated, isLoading, hasMore, fetchMore, isFetchingMore } =
    useBotVolumePrs({
      workspaceId,
      repoIds: repoScope,
      window,
      sort,
      // ⚠ The whole SET rides through. Sending only its first id (or a count) would put the
      // caption and the list back out of step, which is what this shape exists to stop.
      authorUserIds: bots?.userIds ?? null,
      enabled: seed != null,
    });

  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const onOpenPr = useCallback(
    (row: BotVolumePrRow): void => {
      // Author chrome is absent from this row shape and backfills via PrDetail's syncMeta once the
      // tab mounts — the digest/feed precedent.
      const meta: TabMeta = {
        id: row.prId,
        number: row.prNumber,
        title: row.prTitle,
        repoFullName: row.repoFullName,
        authorLogin: null,
        authorDisplayName: null,
        authorAvatarUrl: null,
      };
      openPrDetailTab(meta, { fromActivity: true });
    },
    [openPrDetailTab],
  );

  const loaded = items.length;
  // Only the ref is taken: the footer is gated on `hasMore` rather than the hook's `showSentinel`,
  // so a page that renders no rows still offers the manual button (the BotFlaggingDetail rule).
  const { sentinelRef } = useAutoLoadSentinel({
    hasMore,
    isFetchingMore,
    itemCount: loaded,
    loadMore: fetchMore,
  });

  const sortMeta = VOLUME_SORTS.find((s) => s.key === sort) ?? VOLUME_SORTS[0];

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          Bot comments per merged PR
        </h2>
        <span className="text-[11px] text-gray-400">
          {bots ? `${botNarrowLabel(bots)}’s comments` : 'every bot in this workspace'}
        </span>
        {repoName && (
          <span
            className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            title="This drill-down was opened from a single repo’s Bots tab, so it measures that repo — the same narrowing the column you clicked was computed at."
          >
            {repoName}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Window picker — writes the SHARED store field (see WINDOWS above). */}
          <div className="inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
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
        </div>
      </div>
      <p className="max-w-4xl text-[11px] text-gray-500 dark:text-gray-400">
        Every PR <span className="font-medium">merged</span> in this window that drew at least one
        bot comment — inline review comments, PR comments and review bodies alike. Open PRs are not
        counted.
      </p>

      {seed == null ? (
        // Unreachable in practice — the tab is ephemeral (never persisted, never parsed back from a
        // tab key), so it cannot exist without the seed that opened it. Said plainly rather than
        // rendered as an empty list, which would read as "no bot said anything".
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Open this from the Comments/PR column on the Bots rail to see the PRs behind it.
        </div>
      ) : workspaceId == null || isLoading ? (
        // `workspaceId === null` is "not resolved yet", never "every workspace" — nothing
        // workspace-scoped may render against it.
        <Skeleton />
      ) : total == null || filteredTotal == null ? (
        // No page landed. The infinite query surfaces no error flag of its own, so an absent total
        // once loading has settled IS the failure state — and it must not be dressed up as an
        // empty result, which would claim these bots said nothing.
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Couldn’t load the merged PRs for this window.
        </div>
      ) : (
        <>
          {/* Controls: the ordering, and the bot narrowing if one arrived with the seed. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
              {VOLUME_SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSort(s.key)}
                  aria-pressed={sort === s.key}
                  title={s.help}
                  className={`px-2 py-0.5 text-[11px] font-medium ${
                    sort === s.key
                      ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                      : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {/* The bot narrowing. A BUTTON, not a read-only pill: it arrived from another screen
                and would otherwise be an unclearable filter on a list whose numbers the reader is
                trying to reconcile. Clearing widens to EVERY bot (`null`) — never to an empty set,
                which the wire reads as "no bots". */}
            {bots && (
              <button
                type="button"
                onClick={() => setBots(null)}
                title={`Only ${botNarrowLabel(bots)}${bots.label ? '’s' : '’'} comments — opened from that bot's cell in the Bots table. Click to widen to every bot, keeping this window and scope.`}
                className="flex items-center gap-1 rounded-full border border-violet-400 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 hover:border-violet-500 dark:border-violet-500/60 dark:bg-violet-950/30 dark:text-violet-300"
              >
                <span aria-hidden="true">🤖</span>
                {botNarrowLabel(bots)} only
                <span aria-hidden="true" className="text-violet-400">
                  ✕
                </span>
              </button>
            )}
          </div>
          {/* ⚠ THE SECOND SORT HAS TO BE EXPLAINED, NOT JUST OFFERED. Raw count mostly ranks by
              SIZE (measured: log LOC vs comment count correlates ~0.54–0.62 here, and comments per
              100 LOC fall from 57.65 on sub-50-LOC PRs to 0.83 at 2k+), so a screen that only ever
              shows "most comments" has quietly shipped a size ranking. The example that proves it
              is real: a 17-LOC, single-file PR that drew 25 bot comments — 3.7× what a PR that
              size usually draws — sits 123rd under the default order and 8th under this one. */}
          <p className="max-w-4xl text-[11px] text-gray-500 dark:text-gray-400">{sortMeta?.help}</p>

          {truncated && (
            // The same honesty rule the column's own scan cap follows: say the numbers are a
            // most-recent sample rather than presenting a capped count as the whole window.
            <div className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
              More PRs merged in this window than one read covers — this list and its counts
              describe the most recent sample, not the whole window.
            </div>
          )}

          {filteredTotal === 0 ? (
            // TWO DISTINCT EMPTY STATES. "Nothing matched your filter" without a way out reads as
            // a broken list; "no bot commented" must NOT offer to clear a filter that isn't on.
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
              {bots ? (
                <>
                  {botNarrowLabel(bots)} commented on none of the {total.toLocaleString()} PR
                  {total === 1 ? '' : 's'} merged in this window.
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setBots(null)}
                      className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-500"
                    >
                      Show every bot
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {total === 0
                    ? 'Nothing merged in this window.'
                    : `No bot commented on any of the ${total.toLocaleString()} PRs merged in this window.`}
                  <div className="mt-1 text-[11px]">
                    Bot comments are counted against the PR they landed on and the window is keyed
                    on the merge, so a quiet window here can simply mean little shipped — try
                    widening it above.
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
                <table className="w-full min-w-[720px] border-collapse text-[11px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-800 dark:text-gray-400">
                      <th className="px-2 py-1.5 font-medium">PR</th>
                      <th
                        className="px-2 py-1.5 text-right font-medium"
                        title="Every comment the bots left on this PR — inline review comments, PR-level comments and review bodies."
                      >
                        Bot comments
                      </th>
                      <th
                        className="px-2 py-1.5 text-right font-medium"
                        title="Additions + deletions. Blank when the PR's size was never observed — under lean storage that is indistinguishable from an empty PR, so it is never shown as 0."
                      >
                        LOC
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">Files</th>
                      <th
                        className="px-2 py-1.5 text-right font-medium"
                        title="Bot comments divided by what a PR this size usually draws in this repo. Hover a cell for what it was compared against; 'no baseline' means there were too few comparable merged PRs to say."
                      >
                        vs expected
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <Row key={row.prId} row={row} onOpenPr={onOpenPr} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* NEVER A BARE COUNT. Three different numbers live here — how many rows are on
                  screen, how many merged PRs drew bot comments, and how many merged at all. */}
              <div
                className="text-[11px] tabular-nums text-gray-400"
                title="Both totals are the server's, folded from the same scan the Comments/PR column was — not a separate query."
              >
                {/* ⚠ UNDER A BOT NARROWING `filteredTotal` IS THAT BOT'S PR COUNT, NOT "PRs that
                    drew bot comments" — the unnarrowed figure is larger and is not on this
                    screen. Naming the bot is what stops the sentence claiming a population it
                    never measured. */}
                Showing {loaded.toLocaleString()} of {filteredTotal.toLocaleString()} merged PR
                {filteredTotal === 1 ? '' : 's'} that drew{' '}
                {bots ? `${botNarrowLabel(bots)} comments` : 'bot comments'}
                {' · '}
                {filteredTotal.toLocaleString()} of {total.toLocaleString()} merged in this window
              </div>

              {/* Auto-load. The sentinel is the LAST element in the overlay's scroll pane, so the
                  observer roots on the pane the list actually scrolls in (lib/scrollParent.ts);
                  the button stays as the manual fallback for when the observer can't fire. */}
              {hasMore && (
                <div ref={sentinelRef} className="flex justify-center pt-1">
                  {isFetchingMore ? (
                    <span className="flex items-center gap-2 py-1.5 text-xs text-gray-400">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-transparent dark:border-gray-600 dark:border-t-transparent" />
                      Loading more…
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={fetchMore}
                      className="rounded-full border border-gray-300 px-4 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-800/50"
                    >
                      Load more
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

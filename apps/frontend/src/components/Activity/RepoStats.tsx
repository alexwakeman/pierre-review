import type { ActivityRepoStats } from '@pierre-review/shared';
import { relativeTime } from '../../lib/ui.js';
import { BotIcon, TimerIcon } from '../Icons.js';

// The one-line repo stat summary (open / draft / stalled / TTFR / oldest unreviewed).
// Rendered by the single-repo RepoFeedHeader. "Merged" is deliberately NOT here — the
// RepoInsightsCard's merge-rate graph directly beneath owns that metric (item 12: prefer
// the chart over a duplicate scalar).
export function RepoStatsLine({ stats: s }: { stats: ActivityRepoStats }): JSX.Element {
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
      {s.stalledPrs > 0 && (
        <span className="text-amber-500">
          <span className="tabular-nums">{s.stalledPrs}</span> stalled{' '}
          <TimerIcon size={12} className="inline-block align-[-0.1em]" />
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
      {/* Review-bot signal-to-noise (deterministic, no AI) — only when a review bot is active
          here. "42% acted on" = threads a later commit touched vs the untouched backlog. */}
      {s.botThreads > 0 && (
        <span
          className="text-sky-600 dark:text-sky-400"
          title="Review-bot threads on open PRs, and the share a later commit has likely addressed (resolved or likely_addressed). An approximate signal — likely_addressed is a heuristic."
        >
          <BotIcon size={12} className="inline-block align-[-0.1em]" />{' '}
          <span className="tabular-nums">{s.botThreads}</span> bot thread
          {s.botThreads === 1 ? '' : 's'} ·{' '}
          <span className="tabular-nums">
            {Math.round((s.botThreadsActedOn / s.botThreads) * 100)}%
          </span>{' '}
          acted on
        </span>
      )}
    </div>
  );
}

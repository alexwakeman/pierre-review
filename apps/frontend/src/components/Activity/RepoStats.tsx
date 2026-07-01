import type { ActivityRepoStats } from '@pierre-review/shared';
import { relativeTime } from '../../lib/ui.js';

// The one-line repo stat summary (open / draft / merged-7d / stalled / TTFR / oldest
// unreviewed). Rendered by the single-repo RepoFeedHeader. (Formerly also used by an
// all-repos RepoSection card, which was removed with the "All repos" Activity entry.)
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

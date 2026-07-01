import type { InboxRepo } from '@pierre-review/shared';
import { MaintainerShield } from '../MaintainerShield.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { DigestBanner } from './DigestBanner.js';
import { RepoStatsLine } from './RepoStats.js';

// The compact console header shown above a single repo's feed (when a repo is selected
// in the rail): the Pro digest banner (null in OSS), the repo name + maintainer / open
// counts, the one-line stats summary, and a display-only thread-state bar.
export function RepoFeedHeader({ repo }: { repo: InboxRepo }): JSX.Element {
  const maintainerCount = repo.maintainerIds.length;
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      {/* Pro per-repo digest (renders nothing in OSS mode). */}
      <DigestBanner repoId={repo.repoId} />

      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-base font-semibold text-gray-800 dark:text-gray-100">
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
        {repo.attentionCount > 0 && (
          <span
            className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
            title="PRs needing attention (your turn · stalled · untouched threads)"
          >
            ⚠ {repo.attentionCount}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-gray-400">
          {repo.stats.openPrs > 0 ? `[${repo.stats.openPrs}]` : '[—]'}
        </span>
      </div>

      <RepoStatsLine stats={repo.stats} />

      {/* Display-only thread-state bar (no click-to-filter — the PRs-by-author list it
          used to filter isn't in this view). */}
      <ThreadStateBar counts={repo.threadTotals} />
    </div>
  );
}

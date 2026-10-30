import type { ActivityRepo } from '@pierre-review/shared';
import { MaintainerShield } from '../MaintainerShield.js';
import { WarningIcon } from '../Icons.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { BranchStatusPanel } from './BranchStatusPanel.js';
import { RepoStatsLine } from './RepoStats.js';

// The compact console header shown above a single repo's feed (when a repo is selected
// in the rail): the repo name + maintainer / open
// counts, the one-line stats summary, and a display-only thread-state bar.
export function RepoFeedHeader({ repo }: { repo: ActivityRepo }): JSX.Element {
  const maintainerCount = repo.maintainerIds.length;
  return (
    <div className="space-y-2 rounded-ui border border-ui-line p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-title font-semibold text-ui-ink">
          {repo.repoFullName}
        </span>
        {maintainerCount > 0 && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-meta text-ui-faint"
            title={`${maintainerCount} maintainer${maintainerCount === 1 ? '' : 's'} (have merged here)`}
          >
            <MaintainerShield />
            {maintainerCount}
          </span>
        )}
        {repo.attentionCount > 0 && (
          <span
            className="flex shrink-0 items-center gap-0.5 rounded-ui bg-ui-raise px-1 text-meta font-semibold text-ui-warn"
            title="PRs needing attention (review or reply · stalled · untouched threads)"
          >
            <WarningIcon size={10} />
            {repo.attentionCount}
          </span>
        )}
        <span className="ml-auto shrink-0 text-meta tabular-nums text-ui-faint">
          {repo.stats.openPrs > 0 ? `[${repo.stats.openPrs}]` : '[—]'}
        </span>
      </div>

      <RepoStatsLine stats={repo.stats} />

      {/* Display-only thread-state bar (no click-to-filter — the PRs-by-author list it
          used to filter isn't in this view). */}
      <ThreadStateBar counts={repo.threadTotals} />

      {/* This repo's default branch: CI state + (expandable) what recently landed on trunk.
          Pinned to THIS repo rather than following the Workspace/FilterBar scope, and `compact` so it
          drops the redundant repo-name column and the strip's own scroll. Renders nothing
          until the repo has been branch-synced. */}
      <BranchStatusPanel repoIds={[repo.repoId]} compact />
    </div>
  );
}

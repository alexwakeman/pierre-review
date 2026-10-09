import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { anyBranchSynced, BranchStatusPanel } from './BranchStatusPanel.js';

// The top of Activity → Open PRs: the workspace's default-branch strip. (It headed Pending → My
// turn until Open PRs became the first rail line.)
//
// ⚠ NO NEW REQUESTS. The rail's argument-less `useBranchStatus()` (Activity/index.tsx feeds the
// rail's trunk line from it, so it is in flight on every Activity visit) — this adds a second
// observer to ONE query, not a second request. Mounts once per pane.
//
// ⚠ INFORMATIONAL. Nothing read here reaches a tab badge, a my_turn count, the scorer, the liveness
// sweep or a notification — trunk status is a readout, not an alert channel.
const skeleton =
  'h-9 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40';
const note = 'text-[12px] text-gray-500 dark:text-gray-400';
const fail = 'text-[12px] text-red-600 dark:text-red-400';

/**
 * The default-branch slot. ⚠ UNKNOWN IS NEVER ZERO: a placeholder while the query has no answer
 * (INCLUDING the idle state while the workspace is unresolved — a disabled v5 query is pending, not
 * loading), a sentence when it failed, a sentence when it ANSWERED with nothing synced, else the
 * panel. The panel self-hides on an empty list, so without this the slot would vanish silently.
 */
export function DefaultBranchesSlot(): JSX.Element {
  const branch = useBranchStatus();
  // `?? []` is load-bearing: a response missing the array (an older server, a test catch-all)
  // must read as "nothing", never throw — the SPA has no error boundary.
  const noBranch =
    branch.isSuccess && !branch.isPlaceholderData && !anyBranchSynced(branch.data?.repos ?? []);
  if (branch.data === undefined && !branch.isError) return <div className={skeleton} />;
  if (branch.isError && branch.data === undefined) {
    return <p className={fail}>Couldn’t load the default branches.</p>;
  }
  if (noBranch) return <p className={note}>No default branch has synced yet.</p>;
  return <BranchStatusPanel />;
}

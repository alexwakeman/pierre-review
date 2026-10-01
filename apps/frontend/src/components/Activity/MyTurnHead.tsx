import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useWorkspaceOpenPrs } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { anyBranchSynced, BranchStatusPanel } from './BranchStatusPanel.js';
import { openPrsButtonCount, openPrsButtonLabel } from './pendingTabs.js';

// The top of Pending → My turn (and ONLY My turn — see `showsMyTurnHead`): an "Open PRs · N"
// button into the workspace-wide Open PRs tab, then the workspace's default-branch strip. Both used
// to live in My turn's second view ("Default branches and open PRs", `?attnView=branches`), which is
// retired; the repo-grouped open-PRs list it also held (`FeedOpenPrsPanel`) is no longer mounted —
// the button opens the full, sortable list instead.
//
// ⚠ NO NEW REQUESTS. Both reads share cache entries that already exist: the rail's argument-less
// `useBranchStatus()` (Activity/index.tsx sorts the rail by it, so it is in flight on every Pending
// visit — this adds a second observer to ONE query, not a second request) and the workspace-wide
// open-PRs key (FeedIsolationBanner, OpenPrsDetail, the Timeline board whenever its picker is
// unset). Neither is per-card: this mounts once per board.
//
// ⚠ INFORMATIONAL. Nothing read here reaches a tab badge, a my_turn count, the scorer, the liveness
// sweep or a notification — trunk status is a readout, not an alert channel, and the open-PR figure
// is a way into a list, not a claim on the reader.
const skeleton =
  'h-9 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40';
const note = 'text-[12px] text-gray-500 dark:text-gray-400';
const fail = 'text-[12px] text-red-600 dark:text-red-400';

/** "Open PRs · N" — opens the workspace-wide Open PRs tab, the same one Reports → Flow metrics'
 *  Open PRs tile opens ('feed' scope). N counts NON-DRAFT open PRs; while it is unknown the
 *  button says "Open PRs" with no number, never 0. */
export function OpenPrsButton(): JSX.Element {
  const open = useWorkspaceOpenPrs();
  const openOpenPrsDetail = useFilters((s) => s.openOpenPrsDetail);
  const count = openPrsButtonCount(open.data, open.isPlaceholderData);
  return (
    <button
      type="button"
      onClick={() => openOpenPrsDetail('feed')}
      className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900/60"
    >
      <span className="tabular-nums">{openPrsButtonLabel(count)}</span>
    </button>
  );
}

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

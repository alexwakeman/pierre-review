import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useWorkspaceOpenPrs } from '../../hooks/useTriage.js';
import { anyBranchSynced, BranchStatusPanel } from './BranchStatusPanel.js';
import { FeedOpenPrsPanel } from './FeedOpenPrsPanel.js';

// Pending → My turn → "Default branches and open PRs": every default branch in the workspace and
// every open PR, MOVED here from the Feed (which is now the stream alone).
//
// ⚠ MOUNTED ONLY WHILE THIS VIEW IS ON SCREEN (AttentionView), so the board's default view issues
// nothing for it. Both reads share existing cache entries: the rail's argument-less
// `useBranchStatus()`, and the workspace-wide open-PRs key (FeedIsolationBanner, OpenPrsDetail, and
// the Timeline board whenever its picker is unset).
//
// ⚠ INFORMATIONAL. Nothing read here reaches a tab badge, a my_turn count, the scorer, the
// liveness sweep or a notification — trunk status is a readout, not an alert channel.
//
// ⚠ UNKNOWN IS NEVER ZERO. Each slot is a placeholder while its query has no answer (INCLUDING the
// idle state while the workspace is unresolved — a disabled v5 query is pending, not loading), a
// sentence when it failed, a sentence when it ANSWERED for this workspace with nothing, else its
// panel. Both panels self-hide on an empty list, so without this the view could be blank.
const skeleton =
  'h-9 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40';
const note = 'text-[12px] text-gray-500 dark:text-gray-400';
const fail = 'text-[12px] text-red-600 dark:text-red-400';

export function BranchesAndOpenPrsView(): JSX.Element {
  const branch = useBranchStatus();
  const open = useWorkspaceOpenPrs();
  // `?? []` is load-bearing: a response missing the array (an older server, a test catch-all)
  // must read as "nothing", never throw — the SPA has no error boundary.
  const noBranch =
    branch.isSuccess && !branch.isPlaceholderData && !anyBranchSynced(branch.data?.repos ?? []);
  const noOpen =
    open.isSuccess && !open.isPlaceholderData && (open.data?.prs ?? []).length === 0;
  return (
    <div className="space-y-3" data-testid="branches-and-open-prs">
      {branch.data === undefined && !branch.isError ? (
        <div className={skeleton} />
      ) : branch.isError && branch.data === undefined ? (
        <p className={fail}>Couldn’t load the default branches.</p>
      ) : noBranch ? (
        <p className={note}>No default branch has synced yet.</p>
      ) : (
        <BranchStatusPanel />
      )}
      {open.data === undefined && !open.isError ? (
        <div className={skeleton} />
      ) : open.isError && open.data === undefined ? (
        <p className={fail}>Couldn’t load the open PRs.</p>
      ) : noOpen ? (
        <p className={note}>No open PRs in this workspace.</p>
      ) : (
        <FeedOpenPrsPanel />
      )}
    </div>
  );
}

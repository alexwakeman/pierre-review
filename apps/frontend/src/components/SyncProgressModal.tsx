import type { Repo, SyncStatus } from '@pierre-review/shared';

// A dismissible, determinate progress modal shown while a user-initiated sync
// (esp. a deep re-sync) is in flight. The sync continues server-side even if
// dismissed — closing just hides this overlay.
export function SyncProgressModal({
  repos,
  statuses,
  cancelling,
  onCancel,
}: {
  repos: Repo[];
  statuses: SyncStatus[] | undefined;
  cancelling: boolean;
  onCancel: () => void;
}): JSX.Element {
  const statusFor = (id: number): SyncStatus | undefined =>
    statuses?.find((s) => s.repoId === id);

  // Treat a repo as still running until a status poll explicitly reports it
  // idle/done. That covers two "not done yet" cases: before the first poll
  // lands (`statuses` undefined), and a freshly-added repo the poll hasn't
  // scoped in yet (no entry for its id) — either way we avoid flashing "done".
  const isRunning = (id: number): boolean => {
    if (statuses === undefined) return true;
    const s = statusFor(id);
    return s === undefined || s.status === 'running';
  };

  const completeCount = repos.filter((r) => !isRunning(r.id)).length;
  // `repos` can be momentarily empty right after an add (the scoped repo hasn't
  // landed in the ['repos'] cache yet) — guard so an empty list doesn't read as
  // "all done" and flash the complete state.
  const allDone = repos.length > 0 && completeCount === repos.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="presentation"
    >
      <div
        className="w-[28rem] max-w-[90vw] rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900"
        role="dialog"
        aria-modal="true"
        aria-label="Sync progress"
      >
        {/* No dismiss affordance (no ✕, no outside-click): the sync can only be
            left by letting it finish — it auto-closes — or by Cancel below. */}
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {cancelling
              ? 'Cancelling…'
              : repos.length === 0
                ? 'Starting sync…'
                : allDone
                  ? 'Sync complete'
                  : `Syncing ${repos.length} repo${repos.length === 1 ? '' : 's'}`}
          </h2>
        </div>

        <ul className="space-y-3">
          {repos.map((r) => {
            const s = statusFor(r.id);
            const running = isRunning(r.id);
            const errored = s?.status === 'error';
            const prs = s?.progress?.prsProcessed ?? 0;
            const percent = running ? Math.round((s?.progress?.percent ?? 0) * 100) : 100;
            return (
              <li key={r.id}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium" title={r.fullName}>
                    {r.fullName}
                  </span>
                  <span className="shrink-0 text-gray-500">
                    {errored ? (
                      <span className="text-red-500">error</span>
                    ) : running ? (
                      `${percent}%${prs > 0 ? ` · ${prs} PRs` : ''}`
                    ) : (
                      <span className="text-green-600 dark:text-green-400">
                        ✓ done{prs > 0 ? ` · ${prs} PRs` : ''}
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
                  <div
                    className={`h-2 rounded transition-all duration-500 ${
                      errored
                        ? 'bg-red-500'
                        : running
                          ? 'bg-blue-500'
                          : 'bg-green-500'
                    }`}
                    style={{ width: `${errored ? 100 : percent}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-center justify-between gap-3 text-xs text-gray-500">
          <span>
            {completeCount} of {repos.length} repo{repos.length === 1 ? '' : 's'} complete
          </span>
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            title="Stop the sync and remove any repos still loading for the first time"
            className="rounded border border-red-300 px-3 py-1 text-red-600 hover:border-red-400 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

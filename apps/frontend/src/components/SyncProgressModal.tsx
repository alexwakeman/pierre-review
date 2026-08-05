import { useRef } from 'react';
import type { MlEnrichmentStatus, Repo, SyncStatus } from '@pierre-review/shared';
import { isMlScoring } from '../hooks/useMlLabels.js';

// A dismissible, determinate progress modal shown while a user-initiated sync
// (esp. a deep re-sync) is in flight. The sync continues server-side even if
// dismissed — closing just hides this overlay.
//
// A SYNC HAS TWO HALVES and this modal shows both. The GitHub walk fills the rows below; the
// ML severity pass that scores the bot text the walk just stored gets its own row, because it
// runs AFTER the walk (it cannot run inside it — docs/ML-SEVERITY.md) and the board's badges do
// not exist until it lands. Declaring "Sync complete" at the end of the walk was reporting half
// the work as all of it.
export function SyncProgressModal({
  repos,
  statuses,
  ml,
  cancelling,
  onCancel,
  onDismiss,
}: {
  repos: Repo[];
  statuses: SyncStatus[] | undefined;
  /** Live scoring state, or undefined/disabled where no severity-api is configured. */
  ml: MlEnrichmentStatus | undefined;
  cancelling: boolean;
  onCancel: () => void;
  /** Close the overlay and leave both halves running server-side. */
  onDismiss: () => void;
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

  const scoring = isMlScoring(ml);
  // The backlog is only known once it exists, and it SHRINKS as the worker drains it — so the
  // high-water mark is the only honest denominator for a bar. Held in a ref rather than state
  // because it is derived from data we already re-render on, and it resets naturally: the modal
  // unmounts when it closes, so each round starts from zero.
  const peakPendingRef = useRef(0);
  if (ml && ml.pending > peakPendingRef.current) peakPendingRef.current = ml.pending;
  const peakPending = peakPendingRef.current;
  const scored = Math.max(0, peakPending - (ml?.pending ?? 0));
  const scorePercent =
    peakPending > 0
      ? Math.min(100, Math.round((scored / peakPending) * 100))
      : scoring
        ? 0 // working, but no measured backlog yet — not "finished"
        : 100;
  // Show the row while scoring runs, and afterwards only if this round actually scored
  // something (so the last frame is a full "✓ scored · N" bar).
  //
  // ⚠ NOT `peakPending > 0`. Backlog can exist with nothing draining it — a handful of comments
  // the service rejects sit there permanently — and that combination rendered a "✓ scored"
  // against a 0% bar: a tick beside an empty progress bar, claiming completion of work that had
  // not started. Nothing to report is better reported by rendering nothing.
  const showMlRow = Boolean(ml?.enabled) && (scoring || scored > 0);

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
            left by letting it finish — it auto-closes — or by the footer button. */}
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {cancelling
              ? 'Cancelling…'
              : repos.length === 0
                ? 'Starting sync…'
                : !allDone
                  ? `Syncing ${repos.length} repo${repos.length === 1 ? '' : 's'}`
                  : // The walk is done but the badges are not: say so rather than "complete".
                    scoring
                    ? 'Scoring bot comments…'
                    : 'Sync complete'}
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

        {showMlRow && (
          <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate font-medium" title="Local severity model — nothing billed">
                Scoring bot comments
              </span>
              <span className="shrink-0 text-gray-500">
                {scoring ? (
                  `${scorePercent}%${ml && ml.pending > 0 ? ` · ${ml.pending.toLocaleString()} to go` : ''}`
                ) : (
                  <span className="text-green-600 dark:text-green-400">
                    ✓ scored{scored > 0 ? ` · ${scored.toLocaleString()}` : ''}
                  </span>
                )}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
              <div
                className={`h-2 rounded transition-all duration-500 ${
                  scoring ? 'bg-violet-500' : 'bg-green-500'
                }`}
                style={{ width: `${scorePercent}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
              {ml?.markerFallback
                ? 'Severity model unavailable — labelling from markers only.'
                : 'Severity + category labels for the bot comments this sync brought in.'}
            </p>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-3 text-xs text-gray-500">
          <span>
            {completeCount} of {repos.length} repo{repos.length === 1 ? '' : 's'} complete
          </span>
          {/* Once every repo has finished walking there is nothing left to cancel — no repo is
              mid-initial-backfill, so Cancel would be a no-op — and the scoring pass can take a
              long time on a first backfill (tens of thousands of comments). So the button
              becomes a plain close: the board is already usable, and the header indicator keeps
              reporting the scoring until it finishes. */}
          {allDone && !cancelling ? (
            <button
              type="button"
              onClick={onDismiss}
              title={
                scoring
                  ? 'Close this. Scoring keeps running in the background.'
                  : 'Close'
              }
              className="rounded border border-gray-300 px-3 py-1 text-gray-600 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {scoring ? 'Continue in background' : 'Close'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              title="Stop the sync and remove any repos still loading for the first time"
              className="rounded border border-red-300 px-3 py-1 text-red-600 hover:border-red-400 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

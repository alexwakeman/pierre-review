import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  MlEnrichmentStatus,
  Repo,
  SyncProgress,
  SyncStatus,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { isMlScoring, useMlEnrichmentStatus } from '../hooks/useMlLabels.js';
import { getSyncRoundActions, useFilters } from '../store/filters.js';

// Download-to-tray glyph for "Deep re-sync" — visually distinguishes the heavier action.
// Lives here (not SyncStatus) so the WorkspaceManager's deep-sync buttons can share it.
export function DeepSyncIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="5" y1="21" x2="19" y2="21" />
    </svg>
  );
}

// "Paused — resuming ~HH:MM" needs a local wall-clock time; an unparseable/absent
// estimate degrades to "shortly" rather than "~Invalid Date".
function resumeLabel(resumeAt: string | undefined): string {
  if (!resumeAt) return 'resuming shortly';
  const d = new Date(resumeAt);
  if (Number.isNaN(d.getTime())) return 'resuming shortly';
  return `resuming ~${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// The presentational guts of the sync-progress surface: per-repo rows, the ML scoring row and
// the footer actions. Rendered in TWO hosts — the standalone SyncProgressModal (the onboarding
// add path) and the WorkspaceManager's embedded right-hand column — so it carries no overlay
// chrome of its own.
//
// A SYNC HAS TWO HALVES and this panel shows both. The GitHub walk fills the rows below; the
// ML severity pass that scores the bot text the walk just stored gets its own row, because it
// runs AFTER the walk (it cannot run inside it — docs/ML-SEVERITY.md) and the board's badges do
// not exist until it lands. Declaring "Sync complete" at the end of the walk was reporting half
// the work as all of it.
export function SyncProgressPanel({
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
  /** Hide this surface and leave both halves running server-side. */
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
  // because it is derived from data we already re-render on, and it resets naturally: the panel
  // unmounts when its host closes, so each round starts from zero.
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
    <div>
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
          // A PAUSED walk is a RUNNING walk holding still on purpose (rate-limit wait, or
          // queued behind another sync). It is NOT an error — red stays exclusively for
          // status === 'error' — so it gets its own quiet colours: amber for a rate-limit
          // wait, neutral for the queue.
          const paused: SyncProgress['paused'] =
            s?.status === 'running' ? s.progress?.paused : undefined;
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
                  ) : paused?.reason === 'rate_limit' ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      Paused — GitHub rate limit, {resumeLabel(paused.resumeAt)}
                    </span>
                  ) : paused?.reason === 'queued' ? (
                    <span>Waiting for another sync…</span>
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
                      : paused?.reason === 'rate_limit'
                        ? 'bg-amber-500'
                        : paused?.reason === 'queued'
                          ? 'bg-gray-400 dark:bg-gray-600'
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
                scoring ? 'bg-ai-signal-fill' : 'bg-green-500'
              }`}
              style={{ width: `${scorePercent}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            {ml?.markerFallback
              ? 'Severity model unavailable — labelling from markers only.'
              : 'Severity + category labels for the bot comments this sync brought in.'}
            {/* Quiet, and only when real: legacy rows with no stored text are outside this
                bar's denominator on purpose — they are not work in flight, so folding them
                into the count would spin the bar on rows nothing will ever score. */}
            {ml && ml.unscorable > 0
              ? ` ${ml.unscorable.toLocaleString()} unscorable (no stored text).`
              : null}
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
  );
}

// The CONNECTED wrapper the WorkspaceManager embeds: reads the shared sync round from the
// store and the driver's own React Query caches, scopes them, and renders the panel above.
//
// It deliberately mounts OBSERVERS on the exact caches SyncStatus (the driver) already polls —
// ['repos'], ['sync-status', <repo-id key>] and (via useMlEnrichmentStatus) ['ml-status'] —
// with the same keys and enable conditions, so no second request stream exists: React Query
// dedupes the observers onto one fetch. All round-state WRITES stay in the driver; this
// component only reads and calls the registered actions.
export function EmbeddedSyncPanel(): JSX.Element | null {
  const round = useFilters((s) => s.syncRound);
  const { data: repos } = useQuery<Repo[]>({
    queryKey: ['repos'],
    queryFn: api.listRepos,
  });
  // MUST match SyncStatus's key construction byte-for-byte (['sync-status', ids.join(',')])
  // or the two observers stop sharing a cache entry and this panel starts its own poll.
  const repoIdsKey = (repos ?? []).map((r) => r.id).join(',');
  const { data: statuses } = useQuery<SyncStatus[]>({
    queryKey: ['sync-status', repoIdsKey],
    enabled: round.syncing && !!repos && repos.length > 0,
    queryFn: () => Promise.all((repos ?? []).map((r) => api.syncStatus(r.id))),
    refetchInterval: 1500,
  });
  const { data: ml } = useMlEnrichmentStatus(round.open || round.syncing);

  if (!round.open) return null;

  // Same scope semantics as the driver: an EMPTY id set means "all repos".
  const scopeSet = new Set(round.scopeIds);
  const scopedRepos =
    scopeSet.size === 0 ? repos ?? [] : (repos ?? []).filter((r) => scopeSet.has(r.id));
  const scopedIds = new Set(scopedRepos.map((r) => r.id));
  const scopedStatuses =
    statuses == null ? undefined : statuses.filter((s) => scopedIds.has(s.repoId));

  return (
    <SyncProgressPanel
      repos={scopedRepos}
      statuses={scopedStatuses}
      ml={ml}
      cancelling={round.cancelling}
      onCancel={() => getSyncRoundActions()?.cancel()}
      onDismiss={() => getSyncRoundActions()?.dismiss()}
    />
  );
}

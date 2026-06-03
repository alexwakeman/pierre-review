import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Repo, SyncStatus as SyncStatusT } from '@gh-team-monitor/shared';
import { api } from '../api/client.js';
import { relativeTime } from '../lib/ui.js';
import { useFilters } from '../store/filters.js';
import { SyncProgressModal } from './SyncProgressModal.js';

function mostRecentSync(repos: Repo[]): string | null {
  let latest: string | null = null;
  for (const r of repos) {
    const t = r.lastIncrementalSyncAt ?? r.lastFullSyncAt;
    if (t && (!latest || t > latest)) latest = t;
  }
  return latest;
}

// Matches the backend's default cron (`*/5 * * * *` in config.ts): the scheduler
// fires on clock boundaries (:00, :05, :10, …), not 5 min after the last run.
const SYNC_INTERVAL_MIN = 5;

const hhmm = (d: Date): string =>
  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// The next clock boundary that's a multiple of the interval, strictly after now.
function nextSyncAt(intervalMin: number): Date {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(Math.floor(now.getMinutes() / intervalMin) * intervalMin + intervalMin);
  return next;
}

// Tooltip for the "synced …" label: explain the automatic cadence and when the
// next sync lands (absolute time + an approximate countdown).
function syncTooltip(lastSync: string | null): string {
  const next = nextSyncAt(SYNC_INTERVAL_MIN);
  const mins = Math.max(1, Math.round((next.getTime() - Date.now()) / 60000));
  const lines = lastSync ? [`Last synced ${hhmm(new Date(lastSync))}`] : [];
  lines.push(`Syncs automatically every ${SYNC_INTERVAL_MIN} minutes`);
  lines.push(`Next sync ~${hhmm(next)} (in ${mins} min)`);
  return lines.join('\n');
}

export function SyncStatus(): JSX.Element | null {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  // The progress overlay is tracked separately from `syncing` so it stays up
  // showing the "✓ done" state after the sync finishes — the user dismisses it.
  const [modalOpen, setModalOpen] = useState(false);

  // Dedicated observer on the shared ['repos'] cache that polls for fresh
  // sync timestamps.
  const { data: repos } = useQuery<Repo[]>({
    queryKey: ['repos'],
    queryFn: api.listRepos,
    refetchInterval: syncing ? 3000 : 30000,
  });

  // Per-repo running state, polled only while a manual sync is in flight, so
  // the user sees progress instead of a single opaque "syncing…".
  const { data: statuses } = useQuery<SyncStatusT[]>({
    queryKey: ['sync-status'],
    enabled: syncing && !!repos && repos.length > 0,
    queryFn: () => Promise.all((repos ?? []).map((r) => api.syncStatus(r.id))),
    refetchInterval: 1500,
  });
  const runningCount = (statuses ?? []).filter((s) => s.status === 'running').length;

  const lastSync = mostRecentSync(repos ?? []);
  const prevLastSync = useRef<string | null>(lastSync);

  const invalidateData = (): void => {
    void qc.invalidateQueries({ queryKey: ['timeline'] });
    void qc.invalidateQueries({ queryKey: ['open-prs'] });
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['my-turn'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };

  // When a sync lands (the latest timestamp advances), refresh timeline data.
  useEffect(() => {
    if (prevLastSync.current !== lastSync) {
      prevLastSync.current = lastSync;
      invalidateData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSync]);

  // Drop the "syncing…" indicator once every repo reports idle again.
  useEffect(() => {
    if (syncing && statuses && runningCount === 0) {
      setSyncing(false);
      invalidateData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing, statuses, runningCount]);

  // A freshly-added repo bumps syncModalSignal: pop the progress modal and start
  // polling so its initial backfill (which can take a while) is visible. The
  // repo's background sync is already running server-side — we don't re-trigger
  // anything here, just open the overlay and turn on the status poll. This effect
  // runs even while the component renders null (no repos yet, e.g. the very first
  // add); the modal paints as soon as the invalidated ['repos'] query refetches.
  const syncModalSignal = useFilters((s) => s.syncModalSignal);
  const prevSyncSignal = useRef(syncModalSignal);
  useEffect(() => {
    if (syncModalSignal === prevSyncSignal.current) return;
    prevSyncSignal.current = syncModalSignal;
    setModalOpen(true);
    setSyncing(true);
    void qc.invalidateQueries({ queryKey: ['repos'] });
    void qc.invalidateQueries({ queryKey: ['sync-status'] });
  }, [syncModalSignal, qc]);

  if (!repos || repos.length === 0) return null;

  const erroredRepo = repos.find((r) => r.lastSyncStatus === 'error');

  const syncNow = async (full = false): Promise<void> => {
    setSyncing(true);
    setModalOpen(true);
    await Promise.allSettled(repos.map((r) => api.syncRepo(r.id, full)));
    void qc.invalidateQueries({ queryKey: ['repos'] });
    void qc.invalidateQueries({ queryKey: ['sync-status'] });
  };

  const progress =
    runningCount > 0
      ? `syncing ${runningCount} repo${runningCount === 1 ? '' : 's'}…`
      : 'syncing…';

  return (
    <>
      {modalOpen && (
        <SyncProgressModal
          repos={repos}
          statuses={statuses}
          onClose={() => {
            setModalOpen(false);
            setSyncing(false);
          }}
        />
      )}
      <div className="flex items-center gap-2 text-xs text-gray-500">
      {erroredRepo ? (
        <span className="text-red-500" title={erroredRepo.lastSyncError ?? ''}>
          sync error: {erroredRepo.fullName}
        </span>
      ) : (
        <span className="cursor-help" title={syncTooltip(lastSync)}>
          {syncing
            ? progress
            : lastSync
              ? `synced ${relativeTime(lastSync)}`
              : 'not synced yet'}
        </span>
      )}
      <button
        type="button"
        onClick={() => void syncNow(false)}
        disabled={syncing}
        className="rounded border border-gray-300 px-2 py-0.5 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
      >
        Sync now
      </button>
      <button
        type="button"
        onClick={() => {
          if (
            window.confirm(
              'Deep re-sync re-fetches the full backfill window for every repo. ' +
                'Slower, but catches CI/thread changes the incremental sync can lag. Continue?',
            )
          ) {
            void syncNow(true);
          }
        }}
        disabled={syncing}
        className="rounded px-1.5 py-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-50"
        title="Force a full backfill for all repos"
      >
        deep
      </button>
      </div>
    </>
  );
}

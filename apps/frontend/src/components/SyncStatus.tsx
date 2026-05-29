import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Repo } from '@gh-team-monitor/shared';
import { api } from '../api/client.js';
import { relativeTime } from '../lib/ui.js';

function mostRecentSync(repos: Repo[]): string | null {
  let latest: string | null = null;
  for (const r of repos) {
    const t = r.lastIncrementalSyncAt ?? r.lastFullSyncAt;
    if (t && (!latest || t > latest)) latest = t;
  }
  return latest;
}

export function SyncStatus(): JSX.Element | null {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  // Dedicated observer on the shared ['repos'] cache that polls for fresh
  // sync timestamps.
  const { data: repos } = useQuery<Repo[]>({
    queryKey: ['repos'],
    queryFn: api.listRepos,
    refetchInterval: syncing ? 3000 : 30000,
  });

  const lastSync = mostRecentSync(repos ?? []);
  const prevLastSync = useRef<string | null>(lastSync);

  // When a sync lands (the latest timestamp advances), refresh timeline data
  // and drop the "syncing…" indicator.
  useEffect(() => {
    if (prevLastSync.current !== lastSync) {
      prevLastSync.current = lastSync;
      setSyncing(false);
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    }
  }, [lastSync, qc]);

  if (!repos || repos.length === 0) return null;

  const erroredRepo = repos.find((r) => r.lastSyncStatus === 'error');

  const syncNow = async () => {
    setSyncing(true);
    await Promise.allSettled(repos.map((r) => api.syncRepo(r.id)));
    void qc.invalidateQueries({ queryKey: ['repos'] });
  };

  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      {erroredRepo ? (
        <span className="text-red-500" title={erroredRepo.lastSyncError ?? ''}>
          sync error: {erroredRepo.fullName}
        </span>
      ) : (
        <span title={lastSync ?? 'never synced'}>
          {syncing
            ? 'syncing…'
            : lastSync
              ? `synced ${relativeTime(lastSync)}`
              : 'not synced yet'}
        </span>
      )}
      <button
        type="button"
        onClick={() => void syncNow()}
        disabled={syncing}
        className="rounded border border-gray-300 px-2 py-0.5 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
      >
        Sync now
      </button>
    </div>
  );
}

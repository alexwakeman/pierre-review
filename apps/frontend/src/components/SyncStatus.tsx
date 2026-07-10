import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Repo, SyncStatus as SyncStatusT } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_QUERY_KEYS } from '../hooks/useActivity.js';
import { relativeTime } from '../lib/ui.js';
import { useFilters } from '../store/filters.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { SyncProgressModal } from './SyncProgressModal.js';

// Circular-arrows glyph for the sync trigger + "Sync now" item; spins while a sync runs.
function RefreshIcon({
  spinning = false,
  size = 14,
}: {
  spinning?: boolean;
  size?: number;
}): JSX.Element {
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
      className={spinning ? 'animate-spin' : undefined}
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

// Download-to-tray glyph for "Deep re-sync" — visually distinguishes the heavier action.
function DeepSyncIcon({ size = 14 }: { size?: number }): JSX.Element {
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
  // The progress overlay is tracked separately from `syncing`: it lingers on the
  // final "✓ done" state for a beat after the sync settles, then auto-closes (a
  // pending close is scheduled in the completion effect below).
  const [modalOpen, setModalOpen] = useState(false);
  // Latch: have we actually OBSERVED a sync running since `syncing` went true?
  // A just-triggered (or just-added) repo isn't reflected in the status poll for
  // a tick or two, so `runningCount === 0` on its own can't tell "not started
  // yet" apart from "finished" — gating completion on this avoids declaring the
  // sync done (and refetching half-written data) before it has even begun.
  const [seenRunning, setSeenRunning] = useState(false);
  // True while a user-initiated Cancel is in flight (the backend stops the sync
  // and removes initial-load repos before the request resolves).
  const [cancelling, setCancelling] = useState(false);
  // Which repos the open modal tracks: a set of just-added repo ids (so the
  // add-flow modal ignores a concurrent scheduled sync of the OTHER repos that
  // would otherwise bounce their bars). An EMPTY set means "all repos" (a manual
  // sync) — the same null-sentinel semantics the single id used to carry. Adds in
  // quick succession accumulate into this set so each new repo gets its own row.
  const [modalScopeIds, setModalScopeIds] = useState<number[]>([]);
  // The header sync control is now a dropdown menu (mirrors UserMenu): a compact
  // trigger that shows freshness at a glance (spinning icon while syncing, a red dot
  // on error) and opens a menu with the status line + Sync now / Deep re-sync actions.
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dedicated observer on the shared ['repos'] cache that polls for fresh
  // sync timestamps.
  const { data: repos } = useQuery<Repo[]>({
    queryKey: ['repos'],
    queryFn: api.listRepos,
    refetchInterval: syncing ? 3000 : 30000,
  });

  // Per-repo running state, polled only while a manual sync is in flight, so
  // the user sees progress instead of a single opaque "syncing…". Keyed on the
  // repo-id set so adding a repo mid-session re-scopes the poll to include it
  // (otherwise a brand-new repo's backfill is invisible to the status poll).
  const repoIdsKey = (repos ?? []).map((r) => r.id).join(',');
  const { data: statuses } = useQuery<SyncStatusT[]>({
    queryKey: ['sync-status', repoIdsKey],
    enabled: syncing && !!repos && repos.length > 0,
    queryFn: () => Promise.all((repos ?? []).map((r) => api.syncStatus(r.id))),
    refetchInterval: 1500,
  });
  // Restrict the modal + completion tracking to the in-scope repos (just the
  // freshly-added one(s) on an add; everything on a manual sync). An empty scope
  // set is the "all repos" sentinel. scopedStatuses stays `undefined` until the
  // first poll lands so the modal doesn't briefly flash "done".
  const scopeSet = new Set(modalScopeIds);
  const scopedRepos =
    scopeSet.size === 0
      ? repos ?? []
      : (repos ?? []).filter((r) => scopeSet.has(r.id));
  const scopedIds = new Set(scopedRepos.map((r) => r.id));
  const scopedStatuses =
    statuses == null ? undefined : statuses.filter((s) => scopedIds.has(s.repoId));
  const runningScoped = (scopedStatuses ?? []).filter((s) => s.status === 'running');
  const runningCount = runningScoped.length;
  // Two-phase first sync: true once every running in-scope repo has finished its
  // fast foreground window and is extending the backfill in the background — the
  // moment to drop the user into the (now-populated) recent board.
  const foregroundComplete =
    runningCount > 0 && runningScoped.every((s) => s.progress?.foregroundComplete === true);

  const lastSync = mostRecentSync(repos ?? []);
  const prevLastSync = useRef<string | null>(lastSync);
  // Latch so the foreground→background handoff (close the modal, refresh the
  // recent board) runs once per sync round, not on every poll while phase 2 runs.
  const foregroundHandledRef = useRef(false);

  // Pending auto-close of the progress modal. Held in a ref so a fresh sync can
  // cancel a close that a previous round scheduled.
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelAutoClose = (): void => {
    if (autoCloseTimerRef.current != null) {
      clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }
  };
  // Mark that a fresh sync round is starting: require a new running observation
  // before we treat it as complete, and drop any close queued by the last round.
  const beginSyncRound = (): void => {
    setSeenRunning(false);
    foregroundHandledRef.current = false;
    cancelAutoClose();
  };
  useEffect(() => cancelAutoClose, []);

  // Dropdown dismissal, matching UserMenu: click-outside + Escape. stopPropagation on
  // Escape so it doesn't bubble to the global `esc` handler (useKeyboard), which would
  // otherwise leave the current tab/overlay too.
  useClickOutside(rootRef, () => setMenuOpen(false), menuOpen);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const invalidateData = (): void => {
    void qc.invalidateQueries({ queryKey: ['timeline'] });
    void qc.invalidateQueries({ queryKey: ['open-prs'] });
    void qc.invalidateQueries({ queryKey: ['users'] });
    // Merge-rights (maintainer shields) are first fetched empty on a fresh add —
    // before the backfill lands any merged PRs — so they MUST refresh when a sync
    // completes, or the shields never appear until a manual page reload.
    void qc.invalidateQueries({ queryKey: ['mergers'] });
    void qc.invalidateQueries({ queryKey: ['my-turn'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
    // Keep the Activity console (rail aggregate + feed + Insights) fresh on new synced data,
    // so it stays current without a manual Refresh.
    for (const key of ACTIVITY_QUERY_KEYS) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  // When a sync lands (the latest timestamp advances), refresh timeline data.
  useEffect(() => {
    if (prevLastSync.current !== lastSync) {
      prevLastSync.current = lastSync;
      invalidateData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSync]);

  // Two-phase first sync handoff: the instant the fast foreground window is done,
  // close the progress modal and refresh the (now-populated) recent board so the
  // user can start working — while the deeper backfill keeps running in the
  // background. The repo stays `running`, so the poll and the completion effect
  // below still fire when phase 2 finishes (bringing in the older history). Runs
  // once per round via the latch.
  useEffect(() => {
    if (!syncing || !foregroundComplete || foregroundHandledRef.current) return;
    foregroundHandledRef.current = true;
    setModalOpen(false);
    invalidateData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing, foregroundComplete]);

  // Latch the moment we first see a repo actually running this round.
  useEffect(() => {
    if (runningCount > 0) setSeenRunning(true);
  }, [runningCount]);

  // Completion: once we've observed a running sync and every repo reports idle
  // again, drop the "syncing…" indicator, refresh data, and auto-dismiss the
  // progress modal a second later (long enough to show the final "✓ done").
  useEffect(() => {
    if (syncing && seenRunning && statuses && runningCount === 0) {
      setSyncing(false);
      setSeenRunning(false);
      invalidateData();
      cancelAutoClose();
      autoCloseTimerRef.current = setTimeout(() => {
        setModalOpen(false);
        autoCloseTimerRef.current = null;
      }, 1000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing, seenRunning, statuses, runningCount]);

  // A freshly-added repo bumps syncModalSignal: pop the progress modal and start
  // polling so its initial backfill (which can take a while) is visible. The
  // repo's background sync is already running server-side — we don't re-trigger
  // anything here, just open the overlay and turn on the status poll. This effect
  // runs even while the component renders null (no repos yet, e.g. the very first
  // add); the modal paints as soon as the invalidated ['repos'] query refetches.
  const syncModalSignal = useFilters((s) => s.syncModalSignal);
  const syncModalRepoId = useFilters((s) => s.syncModalRepoId);
  const prevSyncSignal = useRef(syncModalSignal);
  useEffect(() => {
    if (syncModalSignal === prevSyncSignal.current) return;
    prevSyncSignal.current = syncModalSignal;
    if (syncModalRepoId == null) return; // defensive: requestSyncModal always sets one
    if (modalOpen) {
      // A round is already in flight: MERGE the new repo into the scope so it gets
      // its own progress row, but do NOT call beginSyncRound() — that resets
      // seenRunning / cancels the auto-close and would stomp the completion
      // tracking for repos already being watched this round. The completion effect
      // keys off runningCount===0 across the (now-larger) scope, so it naturally
      // waits for ALL scoped repos before declaring the round done.
      setModalScopeIds((ids) => (ids.includes(syncModalRepoId) ? ids : [...ids, syncModalRepoId]));
    } else {
      // Modal closed: start a fresh round scoped to just this repo.
      setModalScopeIds([syncModalRepoId]);
      setModalOpen(true);
      setSyncing(true);
      beginSyncRound();
    }
    void qc.invalidateQueries({ queryKey: ['repos'] });
    void qc.invalidateQueries({ queryKey: ['sync-status'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncModalSignal, qc]);

  if (!repos || repos.length === 0) return null;

  const erroredRepo = repos.find((r) => r.lastSyncStatus === 'error');

  const syncNow = async (full = false): Promise<void> => {
    setSyncing(true);
    setModalOpen(true);
    setModalScopeIds([]); // empty = manual sync shows ALL repos
    beginSyncRound();
    await Promise.allSettled(repos.map((r) => api.syncRepo(r.id, full)));
    void qc.invalidateQueries({ queryKey: ['repos'] });
    void qc.invalidateQueries({ queryKey: ['sync-status'] });
  };

  // Cancel the run: stop every repo that's still syncing (the backend aborts the
  // sync and deletes any repo still on its initial backfill), then close. Repos
  // that already had data keep it. This is the modal's ONLY exit besides letting
  // it finish.
  const cancelSync = async (): Promise<void> => {
    setCancelling(true);
    cancelAutoClose();
    // Only the in-scope repos: cancelling an add must not abort a background
    // scheduled sync of the established repos.
    const runningIds = (scopedStatuses ?? [])
      .filter((s) => s.status === 'running')
      .map((s) => s.repoId);
    // Fall back to the scoped repos if the status poll hasn't landed yet — the
    // backend no-ops on repos that aren't actually running.
    const ids = runningIds.length ? runningIds : scopedRepos.map((r) => r.id);
    await Promise.allSettled(ids.map((id) => api.cancelSync(id)));
    setSyncing(false);
    setSeenRunning(false);
    setCancelling(false);
    setModalOpen(false);
    void qc.invalidateQueries({ queryKey: ['repos'] }); // drop any deleted repos
    invalidateData();
  };

  const progress = foregroundComplete
    ? 'loading older history…'
    : runningCount > 0
      ? `syncing ${runningCount} repo${runningCount === 1 ? '' : 's'}…`
      : 'syncing…';

  return (
    <>
      {modalOpen && (
        <SyncProgressModal
          repos={scopedRepos}
          statuses={scopedStatuses}
          cancelling={cancelling}
          onCancel={() => void cancelSync()}
        />
      )}
      <div ref={rootRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={
            erroredRepo
              ? `Sync error: ${erroredRepo.fullName}${
                  erroredRepo.lastSyncError ? ` — ${erroredRepo.lastSyncError}` : ''
                }`
              : syncTooltip(lastSync)
          }
          className={`relative flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 ${
            menuOpen ? 'bg-gray-100 dark:bg-gray-800' : ''
          }`}
        >
          <RefreshIcon spinning={syncing} />
          <span className="hidden sm:inline">Sync</span>
          {erroredRepo && !syncing && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 ring-1 ring-white dark:ring-gray-900"
            />
          )}
          <span aria-hidden className="text-[9px] text-gray-400">
            ▾
          </span>
        </button>

        {menuOpen && (
          <div
            role="menu"
            aria-label="Sync menu"
            className="absolute right-0 top-full z-[60] mt-1 w-64 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
          >
            <div className="px-3 py-1.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
              {erroredRepo ? (
                <span className="text-red-500">Sync error: {erroredRepo.fullName}</span>
              ) : syncing ? (
                <span>{progress}</span>
              ) : lastSync ? (
                <>
                  <span className="text-gray-600 dark:text-gray-300">
                    Synced {relativeTime(lastSync)}
                  </span>
                  <br />
                  <span>
                    Auto-syncs every {SYNC_INTERVAL_MIN} min · next ~
                    {hhmm(nextSyncAt(SYNC_INTERVAL_MIN))}
                  </span>
                </>
              ) : (
                'Not synced yet'
              )}
            </div>
            <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
            <button
              role="menuitem"
              type="button"
              disabled={syncing}
              onClick={() => {
                setMenuOpen(false);
                void syncNow(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <RefreshIcon spinning={syncing} />
              Sync now
            </button>
            <button
              role="menuitem"
              type="button"
              disabled={syncing}
              onClick={() => {
                if (
                  window.confirm(
                    'Deep re-sync re-fetches the full backfill window for every repo. ' +
                      'Slower, but catches CI/thread changes the incremental sync can lag. Continue?',
                  )
                ) {
                  setMenuOpen(false);
                  void syncNow(true);
                }
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-800"
              title="Force a full backfill for all repos"
            >
              <DeepSyncIcon />
              Deep re-sync…
            </button>
          </div>
        )}
      </div>
    </>
  );
}

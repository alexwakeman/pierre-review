import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Repo, SyncStatus as SyncStatusT } from '@pierre-review/shared';
import { api, ApiError } from '../api/client.js';
import { ACTIVITY_QUERY_KEYS } from '../hooks/useActivity.js';
import {
  registerSyncRoundActions,
  useFilters,
  type SyncRoundState,
} from '../store/filters.js';
import {
  isMlScoring,
  useMlEnrichmentStatus,
  useMlSeverityEnabled,
} from '../hooks/useMlLabels.js';
import { SyncProgressModal } from './SyncProgressModal.js';

// Circular-arrows glyph for the sync trigger; spins while a sync runs.
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

// Tooltip lines for the sync button: explain the automatic cadence and when the
// next sync lands (absolute time + an approximate countdown).
function syncTooltip(lastSync: string | null): string {
  const next = nextSyncAt(SYNC_INTERVAL_MIN);
  const mins = Math.max(1, Math.round((next.getTime() - Date.now()) / 60000));
  const lines = lastSync ? [`Last synced ${hhmm(new Date(lastSync))}`] : [];
  lines.push(`Syncs automatically every ${SYNC_INTERVAL_MIN} minutes`);
  lines.push(`Next sync ~${hhmm(next)} (in ${mins} min)`);
  return lines.join('\n');
}

// The header sync control + the single DRIVER of the shared sync round.
//
// The round's user-visible state lives in the store (`syncRound` — see store/filters.ts) so
// the WorkspaceManager's embedded progress panel and this header describe the same round, but
// ALL writes, polls, completion effects and invalidations stay HERE: SyncStatus is always
// mounted, so the round survives the manager opening and closing. It registers the round
// actions ({cancel, syncAllShallow, syncAllDeep, syncOneDeep, dismiss}) for other surfaces.
//
// The header button itself is a PLAIN button: click = shallow sync of all repos, no dialog —
// the icon spins until the whole round (walk + ML scoring) is done, and errors surface as the
// red dot + the hover tooltip. Deep re-sync lives in the WorkspaceManager now.
export function SyncStatus(): JSX.Element | null {
  const qc = useQueryClient();
  const round = useFilters((s) => s.syncRound);
  const setSyncRound = useFilters((s) => s.setSyncRound);
  const managerOpen = useFilters((s) => s.managerOpen);
  // Latch: have we actually OBSERVED a sync running since the round's walk began?
  // A just-triggered (or just-added) repo isn't reflected in the status poll for
  // a tick or two, so `runningCount === 0` on its own can't tell "not started
  // yet" apart from "finished" — gating completion on this avoids declaring the
  // sync done (and refetching half-written data) before it has even begun.
  const [seenRunning, setSeenRunning] = useState(false);

  // Dedicated observer on the shared ['repos'] cache that polls for fresh
  // sync timestamps.
  const { data: repos } = useQuery<Repo[]>({
    queryKey: ['repos'],
    queryFn: api.listRepos,
    refetchInterval: round.syncing ? 3000 : 30000,
  });

  // Per-repo running state, polled only while a manual sync is in flight, so
  // the user sees progress instead of a single opaque "syncing…". Keyed on the
  // repo-id set so adding a repo mid-session re-scopes the poll to include it
  // (otherwise a brand-new repo's backfill is invisible to the status poll).
  const repoIdsKey = (repos ?? []).map((r) => r.id).join(',');
  const { data: statuses } = useQuery<SyncStatusT[]>({
    queryKey: ['sync-status', repoIdsKey],
    enabled: round.syncing && !!repos && repos.length > 0,
    queryFn: () => Promise.all((repos ?? []).map((r) => api.syncStatus(r.id))),
    refetchInterval: 1500,
  });
  // Restrict the progress UI + completion tracking to the in-scope repos (just the
  // freshly-added one(s) on an add; everything on a manual sync). An empty scope
  // set is the "all repos" sentinel. scopedStatuses stays `undefined` until the
  // first poll lands so the progress UI doesn't briefly flash "done".
  const scopeSet = new Set(round.scopeIds);
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
  // moment to drop the user into the (now-populated) recent board. Rows waiting in
  // the per-account serial queue (paused.reason === 'queued') are excluded: they
  // can't start their foreground pass until the repos ahead finish their whole
  // backfill, so counting them would block a multi-add round's handoff forever.
  const nonQueuedRunning = runningScoped.filter(
    (s) => s.progress?.paused?.reason !== 'queued',
  );
  const foregroundComplete =
    nonQueuedRunning.length > 0 &&
    nonQueuedRunning.every((s) => s.progress?.foregroundComplete === true);

  // THE SECOND HALF OF A SYNC. The GitHub walk above only stores the text; the severity badges
  // the board renders come from a model pass that runs after it and can far outlast it. Polled
  // faster while a round is open, and it keeps polling itself while scoring continues — the
  // backlog outlives the round that produced it.
  const mlEnabled = useMlSeverityEnabled();
  const { data: ml, isFetched: mlFetched } = useMlEnrichmentStatus(
    round.syncing || round.open,
  );
  const mlScoring = isMlScoring(ml);
  // "The feature is on but we have not heard back yet." Load-bearing for the auto-close below:
  // a fast incremental walk can finish inside one poll interval, and closing on `undefined`
  // would recreate the very race this seam exists to remove. `isFetched` (not `isSuccess`) so a
  // failing status request unblocks the close instead of pinning the progress UI open forever.
  const mlUnknown = mlEnabled && !mlFetched;

  const lastSync = mostRecentSync(repos ?? []);
  const prevLastSync = useRef<string | null>(lastSync);
  // Latch so the foreground→background handoff (close the progress UI, refresh the
  // recent board) runs once per sync round, not on every poll while phase 2 runs.
  const foregroundHandledRef = useRef(false);

  // Pending auto-close of the progress UI. Held in a ref so a fresh sync can
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
  // close the progress UI and refresh the (now-populated) recent board so the
  // user can start working — while the deeper backfill keeps running in the
  // background. The repo stays `running`, so the poll and the completion effect
  // below still fire when phase 2 finishes (bringing in the older history). Runs
  // once per round via the latch.
  useEffect(() => {
    if (!round.syncing || !foregroundComplete || foregroundHandledRef.current) return;
    foregroundHandledRef.current = true;
    setSyncRound({ open: false });
    invalidateData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round.syncing, foregroundComplete]);

  // Latch the moment we first see a repo actually running this round.
  useEffect(() => {
    if (runningCount > 0) setSeenRunning(true);
  }, [runningCount]);

  // Completion of the WALK: once we've observed a running sync and every repo reports idle
  // again, drop the "syncing…" indicator and refresh data. The progress UI is NOT closed here —
  // closing is the separate effect below, because the walk finishing is not the sync finishing.
  useEffect(() => {
    if (round.syncing && seenRunning && statuses && runningCount === 0) {
      setSyncRound({ syncing: false });
      setSeenRunning(false);
      invalidateData();
      // Ask the worker where it is RIGHT NOW rather than waiting out the poll interval: the
      // backend kicks a scoring tick before it releases the repo, so this observation is what
      // tells the progress UI whether "done" is actually done.
      void qc.invalidateQueries({ queryKey: ['ml-status'] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round.syncing, seenRunning, statuses, runningCount]);

  // Auto-dismiss the progress UI — gated on BOTH halves being idle. The walk ending used to
  // schedule this directly, which is exactly what made the model pass unrepresentable: the
  // overlay closed on "✓ done" while scoring was only just starting. Its own effect so the close
  // is scheduled whenever the last half settles, which for a small sync is the walk and for a
  // first backfill is the scoring, minutes later. (The user is never trapped: once every repo is
  // done the footer button becomes "Continue in background".)
  useEffect(() => {
    if (!round.open || round.syncing || round.cancelling || mlScoring || mlUnknown) return;
    cancelAutoClose();
    autoCloseTimerRef.current = setTimeout(() => {
      setSyncRound({ open: false });
      autoCloseTimerRef.current = null;
    }, 1200);
    return cancelAutoClose;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round.open, round.syncing, round.cancelling, mlScoring, mlUnknown]);

  // A freshly-added repo bumps syncModalSignal: surface the progress UI and start
  // polling so its initial backfill (which can take a while) is visible. The
  // repo's background sync is already running server-side — we don't re-trigger
  // anything here, just open the round and turn on the status poll. This effect
  // runs even while the component renders null (no repos yet, e.g. the very first
  // add); the UI paints as soon as the invalidated ['repos'] query refetches.
  // Routing: with the WorkspaceManager open the round shows as its embedded panel
  // (modal:false); otherwise (FirstRunOnboarding) the standalone modal opens.
  const syncModalSignal = useFilters((s) => s.syncModalSignal);
  const prevSyncSignal = useRef(syncModalSignal);
  useEffect(() => {
    if (syncModalSignal === prevSyncSignal.current) return;
    prevSyncSignal.current = syncModalSignal;
    // Drain the WHOLE pending list, not a single slot: a multi-add queues one
    // requestSyncModal per repo in a synchronous loop, React batches the sets, and
    // this effect runs ONCE for all of them — a last-writer-wins read would scope
    // the round to only the final repo.
    const pending = useFilters.getState().syncModalRepoIds;
    if (pending.length === 0) return; // defensive: requestSyncModal always queues one
    useFilters.setState({ syncModalRepoIds: [] });
    const cur = useFilters.getState().syncRound;
    if (cur.open) {
      // A round is already in flight: MERGE the new repos into the scope so each gets
      // its own progress row, but do NOT call beginSyncRound() — that resets
      // seenRunning / cancels the auto-close and would stomp the completion
      // tracking for repos already being watched this round. The completion effect
      // keys off runningCount===0 across the (now-larger) scope, so it naturally
      // waits for ALL scoped repos before declaring the round done. An EMPTY scope
      // already means "all repos" and covers the newcomers — appending to it would
      // NARROW the round to just the new repos.
      if (cur.scopeIds.length > 0) {
        const missing = pending.filter((id) => !cur.scopeIds.includes(id));
        if (missing.length > 0) {
          setSyncRound({ scopeIds: [...cur.scopeIds, ...missing] });
        }
      }
      // Re-arm the walk tracking for the newcomer's backfill: past the walk phase
      // (syncing:false during the ML-scoring linger) the ['sync-status'] poll is
      // disabled, and the added repo would render frozen at 0% forever.
      if (!cur.syncing) setSyncRound({ syncing: true });
    } else {
      // No open round: start a fresh one scoped to just the pending repos.
      setSyncRound({
        open: true,
        modal: !useFilters.getState().managerOpen,
        syncing: true,
        cancelling: false,
        scopeIds: pending,
      });
      beginSyncRound();
    }
    void qc.invalidateQueries({ queryKey: ['repos'] });
    void qc.invalidateQueries({ queryKey: ['sync-status'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncModalSignal, qc]);

  // Kick a manual round over every repo. NO dialog is opened from here — the round is
  // "silent" (modal:false): the header icon spins, and if the manager is (or gets) opened
  // the embedded panel picks the round up. 429s (per-repo cooldowns) are deliberately
  // swallowed by allSettled — doneness comes from the status poll via the seenRunning
  // latch, never from the POSTs resolving.
  const runSyncAll = async (full: boolean): Promise<void> => {
    const list = repos ?? [];
    if (list.length === 0) return;
    if (useFilters.getState().syncRound.syncing) return; // no-op while a walk is in flight
    setSyncRound({ open: true, modal: false, syncing: true, cancelling: false, scopeIds: [] });
    beginSyncRound();
    const results = await Promise.allSettled(list.map((r) => api.syncRepo(r.id, full)));
    // Every single POST rejected (all on cooldown / unreachable): nothing was started, so
    // nothing will ever latch seenRunning from THIS trigger — end the round quietly instead
    // of spinning until the next scheduled sync happens to run.
    if (results.every((r) => r.status === 'rejected')) {
      setSyncRound({ open: false, syncing: false });
      setSeenRunning(false);
      return;
    }
    void qc.invalidateQueries({ queryKey: ['repos'] });
    void qc.invalidateQueries({ queryKey: ['sync-status'] });
  };

  // Deep re-sync ONE repo (the manager's per-repo action). The POST goes FIRST: a 429
  // cooldown must not open or re-scope a round for a sync that never started. On success
  // the round either merges the repo in (same rules as the add-signal merge above) or a
  // fresh scoped round begins.
  const syncOneDeep = async (repoId: number): Promise<'started' | 'cooldown' | 'error'> => {
    try {
      await api.syncRepo(repoId, true);
    } catch (e) {
      return e instanceof ApiError && e.status === 429 ? 'cooldown' : 'error';
    }
    const cur = useFilters.getState().syncRound;
    if (cur.open || cur.syncing) {
      // Merge; an EMPTY scope ("all repos") already covers it. No beginSyncRound() — see
      // the add-signal merge branch. open/modal are re-asserted too: a syncing-but-
      // DISMISSED round (open:false after the foreground handoff) would otherwise keep
      // the manager's embedded panel hidden for the deep sync just triggered — and
      // syncOneDeep is only reachable from the manager, which embeds the panel.
      const patch: Partial<SyncRoundState> = { open: true, modal: false };
      if (cur.scopeIds.length > 0 && !cur.scopeIds.includes(repoId)) {
        patch.scopeIds = [...cur.scopeIds, repoId];
      }
      if (!cur.syncing) patch.syncing = true;
      setSyncRound(patch);
    } else {
      setSyncRound({
        open: true,
        modal: false, // only reachable from the manager, which embeds the panel
        syncing: true,
        cancelling: false,
        scopeIds: [repoId],
      });
      beginSyncRound();
    }
    void qc.invalidateQueries({ queryKey: ['repos'] });
    void qc.invalidateQueries({ queryKey: ['sync-status'] });
    return 'started';
  };

  // Cancel the run: stop every repo that's still syncing (the backend aborts the
  // sync and deletes any repo still on its initial backfill), then close. Repos
  // that already had data keep it. This is the round's ONLY exit besides letting
  // it finish.
  const cancelSync = async (): Promise<void> => {
    setSyncRound({ cancelling: true });
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
    setSyncRound({ open: false, syncing: false, cancelling: false });
    setSeenRunning(false);
    void qc.invalidateQueries({ queryKey: ['repos'] }); // drop any deleted repos
    invalidateData();
  };

  // Hide the progress UI, leaving both halves running server-side.
  const dismissRound = (): void => {
    cancelAutoClose();
    setSyncRound({ open: false });
  };

  // Register the round actions for other surfaces (the WorkspaceManager). Re-registered
  // after every render so the closures always see fresh repos/statuses; cleared on unmount
  // (consumers null-check and no-op).
  useEffect(() => {
    registerSyncRoundActions({
      cancel: () => void cancelSync(),
      syncAllShallow: () => void runSyncAll(false),
      syncAllDeep: () => void runSyncAll(true),
      syncOneDeep,
      dismiss: dismissRound,
    });
  });
  useEffect(() => () => registerSyncRoundActions(null), []);

  if (!repos || repos.length === 0) return null;

  const erroredRepos = repos.filter((r) => r.lastSyncStatus === 'error');
  const erroredRepo = erroredRepos[0];
  const errorLine = erroredRepo
    ? `Sync error: ${erroredRepo.fullName}${
        erroredRepo.lastSyncError ? ` — ${erroredRepo.lastSyncError}` : ''
      }${erroredRepos.length > 1 ? ` (and ${erroredRepos.length - 1} more)` : ''}`
    : null;

  // What the sync is doing, in one phrase. The scoring pass is a real phase of it, not a
  // footnote: on a first backfill it is the phase that lasts the longest. `unscorable` rides
  // along quietly when non-zero — rows with no stored text, which nothing will ever score
  // (repair is `pnpm ml:backfill-bodies`) — so "N to go" is never read as full coverage. It
  // deliberately does NOT feed isMlScoring: it is not work in flight.
  const unscorableSuffix =
    ml && ml.unscorable > 0 ? ` · ${ml.unscorable.toLocaleString()} unscorable` : '';
  const scoringLine = ml
    ? `scoring bot comments${ml.pending > 0 ? ` — ${ml.pending.toLocaleString()} to go` : '…'}${unscorableSuffix}`
    : 'scoring bot comments…';
  const progress = foregroundComplete
    ? 'loading older history…'
    : runningCount > 0
      ? `syncing ${runningCount} repo${runningCount === 1 ? '' : 's'}…`
      : mlScoring
        ? scoringLine
        : 'syncing…';

  // First tooltip line: the error if there is one, else what a click does / what's running.
  const actionLine = round.syncing
    ? progress
    : mlScoring
      ? scoringLine
      : 'Click to sync all repos now';
  const title = [errorLine, actionLine, syncTooltip(lastSync)]
    .filter(Boolean)
    .join('\n');

  return (
    <>
      {/* The standalone overlay renders ONLY while the manager is closed AND the round asked
          for a modal (the onboarding add path) — with the manager open the same content shows
          as its embedded right-hand column instead (EmbeddedSyncPanel), never both. */}
      {round.open && round.modal && !managerOpen && (
        <SyncProgressModal
          repos={scopedRepos}
          statuses={scopedStatuses}
          ml={ml}
          cancelling={round.cancelling}
          onCancel={() => void cancelSync()}
          onDismiss={dismissRound}
        />
      )}
      <button
        type="button"
        onClick={() => void runSyncAll(false)}
        aria-busy={round.syncing || mlScoring}
        title={title}
        className="relative flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {/* Spins for BOTH halves. Stopping it when the GitHub walk ends was the visible form
            of the bug: the badges the user is waiting for were still being computed. */}
        <RefreshIcon spinning={round.syncing || mlScoring} />
        <span className="hidden sm:inline">Sync</span>
        {erroredRepo && !round.syncing && !mlScoring && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 ring-1 ring-white dark:ring-gray-900"
          />
        )}
      </button>
    </>
  );
}

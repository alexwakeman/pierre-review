import { useEffect, useRef, useState } from 'react';
import type { SyncActivityRepo } from '@pierre-review/shared';
import { isMlScoring, useMlEnrichmentStatus } from '../hooks/useMlLabels.js';
import { useSyncActivity } from '../hooks/useSyncActivity.js';

// The global ambient loading bar — fixed bottom-right, YELLOW, non-dismissible, visible
// whenever heavy background work is running: any FULL-MODE sync walk (first-sync
// backfill / deep re-sync / queued-for-full, via GET /api/sync-activity) or the ML
// bot-comment scoring pass that follows a walk (via the shared ['ml-status'] poll).
//
// Why it exists: a user added redis/go-redis; the walk finished fine and then ~733 bot
// comments (~735k chars) ground the CPU-bound ONNX classifier for minutes with no
// ambient indicator anywhere — the board looked dead. This card is the always-there
// answer; the sync modal remains the detailed one.
//
// It is an INDICATOR, not a dialog: no close button, no click target (pointer-events
// none — it must never steal a click from the board underneath). It renders as the
// BOTTOM-MOST card of the app's single shared bottom-right toast column (App.tsx) —
// the auto-merge and Claude-review toasts stack ABOVE it rather than painting over it.

// ---- Pure blend/ETA math (kept here, exported, so it is testable by reading) ----------

export const EWMA_ALPHA = 0.3;
/** "estimating…" until this many samples have shown real progress. */
export const MIN_RATE_SAMPLES = 3;

/**
 * EWMA-smoothed drain rate of one stage's "remaining work" number (backfill: summed
 * remaining fraction across walks; ML: pending count). Samples are taken on poll deltas
 * and clamped at ≥ 0 — remaining can legitimately GROW mid-burst (a new repo queued, a
 * walk storing more bot text) and a negative "drain" would poison the average.
 */
export interface DrainRate {
  /** units/second; null until the first sample. */
  ewma: number | null;
  /** How many samples showed actual progress (> 0) — the "stable estimate" gate. */
  positiveSamples: number;
  last: { value: number; at: number } | null;
}

export const emptyDrainRate = (): DrainRate => ({
  ewma: null,
  positiveSamples: 0,
  last: null,
});

/** No drain for this long ⇒ the estimate is stale: degrade to "estimating…" rather than
 * letting a dead rate quote a live countdown. */
export const STALL_CUTOFF_SEC = 90;

/** Feed one poll observation. Work drains in BATCH grain (an ML batch of long comments
 * lands tens of seconds apart), so an UNCHANGED value is treated as no observation at
 * all — the anchor stays put and the eventual drop is averaged over the whole gap.
 * Sampling zero-drain polls instead would decay the EWMA between batches and make the
 * ETA flap several-fold on a ~30s cycle. A GROWN value re-anchors without sampling
 * (new work arriving is not negative drain). Idempotent for repeated (value, at) pairs. */
export function observeDrain(r: DrainRate, value: number, at: number): DrainRate {
  if (r.last == null) return { ...r, last: { value, at } };
  if (value > r.last.value) return { ...r, last: { value, at } };
  const dtSec = (at - r.last.at) / 1000;
  if (value === r.last.value || dtSec <= 0) {
    // Stalled long enough? Drop the learned rate (keep the anchor: a later drop still
    // averages over the full gap). Idempotent once degraded.
    if (dtSec > STALL_CUTOFF_SEC && r.ewma != null) {
      return { ...r, ewma: null, positiveSamples: 0 };
    }
    return r;
  }
  const sample = (r.last.value - value) / dtSec; // > 0 here by the branches above
  return {
    ewma: r.ewma == null ? sample : EWMA_ALPHA * sample + (1 - EWMA_ALPHA) * r.ewma,
    positiveSamples: r.positiveSamples + 1,
    last: { value, at },
  };
}

/** Move the anchor WITHOUT sampling — used across a rate-limit pause so the pause
 * window neither reads as a stall (decaying the rate) nor as progress. */
export function anchorDrain(r: DrainRate, value: number, at: number): DrainRate {
  return { ...r, last: { value, at } };
}

/** Seconds left, or null while the estimate is not yet stable (≥3 positive samples). */
export function drainEtaSeconds(r: DrainRate, remaining: number): number | null {
  if (remaining <= 0) return 0;
  if (r.ewma == null || r.ewma <= 0 || r.positiveSamples < MIN_RATE_SAMPLES) return null;
  return remaining / r.ewma;
}

export interface Stage {
  /** 0..100 */
  percent: number;
  etaSeconds: number | null;
}

/**
 * One number for the headline bar. The stages run CONCURRENTLY, so the blend is a
 * remaining-time-weighted average (weight_i = that stage's share of the summed ETAs —
 * the stage with more time left dominates, and the bar tracks the work that actually
 * gates "done"). Equal weights whenever any stage's ETA is still unknown; a single
 * active stage is passed through directly.
 */
export function blendPercent(stages: readonly Stage[]): number {
  const first = stages[0];
  if (first == null) return 0;
  if (stages.length === 1) return first.percent;
  const mean = stages.reduce((a, s) => a + s.percent, 0) / stages.length;
  if (stages.some((s) => s.etaSeconds == null)) return mean;
  const total = stages.reduce((a, s) => a + (s.etaSeconds as number), 0);
  if (total <= 0) return mean;
  return stages.reduce((a, s) => a + s.percent * ((s.etaSeconds as number) / total), 0);
}

/** Headline ETA = max of the AVAILABLE stage ETAs (concurrent stages: the longest one
 * decides when everything is done). Null when no stage has a stable estimate yet. */
export function headlineEtaSeconds(stages: readonly Stage[]): number | null {
  const known = stages
    .map((s) => s.etaSeconds)
    .filter((e): e is number => e != null);
  return known.length > 0 ? Math.max(...known) : null;
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return `~${Math.max(5, Math.round(seconds / 5) * 5)} sec left`;
  if (seconds < 5400) return `~${Math.max(1, Math.round(seconds / 60))} min left`;
  return `~${Math.round(seconds / 3600)} hr left`;
}

/** Mean walk progress across the full-mode rows, 0..100. Queued rows carry percent 0
 * (the server's contract), so they weigh the mean down honestly. */
export function meanBackfillPercent(rows: readonly SyncActivityRepo[]): number {
  if (rows.length === 0) return 0;
  const sum = rows.reduce((a, r) => a + Math.min(1, Math.max(0, r.percent)), 0);
  return (sum / rows.length) * 100;
}

/** Summed remaining fraction — the backfill stage's "remaining work" number. Robust to
 * set churn: a finished walk leaves the list at ~1.0 (residual ~0, no jump), a newly
 * queued repo joins at 0 (remaining grows, clamped to a 0-drain sample). */
export function backfillRemaining(rows: readonly SyncActivityRepo[]): number {
  return rows.reduce((a, r) => a + (1 - Math.min(1, Math.max(0, r.percent))), 0);
}

// Same degradation contract as SyncProgressPanel's private helper: an unparseable or
// absent estimate reads "resuming shortly", never "~Invalid Date".
function resumeLabel(resumeAt: string | undefined): string {
  if (!resumeAt) return 'resuming shortly';
  const d = new Date(resumeAt);
  if (Number.isNaN(d.getTime())) return 'resuming shortly';
  return `resuming ~${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ---- The component --------------------------------------------------------------------

export function GlobalLoadingBar(): JSX.Element | null {
  // Order matters: the ml hook wants to know a walk is in flight (it only RAISES its
  // cadence off `active`) so the scoring pass that FOLLOWS the walk is picked up without
  // a visible gap between the two bursts. That's circular with useSyncActivity needing
  // `scoring`, so the walk flag rides a ref one render behind — walk percents change on
  // effectively every fast poll, so the lag is one poll at most.
  const backfillsActiveRef = useRef(false);
  const mlQ = useMlEnrichmentStatus(backfillsActiveRef.current);
  const ml = mlQ.data;
  const scoring = isMlScoring(ml);
  const activityQ = useSyncActivity(scoring);
  const backfills = activityQ.data?.backfills ?? [];
  const backfillActive = backfills.length > 0;
  backfillsActiveRef.current = backfillActive;

  const active = backfillActive || scoring;

  // ---- Burst state. Refs mutated during render — the established pattern for
  // poll-derived accumulators (SyncProgressPanel's peakPendingRef): every input change
  // re-renders us anyway, and all mutations are idempotent for a repeated render.
  const backfillRateRef = useRef<DrainRate>(emptyDrainRate());
  const mlRateRef = useRef<DrainRate>(emptyDrainRate());
  // High-water mark of (pending + scoredThisRun): the denominator for "done of total".
  // pending alone shrinks as the worker drains, and this bar can first MOUNT mid-burst,
  // so the scored-so-far half is what keeps the total honest.
  const mlPeakRef = useRef(0);
  // Monotonic clamp within one stage COMPOSITION — a re-estimate must never walk the
  // bar backwards. Reset when the set of active stages changes (walk-only → walk+ML →
  // ML-only) AND when the backfill set itself changes shape: a repo joining/leaving the
  // list or a per-repo percent DROP (the two-phase first sync legitimately restarts the
  // server-side percent from ~1.0 to ~16% when phase 2 begins) each make a lower blend
  // the honest one — pinning across those would hold a stale ~100% through minutes of
  // real work.
  const shownPercentRef = useRef(0);
  const stageSetRef = useRef('');
  const prevRepoPercentsRef = useRef<Map<number, number>>(new Map());
  const prevActiveRef = useRef(false);

  // A new burst can begin INSIDE the previous burst's 1s fade window (whose reset
  // timeout gets cleared by re-activation) — reset the trackers on the idle→active
  // transition itself, not only in the fade-out.
  if (active && !prevActiveRef.current) {
    backfillRateRef.current = emptyDrainRate();
    mlRateRef.current = emptyDrainRate();
    mlPeakRef.current = 0;
    shownPercentRef.current = 0;
    stageSetRef.current = '';
    prevRepoPercentsRef.current = new Map();
  }
  prevActiveRef.current = active;

  const allBackfillsPaused = backfillActive && backfills.every((b) => b.paused != null);
  const remaining = backfillRemaining(backfills);
  // Rows still listed but every walk at ~100%: the post-walk tails (ML-label purge,
  // CI-history backfill) are running. No drain is left to estimate — a "~5 sec left"
  // countdown here would sit frozen for minutes.
  const backfillFinishing = backfillActive && remaining <= 0.01;

  const stages: Stage[] = [];
  let mlDone = 0;
  let mlTotal = 0;
  if (active) {
    const stageSet = `${backfillActive ? 'b' : ''}${scoring ? 'm' : ''}`;
    let clampReset = false;
    if (stageSet !== stageSetRef.current) {
      stageSetRef.current = stageSet;
      clampReset = true;
    }

    // Backfill-set churn: joined / left / per-repo percent regression all invalidate
    // the clamp (idempotent across data-less re-renders — same map, no drops).
    const prevPercents = prevRepoPercentsRef.current;
    const nextPercents = new Map<number, number>();
    for (const b of backfills) {
      const p = Math.min(1, Math.max(0, b.percent));
      const old = prevPercents.get(b.repoId);
      if (old == null || p < old - 0.02) clampReset = true;
      nextPercents.set(b.repoId, p);
    }
    if (nextPercents.size < prevPercents.size) clampReset = true;
    prevRepoPercentsRef.current = nextPercents;

    if (backfillActive) {
      // Sampled on dataUpdatedAt, not wall clock, so a render without fresh data
      // re-anchors instead of sampling. A pause is anchored too: rate-limit minutes must
      // not decay the learned rate into a nonsense post-resume ETA.
      backfillRateRef.current = allBackfillsPaused
        ? anchorDrain(backfillRateRef.current, remaining, activityQ.dataUpdatedAt)
        : observeDrain(backfillRateRef.current, remaining, activityQ.dataUpdatedAt);
      stages.push({
        percent: meanBackfillPercent(backfills),
        etaSeconds:
          allBackfillsPaused || backfillFinishing
            ? null
            : drainEtaSeconds(backfillRateRef.current, remaining),
      });
    } else {
      backfillRateRef.current = emptyDrainRate();
    }

    // The classification stage exists ONLY under the real predicate. `pending > 0` with
    // nothing draining it (service unreachable, worker backed off, rejected comments) is
    // a real resting state — isMlScoring() is false there, so no bar segment, no ETA,
    // nothing animated. That backlog gets at most the static note rendered below.
    if (scoring && ml) {
      mlPeakRef.current = Math.max(mlPeakRef.current, ml.pending + ml.scoredThisRun);
      mlRateRef.current = observeDrain(mlRateRef.current, ml.pending, mlQ.dataUpdatedAt);
      mlTotal = mlPeakRef.current;
      mlDone = Math.max(0, mlTotal - ml.pending);
      stages.push({
        percent: mlTotal > 0 ? (mlDone / mlTotal) * 100 : 0,
        etaSeconds: drainEtaSeconds(mlRateRef.current, ml.pending),
      });
    } else {
      mlPeakRef.current = 0;
      mlRateRef.current = emptyDrainRate();
    }

    const blended = blendPercent(stages);
    shownPercentRef.current = clampReset
      ? blended
      : Math.max(shownPercentRef.current, blended);
  }

  // ---- Visibility: appear immediately, linger ~1s on idle for a short fade-out, then
  // unmount and forget the burst entirely.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (active) {
      setShown(true);
      return;
    }
    if (!shown) return;
    const t = window.setTimeout(() => {
      setShown(false);
      // The burst is over — every tracker starts from zero next time.
      backfillRateRef.current = emptyDrainRate();
      mlRateRef.current = emptyDrainRate();
      mlPeakRef.current = 0;
      shownPercentRef.current = 0;
      stageSetRef.current = '';
      prevRepoPercentsRef.current = new Map();
    }, 1_000);
    return () => window.clearTimeout(t);
  }, [active, shown]);

  if (!active && !shown) return null;

  const displayPercent = Math.min(100, Math.round(shownPercentRef.current));
  const etaSeconds = headlineEtaSeconds(stages);
  // "Every active stage is paused": ML can't be active-and-paused (isMlScoring excludes
  // pausedUntil), so this reduces to "walks are the only stage and all of them are held".
  const pausedHeadline = active && !scoring && allBackfillsPaused;
  const rateLimited = backfills.find((b) => b.paused?.reason === 'rate_limit');

  const queuedCount = backfills.filter((b) => b.paused?.reason === 'queued').length;
  const walkingCount = backfills.length - queuedCount;
  const backfillPercent = Math.round(meanBackfillPercent(backfills));

  // Backlog with nothing draining it, while the walk keeps the card up: a STATIC note —
  // never an animated bar or a running ETA for work nothing is doing.
  const mlWaiting =
    backfillActive && !scoring && Boolean(ml?.enabled) && (ml?.pending ?? 0) > 0;

  return (
    <div
      role="status"
      aria-label="Background loading"
      className={`pointer-events-none rounded-lg border border-gray-200 bg-white/95 p-3 shadow-lg backdrop-blur transition-opacity duration-500 dark:border-gray-700 dark:bg-gray-900/95 ${
        active ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">
          Loading data
        </span>
        <span className="text-xs font-semibold tabular-nums text-yellow-600 dark:text-yellow-400">
          {displayPercent}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={displayPercent}
        className="h-1.5 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800"
      >
        <div
          className="h-1.5 rounded bg-yellow-500 transition-all duration-500 dark:bg-yellow-400"
          style={{ width: `${displayPercent}%` }}
        />
      </div>
      <div className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
        {!active ? (
          'Done'
        ) : pausedHeadline ? (
          <span className="text-amber-600 dark:text-amber-400">
            {rateLimited
              ? `Paused — GitHub rate limit, ${resumeLabel(rateLimited.paused?.resumeAt)}`
              : 'Paused — waiting for another sync'}
          </span>
        ) : etaSeconds != null ? (
          formatEta(etaSeconds)
        ) : backfillFinishing && !scoring ? (
          'finishing up…'
        ) : (
          'estimating…'
        )}
      </div>
      {backfillActive && (
        <div className="mt-0.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
          {walkingCount > 0
            ? `Backfilling ${walkingCount} repo${walkingCount === 1 ? '' : 's'} · ${backfillPercent}%${
                queuedCount > 0 ? ` · ${queuedCount} waiting` : ''
              }`
            : `Backfill queued · ${queuedCount} waiting`}
        </div>
      )}
      {scoring && ml && (
        <div className="mt-0.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
          {`Classifying bot comments · ${mlDone.toLocaleString()} of ${mlTotal.toLocaleString()} · ${
            mlTotal > 0 ? Math.round((mlDone / mlTotal) * 100) : 0
          }%`}
        </div>
      )}
      {mlWaiting && (
        <div className="mt-0.5 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
          Classification waiting…
        </div>
      )}
    </div>
  );
}

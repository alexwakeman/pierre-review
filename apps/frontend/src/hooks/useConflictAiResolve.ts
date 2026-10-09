import { useSyncExternalStore } from 'react';
import type { ConflictAiResolution } from '@pierre-review/shared';
import { api, ApiError } from '../api/client.js';
import { openConflictResolver, type ResolverTarget } from '../store/conflictResolver.js';

// ── "RESOLVE WITH CLAUDE" — THE RUN, AS THE SPA SEES IT ──────────────────────────────────────
//
// A module-level store keyed by PR id, read through `useSyncExternalStore`, so every mount of the
// entry button (the PR pane's Conflicts row, MergeControl, a Pending card, the AI Fix tab) shows
// the SAME run and none of them starts a second one.
//
// ⚠ NOTHING HERE FETCHES ON MOUNT. A PR with no entry in this store issues no request: the
// Pending board stays at zero requests per card. Polling starts on the CLICK (`startConflictAiRun`)
// or on an explicit `resumeConflictAiRun`, which only the PR pane's AI Fix tab calls.
//
// When a run succeeds and was started with `open: true`, the resolver opens on its own — the
// overlay then applies Claude's answer (`useClaudePrefill`).

export type ConflictAiRunPhase = 'starting' | ConflictAiResolution['status'];

export interface ConflictAiRun {
  phase: ConflictAiRunPhase;
  /** The server's sentence, rendered verbatim. */
  error: string | null;
  resolution: ConflictAiResolution | null;
}

const runs = new Map<number, ConflictAiRun>();
const listeners = new Set<() => void>();
const polling = new Set<number>();

function set(prId: number, next: ConflictAiRun): void {
  runs.set(prId, next);
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function conflictAiRunActive(run: ConflictAiRun | null | undefined): boolean {
  return run != null && (run.phase === 'starting' || run.phase === 'preparing' || run.phase === 'running');
}

/** This PR's run, or null when nothing was started here. */
export function useConflictAiRun(prId: number): ConflictAiRun | null {
  return useSyncExternalStore(
    subscribe,
    () => runs.get(prId) ?? null,
    () => null,
  );
}

/** Read without subscribing — the overlay's prefill uses it to skip a fetch it already has. */
export function peekConflictAiRun(prId: number): ConflictAiRun | null {
  return runs.get(prId) ?? null;
}

const POLL_MS = 2_000;
/** Consecutive failed polls (network / 5xx / 429) before the run is reported lost — ~1 minute. */
const MAX_POLL_BLIPS = 30;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown, fallback: string): string =>
  e instanceof ApiError || e instanceof Error ? e.message || fallback : fallback;

async function poll(prId: number, target: ResolverTarget | null, open: boolean): Promise<void> {
  if (polling.has(prId)) return;
  polling.add(prId);
  try {
    let blips = 0;
    for (;;) {
      await sleep(POLL_MS);
      let res: ConflictAiResolution | null;
      try {
        res = (await api.conflictAiResolution(prId)).resolution;
        blips = 0;
      } catch (e) {
        // A 4xx is an answer, not a blip (the PR is gone, or push access was lost): stop. A network
        // failure or 5xx is retried, but not for ever.
        const status = e instanceof ApiError ? e.status : null;
        const permanent = status != null && status >= 400 && status < 500 && status !== 429;
        blips += 1;
        if (permanent || blips >= MAX_POLL_BLIPS) {
          set(prId, {
            phase: 'failed',
            error: message(e, 'Couldn’t reach the server. Start again.'),
            resolution: null,
          });
          return;
        }
        continue; // a blip; the run is on the server either way
      }
      if (res == null) {
        set(prId, { phase: 'failed', error: 'This resolution is no longer available. Start again.', resolution: null });
        return;
      }
      set(prId, { phase: res.status, error: res.error, resolution: res });
      if (res.status === 'succeeded') {
        if (open && target != null) openConflictResolver(target);
        return;
      }
      if (res.status === 'failed' || res.status === 'cancelled') return;
    }
  } finally {
    polling.delete(prId);
  }
}

/**
 * Start Claude on this PR's conflicts. `open` (default true) opens the resolver when the answer is
 * ready. Re-attaches to a run already in flight rather than starting a second.
 */
export function startConflictAiRun(
  target: ResolverTarget,
  opts: { open?: boolean; model?: string } = {},
): void {
  const prId = target.prId;
  if (conflictAiRunActive(runs.get(prId))) return;
  set(prId, { phase: 'starting', error: null, resolution: null });
  void (async () => {
    try {
      const res = await api.startConflictAiResolve(prId, opts.model ? { model: opts.model } : {});
      const r = res.resolution;
      set(prId, { phase: r?.status ?? 'preparing', error: r?.error ?? null, resolution: r });
      void poll(prId, target, opts.open !== false);
    } catch (e) {
      set(prId, { phase: 'failed', error: message(e, 'Couldn’t start Claude.'), resolution: null });
    }
  })();
}

/** Pick up a run started elsewhere (another tab, before a reload). The AI Fix tab only. */
export async function resumeConflictAiRun(prId: number): Promise<void> {
  if (runs.has(prId)) return;
  try {
    const res = (await api.conflictAiResolution(prId)).resolution;
    if (res == null || runs.has(prId)) return;
    set(prId, { phase: res.status, error: res.error, resolution: res });
    if (res.status === 'preparing' || res.status === 'running') void poll(prId, null, false);
  } catch {
    /* nothing to resume */
  }
}

export function cancelConflictAiRun(prId: number): void {
  void api.cancelConflictAiResolve(prId).catch(() => {});
}

/** Forget a settled run, so the entry reads as it did before. */
export function clearConflictAiRun(prId: number): void {
  if (conflictAiRunActive(runs.get(prId))) return;
  if (runs.delete(prId)) for (const l of listeners) l();
}

/** A sentence for the progress line. */
export function conflictAiPhaseLabel(phase: ConflictAiRunPhase): string {
  switch (phase) {
    case 'starting':
    case 'preparing':
      return 'Reading the conflicts…';
    case 'running':
      return 'Claude is resolving the conflicts…';
    case 'succeeded':
      return 'Claude’s answer is ready.';
    case 'cancelled':
      return 'Cancelled.';
    case 'failed':
      return 'Claude couldn’t resolve these conflicts.';
  }
}

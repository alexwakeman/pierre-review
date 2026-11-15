// THE RELEASE SCAN'S IN-MEMORY STATE (docs/RELEASES.md § Implementation → One history pass) — a leaf
// module (no imports but types) so the scan (sync/release-history.ts via sync/tags-step.ts) writes it
// and the check's DB half (db/release-check.ts) reads it without an import cycle.
//
//   • LIVE PROGRESS per repo and step ({done, total, paused}) — what the scan is doing right now.
//     GET /api/releases overlays it on the progress the fold derives from the stored rows (the walk's
//     row is written page by page, so the overlay mostly adds "waiting for GitHub's rate limit"),
//     while it is fresh (LIVE_MS). Lost on a restart: the derived progress stands in.
import type { ReleaseScanStep } from '@pierre-review/shared';

export interface LiveScanStep {
  step: ReleaseScanStep;
  done: number;
  total: number;
  paused: boolean;
  at: number;
}

/** A live step older than this is not shown (the derived progress is). */
export const LIVE_MS = 90_000;

const live = new Map<number, Map<ReleaseScanStep, LiveScanStep>>();

export function noteScanStep(repoId: number, p: Omit<LiveScanStep, 'at'>, now: number = Date.now()): void {
  const m = live.get(repoId) ?? new Map<ReleaseScanStep, LiveScanStep>();
  live.set(repoId, m);
  m.set(p.step, { ...p, at: now });
}

export function endScanStep(repoId: number, step: ReleaseScanStep): void {
  live.get(repoId)?.delete(step);
}

/** The freshest unfinished live step of a repo (null = none fresh). */
export function liveScanStep(repoId: number, now: number = Date.now()): LiveScanStep | null {
  let best: LiveScanStep | null = null;
  for (const s of live.get(repoId)?.values() ?? []) {
    if (now - s.at > LIVE_MS || s.done >= s.total) continue;
    if (best == null || s.at > best.at) best = s;
  }
  return best;
}

/** Test-only. */
export function __resetScanState(): void {
  live.clear();
}

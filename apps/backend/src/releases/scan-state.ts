// THE RELEASE SCAN'S IN-MEMORY STATE (docs/RELEASES.md § Implementation → Automatic candidate) — a leaf
// module (no imports but types) so the scan (sync/release-scan.ts, sync/tags-step.ts) writes it and the
// check's DB half (db/release-check.ts) reads it without an import cycle.
//
//   • LIVE PROGRESS per repo and step ({done, total, the tag being matched, paused}) — what the scan is
//     doing right now. GET /api/releases overlays it on the progress the fold derives from the stored
//     rows, while it is fresh (LIVE_MS). Lost on a restart: the derived progress stands in.
//   • PR FETCH FAILURES per repo: a range PR number GitHub did not give (`syncOnePr` false). It HOLDS
//     its tag ("Pull request #88 could not be read from GitHub.") and is asked again after RETRY_MS.
//     Bounded by the range PRs of the releasable repos.
import type { ReleaseScanStep } from '@pierre-review/shared';

export interface LiveScanStep {
  step: ReleaseScanStep;
  done: number;
  total: number;
  tagName?: string | null;
  tagIndex?: number | null;
  paused: boolean;
  at: number;
}

/** A live step older than this is not shown (the derived progress is). */
export const LIVE_MS = 90_000;
/** A PR GitHub did not give is asked again after this long. */
export const PR_RETRY_MS = 10 * 60_000;

const live = new Map<number, Map<ReleaseScanStep, LiveScanStep>>();
const failed = new Map<number, Map<number, number>>();

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

export function notePrFetchFailed(repoId: number, prNumber: number, now: number = Date.now()): void {
  const m = failed.get(repoId) ?? new Map<number, number>();
  failed.set(repoId, m);
  m.set(prNumber, now);
}

export function notePrFetched(repoId: number, prNumber: number): void {
  failed.get(repoId)?.delete(prNumber);
}

/** Range PR numbers GitHub did not give (they hold their tag). */
export function unreadablePrNumbers(repoId: number): number[] {
  return [...(failed.get(repoId)?.keys() ?? [])].sort((a, b) => a - b);
}

/** A failed number may be asked again now; a never-failed one always may. */
export function prFetchDue(repoId: number, prNumber: number, now: number = Date.now()): boolean {
  const at = failed.get(repoId)?.get(prNumber);
  return at == null || now - at >= PR_RETRY_MS;
}

/** Test-only. */
export function __resetScanState(): void {
  live.clear();
  failed.clear();
}

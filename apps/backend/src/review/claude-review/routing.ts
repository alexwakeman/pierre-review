import type { ReviewMode, ReviewRouteReason } from '@pierre-review/shared';
import type { ReviewFileMetric } from '../../pro/contract.js';

// The deterministic review router (Pro): decide, BEFORE the agent runs, whether a PR can be
// reviewed from its diff alone (fast, tool-less, no worktree), needs the full cloned worktree,
// or has nothing substantive to review. A PURE decision over the per-file metrics core computed
// in ctx.review.prepareReview (the diff primitives stayed core) + the conservative gate below:
// a change stays diff_only only if within EVERY ceiling AND touching no exported/public
// contract; anything else (and any ambiguity) routes to worktree.
//
// ⚠ THE ROUTER ALWAYS DECIDES. The reader used to be able to force a depth (Quick / Deep); that
// choice is gone from the route, the manager and this function, so every new run records
// `requested: 'auto', decidedBy: 'router'`. Older rows keep the forced values they were started with.

export interface RoutingThresholds {
  maxFiles: number;
  maxLines: number;
  maxDirs: number;
  maxSubsystems: number;
}

const envInt = (v: string | undefined, d: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// Defaults mirror the old core config.reviewRouting; overridable per-deployment via env.
export const ROUTING_THRESHOLDS: RoutingThresholds = {
  maxFiles: envInt(process.env.PRO_REVIEW_ROUTE_MAX_FILES, 5),
  maxLines: envInt(process.env.PRO_REVIEW_ROUTE_MAX_LINES, 150),
  maxDirs: envInt(process.env.PRO_REVIEW_ROUTE_MAX_DIRS, 2),
  maxSubsystems: envInt(process.env.PRO_REVIEW_ROUTE_MAX_SUBSYSTEMS, 1),
};

/** Directory of a path (`a/b/c.ts` → `a/b`; `c.ts` → `.`). */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

/** Top-level subsystem of a path (`a/b/c.ts` → `a`; `c.ts` → `c.ts`). */
function subsystemOf(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? path : path.slice(0, i);
}

export interface ReviewDecision {
  mode: ReviewMode;
  reason: ReviewRouteReason;
}

export function decideReviewMode(
  files: ReviewFileMetric[],
  thresholds: RoutingThresholds = ROUTING_THRESHOLDS,
): ReviewDecision {
  const changedFiles = files.length;
  const linesChanged = files.reduce((s, f) => s + f.additions + f.deletions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const dirsTouched = new Set(files.map((f) => dirOf(f.path))).size;
  const subsystems = new Set(files.map((f) => subsystemOf(f.path))).size;
  const apiTouch = files.some((f) => f.apiTouch);
  const allFilesNew = changedFiles > 0 && files.every((f) => f.isNew);
  const modifyingFraction =
    linesChanged > 0 ? Math.round((totalDeletions / linesChanged) * 100) / 100 : 0;

  const metrics = {
    changedFiles,
    linesChanged,
    dirsTouched,
    subsystems,
    apiTouch,
    modifyingFraction,
    allFilesNew,
  };

  // No textual changes → nothing to review; skip.
  if (linesChanged === 0) {
    return { mode: 'skip', reason: { ...metrics, requested: 'auto', decidedBy: 'router', trippedBy: null } };
  }

  // Conservative gate: stay diff_only only if within EVERY ceiling and no contract touch.
  let trippedBy: string | null = null;
  if (changedFiles > thresholds.maxFiles) trippedBy = 'files';
  else if (linesChanged > thresholds.maxLines) trippedBy = 'lines';
  else if (dirsTouched > thresholds.maxDirs) trippedBy = 'dirs';
  else if (subsystems > thresholds.maxSubsystems) trippedBy = 'subsystems';
  else if (apiTouch) trippedBy = 'apiTouch';

  return {
    mode: trippedBy ? 'worktree' : 'diff_only',
    reason: { ...metrics, requested: 'auto', decidedBy: 'router', trippedBy },
  };
}

// ── DEPENDENCY AUTO-MERGE (CORE, free, both modes) ──────────────────────────────────────────────
//
// Two features on one wire file (docs/MERGE-CI-TRUNK.md § Dependency auto-merge):
//   • "Merge or arm all" on Pending → Dependencies — POST /api/dependencies/merge-all?workspace=;
//   • the per-workspace "Merge dependency updates automatically" setting —
//     GET / PUT /api/workspaces/:id/dependency-auto-merge (OFF by default).

import { PENDING_LIMITS } from './pending-rules.js';

/** The most PRs one "Merge or arm all" request may name — the most the Dependencies tab can
 *  LIST: `boardListCap` per list group (`listGroupOf`), over the tab's two kinds
 *  (`dependency_bump`, `security`) × the two author sides. The route's `maxItems` and the SPA's
 *  request both read it, so a full tab never meets a 400. */
export const DEPENDENCY_MERGE_ALL_MAX = PENDING_LIMITS.boardListCap * 2 * 2;

/** Why a PR in the bulk request was left alone. */
export type DependencyMergeSkipReason =
  | 'not_found' // not this account's, not open, not in the workspace, or not dependency automation
  | 'draft'
  | 'conflicts'
  | 'no_write_access'
  | 'already_armed'
  | 'already_queued';

/** The plain-English sentence for each skip reason — ONE spelling, read by the dialog and the toast. */
export const DEPENDENCY_MERGE_SKIP_LABEL: Record<DependencyMergeSkipReason, string> = {
  not_found: 'no longer an open dependency update here',
  draft: 'draft',
  conflicts: 'has conflicts',
  no_write_access: 'you can’t push to the repository',
  already_armed: 'already set to merge when ready',
  already_queued: 'already in the merge queue',
};

/** One PR's plan (dry run) or outcome (real run). */
export type DependencyMergeAction =
  | { action: 'merge' } // dry run: GitHub says it can land now
  | { action: 'arm' } // dry run: will be set to merge when ready
  | { action: 'merged' }
  | { action: 'armed' }
  | { action: 'skipped'; reason: DependencyMergeSkipReason }
  | { action: 'failed'; message: string };

export interface DependencyMergeItem {
  prId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  outcome: DependencyMergeAction;
}

export interface DependencyMergeAllBody {
  /** The Dependencies tab's listed PR ids. Re-checked server-side, one by one. */
  prIds: number[];
  /** true = plan only: no GitHub call, nothing written. The confirm dialog reads this. */
  dryRun?: boolean;
}

export interface DependencyMergeAllResponse {
  workspaceId: number;
  dryRun: boolean;
  items: DependencyMergeItem[];
}

export interface WorkspaceDependencyAutoMerge {
  /** OFF unless switched on. */
  enabled: boolean;
}

export interface WorkspaceDependencyAutoMergeResponse {
  workspaceId: number;
  dependencyAutoMerge: WorkspaceDependencyAutoMerge;
}

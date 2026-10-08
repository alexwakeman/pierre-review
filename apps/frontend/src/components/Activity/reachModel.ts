import type {
  Repo,
  ResolvedBlastConfig,
  WorkspaceMergedReach,
} from '@pierre-review/shared';
import { blastRadius } from '../../lib/ui.js';

// REACH BY REPOSITORY — the pure fold behind `useWorkspaceReach` (hooks/useBlastRadius.ts), kept
// apart so `apps/frontend/test/reachModel.test.ts` can pin it without a renderer.
//
// THE POPULATION is the pull requests MERGED in the workspace's REPORTING WINDOW, the window every
// Reports figure is tied to. The server sends per-PR SIGNALS; the level is `blastRadius()`'s, the
// same call every chip makes, so the Settings dial repaints this with no cache invalidation.

/** One repository's pull requests merged in the window, split by reach. */
export interface RepoReach {
  repoId: number;
  repoFullName: string;
  low: number;
  medium: number;
  high: number;
  /** `low + medium + high` — the pull requests this repository's bar is drawn from. */
  read: number;
  /** ⚠ MERGED PULL REQUESTS WITH NO READING, AND THEY ARE NOT DRAWN. `blastRadius()` returns null
   *  for "never measured" and for "GitHub truncated the file list and no high arm fired" alike.
   *  `read + unread === merged`, so a bar does NOT total the count the list is ranked by — which
   *  is why this number is said in words. Unknown is never zero. */
  unread: number;
  merged: number;
}

export interface WorkspaceReach {
  /** Repositories with at least one pull request merged in the window, DESC by that count,
   *  capped. */
  repos: RepoReach[];
  /** Repositories with at least one merge in the window, BEFORE the cap. */
  repoCount: number;
  /** The active workspace's whole membership — the denominator for "N of the M repositories in
   *  this workspace merged nothing in this window". */
  workspaceRepos: number;
  /** ⚠ EVERY FIGURE BELOW IS FOLDED OVER THE SHOWN ROWS, NOT THE WHOLE WORKSPACE — one row must
   *  never mix the headline and subset populations. What the cap cut travels in `omitted`. */
  merged: number;
  read: number;
  unread: number;
  /** What the cap cut, named on the RANKING measure and the DRAWN one: the list is ranked by
   *  merges while the bars draw the Low/Medium/High split, so the repository holding the most
   *  high-reach pull requests can sit below the fold. */
  omitted: { repos: number; merged: number; high: number; read: number };
  /** The server's row cap bit; the list is partial and the card says so. */
  truncated: boolean;
}

/** Mirrors `REPO_ACTIVITY_MAX_REPOS` in the backend's repo-activity fold, so the two cards in one
 *  section cut at the same place. NO SILENT CAPS: what it cut is disclosed. */
export const REACH_MAX_REPOS = 12;

export function foldWorkspaceReach(
  reach: WorkspaceMergedReach,
  repos: readonly Pick<Repo, 'id' | 'fullName' | 'workspaceId'>[],
  workspaceId: number,
  config: ResolvedBlastConfig,
): WorkspaceReach {
  const names = new Map(repos.map((r) => [r.id, r.fullName]));
  const byRepo = new Map<number, RepoReach>();
  for (const pr of reach.prs) {
    let row = byRepo.get(pr.repoId);
    if (row == null) {
      row = {
        repoId: pr.repoId,
        // `/api/repos` is account-wide, so a workspace repo is always in it; the id is a last
        // resort rather than a dropped row, because dropping one would move a count.
        repoFullName: names.get(pr.repoId) ?? `Repository ${pr.repoId}`,
        low: 0,
        medium: 0,
        high: 0,
        read: 0,
        unread: 0,
        merged: 0,
      };
      byRepo.set(pr.repoId, row);
    }
    row.merged += 1;
    const verdict = blastRadius(pr, config);
    if (verdict == null) {
      row.unread += 1;
      continue;
    }
    row.read += 1;
    if (verdict.level === 'low') row.low += 1;
    else if (verdict.level === 'medium') row.medium += 1;
    else row.high += 1;
  }
  const all = [...byRepo.values()].sort(
    (a, b) => b.merged - a.merged || a.repoFullName.localeCompare(b.repoFullName),
  );
  const shown = all.slice(0, REACH_MAX_REPOS);
  const cut = all.slice(REACH_MAX_REPOS);
  const total = (rows: RepoReach[], pick: (r: RepoReach) => number): number =>
    rows.reduce((n, r) => n + pick(r), 0);
  return {
    repos: shown,
    repoCount: all.length,
    workspaceRepos: repos.reduce((n, r) => n + (r.workspaceId === workspaceId ? 1 : 0), 0),
    merged: total(shown, (r) => r.merged),
    read: total(shown, (r) => r.read),
    unread: total(shown, (r) => r.unread),
    omitted: {
      repos: cut.length,
      merged: total(cut, (r) => r.merged),
      high: total(cut, (r) => r.high),
      // So "none with a reach level" is never said of the shown rows while a cut one has a level.
      read: total(cut, (r) => r.read),
    },
    truncated: reach.truncated,
  };
}

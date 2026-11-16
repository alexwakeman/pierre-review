// THE OLDER BAND'S SIZE (docs/RELEASES.md § Implementation → Tag list and ticket detail) — how many tags
// OLDER than the candidate one releasable repository's row lists, per (account, workspace, repo).
//
//   • IN MEMORY, never stored: the default (RELEASE_OLDER_TAGS_DEFAULT, 10) after a restart, as the tab's
//     own "Show 50 more" count is component state. Bounded by the releasable (workspace, repo) pairs.
//   • Only ever RAISED (the larger of the asked and the current number, clamped to
//     RELEASE_OLDER_TAGS_MAX): two tabs asking at once never shrink each other's band.
//   • Read by the check (db/release-check.ts → the fold's `olderWanted`), so the answer carries at most
//     this many older tags, and by the history pass's early stop (`releaseCandidateProven`): the pass
//     goes on just far enough to cover them.
import { RELEASE_OLDER_TAGS_DEFAULT, clampOlderTagsWanted } from '@pierre-review/shared';

const wantedBy = new Map<string, number>();

const keyOf = (accountId: number, workspaceId: number, repoId: number): string => `${accountId}:${workspaceId}:${repoId}`;

/** The older band's size for this repository in this workspace. */
export function olderTagsWanted(accountId: number, workspaceId: number, repoId: number): number {
  return wantedBy.get(keyOf(accountId, workspaceId, repoId)) ?? RELEASE_OLDER_TAGS_DEFAULT;
}

/** Raise the band to `wanted` (never lowers it). Returns the number now in force and whether it grew. */
export function raiseOlderTagsWanted(accountId: number, workspaceId: number, repoId: number, wanted: number): { wanted: number; grew: boolean } {
  const cur = olderTagsWanted(accountId, workspaceId, repoId);
  const next = Math.max(cur, clampOlderTagsWanted(wanted));
  if (next !== cur) wantedBy.set(keyOf(accountId, workspaceId, repoId), next);
  return { wanted: next, grew: next !== cur };
}

/** Test-only. */
export function __resetOlderTagsWanted(): void {
  wantedBy.clear();
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Workspace,
  WorkspacePendingMuteUpdate,
  WorkspacesResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_QUERY_KEYS } from './useActivity.js';

// Every query key a workspace change touches. A workspace is THE ONLY SCOPE this app has, so
// creating, renaming or deleting one — or moving a repo between two — re-scopes everything under
// it:
//  • ['workspaces'] itself (the selector, the Activity rail, the manager modal);
//  • ['repos'] — every repo row carries its `workspaceId`, so the account-wide repo list is stale
//    the moment a move lands (and every client-side "is this repo in scope?" derives from it);
//  • the whole Activity/Insights surface (ACTIVITY_QUERY_KEYS);
//  • the flow-metric + Reports keys owned by this hook's siblings. They are NOT redundant with
//    the keys above and the reason is easy to miss: ['workspace-metrics', id] and
//    ['workspace-metrics-detail', id] carry the workspace id, but a MEMBERSHIP change moves repos
//    in or out of the SAME id — the key does not change, so nothing would refetch on its own. The
//    two Reports keys are in the same position AND their responses carry the cross-workspace
//    "By workspace" axis, which a create/delete/rename of ANY workspace stales regardless of the
//    id in the key. (They replaced ['workspace-comparison'] here when the Compare rail entry
//    folded into Reports.)
const WORKSPACE_INVALIDATE_KEYS = [
  'workspaces',
  'repos',
  'workspace-metrics',
  'workspace-metrics-detail',
  'period-reports',
  'period-report',
  // The board surfaces. Every one of these keys carries the workspace scope in its query
  // string (`ws:<id>` / `?workspace=`), but a MEMBERSHIP move changes what the SAME scope
  // means — the key does not change, so without an explicit invalidation the Timeline,
  // open-PR strips, My Turn, the Members dropdown and the maintainer shields all kept
  // rendering the pre-move repo set until something unrelated refetched them.
  'timeline',
  'open-prs',
  'my-turn',
  'users',
  'mergers',
  ...ACTIVITY_QUERY_KEYS,
] as const;

// The account's workspaces (CORE). A plain snapshot query; the mutations below invalidate
// ['workspaces'] and everything scoped by it.
//
// It is also the store's resolution source: `GET /api/workspaces` ENSURES the account's Default
// workspace (and repairs any missing membership rows) before answering, so this list is never
// empty and a null `workspaceId` can always be filled from the row whose `isDefault` is true.
// Nothing may render workspace-scoped data before that has happened.
export function useWorkspaces() {
  return useQuery<Workspace[]>({
    queryKey: ['workspaces'],
    queryFn: () => api.listWorkspaces().then((r: WorkspacesResponse) => r.workspaces),
  });
}

// Bundle of the workspace-mutation hooks. Each invalidates the key set above on settle so the
// selector, rail, repo list, feed and metric surfaces all track the change live.
export function useWorkspaceMutations() {
  const qc = useQueryClient();
  const invalidate = (): void => {
    for (const key of WORKSPACE_INVALIDATE_KEYS) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const createWorkspace = useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSettled: invalidate,
  });
  const renameWorkspace = useMutation({
    mutationFn: (v: { id: number; name: string }) => api.renameWorkspace(v.id, { name: v.name }),
    onSettled: invalidate,
  });
  // DELETE answers 409 `{error:'DefaultWorkspace'}` on the default row: it is not deletable, being
  // where new repos land and where a deleted workspace's repos AND reviewer rows (verdicts, vendor
  // names, prices) are re-homed. The caller hides the control on `isDefault`; the 409 surfaces as
  // an ApiError if one ever gets through. Renaming the default IS allowed — that is a different
  // thing entirely.
  const deleteWorkspace = useMutation({
    mutationFn: (id: number) => api.deleteWorkspace(id),
    onSettled: invalidate,
  });
  // MOVE one repo into this workspace, with `watch: true` (an explicit user gesture is what that
  // write is for). There is no "unassign" and no "belongs to nothing" state: a repo belongs to
  // EXACTLY ONE workspace (`workspace_repos` UNIQUE (account_id, repo_id)), so "take it out of
  // workspace X" is spelled "move it to the Default workspace" — POST it to the row whose
  // `isDefault` is true. The old `unassignRepoFromTeam` mutation and its
  // `DELETE /api/teams/:id/repos/:repoId` route are both GONE.
  const assignRepoToWorkspace = useMutation({
    mutationFn: (v: { workspaceId: number; repoId: number }) =>
      api.assignRepoToWorkspace(v.workspaceId, v.repoId),
    onSettled: invalidate,
  });
  // Set a workspace's membership to EXACTLY `repoIds`, diffed server-side: ids ADDED are moved
  // in, ids DROPPED are re-homed to Default. BOTH legs are MEMBERSHIP-ONLY — no `repos` write on
  // either side, because there is no second per-repo visibility column left to write.
  const setWorkspaceRepos = useMutation({
    mutationFn: (v: { id: number; repoIds: number[] }) => api.setWorkspaceRepos(v.id, v.repoIds),
    onSettled: invalidate,
  });

  // THE PENDING MUTE — two independently-owned facts (the workspace switch and the per-repo set),
  // OR-ed, never a chain. It writes NO membership and moves NO repo.
  //
  // ⚠ IT SWEEPS THE SAME KEY SET AS A MEMBERSHIP MOVE, and every key in it is load-bearing here:
  // 'my-turn' is the account-wide inbox the browser notification reads, and 'attention-cards' /
  // 'daily-brief' / 'work-plan' are the three reads of the ONE `getWorkspaceInsights` fold whose
  // whole contract is that they agree — the board's list, the strip's count and the ranked head.
  // A mute changes which population every one of them puts a row in, so sweeping a subset would
  // leave the strip saying "5 need your attention" over a board of 3 for up to a staleTime. The
  // shared `invalidate` is reused rather than a narrower list precisely so that cannot drift.
  const setWorkspacePendingMute = useMutation({
    mutationFn: (v: { id: number; patch: WorkspacePendingMuteUpdate }) =>
      api.setWorkspacePendingMute(v.id, v.patch),
    onSettled: invalidate,
  });

  return {
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    assignRepoToWorkspace,
    setWorkspaceRepos,
    setWorkspacePendingMute,
  };
}

/**
 * ONE workspace's repo ids — the client-side half of the scope.
 *
 * This REPLACED `resolveScopeRepoIds`, which folded a five-member union
 * (`'all' | 'none' | 'teams' | <id> | <id>[]`) into repo ids by unioning teams' memberships and,
 * for `'none'`, subtracting them from the account's repos. There is no union any more and there is
 * nothing to fold: a workspace's membership is a database fact (`workspace_repos`, UNIQUE
 * (account_id, repo_id)) that arrives on the `Workspace` row the server already sent. The client
 * no longer computes a scope — it reads one.
 *
 * ⚠ IT IS NOT AN EXISTENCE TEST. An unresolved (`null`) or unknown id yields `[]`, which in the
 * `repoIds` vocabulary is the real narrowing "this workspace has no repos" and NOT "no filter".
 * Callers must resolve a null/dead id to the account's Default FIRST (the `isDefault` row from
 * `useWorkspaces()`) and only then ask for its repos — see the workspace-sync contract, which
 * replaces a workspace's ids only when the id was null, dead, or actually changed, and otherwise
 * merely PRUNES a user-narrowed selection.
 */
export function workspaceRepoIds(workspaceId: number | null, workspaces: Workspace[]): number[] {
  if (workspaceId == null) return [];
  const ws = workspaces.find((w) => w.id === workspaceId);
  return ws ? [...ws.repoIds] : [];
}

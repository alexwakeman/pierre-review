import type { Workspace, WorkspaceRepoMode } from '@pierre-review/shared';

// How the workspaces hold ONE repo (docs/DATA-MODEL.md § External repos), read off the
// `Workspace` rows the server sent: `repoIds` is every member, `externalRepoIds` the External ones.
// Pure, so the repo manager's two views and their tests read the same answer.

export type MembershipState = WorkspaceRepoMode;

export interface Membership {
  workspaceId: number;
  name: string;
  state: MembershipState;
}

/** Every workspace the repo is in, in the list's order (Default first). */
export function membershipsOf(repoId: number, workspaces: readonly Workspace[]): Membership[] {
  const out: Membership[] = [];
  for (const w of workspaces) {
    if (!w.repoIds.includes(repoId)) continue;
    out.push({ workspaceId: w.id, name: w.name, state: (w.externalRepoIds ?? []).includes(repoId) ? 'external' : 'watched' });
  }
  return out;
}

/**
 * A grid cell's next state on a click: none → External → Maintained → none. A repo belongs to at
 * least one workspace, so its ONLY membership never cycles to none — it toggles between Maintained
 * and External (removing the repo is the row's ✕).
 */
export function nextGridState(here: MembershipState | null, membershipCount: number): MembershipState | null {
  if (here == null) return 'external';
  if (here === 'external') return 'watched';
  return membershipCount <= 1 ? 'external' : null;
}

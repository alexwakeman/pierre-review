import { dirname } from 'node:path';
import { removeWorktreeLocked } from '../../review/clone-manager.js';

/**
 * Remove a KEPT build worktree of the old plan/build flow (`<clone>/.worktrees/<entry>`, the only shape
 * it made; legacy.ts). Any other path is ignored, so a wrong value can never remove the reader's own
 * checkout. A workspace session keeps no host worktree, so its rows have `worktreePath` null.
 */
export async function releaseStoryBuildWorktree(fullName: string, worktreePath: string | null | undefined): Promise<void> {
  if (!worktreePath) return;
  const [owner, name] = fullName.split('/');
  if (!owner || !name || !/[\\/]\.worktrees[\\/][^\\/]+$/.test(worktreePath)) return;
  await removeWorktreeLocked(owner, name, dirname(dirname(worktreePath)), worktreePath).catch(() => {});
}

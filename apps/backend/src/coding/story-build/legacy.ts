import { and, inArray, isNull } from 'drizzle-orm';
import { STORY_BUILD_REPO_RUNNING_STATUSES, type StoryBuildStatus } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { dropSessionBaseRefs } from './base-refs.js';
import { releaseStoryBuildWorktree } from './kept-worktree.js';
import { isStoryBuildRepoPushing } from './push.js';
import {
  getStoryBuildRow,
  listStoryBuildRepoRows,
  storyBuildRepoNames,
  updateStoryBuild,
  updateStoryBuildRepo,
  type StoryBuildRow,
} from './persist.js';

// ROWS OF THE OLD PLAN/BUILD FLOW (removed 2026-11; docs/STORY-BUILD.md § Rows from the old flow). A
// `story_builds` row with `session_phase IS NULL` was made by the shell-less plan agent and the
// per-repository build agent in host worktrees. Nothing can start such a row any more, but rows already
// stored keep their patches (Push still reads them) and may still hold a KEPT write worktree. This file
// is everything the session code still needs for them: discard and the restart reconcile (a kept
// worktree is released by kept-worktree.ts, which push.ts also calls).

export const RESTART_LINE = 'Stopped when Limn restarted.';

/** Discard an old-flow row: mark it discarded, remove its kept worktrees and its pinned base refs. The
 *  stored patches stay on the rows (the export reads them). */
export async function discardLegacyStoryBuild(ctx: AgentContext, accountId: number, buildId: number): Promise<{ status: 'discarded' | 'not_ready' | 'not_found' }> {
  const row = await getStoryBuildRow(ctx, accountId, buildId);
  if (row == null) return { status: 'not_found' };
  const repos = await listStoryBuildRepoRows(ctx, accountId, buildId);
  if (repos.some((r) => isStoryBuildRepoPushing(r.id))) return { status: 'not_ready' };
  if (row.status !== 'discarded') {
    await updateStoryBuild(ctx, accountId, buildId, { status: 'discarded', phase: null, completedAt: new Date() });
  }
  const names = await storyBuildRepoNames(ctx, accountId, repos.map((r) => r.repoId));
  for (const r of repos) {
    if (r.worktreePath == null) continue;
    await releaseStoryBuildWorktree(names.get(r.repoId) ?? '', r.worktreePath);
    await updateStoryBuildRepo(ctx, accountId, r.id, { worktreePath: null }).catch(() => {});
  }
  await dropSessionBaseRefs([...(row.candidatesJson ?? []).map((c) => c.fullName), ...names.values()], buildId).catch(() => {});
  return { status: 'discarded' };
}

/**
 * An old-flow pass a restart (or the upgrade) cut off never stays running. Boot work, every account.
 * Only rows with `session_phase IS NULL` are read, so a workspace session is never touched here.
 *   assessing / planning  ⇒ plan_ready when a plan was stored, else failed
 *   building              ⇒ each running repository failed (ready when it stored a patch), each queued
 *                           one cancelled; the row is ready when any repository built, else failed
 *   docs running          ⇒ docs failed
 * Returns how many rows moved.
 */
export async function reconcileLegacyStoryBuildsOnStartup(ctx: AgentContext): Promise<number> {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const b = (ctx.schema as any).storyBuilds;
  const running: StoryBuildStatus[] = ['assessing', 'planning', 'building'];
  const rows = (await ctx.db
    .select()
    .from(b)
    .where(and(isNull(b.sessionPhase), inArray(b.status, running)))
    .execute()) as StoryBuildRow[];
  const docsRows = (await ctx.db
    .select()
    .from(b)
    .where(and(isNull(b.sessionPhase), inArray(b.docsStatus, ['running'])))
    .execute()) as StoryBuildRow[];
  const now = (): Date => new Date();
  let moved = 0;
  for (const row of rows) {
    if (row.status === 'building') {
      let built = false;
      for (const r of await listStoryBuildRepoRows(ctx, row.accountId, row.id)) {
        if (STORY_BUILD_REPO_RUNNING_STATUSES.includes(r.status)) {
          const kept = r.patch != null && r.patch.length > 0;
          built ||= kept;
          await updateStoryBuildRepo(ctx, row.accountId, r.id, { status: kept ? 'ready' : 'failed', error: kept ? null : RESTART_LINE, completedAt: now() });
        } else if (r.include && r.status === 'queued') {
          await updateStoryBuildRepo(ctx, row.accountId, r.id, { status: 'cancelled', completedAt: now() });
        } else if (r.include && (r.status === 'ready' || r.status === 'pushed')) {
          built = true;
        }
      }
      await updateStoryBuild(ctx, row.accountId, row.id, { status: built ? 'ready' : 'failed', phase: null, error: RESTART_LINE, completedAt: now() });
    } else if (row.planJson != null) {
      await updateStoryBuild(ctx, row.accountId, row.id, { status: 'plan_ready', phase: null, error: RESTART_LINE });
    } else {
      await updateStoryBuild(ctx, row.accountId, row.id, { status: 'failed', phase: null, error: RESTART_LINE, completedAt: now() });
    }
    moved += 1;
  }
  for (const row of docsRows) {
    await updateStoryBuild(ctx, row.accountId, row.id, { docsStatus: 'failed', docsError: RESTART_LINE, ...(row.status === 'plan_ready' ? { phase: null } : {}) });
    moved += 1;
  }
  if (moved > 0) ctx.log.info(`reconciled ${moved} story build row(s) of the old flow cut off by a restart`);
  return moved;
}

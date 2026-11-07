import type { FastifyInstance } from 'fastify';
import type { OpenPrsResponse } from '@pierre-review/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { getOpenPrs, resolveWorkspaceScope, WRITE_PERMISSIONS } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';
import { attachPrChips } from '../../db/pr-chips.js';

// `repoIds` → the `narrow` argument of `resolveWorkspaceScope`, never a scope in its own right.
// Empty/absent → null = no narrowing (every repo in the workspace).
function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? ids : null;
}

export async function openPrsRoutes(app: FastifyInstance): Promise<void> {
  // Every currently-open PR in the active WORKSPACE (ignores the board's date range).
  //
  // `?workspace=<id>` is the scope; `?repoIds=` only narrows within it. This route used to carry
  // repo ids alone, with `null` meaning "every repo of the account" — so an EMPTY workspace, which
  // sends no ids, listed the whole account's open PRs, and two workspaces sending no ids collided
  // in one client cache slot. `resolveWorkspaceScope` returns `membership ∩ (?repoIds= ??
  // membership)`: always concrete, `[]` for an empty workspace, which `getOpenPrs` renders as an
  // empty list.
  app.get('/api/open-prs', async (req): Promise<OpenPrsResponse> => {
    const q = req.query as { workspace?: string; repoIds?: string; userIds?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace, parseIntList(q.repoIds));
    const prs = await getOpenPrs({
      accountId,
      repoIds: scope.repoIds,
      userIds: parseIntList(q.userIds),
    });
    // PR CHIPS (db/pr-chips.ts): the stack and the criteria — on this list only, never the timeline.
    await attachPrChips(accountId, prs, (p) => p.id);
    // The scope's repos the viewer can PUSH to (the synced `repos.viewerPermission`, the ONE
    // WRITE_PERMISSIONS set): the row menu's Merge shows only there. A VISIBILITY gate, never the
    // authority — the merge route re-checks. One indexed read, no GitHub call.
    const writableRepoIds =
      scope.repoIds.length === 0
        ? []
        : (
            await db
              .select({ id: schema.repos.id, viewerPermission: schema.repos.viewerPermission })
              .from(schema.repos)
              .where(and(eq(schema.repos.accountId, accountId), inArray(schema.repos.id, scope.repoIds)))
              .execute()
          )
            .filter((r) => WRITE_PERMISSIONS.has(r.viewerPermission ?? ''))
            .map((r) => r.id);
    // The listed PRs GitHub's merge queue POSITIVELY holds (the synced `in_merge_queue`; null = not
    // observed, never "queued"): a QUEUED PR never shows Merge (docs/MERGE-CI-TRUNK.md). One indexed read.
    const prIds = prs.map((p) => p.id);
    const queuedPrIds =
      prIds.length === 0
        ? []
        : (
            await db
              .select({ id: schema.pullRequests.id })
              .from(schema.pullRequests)
              .where(
                and(
                  eq(schema.pullRequests.accountId, accountId),
                  inArray(schema.pullRequests.id, prIds),
                  eq(schema.pullRequests.inMergeQueue, true),
                ),
              )
              .execute()
          ).map((r) => r.id);
    return { prs, writableRepoIds, queuedPrIds };
  });
}

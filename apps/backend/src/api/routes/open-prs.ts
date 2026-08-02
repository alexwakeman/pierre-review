import type { FastifyInstance } from 'fastify';
import type { OpenPrsResponse } from '@pierre-review/shared';
import { getOpenPrs, resolveWorkspaceScope } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

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
    return { prs };
  });
}

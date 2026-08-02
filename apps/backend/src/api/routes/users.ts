import type { FastifyInstance } from 'fastify';
import type { UserContributionStats } from '@pierre-review/shared';
import { getUserStats, listUsers, resolveWorkspaceScope } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// Parse a comma-separated id list into a positive-int array, or null when empty/absent ("no
// explicit narrowing"). It is fed to `resolveWorkspaceScope` as the `narrow` argument, never used
// as a scope in its own right. Mirrors the parser in bot-triage.ts.
function parseIntList(raw?: string): number[] | null {
  if (raw == null || raw.trim() === '') return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

// GET /api/users/:id/stats — all-time contribution counts for one user. `workspace` is the scope
// (a plain integer; absent / unknown / foreign ⇒ the account's Default workspace), and `repoIds`
// NARROWS within it rather than replacing it: `resolveWorkspaceScope` returns
// `membership ∩ (repoIds ?? membership)`, so a repo id from another workspace simply drops out and
// cannot measure one workspace through another's repos.
const statsSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      workspace: { type: 'string' },
      repoIds: { type: 'string' },
    },
  },
};

// GitHub actor metadata for the Members panel / avatars.
//
// `users` is a GLOBAL table (a login is the same person for every tenant), but the LISTING is
// account-scoped: `listUsers(accountId)` returns only actors that appear in the caller's own
// synced data. Unscoped, this route handed any tenant the login, display name and avatar of
// every user any other tenant had ever synced — including contributors to private repos the
// caller cannot see.
//
// `PATCH /api/users/:id` was REMOVED. It called `setUserBot(id, isBot)`, which wrote the
// `isBot` + sticky `isBotOverridden` flags to the global row with no ownership check, so one
// account could permanently reclassify any enumerable user id for every other tenant. It had
// no frontend caller — bot classification goes through the account-scoped
// `PATCH /api/bot-reviewers/:userId` (api/routes/bot-triage.ts), which writes the per-account,
// per-WORKSPACE `workspace_reviewers` table. See the note in db/queries.ts.
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', async (req) => listUsers(accountIdOf(req)));

  // All-time PR / review / comment counts for one user, counted only over THIS account's
  // synced data (getUserStats binds every source to pullRequests.accountId).
  //
  // There is deliberately NO ownership 404: `users` is global, so a foreign or unknown id is
  // not an object this account can own or fail to own — it simply has no rows here and comes
  // back all zeros. That keeps user ids non-enumerable (404 vs 200 would be an oracle) and
  // leaks nothing, which is also why the response echoes no profile field.
  app.get('/api/users/:id/stats', { schema: statsSchema }, async (req) => {
    const { id } = req.params as { id: number };
    const { workspace, repoIds } = req.query as { workspace?: string; repoIds?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
    const resp: UserContributionStats = await getUserStats(accountId, id, scope.repoIds);
    return resp;
  });
}

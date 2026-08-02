import type { FastifyInstance } from 'fastify';
import type {
  ActivityResponse,
  RepoClaudeReviewsResponse,
  ConsolidatedFeedResponse,
} from '@pierre-review/shared';
import {
  getActivity,
  getConsolidatedFeed,
  listClaudeReviewsByRepo,
  markFeedSeen,
  resolveWorkspaceScope,
} from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// Parse a comma-separated id list into an int array, or null when empty/absent (so
// `resolveWorkspaceScope` treats it as "no narrowing — every repo in the workspace").
//
// ⚠ ITS RESULT IS NEVER A SCOPE. It is the `narrow` argument to `resolveWorkspaceScope`, which
// INTERSECTS it with the workspace's membership; a handler that passed this list straight to a
// getter would let `?workspace=5&repoIds=<a repo of workspace 9>` render one workspace's console
// out of another's repos.
function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? ids : null;
}

// ---- WHY THESE TWO CONTENT ROUTES TAKE `?workspace=` ----
//
// They carried only `?repoIds=` for as long as `null` meant "every repo of the account", and
// that is exactly what broke under a workspace scope, two ways over:
//
//   • a workspace with ZERO repos yields `repoIds: []`, every client query-string builder drops
//     an empty array, and the server then answered with EVERY repo in the account — the precise
//     opposite of "this workspace is empty";
//   • two different workspaces both sitting on `repoIds = null` produced the SAME query string,
//     so React Query served one workspace's data under the other's cache key with no refetch.
//
// `resolveWorkspaceScope` is the one resolver: absent / unparseable / another tenant's id all
// degrade to the account's DEFAULT workspace (never a 404 — every id yields the same response
// shape, so it is not an existence oracle), and the returned `repoIds` is ALWAYS
// `membership ∩ (?repoIds= ?? membership)`. A `[]` therefore reaches the getters as a concrete
// empty set and comes back empty, which is what an empty workspace must render.
export async function activityRoutes(app: FastifyInstance): Promise<void> {
  // The Activity aggregate: per repo, current-state stats + thread totals +
  // attention/unread flags + open PRs. Scoped to the active WORKSPACE — every repo in it, with
  // no second visibility axis; `repoIds` + `userIds` narrow WITHIN that. Pure DB read — no
  // GitHub sync, no AI.
  //
  // It takes the whole `BotScope`, not just the repo list: its acted-on bot stat needs the
  // WORKSPACE to know who counts as a review bot, while `scope.repoIds` only narrows the data.
  app.get('/api/activity', async (req): Promise<ActivityResponse> => {
    const q = req.query as { workspace?: string; repoIds?: string; userIds?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace, parseIntList(q.repoIds));
    return getActivity(accountId, scope, parseIntList(q.userIds));
  });

  // The consolidated Feed (the Activity "Feed" entry): one flat, chronological stream of real
  // activity, each row flagged `isMyTurn` by participation. Scoped to the active WORKSPACE —
  // every repo in it, with no second visibility axis; `repoIds` + `userIds` narrow WITHIN that.
  // Pure DB read — no GitHub sync, no AI.
  //
  // `workspaceId` is passed SEPARATELY from `repoIds` and is required: the bots-only path
  // resolves an automated-reviewer set, and that answer is a workspace fact. The two deliberately
  // disagree on the single-PR isolation path (`prId`), which reaches a PR whose repo may be
  // filtered out of `repoIds` — the workspace still owns "is this login a bot" there.
  app.get('/api/activity/feed', async (req): Promise<ConsolidatedFeedResponse> => {
    const q = req.query as {
      workspace?: string;
      repoIds?: string;
      userIds?: string;
      prId?: string;
      limit?: string;
      offset?: string;
      excludeBots?: string;
      allowBotIds?: string;
      botsOnly?: string;
      botWindowDays?: string;
      includeAllCommits?: string;
    };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace, parseIntList(q.repoIds));
    const limit = q.limit != null ? Number(q.limit) : null;
    const offset = q.offset != null ? Number(q.offset) : 0;
    const prId = q.prId != null ? Number(q.prId) : null;
    // Bot-only feed window (days) — clamped to 1..90; only honored on the botsOnly path.
    const botWindowDaysRaw = q.botWindowDays != null ? Number(q.botWindowDays) : null;
    const botWindowDays =
      botWindowDaysRaw != null && Number.isFinite(botWindowDaysRaw)
        ? Math.min(90, Math.max(1, Math.trunc(botWindowDaysRaw)))
        : null;
    return getConsolidatedFeed(accountId, {
      workspaceId: scope.workspaceId,
      repoIds: scope.repoIds,
      userIds: parseIntList(q.userIds),
      prId: prId != null && Number.isFinite(prId) ? prId : null,
      limit: Number.isFinite(limit) && limit != null && limit > 0 ? limit : null,
      offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
      excludeBots: q.excludeBots === 'true',
      allowBotIds: parseIntList(q.allowBotIds),
      botsOnly: q.botsOnly === 'true',
      botWindowDays,
      includeAllCommits: q.includeAllCommits === 'true',
    });
  });

  // Mark the Activity Feed as seen (bumps the account's server-side "seen" marker to
  // now). Called when the user views the feed; resets the "new My Turn since last here"
  // count that drives the Welcome-back banner. Account-scoped; no body.
  app.post('/api/activity/feed/mark-seen', async (req) => {
    const at = await markFeedSeen(accountIdOf(req));
    return { feedLastSeenAt: at.toISOString() };
  });

  // Repo-scoped Claude-review history for the Activity single-repo console. Ownership +
  // feature-gating are handled inside the query (an unowned repo / disabled feature
  // both return an empty list), so the caller never leaks another account's data.
  app.get('/api/repos/:id/claude-reviews', async (req): Promise<RepoClaudeReviewsResponse> => {
    const { id } = req.params as { id: string };
    return listClaudeReviewsByRepo(Number.parseInt(id, 10), accountIdOf(req));
  });
}

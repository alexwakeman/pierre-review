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
} from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? ids : null;
}

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  // The Activity aggregate: per repo, current-state stats + thread totals +
  // attention/unread flags + open PRs. Scoped to the account's WATCHED repos (inboxWatch);
  // `repoIds` + `userIds` narrow to the active FilterBar repo + member selection WITHIN
  // watched. Pure DB read — no GitHub sync, no AI.
  app.get('/api/activity', async (req): Promise<ActivityResponse> => {
    const q = req.query as { repoIds?: string; userIds?: string };
    return getActivity(accountIdOf(req), parseIntList(q.repoIds), parseIntList(q.userIds));
  });

  // The consolidated Feed (the Activity "Feed" entry): one flat, chronological stream
  // merging My Turn actionables + the activity feed, deduped. Scoped to the account's
  // WATCHED repos (inboxWatch); the FilterBar repo + member selection narrow WITHIN
  // watched. Pure DB read — no GitHub sync, no AI.
  app.get('/api/activity/feed', async (req): Promise<ConsolidatedFeedResponse> => {
    const q = req.query as {
      repoIds?: string;
      userIds?: string;
      prId?: string;
      limit?: string;
      offset?: string;
      excludeBots?: string;
      allowBotIds?: string;
      botsOnly?: string;
      botWindowDays?: string;
    };
    const limit = q.limit != null ? Number(q.limit) : null;
    const offset = q.offset != null ? Number(q.offset) : 0;
    const prId = q.prId != null ? Number(q.prId) : null;
    // Bot-only feed window (days) — clamped to 1..90; only honored on the botsOnly path.
    const botWindowDaysRaw = q.botWindowDays != null ? Number(q.botWindowDays) : null;
    const botWindowDays =
      botWindowDaysRaw != null && Number.isFinite(botWindowDaysRaw)
        ? Math.min(90, Math.max(1, Math.trunc(botWindowDaysRaw)))
        : null;
    return getConsolidatedFeed(accountIdOf(req), {
      repoIds: parseIntList(q.repoIds),
      userIds: parseIntList(q.userIds),
      prId: prId != null && Number.isFinite(prId) ? prId : null,
      limit: Number.isFinite(limit) && limit != null && limit > 0 ? limit : null,
      offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
      excludeBots: q.excludeBots === 'true',
      allowBotIds: parseIntList(q.allowBotIds),
      botsOnly: q.botsOnly === 'true',
      botWindowDays,
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

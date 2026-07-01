import type { FastifyInstance } from 'fastify';
import type {
  ActivityResponse,
  RepoClaudeReviewsResponse,
  ConsolidatedFeedResponse,
} from '@pierre-review/shared';
import { getActivity, getConsolidatedFeed, listClaudeReviewsByRepo } from '../../db/queries.js';
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
  // attention/unread flags + open PRs. Scoped to the account; `repoIds` + `userIds`
  // narrow to the active FilterBar repo + member selection (across ALL the account's
  // repos — watched-only was dropped). Pure DB read — no GitHub sync, no AI.
  app.get('/api/activity', async (req): Promise<ActivityResponse> => {
    const q = req.query as { repoIds?: string; userIds?: string };
    return getActivity(accountIdOf(req), parseIntList(q.repoIds), parseIntList(q.userIds));
  });

  // The consolidated Feed (the Activity "Feed" entry): one flat, chronological stream
  // merging My Turn actionables + the activity feed, deduped. Scoped by the FilterBar
  // repo + member selection across ALL the account's repos (watched-only dropped).
  // Pure DB read — no GitHub sync, no AI.
  app.get('/api/activity/feed', async (req): Promise<ConsolidatedFeedResponse> => {
    const q = req.query as {
      repoIds?: string;
      userIds?: string;
      limit?: string;
      offset?: string;
      excludeBots?: string;
    };
    const limit = q.limit != null ? Number(q.limit) : null;
    const offset = q.offset != null ? Number(q.offset) : 0;
    return getConsolidatedFeed(accountIdOf(req), {
      repoIds: parseIntList(q.repoIds),
      userIds: parseIntList(q.userIds),
      limit: Number.isFinite(limit) && limit != null && limit > 0 ? limit : null,
      offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
      excludeBots: q.excludeBots === 'true',
    });
  });

  // Repo-scoped Claude-review history for the Activity single-repo console. Ownership +
  // feature-gating are handled inside the query (an unowned repo / disabled feature
  // both return an empty list), so the caller never leaks another account's data.
  app.get('/api/repos/:id/claude-reviews', async (req): Promise<RepoClaudeReviewsResponse> => {
    const { id } = req.params as { id: string };
    return listClaudeReviewsByRepo(Number.parseInt(id, 10), accountIdOf(req));
  });
}

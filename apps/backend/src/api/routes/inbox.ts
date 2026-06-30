import type { FastifyInstance } from 'fastify';
import type {
  InboxResponse,
  RepoClaudeReviewsResponse,
  ConsolidatedFeedResponse,
} from '@pierre-review/shared';
import { getInbox, getConsolidatedFeed, listClaudeReviewsByRepo } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? ids : null;
}

export async function inboxRoutes(app: FastifyInstance): Promise<void> {
  // The Inbox aggregate: per watched repo, current-state stats + thread totals +
  // attention/unread flags + open PRs. Scoped to the account; `repoIds` narrows to
  // the active watched-repo selection. Pure DB read — no GitHub sync, no AI.
  app.get('/api/inbox', async (req): Promise<InboxResponse> => {
    const q = req.query as { repoIds?: string };
    return getInbox(accountIdOf(req), parseIntList(q.repoIds));
  });

  // The consolidated Feed (the Inbox "Feed" entry): one relevance-ranked stream
  // across all repos merging unresolved threads + My Turn actionables + the activity
  // feed, deduped and deterministically tiered. Pure DB read — no GitHub sync, no AI.
  app.get('/api/inbox/feed', async (req): Promise<ConsolidatedFeedResponse> => {
    return getConsolidatedFeed(accountIdOf(req));
  });

  // Repo-scoped Claude-review history for the Inbox single-repo console. Ownership +
  // feature-gating are handled inside the query (an unowned repo / disabled feature
  // both return an empty list), so the caller never leaks another account's data.
  app.get('/api/repos/:id/claude-reviews', async (req): Promise<RepoClaudeReviewsResponse> => {
    const { id } = req.params as { id: string };
    return listClaudeReviewsByRepo(Number.parseInt(id, 10), accountIdOf(req));
  });
}

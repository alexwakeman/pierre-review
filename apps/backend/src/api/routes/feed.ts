import type { FastifyInstance } from 'fastify';
import type { FeedResponse } from '@pierre-review/shared';
import { getFeed } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// The watched-repo activity Feed: recent events (last 14 days) across repos the user
// has Watched, newest first, commit pushes excluded. The frontend mirrors these into an
// append-only IndexedDB store (see lib/feedStore.ts). Account-scoped.
export async function feedRoutes(app: FastifyInstance): Promise<void> {
  // getFeed's default is now all-repos; preserve this legacy mirror's watched-repo-only
  // semantics explicitly (the consolidated Activity Feed supersedes this endpoint).
  app.get(
    '/api/feed',
    async (req): Promise<FeedResponse> =>
      getFeed(accountIdOf(req), { daysBefore: 14, watchedOnly: true }),
  );
}

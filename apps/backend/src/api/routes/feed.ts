import type { FastifyInstance } from 'fastify';
import type { FeedResponse } from '@pierre-review/shared';
import { getFeed } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// The activity Feed: recent events (last 14 days) across the account's repos, newest first,
// commit pushes excluded. The frontend mirrors these into an append-only IndexedDB store
// (see lib/feedStore.ts). Account-scoped.
//
// ⚠ THIS ROUTE IS DELIBERATELY *NOT* WORKSPACE-SCOPED, and the omission is not an oversight.
// It is the superseded legacy mirror of `GET /api/activity/feed` and has NO caller left (the only
// reference anywhere is a stub in the e2e mock server); it was account-wide before workspaces
// existed, so leaving it account-wide is not a regression, and adding `?workspace=` to a route
// nothing calls would be untested churn. The five CONTENT routes that DID need the parameter —
// /api/activity, /api/activity/feed, /api/timeline, /api/open-prs, /api/branch-status — all take
// it. If this endpoint ever gains a caller, scope it through `resolveWorkspaceScope` like they do,
// or delete it.
export async function feedRoutes(app: FastifyInstance): Promise<void> {
  // Account-wide by default. This used to pass `watchedOnly: true`, which narrowed the feed to
  // repos flagged `inbox_watch`; that column is DELETED — every repo an account has added is now
  // fully live — so there is nothing left to narrow by and the default is the whole account.
  app.get(
    '/api/feed',
    async (req): Promise<FeedResponse> => getFeed(accountIdOf(req), { daysBefore: 14 }),
  );
}

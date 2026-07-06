import type { FastifyInstance } from 'fastify';
import type { MeResponse, MyTurnDismissBody } from '@pierre-review/shared';
import { config } from '../../config.js';
import { accountToLocalUser } from '../../auth/account.js';
import { accountIdOf } from '../plugins/auth.js';
import { getProCapabilities } from '../../pro/contract.js';
import { getFyiProvider } from '../../feed/fyi-provider.js';
import {
  dismissMyTurn,
  getCompletedDismissals,
  getFeedLastSeenAt,
  getMyTurn,
  markFeedSeen,
  undismissMyTurn,
} from '../../db/queries.js';

const dismissSchema = {
  body: {
    type: 'object',
    required: ['kind', 'refId'],
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string',
        enum: ['review_request', 'thread', 'watched_repo_pr', 'pr_approved', 'claude_review'],
      },
      refId: { type: 'integer' },
    },
  },
};

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', async (req): Promise<MeResponse> => {
    const accountId = accountIdOf(req);
    const user = accountToLocalUser(req.account);
    const myTurn = await getMyTurn(accountId);
    // Feed "seen" marker + how many FYI items are new since. Only counted once a
    // baseline exists (feedLastSeenAt set by the first feed view) so a fresh account
    // never sees a scary first-load number. FYI is a Pro capability — the count comes
    // from the plugin's enricher (0 on the free tier, where there's no provider).
    const feedLastSeen = await getFeedLastSeenAt(accountId);
    const fyi = getFyiProvider();
    const newFeedItems = feedLastSeen && fyi ? await fyi.countNewSince(accountId, feedLastSeen) : 0;
    return {
      user,
      counts: {
        awaitingReview: myTurn.awaitingReview.length,
        yourPrsActivity: myTurn.yourPrs.length,
        approvedPrs: myTurn.approvedPrs.length,
        threadsAwaiting: myTurn.threadsAwaiting.length,
        watchedRepoPrs: myTurn.watchedRepoPrs.length,
        claudeReviewsToAction: myTurn.claudeReviewsToAction.length,
      },
      feedLastSeenAt: feedLastSeen ? feedLastSeen.toISOString() : null,
      newFeedItems,
      // Claude Review is now the Pro `claudeReview` capability (in `pro` below).
      deploymentMode: config.deploymentMode,
      pro: getProCapabilities(),
    };
  });

  app.get('/api/my-turn', async (req) => getMyTurn(accountIdOf(req)));

  app.post('/api/my-turn/dismiss', { schema: dismissSchema }, async (req) => {
    const { kind, refId } = req.body as MyTurnDismissBody;
    await dismissMyTurn(accountIdOf(req), kind, refId);
    return { status: 'ok' };
  });

  // The "Done" tab: entries dismissed in the past 90 days (review_request + thread
  // + claude_review).
  app.get('/api/my-turn/done', async (req) =>
    getCompletedDismissals(accountIdOf(req), 90),
  );

  // Un-dismiss: move a completed entry back to the inbox.
  app.post('/api/my-turn/undismiss', { schema: dismissSchema }, async (req) => {
    const { kind, refId } = req.body as MyTurnDismissBody;
    await undismissMyTurn(accountIdOf(req), kind, refId);
    return { status: 'ok' };
  });
}

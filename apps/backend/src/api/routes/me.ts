import type { FastifyInstance } from 'fastify';
import type { MeResponse, MyTurnDismissBody } from '@pierre-review/shared';
import { config } from '../../config.js';
import { accountToLocalUser } from '../../auth/account.js';
import { accountIdOf } from '../plugins/auth.js';
import {
  dismissMyTurn,
  getCompletedDismissals,
  getMyTurn,
  undismissMyTurn,
} from '../../db/queries.js';

const dismissSchema = {
  body: {
    type: 'object',
    required: ['kind', 'refId'],
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['review_request', 'thread', 'claude_review'] },
      refId: { type: 'integer' },
    },
  },
};

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', async (req): Promise<MeResponse> => {
    const user = accountToLocalUser(req.account);
    const myTurn = await getMyTurn(accountIdOf(req));
    return {
      user,
      counts: {
        awaitingReview: myTurn.awaitingReview.length,
        yourPrsActivity: myTurn.yourPrs.length,
        threadsAwaiting: myTurn.threadsAwaiting.length,
        claudeReviewsToAction: myTurn.claudeReviewsToAction.length,
      },
      claudeReviewEnabled: config.claudeReviewEnabled,
      deploymentMode: config.deploymentMode,
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

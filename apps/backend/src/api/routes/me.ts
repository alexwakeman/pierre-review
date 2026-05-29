import type { FastifyInstance } from 'fastify';
import type { MeResponse, MyTurnDismissBody } from '@gh-team-monitor/shared';
import { ensureLocalUser } from '../../github/local-user.js';
import { dismissMyTurn, getMyTurn } from '../../db/queries.js';

const dismissSchema = {
  body: {
    type: 'object',
    required: ['kind', 'refId'],
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['review_request', 'thread'] },
      refId: { type: 'integer' },
    },
  },
};

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', async (): Promise<MeResponse> => {
    const user = ensureLocalUser();
    const myTurn = getMyTurn();
    return {
      user,
      counts: {
        awaitingReview: myTurn.awaitingReview.length,
        yourPrsActivity: myTurn.yourPrs.length,
        threadsAwaiting: myTurn.threadsAwaiting.length,
      },
    };
  });

  app.get('/api/my-turn', async () => getMyTurn());

  app.post('/api/my-turn/dismiss', { schema: dismissSchema }, async (req) => {
    const { kind, refId } = req.body as MyTurnDismissBody;
    dismissMyTurn(kind, refId);
    return { status: 'ok' };
  });
}

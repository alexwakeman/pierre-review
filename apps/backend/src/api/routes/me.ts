import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '@gh-team-monitor/shared';
import { ensureLocalUser } from '../../github/local-user.js';
import { getMyTurn } from '../../db/queries.js';

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
}

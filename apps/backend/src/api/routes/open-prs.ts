import type { FastifyInstance } from 'fastify';
import type { OpenPrsResponse } from '@pierre-review/shared';
import { getOpenPrs } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? ids : null;
}

export async function openPrsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/open-prs', async (req): Promise<OpenPrsResponse> => {
    const q = req.query as { repoIds?: string; userIds?: string };
    const prs = await getOpenPrs({
      accountId: accountIdOf(req),
      repoIds: parseIntList(q.repoIds),
      userIds: parseIntList(q.userIds),
    });
    return { prs };
  });
}

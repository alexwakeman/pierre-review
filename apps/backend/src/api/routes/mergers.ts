import type { FastifyInstance } from 'fastify';
import { getMergers } from '../../db/queries.js';

// Per-repo "merge rights" inference (distinct users who've merged a PR there).
// Reference data — no filters; the frontend looks it up per timeline row.
export async function mergersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mergers', async () => getMergers());
}

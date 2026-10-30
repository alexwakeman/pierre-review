import type { FastifyInstance } from 'fastify';
import type { CloneStorageResponse } from '@pierre-review/shared';
import { getWorktreeStorage } from '../../review/worktree-gc.js';

// GET /api/storage/clones → CloneStorageResponse: what Limn's clone cache holds on disk — the
// shared repository copies, the per-run checkouts, and what the worktree sweep freed in the last 30
// days (review/worktree-gc.ts; docs/BACKEND.md § Worktree cleanup). Settings → AI → Disk space reads
// it when that tab opens. Disk only — no GitHub call, no model — and the walk is cached for a minute.
export async function storageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/storage/clones', async (): Promise<CloneStorageResponse> => getWorktreeStorage());
}

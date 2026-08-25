import type { FastifyInstance } from 'fastify';
import type { DailyBriefResponse, DailyBriefWorkspaceLine } from '@pierre-review/shared';
import { getDailyBriefCounts, getDailyBriefEntry } from '../../db/daily-brief.js';
import { listWorkspaces, resolveWorkspaceScope } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// The daily brief (plan P3.1/N1 + the P3.3/N5 roll-up) — CORE / FREE, counts only. The Pro
// narration lives entirely on the plugin's synthesis seam (`kind: 'brief'` / `'rollup'`) and is
// fetched separately by the SPA; this route never touches AI and never carries cost/money.
//
// `?workspace=` is the ONE scope parameter (resolveWorkspaceScope: absent/unknown/foreign →
// Default, never a 404) and the resolved id is echoed. `?rollup=1` additionally returns one
// count line per OTHER workspace of the account (the "Elsewhere" strip line) — workspaces are
// few, and each line rides the fold's own 5-min TTL cache (db/daily-brief.ts), so the loop is
// bounded and mostly cache hits. Defensively capped all the same.
//
// Rate tier: `search` (60/min) — a DELIBERATE entry in tierFor, not the blanket read bucket:
// one call folds the consolidated feed, the insights cards and the resolve backlog (× workspace
// count under `?rollup=1`). Pinned in rate-limit.test.ts.
const ROLLUP_WORKSPACE_CAP = 12;

export async function dailyBriefRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/daily-brief', async (req): Promise<DailyBriefResponse> => {
    const q = req.query as { workspace?: string; rollup?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    const { counts, computedAt } = await getDailyBriefEntry(accountId, scope.workspaceId);
    const resp: DailyBriefResponse = {
      workspaceId: scope.workspaceId,
      counts,
      generatedAt: computedAt.toISOString(),
    };
    if (q.rollup === '1' || q.rollup === 'true') {
      const others = (await listWorkspaces(accountId))
        .filter((w) => w.id !== scope.workspaceId)
        .slice(0, ROLLUP_WORKSPACE_CAP);
      if (others.length > 0) {
        const lines: DailyBriefWorkspaceLine[] = await Promise.all(
          others.map(async (w) => ({
            workspaceId: w.id,
            name: w.name,
            counts: await getDailyBriefCounts(accountId, w.id),
          })),
        );
        resp.rollup = lines;
      }
    }
    return resp;
  });
}

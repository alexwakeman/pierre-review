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
// few, and each line rides the fold's 5-min TTL cache (db/daily-brief.ts), so the loop is
// bounded and mostly cache hits. Defensively capped all the same.
//
// ⚠ THE TWO LINES ARE NOT SERVED THE SAME WAY, ON PURPOSE. The ACTIVE workspace's `counts` go
// through `getDailyBriefEntry`, which computes them FRESH: every one of those figures is the
// count of a list a strip line CLICKS INTO (`myTurn` is literally the my_turn card count that
// GET /api/attention recomputes per request), and a cached headline over a live list is a number
// the click disproves — which is exactly the "5 items need your review" over a board of 3 this
// split fixes. The `?rollup=1` lines describe OTHER workspaces and keep the cache: clicking one
// switches workspace, which re-fetches THAT workspace's fresh brief before any list is shown.
//
// ⚠ `generatedAt` therefore stamps the COUNTS (== this request); the `botAnomalies` array inside
// them keeps its own ≤5-min window (an 84-day events scan behind no clickable list). Two
// computation times in one response, deliberately — see db/daily-brief.ts's header before
// "simplifying" either half.
//
// Rate tier: `search` (60/min) — a DELIBERATE entry in tierFor, not the blanket read bucket:
// one call folds the insights cards, the resolve backlog and the trunk snapshot (× workspace
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

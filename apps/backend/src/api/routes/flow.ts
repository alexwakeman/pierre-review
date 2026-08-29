import type { FastifyInstance } from 'fastify';
import type { FlowFindingsResponse } from '@pierre-review/shared';
import { FLOW_DEFAULT_WINDOW_DAYS, getFlowFindings } from '../../db/flow-findings.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// GET /api/flow-findings — the "Bottlenecks" tab: where human review time goes in a workspace.
//
// CORE and FREE ON EVERY TIER. It is deterministic — no model, no plugin, no GitHub call — and
// every sentence it returns is templated in db/flow-findings.ts. (If it ever needs to be paid,
// gating it is a one-line `req.pro?.capabilities` check HERE; nothing in the engine reads a
// capability and nothing in it should, so the free/paid decision stays a routing decision.)
//
// `?workspace=<int>` is THE scope parameter and goes through `resolveWorkspaceScope`: absent,
// unparseable, unknown or ANOTHER TENANT'S id all resolve to the account's DEFAULT workspace —
// never a 404, so the route is not an existence oracle. The resolved id is echoed on the response
// so a client can correct a stale bookmark.
//
// `?days=<int>` is the window, default 30. The engine CLAMPS it to [7, 90] rather than trusting
// it: below seven days a median rests on three observations, and above ninety the retroactive
// COVERAGE BIAS dominates (docs/PERIOD-REPORTING.md — a workspace that onboarded repos over the
// span shows a "trend" that is entirely onboarding). `coverage` rides every response for the same
// reason. The clamp lives in the engine, not here, so a future second caller cannot skip it.
//
// Rate tier: `search` (60/min), a DELIBERATE entry in `tierFor` and pinned in rate-limit.test.ts.
// It is DB-only, but "this route is DB-only" is exactly the sentence that file exists to distrust:
// one call runs the lane resolver, the shared first-human-review fold (two capped candidate
// walks), a thread-path scan, an in-window review scan, a merged-PR walk with its approving
// reviews, an open-PR snapshot with the approvals fold, and the round-trip comment join — the
// same shape of cost that put `GET /api/attention` and `GET /api/daily-brief` on this bucket.
export async function flowRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/flow-findings', async (req): Promise<FlowFindingsResponse> => {
    const q = req.query as { workspace?: string; days?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    // A garbage `?days=` is the DEFAULT, not a 400: this is a dashboard parameter carried in a
    // bookmark, and the same "never an error out of a scope hint" rule `?workspace=` follows.
    const parsed = q.days == null ? Number.NaN : Number.parseInt(q.days, 10);
    const days = Number.isInteger(parsed) && parsed > 0 ? parsed : FLOW_DEFAULT_WINDOW_DAYS;
    return getFlowFindings(accountId, scope, days);
  });
}

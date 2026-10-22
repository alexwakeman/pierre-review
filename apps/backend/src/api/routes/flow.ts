import type { FastifyInstance } from 'fastify';
import type { FlowResponse, FlowTrendResponse } from '@pierre-review/shared';
import { FLOW_DEFAULT_WINDOW_DAYS, getFlowCourts } from '../../db/pr-intervals.js';
import { getFlowTrend } from '../../db/flow-trend.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { getReportingWindow } from '../../db/reporting-window.js';
import { accountIdOf } from '../plugins/auth.js';

// GET /api/flow-findings — "Chronology": the COURT LEDGER for a workspace.
//
// Deterministic — no model, no GitHub call — and every sentence it returns is templated in
// db/pr-intervals.ts.
//
// `?workspace=<int>` is THE scope parameter and goes through `resolveWorkspaceScope`: absent,
// unparseable, unknown or ANOTHER TENANT'S id all resolve to the account's DEFAULT workspace —
// never a 404, so the route is not an existence oracle. The resolved id is echoed on the response
// so a client can correct a stale bookmark.
//
// `?window=reporting` (THE DEFAULT — also what an absent `?days=` means) measures the workspace's
// REPORTING WINDOW: this sprint so far when the workspace has a sprint cadence, else the trailing
// 7/14 days — resolved here through the ONE resolver (`getReportingWindow`), the same window the
// free flow tiles use, and echoed as `reportingWindow`. The panel's 30/60/90 options are the longer
// views, sent as `?days=`.
//
// `?days=<int>` is the fixed trailing window. The engine CLAMPS it to [7, 90] rather than trusting
// it: below seven days a median rests on three observations, and above ninety the retroactive
// COVERAGE BIAS dominates (docs/PERIOD-REPORTING.md — a workspace that onboarded repos over the
// span shows a "trend" that is entirely onboarding). `coverage` rides every response for the same
// reason. The clamp lives in the engine, not here, so a future second caller cannot skip it.
//
// Rate tier: `search` (60/min), a DELIBERATE entry in `tierFor` and pinned in rate-limit.test.ts.
// It is DB-only, but "this route is DB-only" is exactly the sentence that file exists to distrust:
// one call runs the lane resolver and then FOUR chunked action scans (reviews, review comments,
// conversation comments, commits) across every pull request merged in the window — the same shape
// of cost that put `GET /api/attention` and `GET /api/daily-brief` on this bucket.
export async function flowRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/flow-findings', async (req): Promise<FlowResponse> => {
    const q = req.query as { workspace?: string; days?: string; window?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    // A garbage `?days=` is the DEFAULT — the reporting window — not a 400: this is a dashboard
    // parameter carried in a bookmark, and the same "never an error out of a scope hint" rule
    // `?workspace=` follows. Only a positive integer picks a fixed span; anything else (absent,
    // `abc`, `0`, an unknown `?window=`) is the reporting window.
    const parsed = q.days == null ? Number.NaN : Number(q.days);
    const hasDays = Number.isInteger(parsed) && parsed > 0;
    if (q.window === 'reporting' || !hasDays) {
      const nowMs = Date.now();
      const reporting = await getReportingWindow(accountId, scope.workspaceId, nowMs);
      return getFlowCourts(accountId, scope, FLOW_DEFAULT_WINDOW_DAYS, { reporting, nowMs });
    }
    return getFlowCourts(accountId, scope, parsed);
  });

  // GET /api/flow-trend — Chronology "Over time": the last 26 weeks of the same ledger, one point per
  // merge week, plus the event markers (bots and people first seen, repos joining, setting changes,
  // detected shifts) and a before/after lens per marked week. docs/BOTTLENECKS.md § Over time.
  //
  // Same scope rule, same tier (`search`) as /api/flow-findings above. ⚠ THE 26 WEEKS ARE
  // THE LABELLED EXCEPTION TO THE 90-DAY CAP — the response carries per-week coverage, repo-joined
  // markers and a thin-week flag so the coverage bias the cap guards against stays on screen. No
  // `?days=`: the span is fixed.
  app.get('/api/flow-trend', async (req): Promise<FlowTrendResponse> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    return getFlowTrend(accountId, scope);
  });
}

import type { FastifyInstance } from 'fastify';
import type { FlowResponse } from '@pierre-review/shared';
import { FLOW_DEFAULT_WINDOW_DAYS, getFlowCourts } from '../../db/pr-intervals.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';
import { entitledProCapabilities } from '../../pro/contract.js';

// GET /api/flow-findings — "Chronology": the COURT LEDGER for a workspace.
//
// PAID, on the `periodReports` capability. Deterministic all the same — no model, no plugin call,
// no GitHub call — and every sentence it returns is still templated in db/pr-intervals.ts; what it
// costs is DB work, not tokens.
//
// ⚠ IT RIDES `periodReports` RATHER THAN A CAPABILITY OF ITS OWN, deliberately. Chronology and the
// period report answer the same question at two grains — "where did a completed stretch of work
// actually go" — and a fifteenth member on `ProCapabilities` would mean bumping `apiVersion` across
// four literals in two repositories (host contract, plugin index, plugin contract-types, the
// runtime gate in pro/bind.ts) to gate one route. One flag, no wire change, no plugin edit.
//
// ⚠ THE GATE IS A ROUTING DECISION AND MUST STAY ONE. `getFlowCourts` reads no capability and takes
// no flag: `verify:isolation` calls that fold DIRECTLY — no request, no account row, just the ids
// it is handed — and the day entitlement is threaded into the engine is the day every one of those
// cross-tenant assertions needs an account to run. (The `[7, 90]` window clamp is the mirror case:
// it lives in the ENGINE so a second caller cannot skip it, while this check lives HERE so the
// engine stays testable.)
//
// ⚠ THE SPA MUST GATE `useFlowFindings`' `enabled` ON THE SAME FLAG (it does). This route is
// POLLED — the panel refetches every five minutes — so an ungated hook against a 402 is a request
// every five minutes, per mounted pane, forever, and the panel renders "Could not load this
// workspace's flow.": an ERROR where the truth is a paywall, which is the worst of both. The
// unentitled SPA issues no request at all and paints the locked pane instead.
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
// one call runs the lane resolver and then FOUR chunked action scans (reviews, review comments,
// conversation comments, commits) across every pull request merged in the window — the same shape
// of cost that put `GET /api/attention` and `GET /api/daily-brief` on this bucket.
export async function flowRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/flow-findings', async (req, reply): Promise<FlowResponse | { error: string }> => {
    // The same entitlement view /api/me hands the SPA and the /api/pro/* 402 gate mirrors, so the
    // tab's locked pane and this status code can never disagree about one account: a local account
    // is entitled whenever the bound plugin advertises the capability, a free cloud account gets
    // the 402. `!req.account` cannot happen in the running app (local synthesizes one, cloud 401s
    // first) — it is here so a bare test harness fails closed rather than open.
    //
    // Ahead of `resolveWorkspaceScope` on purpose: an unentitled caller does no DB work, and the
    // 402 is identical for every `?workspace=` value, so the gate cannot be read as an oracle for
    // which workspaces exist.
    if (!req.account || !entitledProCapabilities(req.account).periodReports) {
      reply.status(402);
      return { error: 'pro required' };
    }
    const q = req.query as { workspace?: string; days?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    // A garbage `?days=` is the DEFAULT, not a 400: this is a dashboard parameter carried in a
    // bookmark, and the same "never an error out of a scope hint" rule `?workspace=` follows.
    const parsed = q.days == null ? Number.NaN : Number.parseInt(q.days, 10);
    const days = Number.isInteger(parsed) && parsed > 0 ? parsed : FLOW_DEFAULT_WINDOW_DAYS;
    return getFlowCourts(accountId, scope, days);
  });
}

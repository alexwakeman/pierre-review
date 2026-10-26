import type { FastifyInstance } from 'fastify';
import type { BotBehaviourResponse, BotWindowKind } from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import { resolveRequestScope } from '../insights/workspace-request.js';

// The bot BEHAVIOUR analytics route — MOVED here from core (`/api/bot-behaviour`) behind the
// `botDepth` entitlement (plan P0.2; the periodReports precedent verbatim: the compute is CORE —
// db/queries.ts `getBotBehaviourAnalytics`, reached via the `ProHostQueries.getBotBehaviour`
// seam — but there is no free surface for it). Per bot, over the same window/scope resolution as
// core's /api/bot-analytics: time-to-first-review, LoC-to-comments ratio, the week×hour activity
// heatmap, follow-up behaviour, trends/anomalies, overlap and the ML fold. Powers the Bots
// "Behaviour" surfaces (Pro depth tier).
//
// ENTITLEMENT, three layers (the standard /api/pro/* stack):
//  1. Registration — the route exists only when the plugin loads; pure OSS has no route at all
//     (the SPA never fetches: `useBotBehaviour` gates on the `botDepth` capability).
//  2. Self-gate — `botDepth` maps to the paid summary tier (PRO_DIGEST_ENABLED, exactly like
//     workspaceInsights), so a flag-less local run 404s a direct hit instead of leaking the
//     depth data (the Claude-Review "routes 404 when off" pattern; BotBehaviourResponse has no
//     `enabled` envelope to degrade into).
//  3. Cloud per-account entitlement — the host's automatic /api/pro/* 402 gate
//     (api/plugins/auth.ts `registerAuthGate`/`isProPath`): an authenticated free-plan cloud
//     account gets 402 before this handler runs. Staying under /api/pro/ is what keeps that
//     automatic (the platform-routes rule).
//
// SCOPE: `?workspace=` resolves via `resolveRequestScope` (absent/unparseable/foreign → the
// account's DEFAULT workspace, never a 404 — host §5.1), and `?repoIds=` survives as DATA
// NARROWING ONLY: it is intersected with the resolved workspace's membership below, exactly what
// core's `resolveWorkspaceScope(accountId, workspace, narrow)` did for this route before the
// move. The intersection preserves the `repoIds ⊆ membership` invariant `BotScopeWire` requires —
// the raw query list never reaches the seam.

const VALID_WINDOWS = new Set<string>(['rolling_7', 'rolling_14', 'rolling_30', 'sprint']);
function parseWindow(raw: string | undefined): BotWindowKind {
  return raw != null && VALID_WINDOWS.has(raw) ? (raw as BotWindowKind) : 'rolling_14';
}

// Comma-separated positive-int list → number[] | null (null = "no narrowing"). Mirrors core's
// parseIntList in api/routes/bot-triage.ts — its result is NEVER a scope, only the narrow set.
function parseIntList(raw?: string): number[] | null {
  if (raw == null || raw.trim() === '') return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

function parseBotUserId(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function registerBotBehaviourRoutes(app: FastifyInstance, ctx: ProContext): void {
  app.get<{
    Querystring: { window?: string; workspace?: string; repoIds?: string; botUserId?: string };
  }>('/api/pro/bot-behaviour', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const window = parseWindow(req.query.window);
    const resolved = await resolveRequestScope(ctx, accountId, req.query.workspace);
    const narrow = parseIntList(req.query.repoIds);
    const scope: BotScopeWire =
      narrow == null
        ? resolved
        : { workspaceId: resolved.workspaceId, repoIds: resolved.repoIds.filter((id) => narrow.includes(id)) };
    // `botUserId` narrows to ONE bot (the per-bot drill-down tab's fetch, C1). The seam's core
    // implementation admits only ids in the workspace's role-'review' reviewer set — a foreign
    // or non-reviewer id yields the empty response, never someone else's data.
    const botUserId = parseBotUserId(req.query.botUserId);
    return (await ctx.queries.getBotBehaviour(
      accountId,
      window,
      scope,
      botUserId,
    )) as BotBehaviourResponse;
  });
}

import type { FastifyInstance } from 'fastify';
import type { AiUsageReportResponse } from '@pierre-review/shared';
import { config } from '../../config.js';
import { accountIdOf } from '../plugins/auth.js';
import { aiBudgetSnapshot } from '../../ai/budget.js';
import { getProvider } from '../../ai/provider.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { getReportingWindow } from '../../db/reporting-window.js';
import { getAiUsageReport, type AiUsageCostRate } from '../../db/ai-usage-report.js';

// REPORTS → AI USAGE (db/ai-usage-report.ts; types in packages/shared ai-usage-report.ts).
//
//   GET /api/ai/usage-report?workspace=<id> → AiUsageReportResponse
//
// Where Limn's AI runs went over the workspace's REPORTING WINDOW (resolved once, echoed as
// `window`), plus the last 12 weeks (the labelled exception). DB only: it reads the ledger and the
// run tables; it never runs a model, calls GitHub or starts the usage probe — `read` tier.
//
// ⚠ ONE COST UNIT, CLAUDE'S, AND A SUBSCRIPTION NEVER CARRIES US$: an API key answers `usd`; a
// subscription whose kind is known answers `week_pct`, converted HERE with the budget's own
// `weekPctPerUsd`; anything else answers null (tokens only). Codex rows carry tokens only.
//
// Registered only when `config.aiEnabled` (an AI surface; the SPA hides the tab with `me.ai.enabled`).
export async function aiUsageReportRoutes(app: FastifyInstance): Promise<void> {
  if (!config.aiEnabled) return;

  app.get('/api/ai/usage-report', async (req): Promise<AiUsageReportResponse> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    const nowMs = Date.now();
    const [window, rate] = await Promise.all([getReportingWindow(accountId, scope.workspaceId, nowMs), costRate(accountId, nowMs)]);
    return getAiUsageReport(accountId, scope, window, nowMs, rate);
  });
}

async function costRate(accountId: number, nowMs: number): Promise<AiUsageCostRate> {
  try {
    const route = getProvider('claude').credentialRoute();
    if (route === 'api_key') return { unit: 'usd', perUsd: 1 };
    if (route !== 'login') return { unit: null, perUsd: 0 };
    const { usage } = await aiBudgetSnapshot(accountId, { provider: 'claude', probe: false, nowMs });
    const r = usage.weekPctPerUsd;
    return r != null && Number.isFinite(r) && r > 0 ? { unit: 'week_pct', perUsd: r } : { unit: null, perUsd: 0 };
  } catch {
    // No reading, no unit: the report still paints in tokens.
    return { unit: null, perUsd: 0 };
  }
}

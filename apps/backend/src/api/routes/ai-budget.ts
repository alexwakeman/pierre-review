import type { FastifyInstance } from 'fastify';
import {
  aiBudgetSettingsView,
  validateAiBudgetBody,
  type AiBudgetBody,
  type AiBudgetResponse,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { accountIdOf } from '../plugins/auth.js';
import { aiBudgetSnapshot, installAiBudgetObserver, writeAiBudgetSettings } from '../../ai/budget.js';

// THE CLAUDE SPEND BUDGET (ai/budget.ts; types in packages/shared ai-budget.ts).
//
//   GET /api/ai/budget[?provider=claude|codex] → AiBudgetResponse (the named provider's, else the
//                          default's): the settings (defaults filled in; `weeklyUsd` null off
//                          the API-key route), whether anything is stored, the ONE decision
//                          (`status`) and the header's usage view (`usage`). Serves the CACHED usage
//                          reading and, on the login route, starts the usage probe IN THE BACKGROUND
//                          (at most every 5 minutes, 20s timeout, no model call) — it never waits.
//                          The header polls it every ~2 minutes while the tab is visible.
//   PUT /api/ai/budget   AiBudgetBody (any subset; validated) → AiBudgetResponse.
//
// Registered only when `config.aiEnabled`. Registering it also installs the message observer every
// agent run's `rate_limit_event`s pass through, so the reading exists before anyone opens Settings.
export async function aiBudgetRoutes(app: FastifyInstance): Promise<void> {
  if (!config.aiEnabled) return;
  installAiBudgetObserver();

  const respond = async (accountId: number, provider?: 'claude' | 'codex'): Promise<AiBudgetResponse> => {
    const { settings, isDefault, status, usage } = await aiBudgetSnapshot(accountId, {
      probe: 'always',
      ...(provider ? { provider } : {}),
    });
    // A subscription carries no US$ on the wire: the API key's weekly figure is sent only on that route.
    return { settings: aiBudgetSettingsView(settings, status.route), isDefault, status, usage };
  };

  // `?provider=claude|codex`: that provider's reading (the per-run picker's over-budget confirm, for a
  // run on the provider that is NOT the default). Absent or anything else ⇒ the default provider's.
  app.get('/api/ai/budget', async (req) => {
    const raw = (req.query as { provider?: unknown } | undefined)?.provider;
    return respond(accountIdOf(req), raw === 'claude' || raw === 'codex' ? raw : undefined);
  });

  app.put('/api/ai/budget', async (req, reply) => {
    const accountId = accountIdOf(req);
    const problem = validateAiBudgetBody(req.body);
    if (problem != null) return reply.code(400).send({ error: 'InvalidAiBudget', message: problem });
    await writeAiBudgetSettings(accountId, req.body as AiBudgetBody);
    return respond(accountId);
  });
}

import type { FastifyInstance } from 'fastify';
import {
  isAiEffort,
  isAiProviderSetting,
  type AiEffortSettingBody,
  type AiEffortSettingResponse,
  type AiProviderSettingBody,
  type AiProviderSettingResponse,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { accountIdOf } from '../plugins/auth.js';
import { activeProviderId, aiProviderEnvSetting, aiProviderSettingStatus } from '../../ai/provider-setting.js';
import { writeStoredAiEffort, writeStoredAiProvider } from '../../ai/provider-store.js';
import { aiEffortEnvSetting, aiEffortSettingStatus } from '../../ai/effort.js';

// THE AI PROVIDER CHOICE (Settings → AI; docs/CODEX-PLAN.md Phase 4). One per machine, like the spend
// budget. The read side is `/api/me` (`ai.provider` + `ai.providerSetting`); this is the one writer.
//
//   PUT /api/ai/provider  AiProviderSettingBody → AiProviderSettingResponse.
//     400 on an unknown value. 409 while LIMN_AI_PROVIDER is set: the environment wins, so a stored
//     choice would change nothing (the Settings control is disabled and says so).
//
// The switch reaches the NEXT run at once (ai/provider-setting.ts holds it in memory); a run already
// going keeps its provider. Rate tier: the blanket `read` bucket — a single-column UPDATE that reaches
// no GitHub API and no model (pinned in rate-limit.test.ts).
//
//   PUT /api/ai/effort  AiEffortSettingBody → AiEffortSettingResponse  (Settings → AI → Effort).
//     `value`: one of the five levels, or null for Default. 400 on anything else. 409 while REVIEW_EFFORT
//     is set (the environment wins). Same rules as the provider: one column, held in memory
//     (ai/effort.ts), reaches the next run; `read` tier.
export async function aiProviderRoutes(app: FastifyInstance): Promise<void> {
  if (!config.aiEnabled) return;

  app.put('/api/ai/provider', async (req, reply) => {
    const accountId = accountIdOf(req);
    const value = (req.body as Partial<AiProviderSettingBody> | null | undefined)?.value;
    if (!isAiProviderSetting(value)) {
      return reply.code(400).send({ error: 'BadRequest', message: 'value must be claude, codex or auto.' });
    }
    if (aiProviderEnvSetting() != null) {
      return reply
        .code(409)
        .send({ error: 'SetByEnvironment', message: 'LIMN_AI_PROVIDER is set, so it decides the provider.' });
    }
    await writeStoredAiProvider(value, accountId);
    const body: AiProviderSettingResponse = { setting: aiProviderSettingStatus(), provider: activeProviderId() };
    return body;
  });

  app.put('/api/ai/effort', async (req, reply) => {
    const accountId = accountIdOf(req);
    const body = req.body as Partial<AiEffortSettingBody> | null | undefined;
    const value = body?.value;
    if (body == null || !('value' in body) || (value !== null && !isAiEffort(value))) {
      return reply
        .code(400)
        .send({ error: 'BadRequest', message: 'value must be low, medium, high, xhigh, max or null.' });
    }
    if (aiEffortEnvSetting() != null) {
      return reply.code(409).send({ error: 'SetByEnvironment', message: 'REVIEW_EFFORT is set, so it decides the effort.' });
    }
    await writeStoredAiEffort(value ?? null, accountId);
    const res: AiEffortSettingResponse = { setting: aiEffortSettingStatus() };
    return res;
  });
}

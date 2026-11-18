import type { FastifyInstance } from 'fastify';
import {
  isAiEffort,
  isAiProviderSetting,
  parseAiRunProfiles,
  type AiApiKeySettingBody,
  type AiApiKeySettingResponse,
  type AiEffortSettingBody,
  type AiEffortSettingResponse,
  type AiProviderSettingBody,
  type AiProviderSettingResponse,
  type AiRunProfilesBody,
  type AiRunProfilesResponse,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { accountIdOf } from '../plugins/auth.js';
import { activeProviderId, aiProviderEnvSetting, aiProviderSettingStatus } from '../../ai/provider-setting.js';
import { writeStoredAiEffort, writeStoredAiProvider, writeStoredAiRunProfiles, writeStoredPrefersApiKey } from '../../ai/provider-store.js';
import { aiRunProfilesStatus } from '../../ai/run-profile-status.js';
import { apiKeySettingStatus, prefersApiKeyEnvSetting } from '../../ai/credentials.js';
import { aiEffortEnvSetting, aiEffortSettingStatus } from '../../ai/effort.js';
import { envName, envNameSet } from '../../env-name.js';

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
//   PUT /api/ai/effort  AiEffortSettingBody → AiEffortSettingResponse  (THE COMPAT PATH since the run
//     profiles: no Settings control sends it now). `value`: one of the five levels, or null for Default.
//     400 on anything else. 409 while REVIEW_EFFORT is set (the environment wins). Sets the effort of
//     EVERY surface: the one level is stored and every effort in the run profiles is dropped
//     (ai/provider-store.ts `writeStoredAiEffort`); held in memory, reaches the next run; `read` tier.
//
//   PUT /api/ai/run-profiles  AiRunProfilesBody → AiRunProfilesResponse  (Settings → AI → Review, AI Fix,
//     Implement story; shared ai-run-profiles.ts). `profiles`: the WHOLE object — it replaces the stored
//     one. 400 on an unknown field, a model of another vendor, a bad effort or rounds, or no review
//     vendor left on (`parseAiRunProfiles`, the message says which). Efforts are stored while
//     REVIEW_EFFORT is set (it still wins at run time; the controls are locked). One column, held in
//     memory (ai/run-profile.ts), reaches the next run; `read` tier.
//
//   PUT /api/ai/api-key  AiApiKeySettingBody → AiApiKeySettingResponse  (Settings → AI → "Use my API keys
//     first"). `value`: boolean, else 400. 409 while LIMN_AI_USE_API_KEY is set to true or false (the
//     environment wins). Only the tick is stored — never a key. Held in memory (ai/credentials.ts), so
//     the next model call picks its credential by it; `read` tier.
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
        .send({ error: 'SetByEnvironment', message: `${envNameSet(process.env, 'AI_PROVIDER') ?? envName('AI_PROVIDER')} is set, so it decides the provider.` });
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

  app.put('/api/ai/run-profiles', async (req, reply) => {
    const accountId = accountIdOf(req);
    const body = req.body as Partial<AiRunProfilesBody> | null | undefined;
    const parsed = parseAiRunProfiles(body?.profiles);
    if (!parsed.ok) return reply.code(400).send({ error: 'BadRequest', message: parsed.message });
    await writeStoredAiRunProfiles(parsed.value, accountId);
    const res: AiRunProfilesResponse = { runProfiles: aiRunProfilesStatus() };
    return res;
  });

  app.put('/api/ai/api-key', async (req, reply) => {
    const accountId = accountIdOf(req);
    const value = (req.body as Partial<AiApiKeySettingBody> | null | undefined)?.value;
    if (typeof value !== 'boolean') {
      return reply.code(400).send({ error: 'BadRequest', message: 'value must be true or false.' });
    }
    if (prefersApiKeyEnvSetting() != null) {
      return reply.code(409).send({ error: 'SetByEnvironment', message: `${envNameSet(process.env, 'AI_USE_API_KEY') ?? envName('AI_USE_API_KEY')} is set, so it decides.` });
    }
    await writeStoredPrefersApiKey(value, accountId);
    const res: AiApiKeySettingResponse = { setting: apiKeySettingStatus() };
    return res;
  });
}

// `MeResponse.ai.runProfiles` and the PUT's answer: every surface resolved (shared `resolveAiRunProfiles`)
// from the stored profiles (ai/run-profile.ts), the old single level and REVIEW_EFFORT (ai/effort.ts) and
// the default provider. Its own module so run-profile.ts and effort.ts need not import each other both ways.
import { resolveAiRunProfiles, type AiRunProfilesStatus } from '@pierre-review/shared';
import { aiEffortEnvSetting, storedAiEffort } from './effort.js';
import { activeProviderId } from './provider-setting.js';
import { storedAiRunProfiles } from './run-profile.js';

export function aiRunProfilesStatus(env: NodeJS.ProcessEnv = process.env): AiRunProfilesStatus {
  return resolveAiRunProfiles(storedAiRunProfiles(), {
    legacyEffort: storedAiEffort(),
    envEffort: aiEffortEnvSetting(env),
    defaultProvider: activeProviderId(env),
  });
}

// THE DEMO'S AI PROVIDER — Settings → AI, simulated. The demo reader is signed in to BOTH providers
// (Claude Code, and Codex with ChatGPT Plus); the choice starts at Auto, which is Claude when both are
// signed in. Picking Codex (PUT /api/ai/provider) makes every later demo run — a replayed review, fix,
// ticket or CI review, a chat answer — say Codex and the Codex model of the same depth, and the usage
// item reads Codex's own windows (aiBudget.ts). Runs stored before the switch keep their own labels:
// the recording holds Claude AND Codex runs (apps/backend/scripts/seed-demo-agentic.ts).
//
// The one rule for "who runs next" mirrors the server's (ai/provider-setting.ts): an explicit choice
// wins; Auto is Claude while Claude is signed in (it always is here).

import {
  AI_MODEL_FOR_ROLE,
  claudeModelRole,
  isAiProviderSetting,
  type AiModelRole,
  type AiProviderId,
  type AiProviderSetting,
} from '@pierre-review/shared';
import type { DemoServer } from './server.js';
import { isRecord } from './util.js';

const KEY = 'ai-provider';

/** The ChatGPT plan the demo's Codex sign-in reports. */
export const DEMO_CODEX_PLAN = 'plus';

export interface DemoAiState {
  setting: AiProviderSetting;
  codexSignedIn: boolean;
}

const INITIAL: DemoAiState = { setting: 'auto', codexSignedIn: true };

export function aiState(srv: DemoServer): DemoAiState {
  const s = srv.overlay.stored.get(KEY);
  if (!isRecord(s)) return INITIAL;
  return {
    setting: isAiProviderSetting(s.setting) ? s.setting : INITIAL.setting,
    codexSignedIn: typeof s.codexSignedIn === 'boolean' ? s.codexSignedIn : INITIAL.codexSignedIn,
  };
}

export function setAiState(srv: DemoServer, patch: Partial<DemoAiState>): DemoAiState {
  const next = { ...aiState(srv), ...patch };
  srv.overlay.stored.set(KEY, next);
  return next;
}

/** The provider the next run uses. */
export function activeProvider(srv: DemoServer): AiProviderId {
  return aiState(srv).setting === 'codex' ? 'codex' : 'claude';
}

/** A stored model id's depth: a Codex id by the Codex table, anything else by the Claude rule. */
function roleOf(model: string): AiModelRole {
  const codex = AI_MODEL_FOR_ROLE.codex;
  for (const role of ['deep', 'standard', 'fast'] as const) if (codex[role] === model) return role;
  // A bare alias ('opus', 'haiku') reads like its full id.
  return claudeModelRole(/^(opus|sonnet|haiku)$/.test(model) ? `claude-${model}` : model);
}

/**
 * What a run started NOW runs on: the active provider and its model of the same depth as `model` (the
 * template's, or the one asked for). Null model ⇒ the standard one.
 */
export function ranOnNow(srv: DemoServer, model: unknown): { provider: AiProviderId; model: string } {
  const provider = activeProvider(srv);
  const role = typeof model === 'string' && model !== '' ? roleOf(model) : 'standard';
  return { provider, model: AI_MODEL_FOR_ROLE[provider][role] };
}

// THE `LIMN_AI_PROVIDER` SETTING, on its own so the pre-flight (`review/auth.ts` `detectClaudeAuth`)
// can read it without importing the provider registry (`ai/provider.ts` → `providers/claude.ts` →
// `review/auth.ts` would be a cycle). `ai/provider.ts` re-exports all of it.

export const AI_PROVIDER_ENV = 'LIMN_AI_PROVIDER';

export type AiProviderSetting = 'claude' | 'codex' | 'auto';

export const CODEX_NOT_AVAILABLE_MESSAGE =
  'Codex is not available in this version of Limn yet. Unset LIMN_AI_PROVIDER (or set it to claude) to use Claude.';

/** The reader's `LIMN_AI_PROVIDER`, read at call time. Unset, empty or unknown ⇒ 'auto'. */
export function aiProviderSetting(env: NodeJS.ProcessEnv = process.env): AiProviderSetting {
  const raw = env[AI_PROVIDER_ENV]?.trim().toLowerCase();
  if (raw === 'claude' || raw === 'codex' || raw === 'auto') return raw;
  return 'auto';
}

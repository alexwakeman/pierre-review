// THE API-KEY PREFERENCE (Settings → AI → "Use my API keys first"): one switch, per machine, that puts
// the API key in the reader's environment ahead of the subscription sign-in.
//
//   • Claude reads ANTHROPIC_API_KEY. Ticked + the key set ⇒ every Claude run uses the key (billed by
//     Anthropic per token), even while Claude Code is signed in. Unticked ⇒ the sign-in first, the key
//     only when there is no sign-in.
//   • Codex reads OPENAI_API_KEY. Codex runs on an API key are not available yet (Limn cannot price
//     them), so a ChatGPT sign-in is still used first; the box only orders the key ahead of a key stored
//     in Limn's Codex folder.
//
// An explicitly set LIMN_AI_USE_API_KEY (`true` / `false`) wins and locks the box. Nothing is stored but
// the tick: the keys stay in the environment, and the wire carries only WHETHER each one is set.

/** `MeResponse.ai.apiKeySetting`. */
export interface AiApiKeySettingStatus {
  /** Use the environment's API key ahead of the sign-in. */
  value: boolean;
  /** 'env' ⇒ LIMN_AI_USE_API_KEY is set and wins (Settings shows it, disabled). */
  source: 'env' | 'settings';
  /** ANTHROPIC_API_KEY is set in Limn's environment (the value is never sent). */
  anthropicKeySet: boolean;
  /** OPENAI_API_KEY is set in Limn's environment (the value is never sent). */
  openaiKeySet: boolean;
}

/** PUT /api/ai/api-key body. */
export interface AiApiKeySettingBody {
  value: boolean;
}

/** PUT /api/ai/api-key → the setting as now resolved. */
export interface AiApiKeySettingResponse {
  setting: AiApiKeySettingStatus;
}

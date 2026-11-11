-- "USE MY API KEYS FIRST" (Settings → AI): accounts.ai_use_api_key. true ⇒ the environment's
-- ANTHROPIC_API_KEY (and OPENAI_API_KEY, where Codex may use it) ahead of the subscription sign-in.
-- NULL = never chosen (off). An explicitly set LIMN_AI_USE_API_KEY wins (ai/credentials.ts). Only the
-- tick is stored, never a key. Additive only.
ALTER TABLE `accounts` ADD `ai_use_api_key` integer;

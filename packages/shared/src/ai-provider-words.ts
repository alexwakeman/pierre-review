import type { AiProviderId } from './types.js';
import { aiProviderName, aiRunProvider, type AiProviderName } from './ai-run-label.js';

// THE PROVIDER'S NAME IN PRODUCT COPY (docs/CODEX-PLAN.md § 3.7). ONE AI provider runs every feature
// at a time (`MeResponse.ai.provider`); every sentence that means "the AI that will run now" names it
// through these helpers, so the SPA and the server word it the same way. Claude's words are the ones
// the product always used: with Claude active nothing reads differently.
//
// A sentence about a STORED run names the provider THAT run used, not the active one. When a run row
// lacks its provider (older rows), it is read from the model id through ai-run-label.ts
// `aiRunProvider` — the ONE rule, shared with the run label.

/**
 * The provider a stored model id belongs to: OpenAI's ids (`gpt-…`, `o3`, `codex-…`) are Codex's;
 * everything else (Claude's ids and the aliases `opus`, `sonnet`, `haiku`) is Claude's. Null ⇒ Claude.
 */
export function aiProviderOfModel(model: string | null | undefined): AiProviderId {
  return aiRunProvider(null, model);
}

/**
 * The provider a STORED run used: its own `provider` when the row carries one, else read from its
 * model id (`aiProviderOfModel`). Every sentence about a stored run names this, never the active one.
 */
export function aiProviderOfRun(run: { provider?: AiProviderId | null; model?: string | null } | null | undefined): AiProviderId {
  return aiRunProvider(run?.provider, run?.model);
}

/** The name of the provider a stored run used ('Claude' | 'Codex'). */
export function aiRunProviderName(run: { provider?: AiProviderId | null; model?: string | null } | null | undefined): AiProviderName {
  return aiProviderName(aiProviderOfRun(run));
}

/** The one line in place of a Run button when the active provider has no credential. */
export function aiSignInLine(provider: AiProviderId | null | undefined): string {
  return provider === 'codex'
    ? 'Sign in to Codex with ChatGPT (limn ai login codex)'
    : 'Sign in to Claude Code or set ANTHROPIC_API_KEY';
}

/** "your own Claude Code login or Anthropic API key" / "your own Codex sign-in". */
export function aiCredentialWords(provider: AiProviderId | null | undefined): string {
  return provider === 'codex' ? 'your own Codex sign-in' : 'your own Claude Code login or Anthropic API key';
}

/** The model tier a feature uses, named for the active provider: Claude's own name ("Claude Haiku"),
 *  or just "Codex" (its tiers are not product words). */
export function aiModelWords(provider: AiProviderId | null | undefined, claudeTier: 'Haiku' | 'Sonnet' | 'Opus'): string {
  return provider === 'codex' ? 'Codex' : `Claude ${claudeTier}`;
}

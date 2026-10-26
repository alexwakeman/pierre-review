import type { AiProviderId } from './types.js';

// THE PROVIDER'S NAME IN PRODUCT COPY (docs/CODEX-PLAN.md § 3.7). ONE AI provider runs every feature
// at a time (`MeResponse.ai.provider`); every sentence that means "the AI that will run now" names it
// through these helpers, so the SPA and the server word it the same way. Claude's words are the ones
// the product always used: with Claude active nothing reads differently.
//
// A sentence about a STORED run names the provider THAT run used, not the active one. Until a run row
// carries its provider, `aiProviderOfModel` reads it from the model id the row stores.

export type AiProviderName = 'Claude' | 'Codex';

/** 'Claude' | 'Codex'. Absent (an older server) ⇒ Claude. */
export function aiProviderName(provider: AiProviderId | null | undefined): AiProviderName {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

/**
 * The provider a stored model id belongs to: OpenAI's ids (`gpt-…`, `o3`, `codex-…`) are Codex's;
 * everything else (Claude's ids and the aliases `opus`, `sonnet`, `haiku`) is Claude's. Null ⇒ Claude.
 */
export function aiProviderOfModel(model: string | null | undefined): AiProviderId {
  const m = (model ?? '').trim().toLowerCase();
  return /^(gpt-|o\d|codex)/.test(m) ? 'codex' : 'claude';
}

/**
 * The provider a STORED run used: its own `provider` when the row carries one, else read from its
 * model id (`aiProviderOfModel`). Every sentence about a stored run names this, never the active one.
 */
export function aiProviderOfRun(run: { provider?: AiProviderId | null; model?: string | null } | null | undefined): AiProviderId {
  if (run?.provider === 'codex' || run?.provider === 'claude') return run.provider;
  return aiProviderOfModel(run?.model);
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

/** Codex's model per role (mirrors the backend's `CODEX_MODEL_FOR_ROLE`, ai/providers/codex.ts). */
export const CODEX_MODEL_NAMES = { deep: 'gpt-6-astra', standard: 'gpt-6.1-sol', fast: 'gpt-6-luna' } as const;

/**
 * A model picker's option, for the provider that will run it. The pickers list Claude's ids; on Codex
 * the same pick runs the Codex model of that id's role (Opus → deep, Sonnet → standard, Haiku → fast),
 * so the option names THAT model: "gpt-6-astra (most thorough)". `claudeLabel` is Claude's own label.
 */
export function aiPickerModelLabel(provider: AiProviderId | null | undefined, model: string, claudeLabel: string): string {
  if (provider !== 'codex') return claudeLabel;
  const m = model.toLowerCase();
  const role = m.includes('opus') ? 'deep' : m.includes('haiku') ? 'fast' : 'standard';
  const why = /\(([^)]*)\)\s*$/.exec(claudeLabel)?.[1];
  return why ? `${CODEX_MODEL_NAMES[role]} (${why})` : CODEX_MODEL_NAMES[role];
}

/** The model tier a feature uses, named for the active provider: Claude's own name ("Claude Haiku"),
 *  or just "Codex" (its tiers are not product words). */
export function aiModelWords(provider: AiProviderId | null | undefined, claudeTier: 'Haiku' | 'Sonnet' | 'Opus'): string {
  return provider === 'codex' ? 'Codex' : `Claude ${claudeTier}`;
}

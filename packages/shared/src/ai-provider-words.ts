import { AUTO_POST_FOOTER, type AiProviderId } from './types.js';
import { aiProviderName, aiRunProvider, type AiProviderName } from './ai-run-label.js';

/**
 * The visible last line of an auto-posted body, naming the provider that RAN the run. Claude's is
 * `AUTO_POST_FOOTER`, unchanged; a Codex run says Codex (a public "Reviewed by Codex." above a
 * Claude footer contradicted itself).
 */
export function autoPostFooter(by: AiProviderName | null | undefined = 'Claude'): string {
  return by === 'Codex' ? '_Posted automatically by Limn’s Codex review._' : AUTO_POST_FOOTER;
}

/** The body footer of a Claude + Codex pair's ONE automatic review (docs/CLAUDE-REVIEW.md § Claude + Codex). */
export const PAIR_AUTO_POST_FOOTER = '_Posted automatically by Limn’s Claude and Codex reviews._';

/** Every footer a Limn auto post may carry — what "was this posted automatically?" looks for. */
export const AUTO_POST_FOOTERS: readonly string[] = [AUTO_POST_FOOTER, autoPostFooter('Codex'), PAIR_AUTO_POST_FOOTER];

/** Whether a posted body carries one of Limn's auto-post footers (either provider's). */
export function hasAutoPostFooter(body: string | null | undefined): boolean {
  const b = body ?? '';
  return AUTO_POST_FOOTERS.some((f) => b.includes(f));
}

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

// THE RUN LABEL — which provider and which model ran a stored AI run, in ONE spelling for every
// surface (Claude Review run headers and history, chat answers, ticket and CI reviews, Check threads,
// diagrams, sprint paths, AI Fix runs and plans, Resolve with Claude). docs/CODEX-PLAN.md Phase 4.
//
// A run row stores `provider` ('claude' | 'codex', NULL on rows from before the column) and `model`
// (the id that ACTUALLY ran: 'claude-opus-5-5', 'gpt-6-astra', …). Rows from before the column are
// Claude's, EXCEPT a few Phase 3 Codex runs that already stored their Codex model id — so a NULL
// provider is read from the model id (`aiRunProvider`), never assumed blindly.
//
// Shared because both halves read it: the server resolves `provider` for the wire, the SPA labels.
import type { AiProviderId, ClaudeReviewModel } from './types.js';
import { CLAUDE_REVIEW_MODEL_LABELS } from './types.js';

/**
 * The provider CHOICE (Settings → AI, or `LIMN_AI_PROVIDER`): one provider for every AI feature, or
 * `auto` — Claude when both are signed in, Codex only when it alone is (docs/CODEX-PLAN.md § 6).
 */
export type AiProviderSetting = 'claude' | 'codex' | 'auto';

/** The choices, in picker order. */
export const AI_PROVIDER_SETTINGS: readonly AiProviderSetting[] = ['auto', 'claude', 'codex'];

/** Is this a known setting value? (A stored or typed value is checked before it is used.) */
export function isAiProviderSetting(v: unknown): v is AiProviderSetting {
  return v === 'claude' || v === 'codex' || v === 'auto';
}

export type AiProviderName = 'Claude' | 'Codex';

/** The provider's display name. Absent (an older server or row) ⇒ Claude. */
export function aiProviderName(provider: AiProviderId | null | undefined): AiProviderName {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

/** A Codex model id (OpenAI's names). Everything else Limn has ever stored is Claude's. */
function isCodexModelId(model: string): boolean {
  return /^(gpt-|o\d|codex)/i.test(model.trim());
}

/**
 * Who ran a stored run: the stored provider when there is one, else read from the model id (a NULL
 * provider is an older row — Claude's, unless its model is a Codex id).
 */
export function aiRunProvider(provider: string | null | undefined, model: string | null | undefined): AiProviderId {
  if (provider === 'claude' || provider === 'codex') return provider;
  return model != null && isCodexModelId(model) ? 'codex' : 'claude';
}

const CLAUDE_FAMILIES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

/**
 * A model id's short display name, WITHOUT the provider: 'claude-opus-5-5' → 'Opus 5.5',
 * 'claude-sonnet-5' → 'Sonnet 5', 'opus' → 'Opus', 'gpt-6-astra' → 'GPT-6 Astra',
 * 'gpt-6.1-sol' → 'GPT-6.1 Sol'. Any other id is returned as stored (a retired or unknown model
 * still names itself).
 */
export function aiModelName(model: string): string {
  const m = model.trim();
  const lower = m.toLowerCase();
  // Claude: claude-<family>-<major>[-<minor>][-<date>] or a bare family alias.
  const claude = /^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?)?$/.exec(lower);
  if (claude) {
    const family = CLAUDE_FAMILIES[claude[1]!]!;
    if (!claude[2]) return family;
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  }
  // Codex: gpt-<version>[-<name>…].
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(lower);
  if (gpt) {
    const rest = (gpt[2] ?? '')
      .split('-')
      .filter((w) => w.length > 0)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return rest ? `GPT-${gpt[1]} ${rest}` : `GPT-${gpt[1]}`;
  }
  return m;
}

/**
 * THE RUN LABEL: "Claude Opus 5.5", "Claude Sonnet 5", "Codex · GPT-6 Astra". `provider` is the stored
 * value (NULL/absent on older rows, read through `aiRunProvider`). A model id Limn does not know is
 * shown as stored, still named by its provider ("Codex · some-model").
 */
export function aiRunLabel(provider: string | null | undefined, model: string | null | undefined): string {
  const p = aiRunProvider(provider, model);
  if (model == null || model.trim() === '') return aiProviderName(p);
  const name = aiModelName(model);
  if (p === 'codex') return `Codex · ${name}`;
  // A Claude name that is a raw id already says "claude-…": do not say Claude twice.
  return name.toLowerCase().startsWith('claude') ? name : `Claude ${name}`;
}

/** A model ROLE: every call site asks for a depth, and each provider resolves it to its own model. */
export type AiModelRole = 'deep' | 'standard' | 'fast';

/**
 * THE MODEL PER ROLE, per provider — the ONE table (the backend's providers resolve through it:
 * ai/providers/claude.ts `CLAUDE_MODEL_FOR_ROLE`, ai/providers/codex.ts `CODEX_MODEL_FOR_ROLE`).
 * Codex's are pinned for @openai/codex 0.164.0 (docs/CODEX-SPIKE.md § 8).
 */
export const AI_MODEL_FOR_ROLE: Readonly<Record<AiProviderId, Readonly<Record<AiModelRole, string>>>> = {
  claude: { deep: 'claude-opus-5-5', standard: 'claude-sonnet-5', fast: 'claude-haiku-5-5' },
  codex: { deep: 'gpt-6-astra', standard: 'gpt-6.1-sol', fast: 'gpt-6-luna' },
};

/** A Claude model id's role (the backend's `claudeModelChoice` rule: Opus deep, Haiku fast, else standard). */
export function claudeModelRole(model: string): AiModelRole {
  if (model.startsWith('claude-opus')) return 'deep';
  if (model.startsWith('claude-haiku')) return 'fast';
  return 'standard';
}

/**
 * A model PICKER's option, for the provider that will run it: the Claude label as it always was on
 * Claude ("Claude Opus 5.5 (most thorough)"), and on Codex the Codex model of the same depth, with
 * the same reason ("Codex · GPT-6 Astra (most thorough)") — so the picker names what will run.
 */
export function aiModelChoiceLabel(model: ClaudeReviewModel, provider: AiProviderId | null | undefined): string {
  const claudeLabel = CLAUDE_REVIEW_MODEL_LABELS[model];
  if (provider !== 'codex') return claudeLabel;
  const name = aiRunLabel('codex', AI_MODEL_FOR_ROLE.codex[claudeModelRole(model)]);
  const why = /\(([^)]*)\)\s*$/.exec(claudeLabel)?.[1];
  return why ? `${name} (${why})` : name;
}

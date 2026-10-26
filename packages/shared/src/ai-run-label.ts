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
import { CLAUDE_REVIEW_MODEL_LABELS, CLAUDE_REVIEW_MODELS } from './types.js';
import { aiEffortWord } from './ai-effort.js';

/**
 * The DEFAULT provider (Settings → AI, or `LIMN_AI_PROVIDER`): it runs every AUTOMATIC run and every
 * surface without a model picker, and is a picker's opening choice; `auto` — Claude when both are
 * signed in, Codex only when it alone is (docs/CODEX-PLAN.md § 6). A MANUAL run with a model picker
 * may run on any signed-in provider that can run its kind (`aiModelPicks`).
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
 * shown as stored, still named by its provider ("Codex · some-model"). `effort` (a run that stored the
 * effort it used: Claude Review runs, AI Fix builds and plans) is added last: "Claude Opus 5.5 · high",
 * "Codex · GPT-6 Astra · extra high"; absent, NULL or unknown adds nothing.
 */
export function aiRunLabel(
  provider: string | null | undefined,
  model: string | null | undefined,
  effort?: string | null,
): string {
  const word = aiEffortWord(effort);
  const base = aiRunBaseLabel(provider, model);
  return word ? `${base} · ${word}` : base;
}

function aiRunBaseLabel(provider: string | null | undefined, model: string | null | undefined): string {
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
  // Owner's choice 2026-10-26: Sol is the default (deep) and Terra the standard; Astra is no longer
  // offered (it spent a ChatGPT Plus 5-hour window in about two reviews). Old Astra rows still label.
  codex: { deep: 'gpt-6.1-sol', standard: 'gpt-6.1-terra', fast: 'gpt-6-luna' },
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

// ---- THE PER-RUN MODEL PICKER (docs/CODEX-PLAN.md § 6, revised 2026-10-26) ----------------------
//
// A MANUAL run with a model picker (Claude Review run + follow-up, AI Fix + Plan first) may run on ANY
// provider that is signed in and can run that kind. The picker lists each such provider's models at
// the depths the surface offers — Claude's offered tiers (`CLAUDE_REVIEW_MODELS`: Opus = deep, Sonnet
// = standard) and Codex's models of the SAME depths — and the request carries `{ provider, model }`.
// The server validates the pair and runs it on THAT provider; automatic runs keep the default.

/** Codex's models a picker offers: the depths Claude's picker offers (deep, standard). */
export type CodexPickerModel = 'gpt-6.1-sol' | 'gpt-6.1-terra';
export const CODEX_PICKER_MODELS: readonly CodexPickerModel[] = ['gpt-6.1-sol', 'gpt-6.1-terra'];

/** Any model a picker offers, on either provider. */
export type AiPickerModel = ClaudeReviewModel | CodexPickerModel;

/** Every model some picker offers (a route schema's enum). */
export const AI_PICKER_MODELS: readonly AiPickerModel[] = [...CLAUDE_REVIEW_MODELS, ...CODEX_PICKER_MODELS];

/** The models a picker offers for one provider, in picker order (most thorough first). */
export function aiPickerModels(provider: AiProviderId): readonly AiPickerModel[] {
  return provider === 'codex' ? CODEX_PICKER_MODELS : CLAUDE_REVIEW_MODELS;
}

/** Which provider offers this picker model, or null when no picker offers it (retired, unknown). */
export function aiPickerModelProvider(model: unknown): AiProviderId | null {
  if (typeof model !== 'string') return null;
  if ((CLAUDE_REVIEW_MODELS as readonly string[]).includes(model)) return 'claude';
  if ((CODEX_PICKER_MODELS as readonly string[]).includes(model)) return 'codex';
  return null;
}

/**
 * A picker model → the Claude model of the SAME depth (what a run row is queued with and what every
 * run entry point takes; each provider then resolves the depth to its own model). A Claude model is
 * returned as it is.
 */
export function aiPickerRequestModel(model: AiPickerModel): ClaudeReviewModel {
  if (model === 'gpt-6.1-sol') return 'claude-opus-5-5';
  if (model === 'gpt-6.1-terra') return 'claude-sonnet-5';
  return model;
}

/** The picker model of the same depth as a Claude model, on a provider. */
export function aiPickerModelFor(provider: AiProviderId, model: ClaudeReviewModel): AiPickerModel {
  if (provider !== 'codex') return model;
  return AI_MODEL_FOR_ROLE.codex[claudeModelRole(model)] as CodexPickerModel;
}

/** One picker option: who runs it, the model sent, its label and the `<option>` value. */
export interface AiModelPick {
  provider: AiProviderId;
  model: AiPickerModel;
  label: string;
  value: string;
}

/** The `<option>` value of a pick ("codex:gpt-6.1-sol"). */
export function aiModelPickValue(provider: AiProviderId, model: AiPickerModel): string {
  return `${provider}:${model}`;
}

/** Read an `<option>` value back; null when it is not a pick some provider offers. */
export function parseAiModelPickValue(value: string): { provider: AiProviderId; model: AiPickerModel } | null {
  const at = value.indexOf(':');
  if (at < 0) return null;
  const provider = value.slice(0, at);
  const model = value.slice(at + 1);
  if (provider !== 'claude' && provider !== 'codex') return null;
  return aiPickerModelProvider(model) === provider ? { provider, model: model as AiPickerModel } : null;
}

/**
 * THE PICKER'S OPTIONS for the providers that can run the surface's kind, in the order given (the
 * caller puts the default provider first). Labels name what will run ("Claude Opus 5.5 (most
 * thorough)", "Codex · GPT-6 Astra (most thorough)"), so with one provider the picker reads as it
 * always did.
 */
export function aiModelPicks(providers: readonly AiProviderId[]): AiModelPick[] {
  const seen = new Set<AiProviderId>();
  const out: AiModelPick[] = [];
  for (const provider of providers) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    for (const model of aiPickerModels(provider)) {
      out.push({
        provider,
        model,
        label: aiModelChoiceLabel(aiPickerRequestModel(model), provider),
        value: aiModelPickValue(provider, model),
      });
    }
  }
  return out;
}

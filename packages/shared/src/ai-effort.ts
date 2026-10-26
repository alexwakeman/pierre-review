// THE EFFORT SETTING (Settings → AI → Effort) — how hard an agentic run thinks and reads, ONE level for
// both providers. It reaches the PR review (its specialists, its follow-up re-reviews), AI Fix and Plan
// first; every other run keeps its provider's own depth.
//
// THE MAP (Limn level → what each provider is sent) is the IDENTITY, because both providers accept the
// same five words:
//   • Claude (Agent SDK `effort`): Opus 5.5 and Sonnet 5 take low | medium | high | xhigh | max, all
//     with adaptive thinking (Opus 5.5's thinking cannot be switched off; effort is its only control).
//   • Codex (`model_reasoning_effort`, @openai/codex 0.164.0): the enum is none | minimal | low | medium
//     | high | xhigh | max | ultra; GPT-6 Astra and GPT-6.1 Sol take low … ultra, GPT-6 Luna low … max.
//     `none` / `minimal` (below Claude's floor) and `ultra` (no Claude counterpart) are NOT offered.
// So "High" is `high` on both, and a run label ("Claude Opus 5.5 · high", "Codex · GPT-6 Astra · high")
// names the word the provider was actually sent.
//
// NULL (never chosen) is DEFAULT: today's behaviour, which is NOT one level — Claude runs medium, Codex
// runs by depth (deep = high, standard = medium, fast = low). A diff-only review runs one step lower,
// but never below what Default runs it at unless the chosen level is lower still. An explicitly set
// REVIEW_EFFORT wins over the stored level and locks the control. The backend resolver is apps/backend/src/ai/effort.ts.

/** A reasoning effort, in the providers' own words (the same five on both). */
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Every level, lowest first (the Settings menu's order after "Default"). */
export const AI_EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Is this a known level? (A stored, typed or env value is checked before it is used.) */
export function isAiEffort(v: unknown): v is AiEffort {
  return typeof v === 'string' && (AI_EFFORTS as readonly string[]).includes(v);
}

/** The Settings menu's words. */
export const AI_EFFORT_LABELS: Readonly<Record<AiEffort, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** The run label's word ("Claude Opus 5.5 · high"); null for a value Limn does not know. */
export function aiEffortWord(effort: string | null | undefined): string | null {
  if (!isAiEffort(effort)) return null;
  return effort === 'xhigh' ? 'extra high' : effort;
}

/** One level lower, never below `low` (a diff-only review's effort). Pure. */
export function stepDownEffort(effort: AiEffort): AiEffort {
  const i = AI_EFFORTS.indexOf(effort);
  return i > 0 ? AI_EFFORTS[i - 1]! : 'low';
}

/**
 * `MeResponse.ai.effortSetting` — the chosen level and who chose it. `value: null` ⇒ Default.
 * `source: 'env'` ⇒ REVIEW_EFFORT is set and wins (Settings shows it, disabled).
 */
export interface AiEffortSettingStatus {
  value: AiEffort | null;
  source: 'env' | 'settings';
}

/** PUT /api/ai/effort body. `null` ⇒ back to Default. */
export interface AiEffortSettingBody {
  value: AiEffort | null;
}

/** PUT /api/ai/effort → the setting as now resolved. */
export interface AiEffortSettingResponse {
  setting: AiEffortSettingStatus;
}

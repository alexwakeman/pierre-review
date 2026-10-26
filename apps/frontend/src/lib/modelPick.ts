// THE PER-RUN MODEL PICKER (docs/CODEX-PLAN.md § 6, revised 2026-10-26) — the pure half, so tests can
// pin it without React. A MANUAL surface with a model menu (AI Review run + follow-up, AI Fix + Plan
// first) lists the models of EVERY provider that can run its kind right now, the default provider
// (Settings → AI) first; with one provider ready the menu reads exactly as before. It opens on the
// default provider's model at the surface's usual depth; a pick stays until the reader changes it or
// its provider stops being ready (then the menu falls back to the opening choice).
import {
  aiModelPicks,
  aiModelPickValue,
  aiPickerModelFor,
  type AiModelPick,
  type AiProviderId,
  type AiRunKind,
  type ClaudeReviewModel,
  type MeResponse,
} from '@pierre-review/shared';
import { aiProviderReadyFor, aiRunnableProviders } from './aiCapabilities.js';

export interface ModelPickState {
  /** The options, the default provider's first. Never empty. */
  picks: AiModelPick[];
  /** The option shown as chosen. */
  chosen: AiModelPick;
  /** More than one provider is listed (the menu then names both). */
  mixed: boolean;
}

/**
 * Resolve the menu for a kind: `picked` is the reader's last choice (an option value) or null. The
 * opening choice is the default provider's model of the same depth as `usualModel`.
 */
export function resolveModelPick(
  me: MeResponse | undefined,
  kind: AiRunKind,
  usualModel: ClaudeReviewModel,
  picked: string | null,
): ModelPickState {
  const defaultProvider: AiProviderId = me?.ai?.provider === 'codex' ? 'codex' : 'claude';
  const ready = aiRunnableProviders(me, kind);
  // None ready: the default's own models (the Run gate shows its sign-in line in place of the button).
  const providers = ready.length > 0 ? ready : [defaultProvider];
  const picks = aiModelPicks(providers);
  const opening =
    picks.find((p) => p.value === aiModelPickValue(providers[0]!, aiPickerModelFor(providers[0]!, usualModel))) ??
    picks[0]!;
  const chosen = (picked != null ? picks.find((p) => p.value === picked) : undefined) ?? opening;
  return { picks, chosen, mixed: new Set(picks.map((p) => p.provider)).size > 1 };
}

/** The follow-up rule (see hooks/useModelPick.ts `useFollowUpProvider`), pure. */
export function followUpProviderOf(
  me: MeResponse | undefined,
  stored: AiProviderId | null | undefined,
  kind: AiRunKind,
): AiProviderId {
  const fallback: AiProviderId = me?.ai?.provider === 'codex' ? 'codex' : 'claude';
  return stored != null && aiProviderReadyFor(me, stored, kind) ? stored : fallback;
}

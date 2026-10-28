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
import { PAIR_RUN_LABEL } from '@pierre-review/shared';

export interface ModelPickState {
  /** The options, the default provider's first. Never empty. */
  picks: AiModelPick[];
  /** The option shown as chosen. */
  chosen: AiModelPick;
  /** More than one provider is listed (the menu then names both). */
  mixed: boolean;
  /** "Claude + Codex" is listed (the AI Review menu, only while BOTH can review). */
  pairOffered?: boolean;
  /** "Claude + Codex" is the chosen option (`chosen` then holds Claude's default model). */
  pair?: boolean;
}

/** The `<option>` value of "Claude + Codex" (docs/CLAUDE-REVIEW.md § Claude + Codex). */
export const PAIR_PICK_VALUE = 'pair';
/** Its label — the pair's one name everywhere (shared `PAIR_RUN_LABEL`). */
export const PAIR_PICK_LABEL = PAIR_RUN_LABEL;

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

/**
 * THE AI REVIEW MENU: `resolveModelPick`, plus "Claude + Codex" (last) while BOTH providers can
 * review. Picked, it runs Claude's default review model first, then Codex's of the same depth; it
 * falls back to the opening choice when one of them stops being ready.
 */
export function resolveReviewModelPick(
  me: MeResponse | undefined,
  usualModel: ClaudeReviewModel,
  picked: string | null,
): ModelPickState {
  const base = resolveModelPick(me, 'review', usualModel, picked === PAIR_PICK_VALUE ? null : picked);
  const ready = aiRunnableProviders(me, 'review');
  const pairOffered = ready.includes('claude') && ready.includes('codex');
  if (!pairOffered) return { ...base, pairOffered: false, pair: false };
  const pairPick: AiModelPick = {
    provider: 'claude',
    model: usualModel,
    label: PAIR_PICK_LABEL,
    value: PAIR_PICK_VALUE,
  };
  const picks = [...base.picks, pairPick];
  return picked === PAIR_PICK_VALUE
    ? { picks, chosen: pairPick, mixed: true, pairOffered: true, pair: true }
    : { ...base, picks, pairOffered: true, pair: false };
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

/**
 * The progress line of a running review: "Running Claude review" — and for a Claude + Codex pair, the
 * step it is on: "Claude reviewing…", then "Codex reviewing…", then "Merging the two reviews…" (the
 * second half's `merging` phase, docs/CLAUDE-REVIEW.md § Claude + Codex → One review).
 */
export function pairRunningLabel(running: string, role: 'first' | 'second' | null, phase?: string | null): string {
  if (role == null) return `Running ${running} review`;
  if (phase === 'merging') return 'Merging the two reviews…';
  return `${running} reviewing…`;
}

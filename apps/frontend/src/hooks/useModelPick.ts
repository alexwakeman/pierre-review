import { useState } from 'react';
import type { AiProviderId, AiRunKind, ClaudeReviewModel } from '@pierre-review/shared';
import { useMe } from './useTriage.js';
import { followUpProviderOf, resolveModelPick, resolveReviewModelPick, type ModelPickState } from '../lib/modelPick.js';

/**
 * The per-run model menu of a manual surface (lib/modelPick.ts): its options across every ready
 * provider, the chosen one, and the setter for an `<option>` value. The pick lives until remount.
 */
export function useModelPick(
  kind: AiRunKind,
  usualModel: ClaudeReviewModel,
): ModelPickState & { pick: (value: string) => void } {
  const me = useMe().data;
  const [picked, setPicked] = useState<string | null>(null);
  return { ...resolveModelPick(me, kind, usualModel, picked), pick: setPicked };
}

/** The AI Review menu (lib/modelPick.ts `resolveReviewModelPick`): the models, plus "Claude + Codex". */
export function useReviewModelPick(usualModel: ClaudeReviewModel): ModelPickState & { pick: (value: string) => void } {
  const me = useMe().data;
  const [picked, setPicked] = useState<string | null>(null);
  return { ...resolveReviewModelPick(me, usualModel, picked), pick: setPicked };
}

/**
 * WHO RUNS A FOLLOW-UP on a stored run (the server's rule, ai/run-choice.ts `followUpProvider`): the
 * review chat on its review, another pass or the build of a plan. The stored run's provider while it
 * can run the kind, else the default provider (Settings → AI).
 */
export function useFollowUpProvider(stored: AiProviderId | null | undefined, kind: AiRunKind): AiProviderId {
  return followUpProviderOf(useMe().data, stored, kind);
}

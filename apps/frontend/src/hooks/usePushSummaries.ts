import { useQuery } from '@tanstack/react-query';
import type { PrPushSummary } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';

// THE PUSH SUMMARIES of one PR (docs/FRONTEND.md § Push summaries): what each full Limn review said
// the pushes since the previous one changed. Gated on `me.ai.enabled` — off ⇒ no request, nothing
// shown. The key sits UNDER `['claude-review', prId]`, so every place that refreshes a PR's review
// after a run (hooks/useClaudeReview.ts) refreshes these with it.
export const pushSummariesKey = (prId: number): unknown[] => ['claude-review', prId, 'push-summaries'];

// One stable empty list, so a caller's memo over the result does not recompute every render.
const NONE: readonly PrPushSummary[] = [];

export function usePushSummaries(prId: number): readonly PrPushSummary[] {
  const ai = useAiCapabilities();
  const q = useQuery({
    queryKey: pushSummariesKey(prId),
    queryFn: () => api.prPushSummaries(prId),
    enabled: ai.enabled,
    staleTime: 60_000,
  });
  return ai.enabled ? (q.data?.summaries ?? NONE) : NONE;
}

/** Whether push summaries may show at all (the one gate, for surfaces with their data inline). */
export function usePushSummariesVisible(): boolean {
  return useAiCapabilities().enabled;
}

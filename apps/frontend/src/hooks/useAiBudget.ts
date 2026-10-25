import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiBudgetBody, AiBudgetResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';
import { runCostText } from '../lib/aiBudget.js';

// THE ONE QUERY for the Claude spend budget (GET /api/ai/budget). Account-grained (the budget guards
// the machine's Claude login or API key, not a workspace), so the key has no `ws:` segment. Every
// reader — the header toast, the meter beside each Run button, the Settings section — shares it, so
// a page full of Run buttons is still one request. The route exists only when AI is on.

export const AI_BUDGET_QUERY_KEY = ['ai-budget'] as const;

export function useAiBudget() {
  const enabled = useAiCapabilities().enabled;
  return useQuery<AiBudgetResponse>({
    queryKey: AI_BUDGET_QUERY_KEY,
    queryFn: api.aiBudget,
    enabled,
    retry: false,
    staleTime: 60_000,
    // Usage moves while the page sits open, and the header's usage item shows it whether or not the
    // budget is on: every 2 minutes while the tab is visible (React Query pauses an interval in a
    // hidden tab). The server answers from its cached reading and refreshes it in the background.
    refetchInterval: 2 * 60_000,
  });
}

/**
 * A run's cost, worded for the credential: US$ on an API key, the share of the week on a Claude
 * subscription, nothing when unknown (lib/aiBudget.ts `runCostText`). Shares the ONE budget query.
 */
export function useRunCostText(): (costUsd: number | null | undefined) => string | null {
  const usage = useAiBudget().data?.usage;
  return (costUsd) => runCostText(costUsd, usage);
}

export function useSetAiBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AiBudgetBody) => api.setAiBudget(body),
    onSuccess: (data) => qc.setQueryData(AI_BUDGET_QUERY_KEY, data),
  });
}

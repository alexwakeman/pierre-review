import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiBudgetBody, AiBudgetResponse, AiProviderId } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';
import { runCostText } from '../lib/aiBudget.js';

// THE ONE QUERY for the Claude spend budget (GET /api/ai/budget). Account-grained (the budget guards
// the machine's Claude login or API key, not a workspace), so the key has no `ws:` segment. Every
// reader — the header toast, the meter beside each Run button, the Settings section — shares it, so
// a page full of Run buttons is still one request. The route exists only when AI is on.

export const AI_BUDGET_QUERY_KEY = ['ai-budget'] as const;

/**
 * `provider`: whose reading — a manual run's per-run choice. The DEFAULT provider's (absent, or the
 * same as Settings → AI) is the ONE shared query above; the other provider's is its own key
 * (`['ai-budget', provider]`, `GET /api/ai/budget?provider=`), read only by a Run gate whose menu
 * picked it.
 */
export function useAiBudget(provider?: AiProviderId | null) {
  const caps = useAiCapabilities();
  const enabled = caps.enabled;
  const other = provider != null && provider !== caps.provider ? provider : null;
  return useQuery<AiBudgetResponse>({
    queryKey: other ? [...AI_BUDGET_QUERY_KEY, other] : AI_BUDGET_QUERY_KEY,
    queryFn: other ? () => api.aiBudget(other) : () => api.aiBudget(),
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
 * subscription, nothing when unknown (lib/aiBudget.ts `runCostText`). Pass the run's provider so a
 * run by the other provider is never judged by this one's reading. Shares the ONE budget query.
 */
export function useRunCostText(): (costUsd: number | null | undefined, runProvider?: AiProviderId | null) => string | null {
  const usage = useAiBudget().data?.usage;
  return (costUsd, runProvider) => runCostText(costUsd, usage, runProvider);
}

export function useSetAiBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AiBudgetBody) => api.setAiBudget(body),
    onSuccess: (data) => {
      qc.setQueryData(AI_BUDGET_QUERY_KEY, data);
      // The settings are per machine: the other provider's reading (a picker's) re-reads them.
      void qc.invalidateQueries({ queryKey: AI_BUDGET_QUERY_KEY, exact: false, predicate: (q) => q.queryKey.length > 1 });
    },
  });
}

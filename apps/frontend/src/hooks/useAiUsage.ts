import { useQuery } from '@tanstack/react-query';
import type { AiUsageResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useMe } from './useTriage.js';

// Month-to-date AI-usage rollup (summary TURNS + agent CREDITS). Fetched lazily — `enabled` is
// gated on the "Track usage" panel being open. Short staleTime so it reflects a just-run digest.
// Seeded from the login balance (`/api/me` carries `aiUsage`), so the panel shows the spend
// baseline instantly and refreshes in the background.
export function useAiUsage(enabled: boolean) {
  const seed = useMe().data?.aiUsage ?? undefined;
  return useQuery<AiUsageResponse>({
    queryKey: ['ai-usage'],
    queryFn: () => api.aiUsage(),
    enabled,
    staleTime: 30_000,
    placeholderData: seed,
  });
}

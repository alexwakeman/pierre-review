import { useQuery } from '@tanstack/react-query';
import type { AiUsageResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Month-to-date AI-usage rollup in CREDITS (Pro). Fetched lazily — `enabled` is gated on
// the "Track Usage" panel being open. Short staleTime so it reflects a just-run digest.
export function useAiUsage(enabled: boolean) {
  return useQuery<AiUsageResponse>({
    queryKey: ['ai-usage'],
    queryFn: () => api.aiUsage(),
    enabled,
    staleTime: 30_000,
  });
}

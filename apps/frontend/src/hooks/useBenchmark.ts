import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

// Toggle the account's cross-org benchmark consent (cloud-only). On success the ['me'] query
// (which carries `benchmarkOptIn`) is invalidated so the Settings toggle reflects server truth.
export function useSetBenchmarkConsent() {
  const qc = useQueryClient();
  return useMutation<{ status: string; benchmarkOptIn: boolean }, Error, boolean>({
    mutationFn: (optIn) => api.setBenchmarkConsent(optIn),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

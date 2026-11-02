import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FeatureSettings, FeatureSettingsResponse, MeResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// SETTINGS → FEATURES, client side. ACCOUNT-GRAINED, so it rides `['me']` (no `ws:<id>` segment).
// The response carries the RESOLVED `features`; seating it at once moves the sidebar and ⌘K on the
// same click. Visibility only: nothing else needs refetching.
export function useSetFeatureSettings() {
  const qc = useQueryClient();
  return useMutation<FeatureSettingsResponse, Error, FeatureSettings | null>({
    mutationKey: ['feature-settings'],
    mutationFn: (settings) => api.setFeatureSettings(settings),
    onSuccess: (res) => {
      qc.setQueryData<MeResponse>(['me'], (prev) => (prev != null ? { ...prev, features: res.features } : prev));
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

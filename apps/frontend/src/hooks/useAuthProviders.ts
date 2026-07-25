import { useQuery } from '@tanstack/react-query';
import type { AuthProvidersResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Which GitHub sign-in providers this deployment offers. Deployment-level config that can't
// change while the tab is open, so it's effectively static — Infinity staleTime, no refetch.
// Used by the Settings "GitHub App" section for the install link's slug. (The signed-OUT
// SignInGate does its own bare fetch: it renders outside this app's data layer.)
export function useAuthProviders() {
  return useQuery<AuthProvidersResponse>({
    queryKey: ['auth-providers'],
    queryFn: () => api.authProviders(),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

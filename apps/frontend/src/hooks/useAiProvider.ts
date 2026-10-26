import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiProviderSetting, CodexLoginMethod, CodexLoginResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { AI_BUDGET_QUERY_KEY } from './useAiBudget.js';

// THE AI PROVIDER CHOICE and LIMN'S OWN CODEX SIGN-IN (Settings → AI). The choice is READ from
// `/api/me` (`ai.provider`, `ai.providerSetting`, `ai.providers`), so a write invalidates `['me']` —
// every Run gate, picker label and status line follows at once — and the budget, which judges the
// ACTIVE provider's usage.

export function useSetAiProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: AiProviderSetting) => api.setAiProvider(value),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: AI_BUDGET_QUERY_KEY });
    },
  });
}

export const CODEX_LOGIN_QUERY_KEY = ['codex-login'] as const;

/**
 * The Codex sign-in's state (GET /api/ai/codex/login). Polled every 2s while a sign-in is WAITING for
 * the browser or the device code; once it ends, `/api/me` is refetched so the provider list reads the
 * new sign-in. `enabled` false (Settings closed, AI off) asks nothing.
 */
export function useCodexLogin(enabled: boolean) {
  const qc = useQueryClient();
  return useQuery<CodexLoginResponse>({
    queryKey: CODEX_LOGIN_QUERY_KEY,
    queryFn: async () => {
      const prev = qc.getQueryData<CodexLoginResponse>(CODEX_LOGIN_QUERY_KEY);
      const next = await api.codexLogin();
      if (prev?.login.state === 'waiting' && next.login.state !== 'waiting') {
        void qc.invalidateQueries({ queryKey: ['me'] });
      }
      return next;
    },
    enabled,
    retry: false,
    refetchInterval: (q) => (q.state.data?.login.state === 'waiting' ? 2000 : false),
  });
}

/** Start (or join) a sign-in, cancel it, or sign out. Each answer replaces the cached state. */
export function useCodexLoginActions() {
  const qc = useQueryClient();
  const settle = (data: CodexLoginResponse): void => {
    qc.setQueryData(CODEX_LOGIN_QUERY_KEY, data);
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const start = useMutation({
    mutationFn: (method: CodexLoginMethod) => api.startCodexLogin(method),
    onSuccess: settle,
  });
  const cancel = useMutation({ mutationFn: () => api.cancelCodexLogin(), onSuccess: settle });
  const logout = useMutation({
    mutationFn: () => api.codexLogout(),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: CODEX_LOGIN_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return { start, cancel, logout };
}

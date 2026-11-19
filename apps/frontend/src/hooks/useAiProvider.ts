import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiEffort, AiProviderSetting, AiRunProfiles, CodexLoginMethod, CodexLoginResponse, MeResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { AI_BUDGET_QUERY_KEY } from './useAiBudget.js';
import { meWithRunProfiles } from '../lib/runProfiles.js';

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

/** The Effort level (Settings → AI → Effort). `null` ⇒ Default. Read back from `/api/me`. */
export function useSetAiEffort() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: AiEffort | null) => api.setAiEffort(value),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/**
 * The run profiles (Settings → AI → Review / AI Fix / Implement story). Each write sends the WHOLE object,
 * built from `me.ai.runProfiles`, so:
 *   • the new value goes into `['me']` BEFORE the PUT (`meWithRunProfiles`, the server's own fold): a
 *     control never jumps back to the old value mid-save; an error puts the old `/api/me` back;
 *   • the PUT's answer replaces it, and the save stays pending until `/api/me` is read back — the
 *     controls are disabled meanwhile, so the next edit is never built from the value before this one
 *     and two quick edits cannot undo each other.
 */
export function useSetAiRunProfiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (profiles: AiRunProfiles) => api.setAiRunProfiles(profiles),
    onMutate: async (profiles) => {
      // An in-flight `/api/me` read must not land over the optimistic value.
      await qc.cancelQueries({ queryKey: ['me'] });
      const before = qc.getQueryData<MeResponse>(['me']);
      qc.setQueryData<MeResponse | undefined>(['me'], (old) => meWithRunProfiles(old, profiles));
      return { before };
    },
    onError: (_err, _profiles, c) => {
      if (c?.before !== undefined) qc.setQueryData(['me'], c.before);
    },
    onSuccess: (res) => {
      qc.setQueryData<MeResponse>(['me'], (old) => (old?.ai && res?.runProfiles ? { ...old, ai: { ...old.ai, runProfiles: res.runProfiles } } : old));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

/** "Use my API keys first" (Settings → AI). Read back from `/api/me`; the budget follows the credential
 *  (US$ on a key, a share of the week on a sign-in), so it is refetched too. */
export function useSetAiApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: boolean) => api.setAiApiKey(value),
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

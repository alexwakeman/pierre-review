// Bot Tuning Advisor hooks (Pro; /api/pro/advisor/*). Query keys carry the `ws:<id>`
// segment and use skipToken while workspaceId === null (nothing workspace-scoped may fetch
// before the scope resolves — the request would be answered from the account's DEFAULT and
// cached under the wrong key).
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdvisorConfigPrBody,
  AdvisorConfigPrResponse,
  AdvisorEffectResponse,
  AdvisorFindingsResponse,
  AdvisorPreviewResponse,
  AdvisorProfilePutBody,
  AdvisorRefineBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey, ACTIVITY_GC_TIME } from './useActivity.js';

export function advisorFindingsQueryKey(workspaceId: number | null): [string, string] {
  return ['advisor-findings', workspaceKey(workspaceId)];
}

export function useAdvisorFindings(workspaceId: number | null, enabled = true) {
  return useQuery<AdvisorFindingsResponse>({
    queryKey: advisorFindingsQueryKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.advisorFindings(workspaceId),
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

export function useAdvisorEffect(
  workspaceId: number | null,
  botUserId: number | null,
  enabled = true,
) {
  return useQuery<AdvisorEffectResponse>({
    queryKey: ['advisor-effect', workspaceKey(workspaceId), botUserId ?? 'none'],
    queryFn:
      workspaceId == null || botUserId == null
        ? skipToken
        : () => api.advisorEffect(workspaceId, botUserId),
    enabled: enabled && botUserId != null,
    staleTime: 5 * 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

export function useAdvisorBrief(
  workspaceId: number | null,
  botUserId: number | null,
  keys: string[],
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      'advisor-brief',
      workspaceKey(workspaceId),
      botUserId ?? 'all',
      [...keys].sort().join(','),
    ],
    queryFn:
      workspaceId == null
        ? skipToken
        : () => api.advisorBrief(workspaceId, botUserId ?? undefined, keys),
    enabled,
    staleTime: 60_000,
  });
}

function invalidateAdvisor(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['advisor-findings'] });
  void qc.invalidateQueries({ queryKey: ['advisor-effect'] });
}

export function useAdvisorDismiss(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dedupeKey: string) => {
      if (workspaceId == null) return Promise.reject(new Error('no workspace'));
      return api.advisorDismiss(workspaceId, dedupeKey);
    },
    onSuccess: () => invalidateAdvisor(qc),
  });
}

export function useAdvisorFileIssue(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dedupeKey: string) => {
      if (workspaceId == null) return Promise.reject(new Error('no workspace'));
      return api.advisorFileIssue(workspaceId, dedupeKey);
    },
    onSuccess: () => invalidateAdvisor(qc),
  });
}

// The BILLED-adjacent GitHub write. mutationKey is shared across mounts (the CiAnalysisCard
// double-bill lesson): a run started on one mount must read as in-flight everywhere.
export function advisorConfigPrMutationKey(
  botUserId: number,
): [string, number] {
  return ['advisor-config-pr', botUserId];
}

export function useAdvisorConfigPr(workspaceId: number | null, botUserId: number) {
  const qc = useQueryClient();
  return useMutation<AdvisorConfigPrResponse, Error, AdvisorConfigPrBody>({
    mutationKey: advisorConfigPrMutationKey(botUserId),
    mutationFn: (body) => {
      if (workspaceId == null) return Promise.reject(new Error('no workspace'));
      return api.advisorConfigPr(workspaceId, body);
    },
    onSuccess: () => invalidateAdvisor(qc),
  });
}

// The dry-run of the same pipeline (a few GitHub contents reads, nothing billed, nothing
// written). A mutation rather than a query on purpose: the result must visibly belong to
// the exact selection the user clicked Preview with — silently refetching on selection
// change would show a preview for keys the user hasn't asked about yet.
export function useAdvisorPreview(workspaceId: number | null, botUserId: number) {
  return useMutation<AdvisorPreviewResponse, Error, AdvisorConfigPrBody>({
    mutationKey: ['advisor-preview', botUserId],
    mutationFn: (body) => {
      if (workspaceId == null) return Promise.reject(new Error('no workspace'));
      return api.advisorPreview(workspaceId, body);
    },
  });
}

// The ONE LLM mutation. Shared mutationKey `['advisor-refine', keys, path]` so a paid
// rewording in flight reads as running on every mount of the same target.
export function advisorRefineMutationKey(
  dedupeKeys: string[],
  path: string,
): [string, string, string] {
  return ['advisor-refine', [...dedupeKeys].sort().join(','), path];
}

export function useAdvisorRefine(
  workspaceId: number | null,
  dedupeKeys: string[],
  path: string,
) {
  return useMutation({
    mutationKey: advisorRefineMutationKey(dedupeKeys, path),
    mutationFn: (body: AdvisorRefineBody) => {
      if (workspaceId == null) return Promise.reject(new Error('no workspace'));
      return api.advisorRefine(workspaceId, body);
    },
  });
}

export function useAdvisorPutProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { botUserId: number; body: AdvisorProfilePutBody }) =>
      api.advisorPutProfile(args.botUserId, args.body),
    onSuccess: () => invalidateAdvisor(qc),
  });
}

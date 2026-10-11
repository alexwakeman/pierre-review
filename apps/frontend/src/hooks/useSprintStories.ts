import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SprintChecks,
  SprintChecksResponse,
  SprintAssessmentResponse,
  SprintAssessResponse,
  SprintRefreshResponse,
  SprintReposResponse,
  SprintStatusesResponse,
  SprintStatusSettings,
  SprintStoriesResponse,
  SprintTicketRow,
  SprintWriteRequest,
  SprintWriteResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';
import { workspaceKey } from './useActivity.js';
import { useProCapabilities } from './useTriage.js';

// Reports → This sprint. Pro with the rest of Reports (`periodReports`): every route 402s without it,
// so every hook ANDs the capability into its own `enabled` — the SPA must never learn the paywall by
// polling a 402. "Check against code" is agentic and LOCAL-ONLY (its routes are not registered in
// cloud), so its hooks also AND `me.ai.enabled`.
//
// ⚠ SHARED MUTATION KEYS. Every mount of one ticket's Check / Update shares `['sprint-assess', ident]`
// / `['sprint-write', ident]`, and the UI reads `useIsMutating` — never a per-mount `isPending`, which
// resets on a tab switch mid-request and would offer a second billed run or a second write.
//
// ⚠ CACHE WRITES LIVE IN THE HOOK-LEVEL `onSuccess`, never a `mutate()` callback: observer teardown
// (the reader switching tab) kills mutate-scoped callbacks. Both the run and the write record are
// stored server-side, so the list re-reads them in any case.

export function sprintStoriesKey(workspaceId: number | null): [string, string] {
  return ['sprint-stories', workspaceKey(workspaceId)];
}

export function sprintAssessmentKey(id: number | null): [string, number | null] {
  return ['sprint-assessment', id];
}

export function sprintAssessMutationKey(ident: string): [string, string] {
  return ['sprint-assess', ident];
}

export function sprintWriteMutationKey(ident: string): [string, string] {
  return ['sprint-write', ident];
}

export function sprintReposMutationKey(ident: string): [string, string] {
  return ['sprint-repos', ident];
}

function patchTicket(
  data: SprintStoriesResponse | undefined,
  ident: string,
  patch: (t: SprintTicketRow) => SprintTicketRow,
): SprintStoriesResponse | undefined {
  if (data == null) return data;
  return { ...data, tickets: data.tickets.map((t) => (t.ident === ident ? patch(t) : t)) };
}

export function useSprintStories(workspaceId: number | null) {
  const { periodReports } = useProCapabilities();
  return useQuery<SprintStoriesResponse>({
    queryKey: sprintStoriesKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.sprintStories(workspaceId),
    enabled: periodReports,
    staleTime: 30_000,
    // The worker re-reads the sprint every 20 minutes and labels arrive in the background; a minute
    // is often enough. While the first read has not landed ("Reading…"), look sooner.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d != null && d.trackerOn && d.read.readAt == null && d.read.error == null) return 5_000;
      return 60_000;
    },
    // Visible tabs only.
    refetchIntervalInBackground: false,
  });
}

export function useSprintRefresh(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<SprintRefreshResponse, Error>({
    mutationKey: ['sprint-refresh', workspaceKey(workspaceId)],
    mutationFn: () => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.sprintRefresh(workspaceId);
    },
    onSuccess: (data) => {
      qc.setQueryData<SprintStoriesResponse>(sprintStoriesKey(data.workspaceId), (prev) =>
        prev == null ? prev : { ...prev, read: data.read },
      );
      void qc.invalidateQueries({ queryKey: sprintStoriesKey(workspaceId) });
    },
  });
}

export function useSprintRefreshing(workspaceId: number | null): boolean {
  return useIsMutating({ mutationKey: ['sprint-refresh', workspaceKey(workspaceId)] }) > 0;
}

/** Replace the workspace's checks (which issues it raises). The list refetches: issues, counts and
 *  the order all move with them. */
export function useSprintSetChecks(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<SprintChecksResponse, Error, SprintChecks>({
    mutationKey: ['sprint-checks', workspaceKey(workspaceId)],
    mutationFn: (checks) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.sprintSetChecks({ workspaceId, checks });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: sprintStoriesKey(workspaceId) });
    },
  });
}

/** Replace the workspace's status layout override (order + "code delivered from"). `{order: null,
 *  deliveredFrom: null}` = back to automatic. The layout lands at once; the list refetches because every
 *  row's stage and the section order move with it. */
export function useSprintSetStatuses(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<SprintStatusesResponse, Error, SprintStatusSettings>({
    mutationKey: ['sprint-statuses', workspaceKey(workspaceId)],
    mutationFn: (settings) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.sprintSetStatuses({ workspaceId, settings });
    },
    onSuccess: (data) => {
      qc.setQueryData<SprintStoriesResponse>(sprintStoriesKey(data.workspaceId), (prev) =>
        prev == null ? prev : { ...prev, statusLayout: data.statusLayout },
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: sprintStoriesKey(workspaceId) });
    },
  });
}

/** Replace a ticket's accepted repos. */
export function useSprintSetRepos(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation<SprintReposResponse, Error, number[]>({
    mutationKey: sprintReposMutationKey(ident),
    mutationFn: (repoIds) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.sprintSetRepos({ workspaceId, ident, repoIds });
    },
    onSuccess: (data) => {
      const accepted = new Set(data.accepted.map((r) => r.repoId));
      qc.setQueryData<SprintStoriesResponse>(sprintStoriesKey(data.workspaceId), (prev) =>
        patchTicket(prev, data.ident, (t) => ({
          ...t,
          repos: { accepted: data.accepted, suggested: t.repos.suggested.filter((s) => !accepted.has(s.repoId)) },
        })),
      );
      // Suggestions and the assessment's currency both move with the accepted set.
      void qc.invalidateQueries({ queryKey: sprintStoriesKey(data.workspaceId) });
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: sprintStoriesKey(workspaceId) });
    },
  });
}

export function useSprintReposSaving(ident: string): boolean {
  return useIsMutating({ mutationKey: sprintReposMutationKey(ident) }) > 0;
}

/** True when "Check against code" may show at all (Pro + agentic AI on). */
export function useSprintAssessOn(): boolean {
  const { periodReports } = useProCapabilities();
  const ai = useAiCapabilities();
  return periodReports && ai.enabled;
}

/** Polls one run every 2 s while it is queued or running; on a terminal status re-reads the list
 *  (the stored body lands there) and the AI usage. */
export function useSprintAssessment(id: number | null, workspaceId: number | null) {
  const qc = useQueryClient();
  const on = useSprintAssessOn();
  return useQuery<SprintAssessmentResponse>({
    queryKey: sprintAssessmentKey(id),
    queryFn:
      id == null
        ? skipToken
        : async () => {
            const res = await api.sprintAssessment(id);
            const r = res.assessment;
            if (r.status !== 'queued' && r.status !== 'running') {
              void qc.invalidateQueries({ queryKey: sprintStoriesKey(workspaceId) });
              void qc.invalidateQueries({ queryKey: ['ai-usage'] });
            }
            return res;
          },
    enabled: on,
    refetchInterval: (q) => {
      const s = q.state.data?.assessment.status;
      return s == null || s === 'queued' || s === 'running' ? 2_000 : false;
    },
    refetchIntervalInBackground: false,
  });
}

export function useStartSprintAssess(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation<SprintAssessResponse, Error>({
    mutationKey: sprintAssessMutationKey(ident),
    mutationFn: () => {
      // Starting against an unresolved workspace would read the account's Default.
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.sprintAssess({ workspaceId, ident });
    },
    onSuccess: (data) => {
      const r = data.assessment;
      qc.setQueryData<SprintAssessmentResponse>(sprintAssessmentKey(r.id), { assessment: r, currency: null });
      qc.setQueryData<SprintStoriesResponse>(sprintStoriesKey(r.workspaceId), (prev) =>
        patchTicket(prev, r.ident, (t) => ({ ...t, assessment: { record: r, currency: null } })),
      );
    },
    // A refusal (busy, no repos any more, ticket gone) means the list is out of date.
    onError: () => {
      void qc.invalidateQueries({ queryKey: sprintStoriesKey(workspaceId) });
    },
  });
}

/** "Check against code" in flight on ANY mount of this ticket. */
export function useSprintAssessStarting(ident: string): boolean {
  return useIsMutating({ mutationKey: sprintAssessMutationKey(ident) }) > 0;
}

export function useCancelSprintAssess(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<SprintAssessmentResponse, Error, number>({
    mutationFn: (id) => api.sprintAssessCancel(id),
    onSuccess: (data) => {
      qc.setQueryData<SprintAssessmentResponse>(sprintAssessmentKey(data.assessment.id), data);
      void qc.invalidateQueries({ queryKey: sprintStoriesKey(workspaceId) });
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

/** The write-back. ONE ticket per POST, the exact text the dialog showed; never retried here. */
export function useSprintWrite(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation<SprintWriteResponse, Error, Omit<SprintWriteRequest, 'workspaceId' | 'ident'>>({
    mutationKey: sprintWriteMutationKey(ident),
    // ⚠ NO `retry`: the claim makes a repeat harmless, but a client retry would still be a second
    // press nobody made. The query client's mutation default is no retry; keep it explicit.
    retry: false,
    mutationFn: (body) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.sprintWrite({ ...body, workspaceId, ident });
    },
    onSuccess: (data) => {
      qc.setQueryData<SprintStoriesResponse>(sprintStoriesKey(workspaceId), (prev) =>
        patchTicket(prev, data.write.ident, (t) => ({ ...t, lastWrite: data.write })),
      );
      // A successful write forces the ticket's re-read; the list picks up the new text and labels.
      void qc.invalidateQueries({ queryKey: sprintStoriesKey(workspaceId) });
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: sprintStoriesKey(workspaceId) });
    },
  });
}

/** A write in flight on ANY mount of this ticket. */
export function useSprintWriting(ident: string): boolean {
  return useIsMutating({ mutationKey: sprintWriteMutationKey(ident) }) > 0;
}

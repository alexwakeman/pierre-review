import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SprintAskResponse,
  SprintAskTurn,
  SprintAssessmentResponse,
  SprintAssessResponse,
  SprintGraphResponse,
  SprintRefreshResponse,
  SprintReposResponse,
  SprintStatusesResponse,
  SprintStatusSettings,
  SprintTicketDetailResponse,
} from '@pierre-review/shared';
import { create } from 'zustand';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';
import { workspaceKey } from './useActivity.js';

// This Sprint (its own Activity rail line) — the sprint GRAPH. FREE on every tier: no route here
// 402s, so no hook ANDs a Pro capability into `enabled`. "Check against code" and "Ask Claude about
// this sprint" are agentic and LOCAL-ONLY (their routes are not registered in cloud), so their hooks
// AND `me.ai.enabled` — the agentic gate, never a Pro one.
//
// ⚠ SHARED MUTATION KEYS. Every mount of one ticket's Check shares `['sprint-assess', ident]`, and the
// UI reads `useIsMutating` — never a per-mount `isPending`, which resets on a tab switch mid-request and
// would offer a second billed run.
// ⚠ CACHE WRITES LIVE IN THE HOOK-LEVEL `onSuccess`, never a `mutate()` callback (observer teardown kills
// mutate-scoped callbacks).

export function sprintGraphKey(workspaceId: number | null): [string, string] {
  return ['sprint-graph', workspaceKey(workspaceId)];
}

export function sprintTicketKey(workspaceId: number | null, ident: string | null): [string, string, string | null] {
  return ['sprint-ticket', workspaceKey(workspaceId), ident];
}

export function sprintAssessmentKey(id: number | null): [string, number | null] {
  return ['sprint-assessment', id];
}

export function sprintAssessMutationKey(ident: string): [string, string] {
  return ['sprint-assess', ident];
}

export function sprintReposMutationKey(ident: string): [string, string] {
  return ['sprint-repos', ident];
}

/** Everything that reads the sprint for this workspace: the graph and every open drawer. */
function invalidateSprint(qc: ReturnType<typeof useQueryClient>, workspaceId: number | null): void {
  void qc.invalidateQueries({ queryKey: sprintGraphKey(workspaceId) });
  void qc.invalidateQueries({ queryKey: ['sprint-ticket', workspaceKey(workspaceId)] });
}

export function useSprintGraph(workspaceId: number | null) {
  return useQuery<SprintGraphResponse>({
    queryKey: sprintGraphKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.sprintGraph(workspaceId),
    staleTime: 30_000,
    // The worker re-reads the sprint every 20 minutes and briefs arrive in the background; a minute is
    // often enough. While the first read has not landed ("Reading…") or briefs are pending, look sooner.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d != null && d.trackerOn && d.read.readAt == null && d.read.error == null) return 5_000;
      if (d != null && d.aiEnabled && d.briefs.pending > 0) return 15_000;
      return 60_000;
    },
    refetchIntervalInBackground: false,
  });
}

/** The drawer's detail for one node. */
export function useSprintTicket(workspaceId: number | null, ident: string | null) {
  return useQuery<SprintTicketDetailResponse>({
    queryKey: sprintTicketKey(workspaceId, ident),
    queryFn: workspaceId == null || ident == null ? skipToken : () => api.sprintTicket(workspaceId, ident),
    staleTime: 30_000,
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
      qc.setQueryData<SprintGraphResponse>(sprintGraphKey(data.workspaceId), (prev) => (prev == null ? prev : { ...prev, read: data.read }));
      invalidateSprint(qc, workspaceId);
    },
  });
}

export function useSprintRefreshing(workspaceId: number | null): boolean {
  return useIsMutating({ mutationKey: ['sprint-refresh', workspaceKey(workspaceId)] }) > 0;
}

/** Replace the workspace's status layout override (the four stages' statuses, in order).
 *  `{sections: null}` = back to automatic. The layout lands at once; the graph refetches because
 *  every node's stage moves with it. */
export function useSprintSetStatuses(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<SprintStatusesResponse, Error, SprintStatusSettings>({
    mutationKey: ['sprint-statuses', workspaceKey(workspaceId)],
    mutationFn: (settings) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.sprintSetStatuses({ workspaceId, settings });
    },
    onSuccess: (data) => {
      qc.setQueryData<SprintGraphResponse>(sprintGraphKey(data.workspaceId), (prev) =>
        prev == null ? prev : { ...prev, statusLayout: data.statusLayout },
      );
    },
    onSettled: () => invalidateSprint(qc, workspaceId),
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
      qc.setQueryData<SprintTicketDetailResponse>(sprintTicketKey(data.workspaceId, data.ident), (prev) =>
        prev?.repos == null
          ? prev
          : { ...prev, repos: { accepted: data.accepted, suggested: prev.repos.suggested.filter((s) => !accepted.has(s.repoId)), defaulted: false } },
      );
      // Suggestions and the assessment's currency both move with the accepted set.
      invalidateSprint(qc, data.workspaceId);
    },
    onError: () => invalidateSprint(qc, workspaceId),
  });
}

export function useSprintReposSaving(ident: string): boolean {
  return useIsMutating({ mutationKey: sprintReposMutationKey(ident) }) > 0;
}

/** True when the agentic sprint features may show at all (agentic AI on — local only, free). */
export function useSprintAssessOn(): boolean {
  return useAiCapabilities().enabled;
}

/** Polls one run every 2 s while it is queued or running; on a terminal status re-reads the sprint
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
              invalidateSprint(qc, workspaceId);
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
      qc.setQueryData<SprintTicketDetailResponse>(sprintTicketKey(r.workspaceId, r.ident), (prev) =>
        prev == null ? prev : { ...prev, assessment: { record: r, currency: null } },
      );
    },
    // A refusal (busy, no repos any more, ticket gone) means the drawer is out of date.
    onError: () => invalidateSprint(qc, workspaceId),
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
      invalidateSprint(qc, workspaceId);
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

/** "Ask Claude about this sprint": one billed answer per turn. The caller owns the transcript and sends
 *  its prior turns; the server caps how many it reads (`SPRINT_ASK_MAX_TURNS`). Shared mutation key per
 *  workspace, so a second mount cannot fire a second billed ask. */
export function useSprintAsk(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<SprintAskResponse, Error, { question: string; history: SprintAskTurn[] }>({
    mutationKey: ['sprint-ask', workspaceKey(workspaceId)],
    retry: false,
    mutationFn: ({ question, history }) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.sprintAsk({ workspaceId, question, history });
    },
    // ⚠ The completed turn is appended HERE, in the hook-level onSuccess, never in a `mutate()`
    // callback: observer teardown (the panel closing mid-answer) kills mutate-scoped callbacks and would
    // lose a billed answer. The transcript lives in a module store, so it outlives the panel too.
    onSuccess: (data, vars) => {
      useSprintAskTranscript.getState().append(data.workspaceId, {
        question: vars.question,
        answer: data.answer,
        costUsd: data.costUsd,
        trimmedTurns: data.trimmedTurns,
      });
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

/** One finished turn of "Ask Claude about this sprint", as the panel shows it. */
export interface SprintAskShownTurn extends SprintAskTurn {
  costUsd: number | null;
  /** Earlier turns the server did not read for this answer. */
  trimmedTurns: number;
}

/** The conversation per workspace, for the visit only (memory, never storage or the URL). */
export const useSprintAskTranscript = create<{
  turns: Record<number, SprintAskShownTurn[]>;
  append: (workspaceId: number, turn: SprintAskShownTurn) => void;
  clear: (workspaceId: number) => void;
}>((set) => ({
  turns: {},
  append: (ws, turn) => set((s) => ({ turns: { ...s.turns, [ws]: [...(s.turns[ws] ?? []), turn] } })),
  clear: (ws) => set((s) => ({ turns: { ...s.turns, [ws]: [] } })),
}));

export function useSprintAsking(workspaceId: number | null): boolean {
  return useIsMutating({ mutationKey: ['sprint-ask', workspaceKey(workspaceId)] }) > 0;
}

import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SprintAskResponse,
  SprintAskTurn,
  SprintGraphResponse,
  SprintRefreshResponse,
  SprintStatusesResponse,
  SprintStatusSettings,
} from '@pierre-review/shared';
import { create } from 'zustand';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';
import { workspaceKey } from './useActivity.js';

// This Sprint (its own Activity rail line) — the sprint GRAPH. FREE on every tier: no route here
// 402s, so no hook ANDs a Pro capability into `enabled`. "Ask Claude about this sprint" is agentic and
// LOCAL-ONLY (its route is not registered in cloud), so it gates on `me.ai.enabled` — the agentic gate,
// never a Pro one. ("Check against code" and the drawer were REMOVED; a ticket opens in the story view.)
//
// ⚠ SHARED MUTATION KEYS. The UI reads `useIsMutating` — never a per-mount `isPending`, which resets on
// a tab switch mid-request and would offer a second billed run.
// ⚠ CACHE WRITES LIVE IN THE HOOK-LEVEL `onSuccess`, never a `mutate()` callback (observer teardown kills
// mutate-scoped callbacks).

export function sprintGraphKey(workspaceId: number | null): [string, string] {
  return ['sprint-graph', workspaceKey(workspaceId)];
}

/** Everything that reads the sprint for this workspace: the sprint boards and every story view's ticket text. */
function invalidateSprint(qc: ReturnType<typeof useQueryClient>, workspaceId: number | null): void {
  void qc.invalidateQueries({ queryKey: sprintGraphKey(workspaceId) });
  void qc.invalidateQueries({ queryKey: ['ticket-story', workspaceKey(workspaceId)] });
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
      // The critical paths are being written (or are next in line after the summaries): see them land.
      if (d != null && d.aiEnabled && (d.pathsStatus?.state === 'writing' || d.pathsStatus?.state === 'queued')) return 5_000;
      if (d != null && d.aiEnabled && d.briefs.pending > 0) return 15_000;
      return 60_000;
    },
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
      qc.setQueryData<SprintGraphResponse>(sprintGraphKey(data.workspaceId), (prev) => (prev == null ? prev : { ...prev, read: data.read }));
      invalidateSprint(qc, workspaceId);
    },
  });
}

export function useSprintRefreshing(workspaceId: number | null): boolean {
  return useIsMutating({ mutationKey: ['sprint-refresh', workspaceKey(workspaceId)] }) > 0;
}

/** Replace the workspace's status buckets override (`{buckets, mergedColumn}`). `{buckets: null,
 *  mergedColumn: true}` = back to automatic. The layout lands at once; the sprint refetches because
 *  every node's stage and column move with it. */
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

/** True when the agentic sprint features may show at all (agentic AI on — local only, free). */
export function useSprintAiOn(): boolean {
  return useAiCapabilities().enabled;
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

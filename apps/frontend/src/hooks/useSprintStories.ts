import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SPRINT_CHANGE_TOKEN_POLL_MS,
  type SprintAskResponse,
  type SprintAskTurn,
  type SprintGraphResponse,
  type SprintGraphTokenResponse,
  type SprintRefreshResponse,
  type SprintStatusesResponse,
  type SprintStatusSettings,
} from '@pierre-review/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { sprintTokenChanged } from '../lib/sprintChangeToken.js';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';
import { workspaceKey } from './useActivity.js';

// This Sprint (a fixed tab beside Activity) — the sprint GRAPH. "Ask Claude about this sprint" is
// agentic and LOCAL-ONLY (its route is not registered in cloud), so it gates on `me.ai.enabled`. ("Check against code" and the drawer were REMOVED; a ticket opens in the story view.)
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
    // ⚠ IN STEADY STATE THE GRAPH ITSELF IS NOT POLLED: a cheap change token is (`useSprintChangeToken`,
    // every minute), and SprintView re-fetches the graph AUTOMATICALLY when it differs — so the board
    // updates itself within a minute of a change and never re-lays out when nothing changed. Only while
    // something is still landing does the graph poll directly: the first read ("Reading…"), the
    // critical paths being written, pending briefs, a ticket check running.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d != null && d.trackerOn && d.read.readAt == null && d.read.error == null) return 5_000;
      // The critical paths are being written (or are next in line after the summaries): see them land.
      if (d != null && d.aiEnabled && (d.pathsStatus?.state === 'writing' || d.pathsStatus?.state === 'queued')) return 5_000;
      if (d != null && d.aiEnabled && d.briefs.pending > 0) return 15_000;
      if (d != null && d.aiEnabled && d.nodes.some((n) => n.checkRunning === true)) return 15_000;
      return false;
    },
    refetchIntervalInBackground: false,
  });
}

export function sprintTokenKey(workspaceId: number | null): [string, string] {
  return ['sprint-graph-token', workspaceKey(workspaceId)];
}

/**
 * THE CHANGE TOKEN, polled every SPRINT_CHANGE_TOKEN_POLL_MS while This Sprint is on screen (`enabled`:
 * the caller is mounted only on the This Sprint tab, and passes false until the graph has loaded) and
 * the page is visible — never in the background. DB only on the server; stamps nothing.
 * ⚠ NOTHING ON A BOARD FETCHES ON MOUNT: the answer is SEEDED from the loaded graph's own token, timed
 * at the graph's fetch — on first mount (`initialData`) AND every time the graph's data changes (the
 * effect below, so a remount within gcTime holding an older cached token is re-seeded too) — and
 * `refetchOnMount: false`, so the only request is the interval poll, one interval later.
 * `changed` is the pure `sprintTokenChanged` rule (lib/sprintChangeToken.ts); SprintView re-fetches the
 * graph when it turns true (the board updates itself — no hint line, no button).
 */
export function useSprintChangeToken(
  workspaceId: number | null,
  graph: { changeToken: string | undefined; updatedAt: number; fetching: boolean } | null,
): { changed: boolean; tokenUpdatedAt: number } {
  const qc = useQueryClient();
  const seed = graph?.changeToken;
  const graphUpdatedAt = graph?.updatedAt;
  useEffect(() => {
    if (workspaceId == null || typeof seed !== 'string' || graphUpdatedAt == null) return;
    const key = sprintTokenKey(workspaceId);
    const cached = qc.getQueryState<SprintGraphTokenResponse>(key);
    // Only ever move the cache FORWARD: a poll answered after this graph stays.
    if (cached != null && cached.dataUpdatedAt > graphUpdatedAt) return;
    qc.setQueryData<SprintGraphTokenResponse>(key, { workspaceId, changeToken: seed }, { updatedAt: graphUpdatedAt });
  }, [qc, workspaceId, seed, graphUpdatedAt]);
  const q = useQuery<SprintGraphTokenResponse>({
    queryKey: sprintTokenKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.sprintGraphToken(workspaceId),
    enabled: workspaceId != null && seed != null,
    initialData: workspaceId != null && seed != null ? { workspaceId, changeToken: seed } : undefined,
    initialDataUpdatedAt: graphUpdatedAt,
    staleTime: SPRINT_CHANGE_TOKEN_POLL_MS,
    refetchInterval: SPRINT_CHANGE_TOKEN_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const changed =
    graph != null &&
    sprintTokenChanged({
      seed,
      token: q.data?.changeToken,
      tokenUpdatedAt: q.dataUpdatedAt,
      graphUpdatedAt: graph.updatedAt,
      graphFetching: graph.fetching,
    });
  return { changed, tokenUpdatedAt: q.dataUpdatedAt };
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

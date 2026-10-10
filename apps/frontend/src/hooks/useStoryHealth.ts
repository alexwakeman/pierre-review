import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StoryHealthResponse, StoryLabelRunResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';
import { workspaceKey } from './useActivity.js';
import { useProCapabilities } from './useTriage.js';

// Reports → Stories → STORY HEALTH (docs/FRONTEND.md § Story health).
//
// ⚠ PRO, ON `periodReports` — the flag every route here 402s on, ANDed into every hook's `enabled`
// so the SPA never learns the paywall by polling a 402. `skipToken` while the workspace is
// unresolved, never a request without `?workspace=`.
//
// ⚠ THE LABEL RUN IS LOCAL-ONLY AGENTIC WORK: its routes exist only where `registerAgenticRoutes`
// ran, so its hooks also AND `me.ai.enabled` (false in cloud and under `LIMN_AI_DISABLED=true`).
// The run is ACCOUNT-scoped (one in flight per account), so its query key carries no workspace.
//
// ⚠ "Label N stories" bills. Every mount shares the start MUTATION key (`useIsMutating`, never a
// per-mount `isPending`), and the started run is written into the cache in the HOOK-level
// `onSuccess`, never a `mutate()` callback (observer teardown would drop it).

export function storyHealthKey(workspaceId: number | null): [string, string] {
  return ['story-health', workspaceKey(workspaceId)];
}

export function storyLabelRunKey(): [string] {
  return ['story-label-run'];
}

/** The MUTATION key of "Label N stories" — shared by every mount for one workspace. */
export function storyLabelStartKey(workspaceId: number | null): [string, string] {
  return ['story-label-start', workspaceKey(workspaceId)];
}

export function useStoryHealth(workspaceId: number | null) {
  const { periodReports } = useProCapabilities();
  return useQuery<StoryHealthResponse>({
    queryKey: storyHealthKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.storyHealth(workspaceId),
    enabled: periodReports,
    // Folded from synced rows and stored labels; only the current week moves between syncs.
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    refetchIntervalInBackground: false,
  });
}

/** True when the label run may be offered at all (Pro + agentic AI on). */
export function useStoryLabelsOn(): boolean {
  const { periodReports } = useProCapabilities();
  const ai = useAiCapabilities();
  return periodReports && ai.enabled;
}

/**
 * The account's label run. Polls every 2 s while it runs — `runningHint` lets a reload re-attach
 * from the GET's `labelRun` before this query has answered. When a run it watched leaves `running`,
 * every story-health workspace re-reads (the new labels land there) and so does the AI usage.
 */
export function useStoryLabelRun(runningHint: boolean) {
  const qc = useQueryClient();
  const on = useStoryLabelsOn();
  return useQuery<StoryLabelRunResponse>({
    queryKey: storyLabelRunKey(),
    queryFn: async () => {
      const before = qc.getQueryData<StoryLabelRunResponse>(storyLabelRunKey())?.run ?? null;
      const res = await api.storyLabelRun();
      const after = res.run;
      if (before?.state === 'running' && (after == null || after.id !== before.id || after.state !== 'running')) {
        void qc.invalidateQueries({ queryKey: ['story-health'] });
        void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      }
      return res;
    },
    enabled: on,
    refetchInterval: (q) => (q.state.data?.run?.state === 'running' || (runningHint && q.state.data == null) ? 2_000 : false),
    refetchIntervalInBackground: false,
  });
}

export function useStartStoryLabelRun(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<StoryLabelRunResponse, Error>({
    mutationKey: storyLabelStartKey(workspaceId),
    mutationFn: () => {
      // Starting against an unresolved workspace would label the account's Default.
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.startStoryLabelRun({ workspaceId });
    },
    onSuccess: (data) => {
      qc.setQueryData<StoryLabelRunResponse>(storyLabelRunKey(), data);
      void qc.invalidateQueries({ queryKey: storyHealthKey(workspaceId) });
    },
    // A refusal (busy, nothing left to label) means what we showed is out of date.
    onError: () => {
      void qc.invalidateQueries({ queryKey: storyHealthKey(workspaceId) });
      void qc.invalidateQueries({ queryKey: storyLabelRunKey() });
    },
  });
}

/** "Label N stories" in flight on ANY mount for this workspace. */
export function useStoryLabelStarting(workspaceId: number | null): boolean {
  return useIsMutating({ mutationKey: storyLabelStartKey(workspaceId) }) > 0;
}

export function useCancelStoryLabelRun() {
  const qc = useQueryClient();
  return useMutation<StoryLabelRunResponse, Error>({
    mutationFn: () => api.cancelStoryLabelRun(),
    onSuccess: (data) => {
      qc.setQueryData<StoryLabelRunResponse>(storyLabelRunKey(), data);
      void qc.invalidateQueries({ queryKey: ['story-health'] });
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  StartStoryReportResponse,
  StoriesResponse,
  StoryReportResponse,
  StoryReportsResponse,
  StoryReportWindowChoice,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';
import { workspaceKey } from './useActivity.js';
import { useProCapabilities } from './useTriage.js';

// Reports → Stories. Pro with the rest of Reports (`periodReports`): every route 402s without it, so
// every hook ANDs the capability into its own `enabled` — the SPA must never learn the paywall by
// polling a 402.
//
// THE STORY REPORT (core, agentic, local-only) also ANDs `me.ai.enabled`: its routes are not
// registered in cloud, and a local `LIMN_AI_DISABLED=true` hides it. Without it the tab shows only
// the lists and the charts.
//
// ⚠ THE LIST GET NEVER RUNS CLAUDE. It reads stored runs and computes, by code, what a run would
// pick. The POST is the ONE billing path, and every mount of one (workspace, window) shares its
// MUTATION key, so a tab switch mid-start cannot offer a second "Write report" (`useIsMutating`,
// never a per-mount `isPending`).
//
// ⚠ THE QUEUED RUN IS WRITTEN INTO THE LIST CACHE IN THE HOOK-LEVEL `onSuccess`, never a `mutate()`
// callback — observer teardown (the reader switching tab) kills mutate-scoped callbacks. The run
// itself is stored server-side, so a finished report is never lost: the list re-reads it.

export function storiesKey(workspaceId: number | null): [string, string] {
  return ['stories', workspaceKey(workspaceId)];
}

export function storyReportsKey(
  workspaceId: number | null,
  window: StoryReportWindowChoice,
): [string, string, StoryReportWindowChoice] {
  return ['story-reports', workspaceKey(workspaceId), window];
}

export function storyReportKey(id: number | null): [string, number | null] {
  return ['story-report', id];
}

/** The MUTATION key of "Write report" — shared by every mount of one (workspace, window). */
export function storyReportStartKey(
  workspaceId: number | null,
  window: StoryReportWindowChoice,
): [string, string, StoryReportWindowChoice] {
  return ['story-report-start', workspaceKey(workspaceId), window];
}

export function useStories(workspaceId: number | null) {
  const { periodReports } = useProCapabilities();
  return useQuery<StoriesResponse>({
    queryKey: storiesKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.stories(workspaceId),
    enabled: periodReports,
    // Folded from synced rows; it can only move when a sync lands.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}

/** True when the story report may show at all (Pro + agentic AI on). */
export function useStoryReportsOn(): boolean {
  const { periodReports } = useProCapabilities();
  const ai = useAiCapabilities();
  return periodReports && ai.enabled;
}

export function useStoryReports(workspaceId: number | null, window: StoryReportWindowChoice) {
  const on = useStoryReportsOn();
  return useQuery<StoryReportsResponse>({
    queryKey: storyReportsKey(workspaceId, window),
    queryFn: workspaceId == null ? skipToken : () => api.storyReports(workspaceId, window),
    enabled: on,
    staleTime: 60_000,
    // A run in flight for ANOTHER workspace or window is not polled by id here; re-read the list
    // slowly so the "being written" line clears when it ends.
    refetchInterval: (q) => {
      const r = q.state.data?.running;
      if (r == null) return 5 * 60_000;
      return r.workspaceId === q.state.data?.workspaceId && r.window === window ? false : 5_000;
    },
    refetchIntervalInBackground: false,
  });
}

/** Polls one run every 2 s while it is queued or running. On a terminal status it re-reads the list
 *  (the stored report lands there) and the AI usage. */
export function useStoryReport(id: number | null) {
  const qc = useQueryClient();
  const on = useStoryReportsOn();
  return useQuery<StoryReportResponse>({
    queryKey: storyReportKey(id),
    queryFn:
      id == null
        ? skipToken
        : async () => {
            const res = await api.storyReport(id);
            const r = res.report;
            if (r.status !== 'queued' && r.status !== 'running') {
              void qc.invalidateQueries({ queryKey: storyReportsKey(r.workspaceId, r.window) });
              void qc.invalidateQueries({ queryKey: ['ai-usage'] });
            }
            return res;
          },
    enabled: on,
    refetchInterval: (q) => {
      const s = q.state.data?.report.status;
      return s == null || s === 'queued' || s === 'running' ? 2_000 : false;
    },
    refetchIntervalInBackground: false,
  });
}

export function useStartStoryReport(workspaceId: number | null, window: StoryReportWindowChoice) {
  const qc = useQueryClient();
  return useMutation<StartStoryReportResponse, Error>({
    mutationKey: storyReportStartKey(workspaceId, window),
    mutationFn: () => {
      // Starting against an unresolved workspace would bill for the account's Default.
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.startStoryReport({ workspaceId, window });
    },
    onSuccess: (data) => {
      const r = data.report;
      qc.setQueryData<StoryReportsResponse>(storyReportsKey(r.workspaceId, r.window), (prev) =>
        prev == null
          ? prev
          : {
              ...prev,
              latest: r,
              running: {
                id: r.id,
                workspaceId: r.workspaceId,
                window: r.window,
                status: r.status === 'running' ? 'running' : 'queued',
              },
            },
      );
      qc.setQueryData<StoryReportResponse>(storyReportKey(r.id), { report: r, currency: null });
    },
    // A refusal (busy elsewhere, no candidates any more) means the list is out of date.
    onError: () => {
      void qc.invalidateQueries({ queryKey: storyReportsKey(workspaceId, window) });
    },
  });
}

/** "Write report" in flight on ANY mount of this (workspace, window). */
export function useStoryReportStarting(workspaceId: number | null, window: StoryReportWindowChoice): boolean {
  return useIsMutating({ mutationKey: storyReportStartKey(workspaceId, window) }) > 0;
}

export function useCancelStoryReport() {
  const qc = useQueryClient();
  return useMutation<StoryReportResponse, Error, number>({
    mutationFn: (id) => api.cancelStoryReport(id),
    onSuccess: (data) => {
      const r = data.report;
      qc.setQueryData<StoryReportResponse>(storyReportKey(r.id), data);
      void qc.invalidateQueries({ queryKey: storyReportsKey(r.workspaceId, r.window) });
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

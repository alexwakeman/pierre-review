import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isStoryDocsInFlight,
  type StartStoryDocsAlignmentResponse,
  type StoryDocsAlignmentResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';

// CHECK A STORY AGAINST THE DOCS — server state (docs/API.md § Check a story against the docs; CORE,
// free, LOCAL ONLY). Gated on `me.ai.enabled`: the routes are absent in the cloud.
//
// ⚠ NOTHING FETCHES ON A BOARD'S MOUNT: the only caller is the Story section, which only the story view
// mounts (never the Open PRs board). The GET reads the stored run (no model, no tracker call) and polls
// only while the newest run is queued, choosing sections or reading. ONE mutation key per (workspace,
// ticket), so every story tab of the ticket shows the same "Checking…" while a click is in flight.

const POLL_MS = 4000;

export const storyDocsAlignmentKey = (workspaceId: number | null, ident: string): readonly unknown[] => [
  'story-docs-alignment',
  `ws:${workspaceId ?? 'none'}`,
  ident,
];
const startKey = (workspaceId: number | null, ident: string): readonly unknown[] => [
  'story-docs-alignment-start',
  `ws:${workspaceId ?? 'none'}`,
  ident,
];

export function useStoryDocsAlignment(workspaceId: number | null, ident: string) {
  const ai = useAiCapabilities();
  return useQuery<StoryDocsAlignmentResponse>({
    queryKey: storyDocsAlignmentKey(workspaceId, ident),
    queryFn: () => api.storyDocsAlignment(workspaceId as number, ident),
    enabled: ai.enabled && workspaceId != null,
    staleTime: 10_000,
    refetchInterval: (q) => {
      const run = q.state.data?.run;
      return run != null && isStoryDocsInFlight(run.status) ? POLL_MS : false;
    },
  });
}

export function useStartStoryDocsAlignment(workspaceId: number | null, ident: string) {
  const qc = useQueryClient();
  return useMutation<StartStoryDocsAlignmentResponse, Error, void>({
    mutationKey: startKey(workspaceId, ident),
    mutationFn: () => api.startStoryDocsAlignment({ ident, ...(workspaceId != null ? { workspaceId } : {}) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: storyDocsAlignmentKey(workspaceId, ident) }),
  });
}

/** A start click for this ticket is in flight in ANY mount. */
export function useStoryDocsStarting(workspaceId: number | null, ident: string): boolean {
  return useIsMutating({ mutationKey: startKey(workspaceId, ident) }) > 0;
}

import { skipToken, useQuery } from '@tanstack/react-query';
import type { StoriesResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// Reports → Stories. (The agentic story report that used to head this tab was removed 2026-10-18.)

export function storiesKey(workspaceId: number | null): [string, string] {
  return ['stories', workspaceKey(workspaceId)];
}

export function useStories(workspaceId: number | null) {
  return useQuery<StoriesResponse>({
    queryKey: storiesKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.stories(workspaceId),
    // Folded from synced rows; it can only move when a sync lands.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}

import { useQuery } from '@tanstack/react-query';
import type { Repo, TimelineResponse, User } from '@gh-team-monitor/shared';
import { api } from '../api/client.js';
import { buildTimelineSearch, useFilters } from '../store/filters.js';

export function useRepos() {
  return useQuery<Repo[]>({ queryKey: ['repos'], queryFn: api.listRepos });
}

export function useUsers() {
  return useQuery<User[]>({ queryKey: ['users'], queryFn: api.listUsers });
}

export function useTimeline() {
  // Selector returns a stable query string; re-runs the query only when it changes.
  const search = useFilters(buildTimelineSearch);
  return useQuery<TimelineResponse>({
    queryKey: ['timeline', search],
    queryFn: () => api.timeline(search),
    placeholderData: (prev) => prev, // keep previous data while refetching
  });
}

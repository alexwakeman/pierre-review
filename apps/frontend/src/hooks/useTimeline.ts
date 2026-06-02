import { useQuery } from '@tanstack/react-query';
import type {
  MergersResponse,
  Repo,
  TimelineResponse,
  User,
} from '@gh-team-monitor/shared';
import { api } from '../api/client.js';
import { buildTimelineSearch, useFilters } from '../store/filters.js';

export function useRepos() {
  return useQuery<Repo[]>({ queryKey: ['repos'], queryFn: api.listRepos });
}

export function useUsers() {
  return useQuery<User[]>({ queryKey: ['users'], queryFn: api.listUsers });
}

// Per-repo merge-rights inference (who has merged a PR there). Reference data,
// independent of filters — used to badge maintainers on timeline rows.
export function useMergers() {
  return useQuery<MergersResponse>({ queryKey: ['mergers'], queryFn: api.mergers });
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

// PR/event set for the PR-title search index. Same window / repos / bot rule as
// the main timeline but ALWAYS ignoring the member filter, so search is a global
// "jump to any PR" tool (picking a result force-shows its bar even when the
// member filter would hide its row). When no member filter is active this builds
// the identical query string to useTimeline, so React Query serves it from the
// same cache entry — no extra fetch; only an active member filter incurs a second.
export function useSearchTimeline() {
  const search = useFilters((s) => buildTimelineSearch(s, false, false, false));
  return useQuery<TimelineResponse>({
    queryKey: ['timeline', search],
    queryFn: () => api.timeline(search),
    placeholderData: (prev) => prev,
  });
}

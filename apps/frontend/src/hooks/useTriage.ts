import { useQuery } from '@tanstack/react-query';
import type {
  DismissedMyTurnResponse,
  InsightsResponse,
  MeResponse,
  MyTurnResponse,
  OpenPrsResponse,
  ProCapabilities,
  RepoAnalytics,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { buildOpenPrsSearch, useFilters } from '../store/filters.js';

export function useOpenPrs() {
  const search = useFilters(buildOpenPrsSearch);
  return useQuery<OpenPrsResponse>({
    queryKey: ['open-prs', search],
    queryFn: () => api.openPrs(search),
    placeholderData: (prev) => prev,
  });
}

// Open PRs for the PR-title search index — ignores the member filter so search
// is global (see useSearchTimeline). Dedupes with useOpenPrs when no member
// filter is active (identical query string → shared cache entry).
export function useSearchOpenPrs() {
  const search = useFilters((s) => buildOpenPrsSearch(s, false));
  return useQuery<OpenPrsResponse>({
    queryKey: ['open-prs', search],
    queryFn: () => api.openPrs(search),
    placeholderData: (prev) => prev,
  });
}

export function useMe() {
  // `retry: false` so a cloud-mode 401 (signed out) surfaces immediately to the
  // App auth gate instead of being retried.
  return useQuery<MeResponse>({ queryKey: ['me'], queryFn: api.me, retry: false });
}

// Premium capability flags (mirrors claudeReviewEnabled). All-false until /api/me
// loads and in OSS mode (no @pierre/pro plugin).
export function useProCapabilities(): ProCapabilities {
  return (
    useMe().data?.pro ?? {
      activityDigest: false,
      reviewMemory: false,
      aiAnalysis: false,
      prSummary: false,
      aiFix: false,
      teamInsights: false,
      claudeReview: false,
      feedMyTurn: false,
      slackDigest: false,
      issueLinks: false,
    }
  );
}

export function useMyTurn() {
  return useQuery<MyTurnResponse>({ queryKey: ['my-turn'], queryFn: api.myTurn });
}

// Per-repo Insights stats. Respects the active repo filter (other filters don't
// apply — insights are a current-state snapshot). Only fetched while the panel is
// open (`enabled`), and kept fresh-ish on reopen.
export function useInsights(enabled: boolean) {
  const search = useFilters((s) =>
    s.repoIds && s.repoIds.length > 0 ? `repoIds=${s.repoIds.join(',')}` : '',
  );
  return useQuery<InsightsResponse>({
    queryKey: ['insights', search],
    queryFn: () => api.insights(search),
    enabled,
  });
}

// Heavier per-repo analytics for the drill-down chart panel. Fetched only when the
// panel is open for a specific repo; cached per repo.
export function useRepoAnalytics(repoId: number | null) {
  return useQuery<RepoAnalytics>({
    queryKey: ['repo-analytics', repoId],
    queryFn: () => api.repoAnalytics(repoId as number),
    enabled: repoId != null,
  });
}

// The "Done" tab — completed (dismissed) entries, past 90 days. Only fetched when
// the tab is active (`enabled`).
export function useMyTurnDone(enabled: boolean) {
  return useQuery<DismissedMyTurnResponse>({
    queryKey: ['my-turn-done'],
    queryFn: api.myTurnDone,
    enabled,
  });
}

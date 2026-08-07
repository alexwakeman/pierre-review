import { useQuery } from '@tanstack/react-query';
import type {
  MergersResponse,
  Repo,
  TimelineResponse,
  User,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { buildTimelineSearch, useFilters } from '../store/filters.js';
import { workspaceKey } from './useActivity.js';

// ⚠ THE WORKSPACE IS READ FROM THE STORE, NOT PASSED IN — and here that is the correctness rule,
// not a convenience. `buildTimelineSearch` derives the whole query string (including
// `workspace=<id>`) from the same store state; a caller-supplied id could disagree with the string
// it keys, and the cache would then be labelled with a workspace the request never asked for.
// Hooks whose scope arrives as props (useActivity, useConsolidatedFeed, the bot hooks) take it as
// a parameter instead, because their callers already own the narrowing.

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

// `override` scopes an EMBEDDED (per-tab) timeline instead of the shared board:
//  • dropMembers — ignore the active member filter (so a focus tab's subject PR /
//    a My-Turn tab's inbox PRs are present even when a member filter would hide them);
//  • fromMs — widen `from` back to this instant (e.g. ~90 days) so an out-of-window PR
//    is fetched. Both feed a SEPARATE query key → a separate cache entry, so they never
//    touch the store/URL and the base board's query (override omitted → identical string)
//    is unchanged. Base call: `useTimeline()`.
export function useTimeline(override?: {
  dropMembers?: boolean;
  fromMs?: number | null;
  // A pr-focus tab passes its subject PR's id so the isolated fetch returns exactly that PR
  // (+ its events), bypassing the board filters — the PR loads even when its repo/date isn't
  // on the board.
  prIds?: number[];
}) {
  // Selector returns a stable query string; re-runs the query only when it changes.
  const search = useFilters((s) =>
    buildTimelineSearch(
      s,
      !override?.dropMembers,
      true,
      true,
      true,
      override?.fromMs ?? null,
      true,
      override?.prIds,
    ),
  );
  const workspaceId = useFilters((s) => s.workspaceId);
  // A pr-focus tab (`prIds`) is WORKSPACE-INDEPENDENT and must stay that way in the cache too.
  // `buildTimelineSearch` deliberately emits no `workspace=` on that path — getTimeline's prIds
  // branch bypasses the repo scope entirely so an isolate tab loads its subject PR even when the
  // board's scope would hide it — so naming a workspace here could not change the response. It
  // would only fragment one answer across N slots AND (via the gate below) refuse to load the tab
  // until the workspaces query lands, which is a regression on a surface that never needed it.
  const isolated = (override?.prIds?.length ?? 0) > 0;
  return useQuery<TimelineResponse>({
    // The `ws:` segment is NOT redundant with `workspace=` inside `search`: it is the half that
    // fixes the CACHE. Two workspaces on `repoIds = null` would otherwise be one slot.
    queryKey: isolated
      ? ['timeline', search]
      : ['timeline', workspaceKey(workspaceId), search],
    queryFn: () => api.timeline(search),
    // Null = the store has not resolved a workspace yet, and `search` then carries no `workspace=`
    // — the server would answer for the account's Default under whatever name the header is about
    // to show. Held idle until it resolves (except on the scope-free isolate path).
    enabled: isolated || workspaceId != null,
    placeholderData: (prev) => prev, // keep previous data while refetching
  });
}

// PR/event set for the PR-title search index AND the Members dropdown's per-repo
// membership derivation. Always ignores the member filter (a global "jump to any PR"
// tool) AND always includes bots (so the Bots sections can list every bot even while the
// board hides them). Because it always emits bot activity — and the board now hides bots
// by DEFAULT — its query string differs from useTimeline's on every fresh load: one
// permanent extra lean fetch, accepted so the bot listing stays complete. The strings
// still share a cache entry while the user is showing bots.
export function useSearchTimeline() {
  const search = useFilters((s) => buildTimelineSearch(s, false, false, false, false, null, false));
  const workspaceId = useFilters((s) => s.workspaceId);
  return useQuery<TimelineResponse>({
    queryKey: ['timeline', workspaceKey(workspaceId), search],
    queryFn: () => api.timeline(search),
    enabled: workspaceId != null,
    placeholderData: (prev) => prev,
  });
}

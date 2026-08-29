import { skipToken, useQuery } from '@tanstack/react-query';
import type { FlowFindingsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// The Bottlenecks tab's one read — `GET /api/flow-findings`, the human-lane twin of the Bots
// rail. CORE and FREE ON EVERY TIER: no `useProCapabilities`, no `enabled` gate, no 402/404 path
// to defend against, and it renders identically under `npx pierre-review` with no plugin present.
// (The route is deterministic — no model, no GitHub call — which is what makes free affordable.)
//
// ⚠ NO `repoIds`. The Reports pane covers the WHOLE workspace: the repo picker (RepoSelectPanel)
// is Timeline-only, so narrowing here would scope a screen that renders no control to un-scope it
// — the reader would be looking at a subset with nothing on the page saying so. The server
// expands a missing narrowing to the resolved workspace's membership, which is exactly right.
//
// ⚠ `workspaceId === null` MEANS "NOT RESOLVED YET", and `skipToken` (not a bare `enabled`) is
// what holds the query idle: it NARROWS the id to a number, so a request carrying no
// `?workspace=` — which the server would answer out of the account's DEFAULT workspace, then
// cache under the null slot and paint under whichever workspace resolves a second later — is
// unrepresentable rather than merely discouraged.

/** The canonical key segments for one Bottlenecks scope. Every scoped key carries `ws:<id>`. */
export function flowFindingsQueryKey(
  workspaceId: number | null,
  days: number,
): (string | number)[] {
  // `days` is its own slot: the server CLAMPS it to [7, 90], so two windows are two genuinely
  // different answers over the same workspace and must not share a cache entry.
  return ['flow-findings', workspaceKey(workspaceId), days];
}

// ⚠ DELIBERATELY NOT IN `ACTIVITY_QUERY_KEYS`. That list is swept on every repo add/move and every
// landing sync, and everything on it is either cheap or has to agree with a sibling panel on
// screen (the brief / the board / the work plan are ONE fold read three times, so they must
// refetch in phase). Neither is true here: the route sits on the `search` rate tier because one
// call runs the lane resolver, the first-human-review fold, a thread-path scan, an in-window
// review scan, a merged-PR walk and the round-trip comment join — and nothing else on screen
// claims to describe the same population. The 5-minute interval below already tracks the sync
// cadence; adding it to the sweep would spend that fold again on every repo edit.
export function useFlowFindings(workspaceId: number | null, days: number) {
  return useQuery<FlowFindingsResponse>({
    queryKey: flowFindingsQueryKey(workspaceId, days),
    queryFn: workspaceId == null ? skipToken : () => api.flowFindings(workspaceId, days),
    // The same cadence every workspace-scoped survey on this pane runs at: findings are folded
    // from already-synced rows, so they can only change when a sync lands.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}

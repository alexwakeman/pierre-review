import { skipToken, useQuery } from '@tanstack/react-query';
import type { FlowResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useProCapabilities } from './useTriage.js';
import { workspaceKey } from './useActivity.js';

// The "Chronology" tab's one read — `GET /api/flow-findings`, the COURT LEDGER.
// The human-lane twin of the Bots rail: that surface measures automation, this one measures where
// people's time went. (Deterministic — no model, no GitHub call. Paid for the DB work, not tokens.)
//
// ⚠ PRO, ON `periodReports` — THE SAME FLAG THE ROUTE 402s ON. The two gates are one decision
// written twice and they must not drift: the route is the monetisation gate, `enabled` below is
// what stops the SPA finding out by error. It matters more here than on most hooks because this
// query POLLS every five minutes — an ungated hook against a 402 is a request every five minutes
// per mounted pane, forever, and BottlenecksPanel would render "Could not load this workspace's
// flow.", an ERROR where the truth is a paywall. A disabled query runs no interval, so gating
// `enabled` stops the timer too.
//
// ⚠ `useProCapabilities()` IS ALL-FALSE UNTIL /api/me RESOLVES, so on a cold load an entitled
// account holds this query idle for one beat and then fires it. That ordering is correct and not
// worth "fixing": the alternative is issuing a request we may not be allowed to make. The panel is
// not mounted during that beat anyway — InsightsView routes the render through `useProGateState`,
// which waits on the same /api/me rather than painting a lock at a paying customer.
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
// call runs the lane resolver and four chunked action scans over every merge in the window —
// and nothing else on screen
// claims to describe the same population. The 5-minute interval below already tracks the sync
// cadence; adding it to the sweep would spend that fold again on every repo edit.
export function useFlowFindings(workspaceId: number | null, days: number) {
  const { periodReports } = useProCapabilities();
  return useQuery<FlowResponse>({
    queryKey: flowFindingsQueryKey(workspaceId, days),
    queryFn: workspaceId == null ? skipToken : () => api.flowFindings(workspaceId, days),
    // ⚠ THE CAPABILITY, NOT A CALLER FLAG. Chronology has exactly one mount, so there is no
    // `enabled` argument to `&&` this with — and a future second caller must not be able to
    // widen the gate by forgetting to pass one.
    enabled: periodReports,
    // The same cadence every workspace-scoped survey on this pane runs at: findings are folded
    // from already-synced rows, so they can only change when a sync lands. Held with the query:
    // a disabled query does not refetch on an interval, on focus or on reconnect.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}

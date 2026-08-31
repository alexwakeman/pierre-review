import { skipToken, useQuery } from '@tanstack/react-query';
import type {
  BotBenchmarkPlacementResponse,
  BotBenchmarkResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { repoKeySlot } from './useBotTriage.js';
import { useProCapabilities } from './useTriage.js';

// The two reads behind **Bots → Benchmark**. Both are PAID on `botDepth` and both 402 server-side;
// the `enabled` gates below are what stop the SPA finding that out by error on a timer.
//
// ⚠ ONE FETCH ON MOUNT, AND ONLY ONE. The panel owns exactly `useBotBenchmarkPlacement` — the
// placement response already carries the cohort's quantiles, median CI, direction, unit, band label
// and band count PER METRIC, so nothing on this screen needs the cohort route to draw a number.
// The Pending board is the precedent that makes this a rule rather than a preference: an eager
// per-card fetch there turned a fifty-card board into 150 GitHub calls. The second read below is
// CLICK-GATED and fetches nothing until a reader opens the definitions.
//
// ⚠ `useProCapabilities()` IS ALL-FALSE UNTIL /api/me RESOLVES, so an entitled account holds both
// queries idle for one beat and then fires. That ordering is correct: the alternative is issuing a
// request we may not be allowed to make. The panel is not mounted during that beat either — its
// body routes through `useProGateState`, which waits on the same /api/me rather than painting a
// lock at a paying customer.

/** The canonical key for one placement scope. Every scoped key carries `ws:<id>`; `repoIds` gets
 *  its OWN slot because the same narrowing under two workspaces is two different answers. */
export function botBenchmarkPlacementQueryKey(
  workspaceId: number | null,
  repoIds: number[] | null,
): (string | number)[] {
  return ['bot-benchmark-placement', workspaceKey(workspaceId), repoKeySlot(repoIds)];
}

/**
 * The caller's own (repository × reviewer) placements — the one query this tab owns.
 *
 * ⚠ `workspaceId === null` MEANS "NOT RESOLVED YET", and `skipToken` (not a bare `enabled`) holds
 * it idle: it NARROWS the id to a number, so a request carrying no `?workspace=` — which the server
 * would answer out of the account's DEFAULT workspace, then cache under the null slot and repaint
 * under whichever workspace resolves a beat later — is unrepresentable rather than discouraged.
 *
 * ⚠ `repoIds` is sent WHENEVER THE ARRAY EXISTS, including when empty. `if (ids)`, never
 * `ids.length > 0`: an empty repo list is a real narrowing ("this workspace has no repositories in
 * scope") and dropping it would widen the request to the whole workspace.
 *
 * NO `refetchInterval`. Everything it folds comes from already-synced rows, the fold is the most
 * expensive read on the Bots rail (up to twelve repositories' pull requests, threads and comments),
 * and a peer comparison does not move between two syncs in a way anyone is watching for. It
 * refreshes when the reader returns to the tab, which is when they are looking.
 */
export function useBotBenchmarkPlacement(workspaceId: number | null, repoIds: number[] | null) {
  const { botDepth } = useProCapabilities();
  return useQuery<BotBenchmarkPlacementResponse>({
    queryKey: botBenchmarkPlacementQueryKey(workspaceId, repoIds),
    queryFn:
      workspaceId == null
        ? skipToken
        : () => api.botBenchmarkPlacement(workspaceId, repoIds ?? undefined),
    // ⚠ THE CAPABILITY, AND-ed IN HERE rather than left to the caller. `GET
    // /api/pro/bot-benchmark/placement` 402s without `botDepth`, and a hook that leaves the gate to
    // its call site is one forgotten argument away from an unentitled pane polling a 402.
    enabled: botDepth,
    staleTime: 5 * 60_000,
  });
}

/**
 * The corpus MANIFEST — metric definitions, populations, params, the vendor band ladders.
 *
 * ⚠ CLICK-GATED, and that is the whole point of the `open` argument: this is the "How these are
 * measured" disclosure, ~16 KB of prose that nobody needs to paint the panel. Called with no
 * `cells`, so the response is the manifest alone — the picker's shape, not a cohort payload.
 *
 * ⚠ AND IT IS THE ONLY SOURCE OF A METRIC'S DEFINITION. The corpus's `acted_on_rate` is NOT this
 * app's acted-on column (the app's folds the `likely_addressed` commit heuristic in and divides by
 * every in-window thread; the corpus's divides by settled, fully-read threads). Re-typing the
 * definitions into the SPA would make a second source of truth that drifts from the fitter's — so
 * the panel renders display LABELS from its own model and the DEFINITIONS from here.
 */
export function useBotBenchmarkSpecs(open: boolean) {
  const { botDepth } = useProCapabilities();
  return useQuery<BotBenchmarkResponse>({
    // No scope segment: the cohort artifact is identical for every tenant and takes no
    // `?workspace=`, so a `ws:` slot here would invent a scope the route does not have.
    queryKey: ['bot-benchmark-manifest'],
    queryFn: () => api.botBenchmark(),
    enabled: botDepth && open,
    // The artifact only changes when the image is rebuilt.
    staleTime: Infinity,
  });
}

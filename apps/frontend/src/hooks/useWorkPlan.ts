import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkPlanResponse } from '@pierre-review/shared';
import { api, type WorkPlanRequestParams } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { useProCapabilities } from './useTriage.js';

// The Pro work plan — "what should I work on today" for ONE workspace. Modelled on
// `useSynthesis` because the seam is the same shape: a FREE GET (the deterministic worklist + any
// stored narration + a `stale` probe, never generating) and a BILLED POST (the narration itself).
//
// ⚠ ONE KEY-SLOT BUILDER. The query key, the mutation key and the `setQueryData` write all build
// from `workPlanKeySlots`, so they cannot drift into addressing different rows — a hand-spelled
// key on any one of the three is how a "Plan my day" click appears to do nothing until the next
// refetch. Every scoped key carries the `ws:<id>` segment (`workspaceKey`), so two workspaces'
// plans never share a cache entry.
//
// ⚠ THE MUTATION KEY IS SHARED PER SCOPE (the CiAnalysisCard / SynthesisCard lesson). The card
// can be mounted more than once across a tab switch, and a per-mount `isPending` resets the button
// to "Plan my day" mid-run — inviting a second BILLED POST. `useWorkPlanGenerating` reads the
// in-flight state off the shared mutation key via `useIsMutating`, and the card MUST use it.
//
// ⚠ NOTHING FETCHES WITHOUT THE `workPlan` CAPABILITY: in OSS the route does not exist, and on
// free cloud it would answer `enabled: false` — either way the hook stays quiet and the card
// renders the nudge (cloud) or nothing at all (local/OSS).

/** The canonical client-side key segments for one work-plan scope. */
export function workPlanKeySlots(workspaceId: number | null): (string | number)[] {
  return [workspaceKey(workspaceId)];
}

function requestParams(workspaceId: number): WorkPlanRequestParams {
  // No `repoIds`: the Activity console is the only surface that mounts this panel and it always
  // covers the whole workspace (the repo picker is Timeline-only). Sending a narrowing here would
  // scope a screen that renders no control for it.
  return { workspaceId };
}

/**
 * The cached plan + the deterministic evidence behind it. FREE — the server never generates on
 * this path, so this query is safe to mount eagerly wherever the capability is on.
 */
export function useWorkPlan(workspaceId: number | null, enabled = true) {
  const { workPlan } = useProCapabilities();
  return useQuery<WorkPlanResponse>({
    queryKey: ['work-plan', ...workPlanKeySlots(workspaceId)],
    // `skipToken`, not a bare `enabled`: it NARROWS workspaceId to a number, so a request the
    // server would answer out of the account's DEFAULT workspace cannot be written at all
    // (`workspaceId === null` means "not resolved yet" — nothing workspace-scoped may render or
    // fetch while it is null).
    queryFn: workspaceId == null ? skipToken : () => api.workPlan(requestParams(workspaceId)),
    enabled: enabled && workPlan,
    staleTime: 60_000,
    // ⚠ THE SAME CADENCE AS `useDailyBrief` AND `useAttentionCards`, DELIBERATELY. This panel sits
    // directly beneath the brief strip and its entire claim is that the two describe one
    // population — so a panel that refetches on a different clock from the strip above it will
    // eventually disagree with it on screen, which is the one thing it may not do. (`work-plan` is
    // also in ACTIVITY_QUERY_KEYS, so a landing sync sweeps all three in phase; this interval
    // covers the quiet stretches between syncs.)
    refetchInterval: 5 * 60_000,
    // The third of the three keys that opt OUT of the app-wide `refetchOnWindowFocus:false` — for
    // the same reason the interval above is shared. A plan that still names a PR the board
    // dropped on focus is the disagreement this hook's comment exists to prevent.
    refetchOnWindowFocus: true,
  });
}

/**
 * The generate mutation — the ONLY billing path. Read its in-flight state through
 * `useWorkPlanGenerating`, never a per-mount `isPending` alone.
 */
export function useGenerateWorkPlan(workspaceId: number | null) {
  const qc = useQueryClient();
  const slots = workPlanKeySlots(workspaceId);
  return useMutation<WorkPlanResponse>({
    // EXPLICIT, and shared by every mount of this scope — that is what `useIsMutating` reads.
    mutationKey: ['work-plan-generate', ...slots],
    // A mutation cannot be skipToken-gated, so it refuses outright: generating against an
    // unresolved workspace would BILL for the account's Default and cache under 'ws:pending'.
    mutationFn: () => {
      if (workspaceId == null) throw new Error('No workspace selected');
      return api.workPlanGenerate(requestParams(workspaceId));
    },
    onSuccess: (data) => {
      // Written under the SAME slots the read uses.
      //
      // ⚠ `stale` IS A GET-ONLY FIELD, so a wholesale overwrite ERASES IT. The throttled and
      // creditsExhausted branches serve the CACHED row and omit `stale` entirely — nothing was
      // generated, so nothing about its freshness changed — and writing that response over the
      // GET's row flipped `stale: true` to `undefined`, quietly relabelling an out-of-date
      // narration as current. The user's click did nothing except remove the badge telling them
      // it had done nothing. So a response that did not generate INHERITS the staleness it found.
      qc.setQueryData<WorkPlanResponse>(['work-plan', ...slots], (prev) =>
        data.stale === undefined && prev?.stale !== undefined
          ? { ...data, stale: prev.stale }
          : data,
      );
      // A generation may have spent credits → refresh the meter and the out-of-credits gate.
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      // ⚠ AND RE-READ THE BOARD, so the head and the prose describe ONE fold.
      //
      // The narration joins a step to a card through `WorkPlanItem.cardId`, then INTERSECTS with
      // the head — the ids `/api/attention` returned. Both sides fold `getWorkspaceInsights`, but
      // at different INSTANTS: this POST folds fresh while the board is serving a body up to 60s
      // old, and with `MY_TURN_CARD_CAP` (50) biting a 176-item population, which rows are in the
      // fold genuinely moves between the two. Observed on real data: two of six sentences were
      // written about rows the board's head did not contain, so the intersection correctly dropped
      // them — no misattribution, but no sentence either.
      //
      // Refetching the board here brings the two into phase, so the model's work is actually
      // rendered. It is ONE extra `search`-tier read per user-initiated, billed generation.
      // ⚠ It must stay an INVALIDATION, never a source of the board's ORDER: the head is served
      // free by core `/api/attention`, and a board whose ranking depended on a Pro response would
      // put the free product's ordering behind the paywall.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
    },
  });
}

/** True while ANY mount of this workspace's plan is generating (the shared-mutation-key read). */
export function useWorkPlanGenerating(workspaceId: number | null): boolean {
  return (
    useIsMutating({ mutationKey: ['work-plan-generate', ...workPlanKeySlots(workspaceId)] }) > 0
  );
}
